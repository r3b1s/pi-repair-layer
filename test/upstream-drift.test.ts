/**
 * Upstream-drift tripwires — behavioral assertions about pi's real agent loop
 * that this extension's design depends on, executed against the installed pi
 * packages (not a simulation). Each claim these guard is documented, with pi
 * source citations, in docs/research.md; when one of these fails after a pi
 * upgrade, that document's re-verification checklist says what to re-check.
 *
 * The loop is driven offline by pi-ai's faux provider: a scripted model that
 * emits pre-authored assistant messages, so a full turn (streaming, preflight,
 * validation, tool execution, message_end replacement) runs with no network.
 * An on-disk instrumentation extension (test/fixtures/drift-instrument.ts) is
 * loaded through pi's real extension loader so its tool_call / message_end
 * handlers run on the real loop; it records through `globalThis.__drift`.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
  AuthStorage,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  discoverAndLoadExtensions,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const INSTRUMENT_PATH = join(here, "fixtures", "drift-instrument.ts");

/**
 * The pi minor version the research claims in docs/research.md were verified
 * against. The canary test below fails on a minor bump so the claims get
 * re-verified deliberately; patch bumps pass.
 */
const VERIFIED_PI_VERSION = "0.80";

interface DriftBridge {
  toolCallFired: { toolName: string; input: unknown }[];
  mutateInPlace?: boolean;
  reassign?: boolean;
  injectToolCall?: { name: string; arguments: Record<string, unknown> };
}

function driftBridge(): DriftBridge {
  const g = globalThis as unknown as { __drift?: DriftBridge };
  g.__drift = { toolCallFired: [] };
  return g.__drift;
}

interface ProbeObservations {
  prepared: unknown[];
  executed: unknown[];
}

/** A minimal custom tool whose prepareArguments/execute we watch. */
function probeTool(obs: ProbeObservations) {
  return {
    name: "probe",
    description: "probe tool for drift tests",
    parameters: Type.Object({ path: Type.String() }),
    prepareArguments(raw: unknown) {
      obs.prepared.push(raw);
      return raw;
    },
    async execute(_id: string, params: unknown) {
      obs.executed.push(params);
      return {
        content: [
          { type: "text", text: `probe ran ${JSON.stringify(params)}` },
        ],
      };
    },
  };
}

/** Drives one prompt through the real loop against the faux provider. */
async function runLoop(responses: unknown[]) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-drift-"));
  const obs: ProbeObservations = { prepared: [], executed: [] };

  const faux = registerFauxProvider({ models: [{ id: "faux-drift" }] });
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

  const extResult = await discoverAndLoadExtensions(
    [INSTRUMENT_PATH],
    cwd,
    cwd,
  );
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

  const events: any[] = [];
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    model,
    authStorage: auth,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    resourceLoader,
    customTools: [probeTool(obs) as any],
    tools: ["probe"],
  });
  session.subscribe((event: any) => events.push(event));

  faux.setResponses(responses as any);
  await session.prompt("go");

  const messages = session.messages;
  session.dispose();
  faux.unregister();
  return { obs, events, messages };
}

let bridge: DriftBridge;
beforeEach(() => {
  bridge = driftBridge();
});
afterEach(() => {
  (globalThis as any).__drift = undefined;
});

