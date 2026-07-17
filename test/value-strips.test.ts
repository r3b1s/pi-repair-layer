/**
 * Value-strip pre-pass: pure-function unit tests plus an integration test that
 * drives the strips through the extension's real prepareArguments override
 * (against pi's real tool factories) to confirm a strip and an engine repair
 * combine into one repair note.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { beforeAll, describe, expect, test } from "vitest";
import toolRepairExtension from "../src/index.ts";
import {
  STRIP_ANCHOR_RULE,
  STRIP_GRAMMAR_RULE,
  stripValues,
} from "../src/value-strips.ts";

describe("stripValues (pure)", () => {
  test("strips bled anchors from a path value on a gated model", () => {
    const { input, result } = stripValues({
      toolName: "read",
      input: { path: "^/home/user/file.ts$" },
      modelId: "kimi-k2-instruct",
    });
    expect(input).toEqual({ path: "/home/user/file.ts" });
    expect(result.changed).toBe(true);
    expect(result.rules).toContain(STRIP_ANCHOR_RULE);
    expect(result.notes.join(" ")).toContain("read");
  });

  test("gates: minimax and glm strip anchors, an ungated model does not", () => {
    for (const modelId of ["MiniMax-Text-01", "glm-4.6"]) {
      const { result } = stripValues({
        toolName: "read",
        input: { path: "^/x$" },
        modelId,
      });
      expect(result.changed, modelId).toBe(true);
    }
    const ungated = stripValues({
      toolName: "read",
      input: { path: "^/x$" },
      modelId: "claude-opus-4-8",
    });
    expect(ungated.result.changed).toBe(false);
    expect(ungated.input).toEqual({ path: "^/x$" });
  });

  test("grep.pattern is exempt, but a sibling field on the same call is stripped", () => {
    const { input, result } = stripValues({
      toolName: "grep",
      input: { pattern: "^import React", path: "^/src$" },
      modelId: "glm-4.6",
    });
    expect(input).toEqual({ pattern: "^import React", path: "/src" });
    expect(result.rules).toContain(STRIP_ANCHOR_RULE);
  });

  test("find.pattern is NOT exempt (it is a glob, not a regex)", () => {
    const { input } = stripValues({
      toolName: "find",
      input: { pattern: "^*.ts$" },
      modelId: "glm-4.6",
    });
    expect(input).toEqual({ pattern: "*.ts" });
  });

  test("strips grammar-token leaks from keys and values on glm", () => {
    const { input, result } = stripValues({
      toolName: "grep",
      input: { "<arg_key>pattern</arg_key>": "<arg_value>foo</arg_value>" },
      modelId: "glm-4.6",
    });
    expect(input).toEqual({ pattern: "foo" });
    expect(result.rules).toContain(STRIP_GRAMMAR_RULE);
  });

  test("grammar tokens are not stripped on a non-glm anchor-bleed model", () => {
    const { input, result } = stripValues({
      toolName: "grep",
      input: { "<arg_key>pattern</arg_key>": "foo" },
      modelId: "kimi-k2-instruct",
    });
    // kimi is an anchor-bleed model but not a grammar-leak model.
    expect(input).toEqual({ "<arg_key>pattern</arg_key>": "foo" });
    expect(result.rules).not.toContain(STRIP_GRAMMAR_RULE);
  });

  test("recurses into nested arrays and objects", () => {
    const { input } = stripValues({
      toolName: "edit",
      input: { edits: [{ oldText: "^a$", newText: "^b$" }] },
      modelId: "glm-4.6",
    });
    expect(input).toEqual({ edits: [{ oldText: "a", newText: "b" }] });
  });
});

// --- Integration: strip + engine repair combine into one note --------------

type RegisteredTool = {
  name: string;
  parameters: TSchema;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    id: string,
    params: unknown,
    s?: unknown,
    u?: unknown,
    c?: unknown,
  ) => Promise<any>;
};

const workDir = mkdtempSync(join(tmpdir(), "pi-strip-test-"));
process.env.PI_TOOL_REPAIR_TELEMETRY = join(workDir, "telemetry.jsonl");
process.env.PI_TOOL_REPAIR_SETTINGS = join(workDir, "display-settings.json");

const tools = new Map<string, RegisteredTool>();
const handlers = new Map<string, (e: any, c: any) => Promise<any>>();
const fakePi = {
  registerTool: (def: RegisteredTool) => tools.set(def.name, def),
  registerCommand: () => {},
  on: (event: string, h: (e: any, c: any) => Promise<any>) =>
    handlers.set(event, h),
} as any;

function validateLikePi(tool: RegisteredTool, args: unknown): unknown {
  const converted = Value.Convert(tool.parameters, structuredClone(args));
  if (!Value.Check(tool.parameters, converted)) {
    throw new Error(`Validation failed for tool "${tool.name}"`);
  }
  return converted;
}

async function runLikePi(toolName: string, rawArgs: unknown, id = "c1") {
  const tool = tools.get(toolName);
  if (!tool) throw new Error(`tool ${toolName} not registered`);
  const prepared = tool.prepareArguments
    ? tool.prepareArguments(rawArgs)
    : rawArgs;
  const validated = validateLikePi(tool, prepared);
  await handlers.get("tool_call")?.(
    { type: "tool_call", toolName, toolCallId: id, input: validated },
    {},
  );
  const result = await tool.execute(id, validated, undefined, undefined, {
    cwd: workDir,
  });
  const replacement = await handlers.get("tool_result")?.(
    {
      type: "tool_result",
      toolName,
      toolCallId: id,
      input: validated,
      content: result.content,
      details: result.details,
      isError: false,
    },
    {},
  );
  return replacement ? { ...result, ...replacement } : result;
}

function resultText(result: any): string {
  return (result.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

describe("strip + engine repair through the real override (gated model)", () => {
  beforeAll(async () => {
    toolRepairExtension(fakePi);
    const sessionStart = handlers.get("session_start");
    if (!sessionStart) throw new Error("no session_start handler");
    // Gate the strips on: glm is both an anchor-bleed and grammar-leak family.
    await sessionStart({}, { cwd: workDir, model: { id: "glm-4.6" } });
  });

  test("anchor-bled alias field is stripped AND renamed, surfacing both rules", async () => {
    const file = join(workDir, "combo.txt");
    writeFileSync(file, "combo body\n");
    // `file_path` is an alias (engine renames -> path) whose value is anchor-bled
    // (strip cleans it first). Both must fire and both notes must surface.
    const result = await runLikePi("read", { file_path: `^${file}$` });
    const text = resultText(result);
    expect(text).toContain("combo body");
    expect(text).toContain("<repair_note>");
    expect(text).toContain("regex anchors"); // strip note
    expect(text).toContain("file_path"); // rename note
  });

  test("a strip alone (no engine repair) is still recorded in telemetry", async () => {
    const file = join(workDir, "striponly.txt");
    writeFileSync(file, "strip only\n");
    await runLikePi("read", { path: `^${file}$` }, "c-striponly");
    const lines = readFileSync(process.env.PI_TOOL_REPAIR_TELEMETRY!, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(
      lines.some(
        (r) => r.tool === "read" && r.rules.includes(STRIP_ANCHOR_RULE),
      ),
    ).toBe(true);
  });
});
