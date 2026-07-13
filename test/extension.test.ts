/**
 * End-to-end test of the extension against pi's REAL built-in tool
 * definitions, driving the same pipeline pi's agent loop runs:
 *
 *   prepareArguments(raw) -> Value.Convert + Value.Check -> execute(params)
 *
 * No LLM involved: we feed the malformed inputs open models actually emit and
 * assert that the repaired call validates, executes against the filesystem,
 * and carries <repair_note> feedback in the result.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { beforeAll, describe, expect, test } from "vitest";
import toolRepairExtension from "../src/index.ts";

const workDir = mkdtempSync(join(tmpdir(), "pi-repair-test-"));
process.env.PI_TOOL_REPAIR_TELEMETRY = join(workDir, "telemetry.jsonl");
process.env.PI_TOOL_REPAIR_SETTINGS = join(workDir, "display-settings.json");

type RegisteredTool = {
  name: string;
  parameters: TSchema;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<any>;
};

const tools = new Map<string, RegisteredTool>();
const eventHandlers = new Map<
  string,
  (event: unknown, ctx: unknown) => Promise<void>
>();

const fakePi = {
  registerTool: (def: RegisteredTool) => tools.set(def.name, def),
  registerCommand: () => {},
  on: (
    event: string,
    handler: (event: unknown, ctx: unknown) => Promise<void>,
  ) => eventHandlers.set(event, handler),
} as any;

/** Mirror pi's validateToolArguments: Convert a clone, then Check. */
function validateLikePi(tool: RegisteredTool, args: unknown): unknown {
  const converted = Value.Convert(tool.parameters, structuredClone(args));
  if (!Value.Check(tool.parameters, converted)) {
    throw new Error(`Validation failed for tool "${tool.name}"`);
  }
  return converted;
}

async function runLikePi(
  toolName: string,
  rawArgs: unknown,
  toolCallId = "call-1",
) {
  const tool = tools.get(toolName);
  if (!tool) throw new Error(`tool ${toolName} not registered`);
  const prepared = tool.prepareArguments
    ? tool.prepareArguments(rawArgs)
    : rawArgs;
  const validated = validateLikePi(tool, prepared);
  return tool.execute(toolCallId, validated, undefined, undefined, {
    cwd: workDir,
  });
}

function resultText(result: any): string {
  return (result.content ?? [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");
}

beforeAll(async () => {
  toolRepairExtension(fakePi);
  const sessionStart = eventHandlers.get("session_start");
  if (!sessionStart)
    throw new Error("extension did not subscribe to session_start");
  await sessionStart({}, { cwd: workDir, model: { id: "test-model" } });
});

describe("overrides registered", () => {
  test("all seven built-ins are overridden", () => {
    expect([...tools.keys()].sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });
});

describe("read", () => {
  test("repairs file_path alias and surfaces a repair note with the file content", async () => {
    const file = join(workDir, "hello.txt");
    writeFileSync(file, "hello from pi\n");
    const result = await runLikePi("read", { file_path: file });
    const text = resultText(result);
    expect(text).toContain("<repair_note>");
    expect(text).toContain("file_path");
    expect(text).toContain("hello from pi");
  });

  test("valid input executes with no repair note", async () => {
    const file = join(workDir, "clean.txt");
    writeFileSync(file, "clean\n");
    const result = await runLikePi("read", { path: file });
    const text = resultText(result);
    expect(text).toContain("clean");
    expect(text).not.toContain("<repair_note>");
  });

  test("markdown auto-linked path is unwrapped", async () => {
    const file = join(workDir, "notes.md");
    writeFileSync(file, "note body\n");
    const result = await runLikePi("read", {
      path: `${workDir}/[notes.md](http://notes.md)`,
    });
    const text = resultText(result);
    expect(text).toContain("note body");
    expect(text).toContain("<repair_note>");
  });
});

describe("bash", () => {
  test("bare-string arguments are wrapped and executed", async () => {
    const result = await runLikePi("bash", "echo repair-layer-works");
    const text = resultText(result);
    expect(text).toContain("repair-layer-works");
    expect(text).toContain("<repair_note>");
  });

  test("cmd alias is renamed to command", async () => {
    const result = await runLikePi("bash", { cmd: "echo alias-works" });
    expect(resultText(result)).toContain("alias-works");
  });
});

describe("edit", () => {
  test("claude-code style old_string/new_string edits the file", async () => {
    const file = join(workDir, "edit-me.txt");
    writeFileSync(file, "alpha beta gamma\n");
    const result = await runLikePi("edit", {
      file_path: file,
      old_string: "beta",
      new_string: "delta",
    });
    expect(readFileSync(file, "utf-8")).toBe("alpha delta gamma\n");
    expect(resultText(result)).toContain("<repair_note>");
  });

  test("pi's own shim still works through the chain (flat oldText/newText)", async () => {
    const file = join(workDir, "edit-me-2.txt");
    writeFileSync(file, "one two three\n");
    await runLikePi("edit", { path: file, oldText: "two", newText: "2" });
    expect(readFileSync(file, "utf-8")).toBe("one 2 three\n");
  });
});

describe("unrepairable input", () => {
  test("raises a model-readable retry error before pi's Convert can corrupt it", async () => {
    await expect(runLikePi("read", { nothing: "useful" })).rejects.toThrow(
      'Invalid input for tool "read"',
    );
  });

  test("write with null content errors instead of writing the string 'null'", async () => {
    await expect(
      runLikePi("write", { path: join(workDir, "never.txt"), content: null }),
    ).rejects.toThrow('Invalid input for tool "write"');
  });
});

describe("TUI indicator", () => {
  const fakeTheme = { fg: (_color: string, text: string) => text } as any;

  test("repaired calls get the 🔨 indicator appended to their rendered result", async () => {
    const file = join(workDir, "indicator.txt");
    writeFileSync(file, "content\n");
    const result = await runLikePi(
      "read",
      { file_path: file },
      "call-indicator",
    );
    const tool = tools.get("read") as any;
    const component = tool.renderResult(
      result,
      { expanded: false },
      fakeTheme,
      {
        toolCallId: "call-indicator",
        lastComponent: undefined,
      },
    );
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("🔨 ✓ input repaired");
    expect(rendered).toContain("renameAliasedField");
    expect(rendered).not.toContain("<repair_note>"); // notes off by default
  });

  test("clean calls render natively with no indicator", async () => {
    const file = join(workDir, "indicator-clean.txt");
    writeFileSync(file, "content\n");
    const result = await runLikePi("read", { path: file }, "call-clean");
    const tool = tools.get("read") as any;
    const component = tool.renderResult(
      result,
      { expanded: false },
      fakeTheme,
      {
        toolCallId: "call-clean",
        lastComponent: undefined,
      },
    );
    expect(component.render(80).join("\n")).not.toContain("🔨");
  });
});

describe("telemetry", () => {
  test("repairs were recorded locally as JSONL", () => {
    const lines = readFileSync(process.env.PI_TOOL_REPAIR_TELEMETRY!, "utf-8")
      .split("\n")
      .filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(0);
    const record = JSON.parse(lines[0]);
    expect(record.tool).toBeDefined();
    expect(record.model).toBe("test-model");
    expect(record.outcome).toMatch(/repaired|unrepairable/);
    expect(record.fingerprint).toBeDefined();
  });
});
