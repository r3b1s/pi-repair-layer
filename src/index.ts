/**
 * pi-repair-layer — tool-input repair for pi's built-in tools.
 *
 * Why this hooks where it does: pi's agent loop runs
 *
 *   tool.prepareArguments(raw) -> validateToolArguments(...) -> tool_call event -> execute
 *
 * A validation failure short-circuits to an error result before the
 * `tool_call` extension event ever fires, so event handlers can never see
 * (let alone repair) malformed input. The only pre-validation seam is
 * `prepareArguments`, which extensions reach by overriding a built-in tool
 * with `pi.registerTool({ same name })`. Each override spreads the original
 * tool definition — renderers, prompt metadata, execution — and replaces only
 * `prepareArguments` (chaining the tool's own shim first) plus thin wrappers
 * around `execute` and `renderResult`.
 *
 * Feedback paths per repaired call:
 *  - Model: `<repair_note>` lines prepended to the tool result content, seen
 *    on the very next inference step of the same agent turn.
 *  - User: a `🔨 ✓ input repaired (...)` line appended to the tool row in the
 *    TUI (plus the note text if enabled) — toggle both via /repair-settings.
 *  - Telemetry: local-only JSONL, summarized by /repair-stats.
 *
 * Unrepairable input (still invalid after repairs) raises a model-readable
 * retry message instead of passing through, because pi's Value.Convert would
 * otherwise coerce it into garbage (null -> "null") and execute it anyway.
 *
 * Env:
 *   PI_TOOL_REPAIR_LOG=1           log repair decisions to stderr
 *   PI_TOOL_REPAIR_TELEMETRY=off   disable telemetry (or =<path> to relocate it)
 *   PI_TOOL_REPAIR_PASSTHROUGH=1   on unrepairable input, defer to pi's native
 *                                  validation instead of raising the retry error
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  getAgentDir,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type MinimalAssistantMessage,
  modelLeaksGrammar,
  recoverGrammarLeaks,
} from "./grammar-recovery.ts";
import { type RepairResult, repairToolInput } from "./repair-engine.ts";
import {
  loadDisplaySettings,
  type RepairDisplaySettings,
  saveDisplaySettings,
} from "./settings.ts";
import { REPAIR_CONFIGS } from "./tables.ts";
import { stripValues } from "./value-strips.ts";

const BUILTIN_FACTORIES = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
} as const;

const NOTE_TTL_MS = 5 * 60 * 1000;
const REPAIR_ENTRY_TYPE = "tool-repair";

interface PendingRepair {
  argsJson: string;
  rules: string[];
  notes: string[];
  ts: number;
}

interface RepairInfo {
  rules: string[];
  notes: string[];
}

interface TelemetryRecord {
  ts: string;
  /** Present on the tool channel; absent on the message channel. */
  tool?: string;
  model: string | undefined;
  outcome: "repaired" | "unrepairable" | "recovered" | "stripped";
  rules: string[];
  issues?: string | undefined;
  fingerprint?: string | undefined;
  /**
   * "tool" (default when absent, for backward-readability of old records) keys
   * on a tool; "message" is for grammar strip-only events that have no tool.
   */
  channel?: "tool" | "message";
  /** Grammar family for recovered/stripped events. */
  grammar?: string;
}

function telemetryPath(): string | undefined {
  const override = process.env.PI_TOOL_REPAIR_TELEMETRY;
  if (override === "off" || override === "0" || override === "false")
    return undefined;
  if (override) return override;
  return join(getAgentDir(), "tool-repair", "telemetry.jsonl");
}

function diagnosticsEnabled(): boolean {
  const value = process.env.PI_TOOL_REPAIR_LOG;
  return (
    value !== undefined && value !== "" && value !== "0" && value !== "false"
  );
}

function passthroughEnabled(): boolean {
  const value = process.env.PI_TOOL_REPAIR_PASSTHROUGH;
  return (
    value !== undefined && value !== "" && value !== "0" && value !== "false"
  );
}

