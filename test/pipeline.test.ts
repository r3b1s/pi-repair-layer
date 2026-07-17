import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
  escapeJsonStringControlCharacters,
  recoverEnvelope,
} from "../src/envelope.ts";
import { attachRepairNotes, RepairLifecycle } from "../src/lifecycle.ts";
import { runRepairPipeline } from "../src/pipeline.ts";
import { resolveRepairPolicy } from "../src/policy.ts";
import type { Preprocessor } from "../src/preprocess.ts";
import { PIPELINE_PREPROCESSORS, REPAIR_CONFIGS } from "../src/tables.ts";

const schema = Type.Object({
  path: Type.String({ minLength: 1 }),
  files: Type.Optional(
    Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
  ),
  content: Type.Optional(Type.String()),
});

function repair(
  input: unknown,
  policy: "conservative" | "adaptive" = "adaptive",
) {
  return runRepairPipeline({
    input,
    config: {
      toolName: "read",
      schema,
      policy,
      preprocessors: PIPELINE_PREPROCESSORS.read,
      legacyConfig: REPAIR_CONFIGS.read,
    },
  });
}

describe("ordered repair pipeline", () => {
  test("preserves strictly valid input by reference", () => {
    const input = { path: "/tmp/a" };
    const result = repair(input);
    expect(result.outcome).toBe("valid");
    expect(result.args).toBe(input);
    expect(result.changes).toEqual([]);
  });

  test("does not mutate caller input and is deterministic/idempotent", () => {
    const input = { file_path: "/tmp/a" };
    const before = structuredClone(input);
    const first = repair(input);
    const second = repair(input);
    expect(input).toEqual(before);
    expect(first).toEqual(second);
    expect(first.outcome).toBe("repaired");
    const repeated = repair(first.args);
    expect(repeated.outcome).toBe("valid");
    expect(repeated.args).toBe(first.args);
  });

  test("runs exact optional aliases before a permissive strict-valid return", () => {
    const optionalSchema = Type.Object({ path: Type.Optional(Type.String()) });
    const input = { directory: "/tmp" };
    const result = runRepairPipeline({
      input,
      config: {
        toolName: "ls",
        schema: optionalSchema,
        preprocessors: [
          {
            kind: "alias",
            selector: "/path",
            aliases: ["directory"],
            accepts: "string",
          },
        ],
      },
    });
    expect(result.outcome).toBe("repaired");
    expect(result.args).toEqual({ path: "/tmp" });
  });

  test("only replaces empty canonical values when explicitly configured", () => {
    const preprocessors: Preprocessor[] = [
      {
        kind: "alias",
        selector: "/path",
        aliases: ["file_path"],
        accepts: "string",
        emptyEquivalentToMissing: true,
      },
      {
        kind: "alias",
        selector: "/content",
        aliases: ["body"],
        accepts: "string",
      },
    ];
    const result = runRepairPipeline({
      input: { path: "", file_path: "/x", content: "", body: "replacement" },
      config: { toolName: "write", schema, preprocessors },
    });
    expect(result.args).toEqual({
      path: "/x",
      content: "",
      body: "replacement",
    });
  });

  test("supports nested array wildcard selectors and preserves unknown content", () => {
    const input = {
      path: "/x",
      files: [{ old_string: "a", new_string: "b" }],
      content: '{"looks":"structured"}',
      paht: "/not-guessed",
    };
    const result = runRepairPipeline({
      input,
      config: {
        toolName: "custom",
        schema,
        preprocessors: [
          {
            kind: "alias",
            selector: "/files/*/oldText",
            aliases: ["old_string"],
            accepts: "string",
          },
          {
            kind: "alias",
            selector: "/files/*/newText",
            aliases: ["new_string"],
            accepts: "string",
          },
        ],
      },
    });
    expect(result.args).toEqual({
      path: "/x",
      files: [{ oldText: "a", newText: "b" }],
      content: '{"looks":"structured"}',
      paht: "/not-guessed",
    });
  });

  test("every mutation has a stable rule and note and final repaired output validates", () => {
    const result = repair(JSON.stringify({ file_path: "/tmp/a" }));
    expect(result.outcome).toBe("repaired");
    expect(result.changes.length).toBeGreaterThan(0);
    for (const change of result.changes) {
      expect(change.ruleId).not.toBe("");
      expect(change.note).not.toBe("");
    }
    expect(Value.Check(schema, result.args)).toBe(true);
  });

  test("fails closed without replacing input with an empty object", () => {
    for (const input of [[], [{ path: "/a" }, { path: "/b" }], 42]) {
      const result = repair(input);
      expect(result.outcome).toBe("unrepairable");
      expect(result.args).toBe(input);
      expect(result.args).not.toEqual({});
      expect(result.changes).toEqual([]);
    }
  });
});

