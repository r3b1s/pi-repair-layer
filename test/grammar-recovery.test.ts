/**
 * Grammar-leak recovery tests.
 *
 * - Pure parser tests ported from monotykamary/pi-tool-repair's grammar-repair
 *   suite (they exercise `parseToolGrammarLeaks` unchanged).
 * - Driver tests for `recoverGrammarLeaks`, including the new stopReason gate,
 *   the default-mode ("strip") never-promotes behavior, unknown-tool preservation,
 *   and empty-args skip.
 * - One end-to-end test that drives a recovered call through the real agent loop
 *   (glm-gated, recover mode) and asserts the executed built-in surfaces a
 *   <repair_note> and a tool-keyed "recovered" telemetry record.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
  AuthStorage,
  createAgentSession,
  discoverAndLoadExtensions,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  type MinimalAssistantMessage,
  parseToolGrammarLeaks,
  recoverGrammarLeaks,
} from "../src/grammar-recovery.ts";

const here = dirname(fileURLToPath(import.meta.url));

function assistant(text: string, stopReason = "stop"): MinimalAssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

describe("grammar leak parsing (ported)", () => {
  test("DSML double/single/no-lead-bar variants", () => {
    const text = `
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="code_exec">
<｜｜DSML｜｜parameter name="language" string="true">python</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
<｜DSML｜tool_calls>
<｜DSML｜invoke name="fetch">
<｜DSML｜parameter name="url" string="false">["x"]</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;
    expect(parseToolGrammarLeaks(text, ["dsml"])).toEqual([
      { grammar: "dsml", name: "code_exec", arguments: { language: "python" } },
      { grammar: "dsml", name: "fetch", arguments: { url: ["x"] } },
    ]);
  });

  test("Qwen function/parameter XML", () => {
    const text = `<tool_call>\n<function=get_weather>\n<parameter=location>Paris</parameter>\n</function>\n</tool_call>`;
    expect(parseToolGrammarLeaks(text, ["qwen"])).toEqual([
      {
        grammar: "qwen",
        name: "get_weather",
        arguments: { location: "Paris" },
      },
    ]);
  });

  test("Kimi sentinel tool calls", () => {
    const text = `<|tool_calls_section_begin|><|tool_call_begin|>functions.web_search:0<|tool_call_argument_begin|>{"query":"pi"}<|tool_call_end|><|tool_calls_section_end|>`;
    expect(parseToolGrammarLeaks(text, ["kimi"])).toEqual([
      { grammar: "kimi", name: "web_search", arguments: { query: "pi" } },
    ]);
  });

  test("GLM arg_key/arg_value XML", () => {
    const text = `<tool_call>get_weather\n<arg_key>city</arg_key>\n<arg_value>Beijing</arg_value>\n</tool_call>`;
    expect(parseToolGrammarLeaks(text, ["glm"])).toEqual([
      { grammar: "glm", name: "get_weather", arguments: { city: "Beijing" } },
    ]);
  });

  test("Llama python_tag JSON", () => {
    const text = `<|python_tag|>{"name":"write_file","arguments":{"path":"/tmp/a","content":"x"}}`;
    expect(parseToolGrammarLeaks(text, ["llama"])).toEqual([
      {
        grammar: "llama",
        name: "write_file",
        arguments: { path: "/tmp/a", content: "x" },
      },
    ]);
  });

  test("OLMo pythonic function calls", () => {
    const text = `<function_calls>\nwrite_file(path="/tmp/a", content="hello", overwrite=True)\n</function_calls>`;
    expect(parseToolGrammarLeaks(text, ["olmo"])).toEqual([
      {
        grammar: "olmo",
        name: "write_file",
        arguments: { path: "/tmp/a", content: "hello", overwrite: true },
      },
    ]);
  });

  test("does not parse grammar inside markdown code fences", () => {
    const text =
      '```xml\n<tool_call>{"name":"bash","arguments":{}}</tool_call>\n```';
    expect(parseToolGrammarLeaks(text, ["granite"])).toEqual([]);
  });

  test("does not report truncated/dangling DSML markers as calls", () => {
    expect(
      parseToolGrammarLeaks("I'll read.\n<｜DSML｜tool_calls", ["dsml"]),
    ).toEqual([]);
  });
});

describe("recoverGrammarLeaks driver", () => {
  const knownBash = new Set(["bash"]);

  test("recover mode strips leaked text and appends a recovered toolCall", () => {
    const message = assistant(
      `I'll use the tool.\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`,
    );
    const result = recoverGrammarLeaks(message, {
      mode: "recover",
      knownTools: knownBash,
    });
    expect(result.changed).toBe(true);
    expect(result.promoted).toBe(true);
    expect(result.message.stopReason).toBe("toolUse");
    expect(result.message.content).toEqual([
      { type: "text", text: "I'll use the tool." },
      {
        type: "toolCall",
        id: expect.stringMatching(/^tool_repair_dsml_/),
        name: "bash",
        arguments: { command: "pwd" },
      },
    ]);
  });

  test("stopReason gate: a truncated (length) message is stripped but never promoted", () => {
    const message = assistant(
      `text\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`,
      "length",
    );
    const result = recoverGrammarLeaks(message, {
      mode: "recover",
      knownTools: knownBash,
    });
    expect(result.changed).toBe(true); // text was stripped
    expect(result.promoted).toBe(false);
    expect(result.message.stopReason).toBe("length"); // not overwritten
    expect(result.message.content.some((p: any) => p.type === "toolCall")).toBe(
      false,
    );
  });

  test("default mode 'strip' never promotes, even for a known tool on stopReason stop", () => {
    const message = assistant(
      `<tool_call>\n<function=bash>\n<parameter=command>pwd</parameter>\n</function>\n</tool_call>`,
    );
    const result = recoverGrammarLeaks(message, {
      mode: "strip",
      knownTools: knownBash,
    });
    expect(result.changed).toBe(true);
    expect(result.promoted).toBe(false);
    expect(result.message.stopReason).toBe("stop");
    expect(result.message.content.some((p: any) => p.type === "toolCall")).toBe(
      false,
    );
  });

  test("off mode does nothing", () => {
    const message = assistant(
      `<tool_call>\n<function=bash>\n<parameter=command>pwd</parameter>\n</function>\n</tool_call>`,
    );
    const result = recoverGrammarLeaks(message, {
      mode: "off",
      knownTools: knownBash,
    });
    expect(result.changed).toBe(false);
  });

  test("unknown tool: text is preserved by default and never promoted", () => {
    const message = assistant(
      `<tool_call>{"name":"unknown","arguments":{"x":1}}</tool_call>`,
    );
    const result = recoverGrammarLeaks(message, {
      mode: "recover",
      knownTools: knownBash, // "unknown" not in the allowlist
    });
    expect(result.changed).toBe(false);
    expect(result.promoted).toBe(false);
    expect((result.message.content[0] as { text?: string }).text).toContain(
      "unknown",
    );
    expect(result.message.content.some((p: any) => p.type === "toolCall")).toBe(
      false,
    );
  });

  test("explicit unknown-tool policy strips text without promotion", () => {
    const message = assistant(
      `<tool_call>{"name":"unknown","arguments":{"x":1}}</tool_call>`,
    );
    const result = recoverGrammarLeaks(message, {
      mode: "recover",
      knownTools: knownBash,
      unknownToolText: "strip",
    });
    expect(result.changed).toBe(true);
    expect(result.promoted).toBe(false);
    expect((result.message.content[0] as { text?: string }).text).not.toContain(
      "unknown",
    );
  });

  test("observe mode records detection without changing message identity", () => {
    const message = assistant(
      `<tool_call>\n<function=bash>\n<parameter=command>pwd</parameter>\n</function>\n</tool_call>`,
    );
    const result = recoverGrammarLeaks(message, {
      mode: "observe",
      knownTools: knownBash,
    });
    expect(result.changed).toBe(false);
    expect(result.observed).toBe(true);
    expect(result.message).toBe(message);
    expect(result.message.stopReason).toBe("stop");
    expect(result.detectedRanges).toBe(1);
  });

  test("empty-argument candidate is stripped but not promoted", () => {
    const message = assistant(`<tool_call>write</tool_call>`);
    const result = recoverGrammarLeaks(message, {
      mode: "recover",
      knownTools: new Set(["write"]),
    });
    expect(result.recoveredCalls).toEqual([]);
    expect(result.promoted).toBe(false);
    expect((result.message.content[0] as any).text).not.toContain("tool_call");
  });

  test("strip-only when the message already has a real toolCall", () => {
    const message: MinimalAssistantMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: `<tool_call>\n<function=bash>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>`,
        },
        {
          type: "toolCall",
          id: "real-1",
          name: "bash",
          arguments: { command: "pwd" },
        },
      ],
    };
    const result = recoverGrammarLeaks(message, {
      mode: "recover",
      knownTools: new Set(["bash"]),
    });
    expect(result.promoted).toBe(false); // existing toolCall present
  });

  test("code-fenced grammar is not a leak", () => {
    const message = assistant(
      "```\n<tool_call>\n<function=bash>\n<parameter=command>pwd</parameter>\n</function>\n</tool_call>\n```",
    );
    const result = recoverGrammarLeaks(message, {
      mode: "recover",
      knownTools: knownBash,
    });
    expect(result.changed).toBe(false);
  });
});

// --- End-to-end: recovered call executes with a note + telemetry ------------

describe("recovered call executes through the real loop with a repair note", () => {
  test("glm-gated recover mode promotes a leaked read, surfacing <repair_note>", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-recover-"));
    const target = join(cwd, "leaked-read.txt");
    writeFileSync(target, "recovered content here\n");

    // Enable recover mode via the extension's settings file before it loads.
    const settingsPath = join(cwd, "repair-settings.json");
    writeFileSync(settingsPath, JSON.stringify({ grammarRecovery: "recover" }));
    const telemetryPath = join(cwd, "telemetry.jsonl");
    process.env.PI_TOOL_REPAIR_SETTINGS = settingsPath;
    process.env.PI_TOOL_REPAIR_TELEMETRY = telemetryPath;

    const faux = registerFauxProvider({ models: [{ id: "glm-4.6" }] });
    const model = faux.getModel();
    const auth = AuthStorage.inMemory();
    auth.setRuntimeApiKey(model.provider, "faux-key");
    const modelRegistry = ModelRegistry.inMemory(auth);
    modelRegistry.registerProvider(model.provider, {
      baseUrl: model.baseUrl,
      apiKey: "faux-key",
      api: faux.api,
      models: faux.models.map((rm) => ({
        id: rm.id,
        name: rm.name,
        api: rm.api,
        reasoning: rm.reasoning,
        input: rm.input,
        cost: rm.cost,
        contextWindow: rm.contextWindow,
        maxTokens: rm.maxTokens,
        baseUrl: rm.baseUrl,
      })),
    });

    const extPath = join(here, "..", "src", "index.ts");
    const extResult = await discoverAndLoadExtensions([extPath], cwd, cwd);
    const resourceLoader = {
      getExtensions: () => extResult,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => undefined,
      getAppendSystemPrompt: () => [],
      extendResources: () => {},
      reload: async () => {},
    } as any;

    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model,
      authStorage: auth,
      modelRegistry,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
      tools: ["read"],
    });
    // Fire session_start (registers our built-in overrides + sets the model id),
    // as the real pi host does at startup.
    await session.bindExtensions({});

    // The model prints a GLM tool-call for `read` as text instead of calling it.
    const leaked = `Let me read that file.\n<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>${target}</arg_value>\n</tool_call>`;
    faux.setResponses([
      fauxAssistantMessage(leaked, { stopReason: "stop" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    await session.prompt("go");

    const toolResults = session.messages.filter(
      (m: any) => m.role === "toolResult",
    );
    const text = toolResults
      .flatMap((m: any) =>
        (m.content ?? []).filter((b: any) => b.type === "text"),
      )
      .map((b: any) => b.text)
      .join("\n");
    session.dispose();
    faux.unregister();

    // The recovered read executed against the real file...
    expect(text).toContain("recovered content here");
    // ...and its result carries the recovery repair note.
    expect(text).toContain("<repair_note>");
    expect(text.toLowerCase()).toContain("recovered a leaked");

    // Telemetry recorded a tool-keyed "recovered" outcome.
    const records = readFileSync(telemetryPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(
      records.some((r) => r.outcome === "recovered" && r.tool === "read"),
    ).toBe(true);
  });
});