describe("loop-ordering tripwire (research.md Claims 1-2)", () => {
  test("prepareArguments sees raw failing input and tool_call never fires for it", async () => {
    // `{ wrong: "x" }` is missing the required `path` → validation throws.
    const { obs } = await runLoop([
      fauxAssistantMessage([fauxToolCall("probe", { wrong: "x" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);

    // prepareArguments ran, and saw the raw (unvalidated, unrepaired) input.
    expect(obs.prepared).toContainEqual({ wrong: "x" });
    // Validation failed before execution — the tool never ran.
    expect(obs.executed).toHaveLength(0);
    // ...and the post-validation tool_call event never fired for that call.
    expect(
      bridge.toolCallFired.find((c) => c.toolName === "probe"),
    ).toBeUndefined();
  });
});

describe("event-propagation tripwire (research.md Claims 3-4)", () => {
  test("in-place mutation of event.input reaches execute", async () => {
    bridge.mutateInPlace = true;
    const { obs } = await runLoop([
      fauxAssistantMessage([fauxToolCall("probe", { path: "/original" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    expect(obs.executed).toEqual([{ path: "/mutated" }]);
  });

  test("reassignment of event.input is dropped", async () => {
    bridge.reassign = true;
    const { obs } = await runLoop([
      fauxAssistantMessage([fauxToolCall("probe", { path: "/original" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    expect(obs.executed).toEqual([{ path: "/original" }]);
  });

  test("message_end replacement's toolCall executes same-turn", async () => {
    // Model returns plain text with no toolCall; the message_end handler injects
    // a probe toolCall and returns the replacement. It must execute this turn.
    bridge.injectToolCall = { name: "probe", arguments: { path: "/injected" } };
    const { obs } = await runLoop([
      fauxAssistantMessage("just some text", { stopReason: "stop" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    expect(obs.executed).toEqual([{ path: "/injected" }]);
  });
});

describe("length-truncation protection (research.md Claim 7)", () => {
  test('stopReason "length" toolCalls are failed by pi, not executed', async () => {
    const { obs, messages } = await runLoop([
      fauxAssistantMessage([fauxToolCall("probe", { path: "/x" })], {
        stopReason: "length",
      }),
      // Safety net in case pi continues the turn after failing truncated calls.
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    // The tool was never executed...
    expect(obs.executed).toHaveLength(0);
    // ...and pi produced a failed tool result for it.
    const toolResults = messages.filter((m: any) => m.role === "toolResult");
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults.some((m: any) => m.isError)).toBe(true);
  });
});

describe("built-in schema-shape snapshot (research.md Claim 8)", () => {
  const factories: Record<string, (cwd: string) => any> = {
    read: createReadToolDefinition,
    bash: createBashToolDefinition,
    edit: createEditToolDefinition,
    write: createWriteToolDefinition,
    grep: createGrepToolDefinition,
    find: createFindToolDefinition,
    ls: createLsToolDefinition,
  };

  /** JSON-schema shape (Symbol-keyed TypeBox internals dropped by stringify). */
  function schemaShape(): Record<string, unknown> {
    const shape: Record<string, unknown> = {};
    for (const [name, factory] of Object.entries(factories)) {
      shape[name] = JSON.parse(JSON.stringify(factory("/tmp").parameters));
    }
    return shape;
  }

  test("live schemas match the checked-in fixture", () => {
    const fixturePath = join(here, "fixtures", "builtin-schemas.snapshot.json");
    const live = schemaShape();
    // Update deliberately: PI_UPDATE_SCHEMA_SNAPSHOT=1 pnpm test
    if (process.env.PI_UPDATE_SCHEMA_SNAPSHOT) {
      writeFileSync(fixturePath, `${JSON.stringify(live, null, 2)}\n`);
    }
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
    expect(live).toEqual(fixture);
  });

  test("no wrapped built-in schema contains a regex `pattern` keyword", () => {
    // A JSON-schema `pattern` keyword is a string regex; the grep/find field
    // literally named "pattern" is a property whose value is an object, so
    // flagging only string-valued `pattern` keys correctly ignores it.
    const offenders: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          walk(item, `${path}[${i}]`);
        });
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "pattern" && typeof value === "string") {
          offenders.push(`${path}.pattern`);
        }
        walk(value, `${path}.${key}`);
      }
    };
    walk(schemaShape(), "schemas");
    expect(offenders).toEqual([]);
  });
});

describe("verified-version canary (research.md re-verification checklist)", () => {
  test("installed pi-coding-agent minor version matches VERIFIED_PI_VERSION", () => {
    const pkgPath = join(
      process.cwd(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    );
    const installed = JSON.parse(readFileSync(pkgPath, "utf-8"))
      .version as string;
    const minor = installed.split(".").slice(0, 2).join(".");
    expect(
      minor,
      `Installed pi-coding-agent ${installed} differs in minor version from ` +
        `VERIFIED_PI_VERSION ${VERIFIED_PI_VERSION}. Work through the ` +
        `re-verification checklist in docs/research.md, update the constant and ` +
        `the schema snapshot, then commit deliberately.`,
    ).toBe(VERIFIED_PI_VERSION);
  });
});