/**
 * Wraps the built-in result component and appends the repair indicator lines.
 * The inner component is threaded back through `context.lastComponent` on
 * re-renders because built-in renderers reuse it (`lastComponent ?? new Text`)
 * without instanceof checks.
 */
class RepairIndicatorComponent {
  inner: { render(width: number): string[] } | undefined;
  extraLines: string[] = [];

  render(width: number): string[] {
    const lines = this.inner?.render(width) ?? [];
    return this.extraLines.length > 0 ? [...lines, ...this.extraLines] : lines;
  }
}

export default function toolRepairExtension(pi: ExtensionAPI) {
  let currentModelId: string | undefined;
  let registeredCwd: string | undefined;
  const displaySettings: RepairDisplaySettings = loadDisplaySettings();
  const pendingRepairs = new Map<string, PendingRepair[]>();
  const repairInfoByCallId = new Map<string, RepairInfo>();

  const stashRepair = (
    tool: string,
    argsJson: string,
    rules: string[],
    notes: string[],
  ) => {
    const queue = pendingRepairs.get(tool) ?? [];
    const now = Date.now();
    const fresh = queue.filter((entry) => now - entry.ts < NOTE_TTL_MS);
    fresh.push({ argsJson, rules, notes, ts: now });
    pendingRepairs.set(tool, fresh);
  };

  const takeRepair = (
    tool: string,
    argsJson: string,
  ): PendingRepair | undefined => {
    const queue = pendingRepairs.get(tool);
    if (!queue) return undefined;
    const index = queue.findIndex((entry) => entry.argsJson === argsJson);
    if (index === -1) return undefined;
    const [entry] = queue.splice(index, 1);
    return entry;
  };

  const logTelemetry = (record: TelemetryRecord) => {
    const path = telemetryPath();
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`);
    } catch {
      // Telemetry must never break tool execution.
    }
  };

  const diag = (tool: string, result: RepairResult) => {
    if (!diagnosticsEnabled()) return;
    const rules =
      result.rulesFired.length > 0 ? result.rulesFired.join(",") : "none";
    process.stderr.write(
      `[pi-repair] tool=${tool} outcome=${result.outcome} rules=${rules}${
        result.issueSummary ? ` issues=${result.issueSummary}` : ""
      }\n`,
    );
  };

  const indicatorLines = (
    info: RepairInfo,
    theme: { fg?: (color: string, text: string) => string },
  ): string[] => {
    if (!displaySettings.showIndicator) return [];
    const muted = (text: string) => {
      try {
        return theme?.fg ? theme.fg("muted", text) : text;
      } catch {
        return text;
      }
    };
    const lines = [muted(`🔨 ✓ input repaired (${info.rules.join(", ")})`)];
    if (displaySettings.showNotes) {
      for (const note of info.notes) lines.push(muted(`   ↳ ${note}`));
    }
    return lines;
  };

  const registerOverrides = (cwd: string) => {
    if (registeredCwd === cwd) return;
    registeredCwd = cwd;
    for (const [name, factory] of Object.entries(BUILTIN_FACTORIES)) {
      const original = factory(cwd) as ToolDefinition<any, any>;
      const config = REPAIR_CONFIGS[name];
      const originalPrepare = original.prepareArguments;
      const originalRenderResult = original.renderResult?.bind(original);

      pi.registerTool({
        ...original,
        prepareArguments(raw: unknown) {
          let shimmed = raw;
          if (originalPrepare) {
            try {
              shimmed = originalPrepare(raw);
            } catch {
              shimmed = raw;
            }
          }
          // Value-strip pre-pass: model-gated strips run before the engine, on
          // input that is valid both before and after (an anchor-bled string
          // still validates as a string), so the engine never sees them.
          const strip = stripValues({
            toolName: name,
            input: shimmed,
            modelId: currentModelId,
          });
          const engineInput = strip.result.changed ? strip.input : shimmed;
          const result = repairToolInput({
            toolName: name,
            schema: original.parameters,
            input: engineInput,
            config,
          });
          if (result.outcome === "valid") {
            // Engine found nothing to fix. If a strip fired, still surface it as
            // a repair; otherwise pass the (untouched) input straight through.
            if (!strip.result.changed) return shimmed;
            logTelemetry({
              ts: new Date().toISOString(),
              tool: name,
              model: currentModelId,
              outcome: "repaired",
              rules: strip.result.rules,
              issues: undefined,
              fingerprint: undefined,
            });
            stashRepair(
              name,
              JSON.stringify(engineInput),
              strip.result.rules,
              strip.result.notes,
            );
            return engineInput;
          }
          diag(name, result);
          logTelemetry({
            ts: new Date().toISOString(),
            tool: name,
            model: currentModelId,
            outcome: result.outcome,
            rules: [...strip.result.rules, ...result.rulesFired],
            issues: result.issueSummary,
            fingerprint: result.fingerprint,
          });
          if (result.outcome === "repaired") {
            stashRepair(
              name,
              JSON.stringify(result.args),
              [...strip.result.rules, ...result.rulesFired],
              [...strip.result.notes, ...result.notes],
            );
            return result.args;
          }
          // Unrepairable. Raise a model-readable retry error: pi's loop turns
          // it into an error tool result. Passing the input through instead
          // would let Value.Convert coerce it (null -> "null") and execute.
          if (result.retryMessage && !passthroughEnabled()) {
            throw new Error(result.retryMessage);
          }
          // Passthrough mode: hand back the stripped input if a strip fired, so
          // its cleanup is not lost when we defer to pi's native validation.
          return engineInput;
        },
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const repair = takeRepair(name, JSON.stringify(params));
          if (repair) {
            repairInfoByCallId.set(toolCallId, {
              rules: repair.rules,
              notes: repair.notes,
            });
            try {
              pi.appendEntry(REPAIR_ENTRY_TYPE, {
                toolCallId,
                tool: name,
                rules: repair.rules,
                notes: repair.notes,
              });
            } catch {
              // Persistence is best-effort; the in-memory map still works.
            }
          }
          const result = await original.execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx,
          );
          if (repair && repair.notes.length > 0) {
            const noteText = repair.notes
              .map((note) => `<repair_note>${note}</repair_note>`)
              .join("\n");
            const first = Array.isArray(result.content)
              ? result.content[0]
              : undefined;
            if (first?.type === "text") {
              first.text = `${noteText}\n${first.text}`;
            } else if (Array.isArray(result.content)) {
              result.content.unshift({ type: "text", text: noteText });
            }
          }
          return result;
        },
        ...(originalRenderResult
          ? {
              renderResult(
                result: any,
                options: any,
                theme: any,
                context: any,
              ) {
                const info = repairInfoByCallId.get(context.toolCallId);
                const last = context.lastComponent;
                const wrapper =
                  last instanceof RepairIndicatorComponent
                    ? last
                    : info
                      ? new RepairIndicatorComponent()
                      : undefined;
                if (!wrapper)
                  return originalRenderResult(result, options, theme, context);
                wrapper.inner = originalRenderResult(result, options, theme, {
                  ...context,
                  lastComponent: wrapper.inner,
                });
                wrapper.extraLines = info ? indicatorLines(info, theme) : [];
                return wrapper as any;
              },
            }
          : {}),
      });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    currentModelId = ctx.model?.id;
    registerOverrides(ctx.cwd);
    // Restore indicators for repairs recorded earlier in this session
    // (survives /reload and session resume).
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        const e = entry as { type?: string; customType?: string; data?: any };
        if (
          e.type === "custom" &&
          e.customType === REPAIR_ENTRY_TYPE &&
          typeof e.data?.toolCallId === "string"
        ) {
          repairInfoByCallId.set(e.data.toolCallId, {
            rules: Array.isArray(e.data.rules) ? e.data.rules : [],
            notes: Array.isArray(e.data.notes) ? e.data.notes : [],
          });
        }
      }
    } catch {
      // Older pi versions may not expose entries here; indicators just start fresh.
    }
  });

  pi.on("model_select", async (event, ctx) => {
    currentModelId =
      (event as { model?: { id?: string } }).model?.id ??
      ctx.model?.id ??
      currentModelId;
  });

  const safeGetActiveTools = (): string[] => {
    try {
      return (
        (pi as { getActiveTools?: () => string[] }).getActiveTools?.() ?? []
      );
    } catch {
      return [];
    }
  };

  // Grammar-leak recovery: on message_end, strip tool-call grammar the model
  // printed as text and — in recover mode — promote it to real toolCalls that
  // execute the same turn (docs/research.md Claim 4). Promotion is gated on
  // stopReason "stop" (Claim 7); stripping is allowed on any stopReason.
  pi.on("message_end", async (event, _ctx) => {
    const mode = displaySettings.grammarRecovery;
    if (mode === "off") return undefined;
    const message = (event as unknown as { message?: MinimalAssistantMessage })
      .message;
    if (message?.role !== "assistant") return undefined;
    if (!modelLeaksGrammar(currentModelId)) return undefined;

    const allowed = displaySettings.grammarAllowedTools;
    const knownTools = new Set(
      allowed.length > 0 ? allowed : safeGetActiveTools(),
    );

    const result = recoverGrammarLeaks(message, {
      mode,
      knownTools,
      requireKnownTool: true,
    });
    if (!result.changed) return undefined;

    if (result.promoted) {
      // Tool-keyed "recovered" telemetry, and a stashed note so the executed
      // (re-entering) built-in call surfaces <repair_note> via the execute wrap.
      for (const call of result.recoveredCalls) {
        const note = `Recovered a leaked ${call.grammar} tool call for "${call.name}" that the model printed as text instead of emitting a real tool call. Emit a proper tool call next time.`;
        stashRepair(
          call.name,
          JSON.stringify(call.arguments),
          [`grammarRecovery:${call.grammar}`],
          [note],
        );
        logTelemetry({
          ts: new Date().toISOString(),
          tool: call.name,
          model: currentModelId,
          outcome: "recovered",
          rules: [`grammarRecovery:${call.grammar}`],
          grammar: call.grammar,
        });
      }
    } else {
      // Strip-only: no tool to key on. One message-channel event naming the
      // grammar families that were stripped.
      logTelemetry({
        ts: new Date().toISOString(),
        model: currentModelId,
        outcome: "stripped",
        rules: ["grammarStrip"],
        channel: "message",
        grammar:
          result.strippedGrammars.length > 0
            ? result.strippedGrammars.join(",")
            : undefined,
      });
    }

    // The replacement keeps the original assistant role; pi types the message
    // as its own AgentMessage union, so hand it back through `any`.
    return { message: result.message as any };
  });

  const nextGrammarMode = (mode: RepairDisplaySettings["grammarRecovery"]) =>
    mode === "off" ? "strip" : mode === "strip" ? "recover" : "off";

  pi.registerCommand("repair-settings", {
    description:
      "Toggle the tool-repair indicator (🔨), repair-note display, and grammar recovery",
    handler: async (_args, ctx) => {
      for (;;) {
        const indicatorLabel = `Repair indicator (🔨 ✓): ${displaySettings.showIndicator ? "on" : "off"} — toggle`;
        const notesLabel = `Repair note text beneath indicator: ${displaySettings.showNotes ? "on" : "off"} — toggle`;
        const grammarLabel = `Grammar-leak recovery: ${displaySettings.grammarRecovery} — cycle (off → strip → recover)`;
        const choice = await ctx.ui.select("Tool repair display settings", [
          indicatorLabel,
          notesLabel,
          grammarLabel,
          "Close",
        ]);
        if (choice === undefined || choice === "Close") break;
        if (choice === indicatorLabel)
          displaySettings.showIndicator = !displaySettings.showIndicator;
        if (choice === notesLabel)
          displaySettings.showNotes = !displaySettings.showNotes;
        if (choice === grammarLabel)
          displaySettings.grammarRecovery = nextGrammarMode(
            displaySettings.grammarRecovery,
          );
        saveDisplaySettings(displaySettings);
      }
      ctx.ui.notify(
        `Repair display: indicator ${displaySettings.showIndicator ? "on" : "off"}, notes ${
          displaySettings.showNotes ? "on" : "off"
        }, grammar recovery ${displaySettings.grammarRecovery} (applies from now on)`,
        "info",
      );
    },
  });

  pi.registerCommand("repair-stats", {
    description: "Summarize tool-input repair telemetry",
    handler: async (_args, ctx) => {
      const path = telemetryPath();
      if (!path || !existsSync(path)) {
        ctx.ui.notify("No repair telemetry recorded yet.", "info");
        return;
      }
      const records: TelemetryRecord[] = [];
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
      }
      if (records.length === 0) {
        ctx.ui.notify("No repair telemetry recorded yet.", "info");
        return;
      }
      type ToolCounts = {
        repaired: number;
        unrepairable: number;
        recovered: number;
      };
      const emptyCounts = (): ToolCounts => ({
        repaired: 0,
        unrepairable: 0,
        recovered: 0,
      });
      const byTool = new Map<string, ToolCounts>();
      const byRule = new Map<string, number>();
      const byModel = new Map<string, ToolCounts>();
      const byGrammar = new Map<string, number>();
      let stripOnlyEvents = 0;
      let toolEvents = 0;

      const bump = (
        counts: ToolCounts,
        outcome: TelemetryRecord["outcome"],
      ) => {
        if (
          outcome === "repaired" ||
          outcome === "unrepairable" ||
          outcome === "recovered"
        )
          counts[outcome] += 1;
      };

      for (const record of records) {
        // Records without an explicit channel are legacy tool-channel repairs.
        if (record.channel === "message") {
          stripOnlyEvents += 1;
          for (const family of (record.grammar ?? "unknown").split(","))
            byGrammar.set(family, (byGrammar.get(family) ?? 0) + 1);
        } else {
          toolEvents += 1;
          const key = record.tool ?? "unknown";
          const tool = byTool.get(key) ?? emptyCounts();
          bump(tool, record.outcome);
          byTool.set(key, tool);
          const model = byModel.get(record.model ?? "unknown") ?? emptyCounts();
          bump(model, record.outcome);
          byModel.set(record.model ?? "unknown", model);
        }
        for (const rule of record.rules)
          byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      }

      const fmt = (c: ToolCounts) =>
        `${c.repaired} repaired, ${c.recovered} recovered, ${c.unrepairable} unrepairable`;
      const lines = [
        `Tool repair telemetry (${records.length} events: ${toolEvents} tool, ${stripOnlyEvents} grammar strip-only)`,
        "",
        "By tool:",
      ];
      for (const [tool, counts] of [...byTool].sort(
        (a, b) =>
          b[1].repaired + b[1].recovered - (a[1].repaired + a[1].recovered),
      )) {
        lines.push(`  ${tool}: ${fmt(counts)}`);
      }
      lines.push("", "By model:");
      for (const [model, counts] of [...byModel].sort(
        (a, b) =>
          b[1].repaired + b[1].recovered - (a[1].repaired + a[1].recovered),
      )) {
        lines.push(`  ${model}: ${fmt(counts)}`);
      }
      if (byGrammar.size > 0) {
        lines.push("", "Grammar strip-only events (message channel):");
        for (const [family, count] of [...byGrammar].sort(
          (a, b) => b[1] - a[1],
        )) {
          lines.push(`  ${family}: ${count}`);
        }
      }
      lines.push("", "Rules fired:");
      for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${rule}: ${count}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