describe("bounded envelope recovery", () => {
  test("decodes double-encoded objects and singleton arrays", () => {
    const encoded = JSON.stringify(JSON.stringify({ path: "/x" }));
    expect(repair(encoded).args).toEqual({ path: "/x" });
    expect(repair([{ path: "/x" }]).args).toEqual({ path: "/x" });
  });

  test("escapes raw JSON-string control characters", () => {
    const raw = '{"path":"/tmp/a\nb"}';
    expect(escapeJsonStringControlCharacters(raw)).toBe(
      '{"path":"/tmp/a\\u000ab"}',
    );
    expect(repair(raw).args).toEqual({ path: "/tmp/a\nb" });
  });

  test("truncated completion is policy-gated and schema-validated", () => {
    const truncated = '{"path":"/tmp/a"';
    const run = (input: unknown, policy: "conservative" | "adaptive") =>
      runRepairPipeline({
        input,
        config: { toolName: "custom", schema, policy },
      });
    const adaptive = run(truncated, "adaptive");
    expect(adaptive.outcome).toBe("repaired");
    expect(adaptive.changes.map((item) => item.ruleId)).toContain(
      "envelope.complete-truncated-object",
    );
    expect(run(truncated, "conservative").outcome).toBe("unrepairable");
    expect(run('{"wrong":true', "adaptive").outcome).toBe("unrepairable");
  });

  test("enforces byte/depth limits and leaves prototype-looking keys inert", () => {
    const limited = recoverEnvelope("x".repeat(20), { maxInputBytes: 4 });
    expect(limited.limited).toBe(true);
    const input = JSON.parse('{"path":"/x","__proto__":{"polluted":true}}');
    const result = repair(input);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(result.args).toHaveProperty("__proto__");
  });
});

describe("profiles and repair lifecycle", () => {
  test("profiles expose coherent safety boundaries", () => {
    expect(resolveRepairPolicy("conservative")).toMatchObject({
      grammarMode: "observe",
      allowValidValueTransforms: false,
      allowTruncatedEnvelopeCompletion: false,
    });
    expect(resolveRepairPolicy("adaptive").grammarMode).toBe("strip");
    expect(resolveRepairPolicy("recover").grammarMode).toBe("recover");
    expect(
      resolveRepairPolicy("recover", { unknownGrammarText: "strip" })
        .unknownGrammarText,
    ).toBe("strip");
  });

  test("matches identical calls FIFO, expires entries, caps queues, and clears", () => {
    let now = 0;
    const lifecycle = new RepairLifecycle({
      ttlMs: 10,
      maxPending: 2,
      now: () => now,
    });
    lifecycle.enqueue("x", { b: 2, a: 1 }, { rules: ["one"], notes: ["n1"] });
    lifecycle.enqueue("x", { a: 1, b: 2 }, { rules: ["two"], notes: ["n2"] });
    expect(lifecycle.correlate("x", { a: 1, b: 2 }, "c1")?.rules).toEqual([
      "one",
    ]);
    expect(lifecycle.correlate("x", { a: 1, b: 2 }, "c2")?.rules).toEqual([
      "two",
    ]);
    lifecycle.enqueue("x", {}, { rules: ["stale"], notes: [] });
    now = 11;
    lifecycle.cleanup();
    expect(lifecycle.pendingCount).toBe(0);
    expect(lifecycle.peek("c1")).toBeUndefined();
    lifecycle.clear();
    expect(lifecycle.take("c1")).toBeUndefined();
  });

  test("attaches notes once while preserving non-text content", () => {
    const content = [
      { type: "image", data: "x" },
      { type: "text", text: "result" },
    ];
    const once = attachRepairNotes(content, ["fixed"]);
    const twice = attachRepairNotes(once, ["fixed"]);
    expect(twice).toEqual(once);
    expect(twice[0]).toEqual(content[0]);
    expect(twice[1]?.text).toContain("<repair_note>fixed</repair_note>");
  });
});
