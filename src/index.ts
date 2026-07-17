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
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type MinimalAssistantMessage,
  modelLeaksGrammar,
  recoverGrammarLeaks,
} from "./grammar-recovery.ts";
import {
  attachRepairNotes,
  type RepairFeedback,
  RepairLifecycle,
} from "./lifecycle.ts";
import { runRepairPipeline } from "./pipeline.ts";
import {
  loadDisplaySettings,
  type RepairDisplaySettings,
  saveDisplaySettings,
} from "./settings.ts";
import { PIPELINE_PREPROCESSORS, REPAIR_CONFIGS } from "./tables.ts";
import type { RepairPipelineResult } from "./types.ts";

const BUILTIN_FACTORIES = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
} as const;

const REPAIR_ENTRY_TYPE = "tool-repair";
type RepairInfo = RepairFeedback;

interface TelemetryRecord {
  ts: string;
  /** Present on the tool channel; absent on the message channel. */
  tool?: string;
  model: string | undefined;
  outcome: "repaired" | "unrepairable" | "recovered" | "stripped" | "observed";
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
  profile?: string;
  stages?: string[];
  /** Value-free detection/decision metadata. */
  observation?: boolean;
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
  info: RepairInfo | undefined;
  theme: { fg?: (color: string, text: string) => string } | undefined;
  settings: RepairDisplaySettings | undefined;

  render(width: number): string[] {
    const lines = this.inner?.render(width) ?? [];
    if (!this.info || !this.settings?.showIndicator) return lines;
    const muted = (text: string) => {
      try {
        return this.theme?.fg ? this.theme.fg("muted", text) : text;
      } catch {
        return text;
      }
    };
    const added = wrapTextWithAnsi(
      muted(`🔨 ✓ input repaired (${this.info.rules.join(", ")})`),
      width,
    );
    if (this.settings.showNotes) {
      for (const note of this.info.notes) {
        added.push(...wrapTextWithAnsi(muted(`   ↳ ${note}`), width));
      }
    }
    return [...lines, ...added];
  }
}

export default function toolRepairExtension(pi: ExtensionAPI) {
  let currentModelId: string | undefined;
  let registeredCwd: string | undefined;
  const displaySettings: RepairDisplaySettings = loadDisplaySettings();
  const lifecycle = new RepairLifecycle();
  const repairInfoByCallId = new Map<string, RepairInfo>();

  const stashRepair = (
    tool: string,
    args: unknown,
    rules: string[],
    notes: string[],
    stages?: string[],
    fingerprint?: string,
  ) => {
    lifecycle.enqueue(tool, args, {
      rules,
      notes,
      stages,
      profile: displaySettings.policyProfile,
      model: currentModelId,
      outcome: "repaired",
      fingerprint,
    });
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

  const diag = (tool: string, result: RepairPipelineResult) => {
    if (!diagnosticsEnabled()) return;
    const rules =
      result.changes.length > 0
        ? [...new Set(result.changes.map((change) => change.ruleId))].join(",")
        : "none";
    process.stderr.write(
      `[pi-repair] tool=${tool} outcome=${result.outcome} rules=${rules}${
        result.issueSummary ? ` issues=${result.issueSummary}` : ""
      }\n`,
    );
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
          const result = runRepairPipeline({
            input: raw,
            config: {
              toolName: name,
              schema: original.parameters,
              policy: displaySettings.policyProfile,
              modelId: currentModelId,
              ownerPrepareArguments: originalPrepare,
              preprocessors: PIPELINE_PREPROCESSORS[name],
              legacyConfig: config,
              onObservation(observation) {
                logTelemetry({
                  ts: new Date().toISOString(),
                  tool: name,
                  model: currentModelId,
                  outcome: "observed",
                  rules: [observation.ruleId],
                  channel: "tool",
                  profile: displaySettings.policyProfile,
                  stages: [observation.stage],
                  observation: true,
                });
              },
            },
          });
          if (result.outcome === "valid") return result.args;
          diag(name, result);
          const rules = [
            ...new Set(result.changes.map((change) => change.ruleId)),
          ];
          const notes = result.changes.map((change) => change.note);
          const stages = [
            ...new Set(result.changes.map((change) => change.stage)),
          ];
          logTelemetry({
            ts: new Date().toISOString(),
            tool: name,
            model: currentModelId,
            outcome: result.outcome,
            rules,
            issues: result.issueSummary,
            fingerprint: result.fingerprint,
            profile: result.policy,
            stages,
          });
          if (result.outcome === "repaired") {
            stashRepair(
              name,
              result.args,
              rules,
              notes,
              stages,
              result.fingerprint,
            );
            return result.args;
          }
          // Unrepairable. Raise a model-readable retry error: pi's loop turns
          // it into an error tool result. Passing the input through instead
          // would let Value.Convert coerce it (null -> "null") and execute.
          if (result.retryMessage && !passthroughEnabled()) {
            throw new Error(result.retryMessage);
          }
          return raw;
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
                wrapper.info = info;
                wrapper.theme = theme;
                wrapper.settings = displaySettings;
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
            notes: [],
            stages: Array.isArray(e.data.stages) ? e.data.stages : [],
            profile:
              typeof e.data.profile === "string" ? e.data.profile : undefined,
            model: typeof e.data.model === "string" ? e.data.model : undefined,
            outcome:
              e.data.outcome === "repaired" || e.data.outcome === "recovered"
                ? e.data.outcome
                : undefined,
            fingerprint:
              typeof e.data.fingerprint === "string"
                ? e.data.fingerprint
                : undefined,
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

  pi.on("tool_call", async (event) => {
    const repair = lifecycle.correlate(
      event.toolName,
      event.input,
      event.toolCallId,
    );
    if (!repair) return undefined;
    repairInfoByCallId.set(event.toolCallId, repair);
    try {
      pi.appendEntry(REPAIR_ENTRY_TYPE, {
        toolCallId: event.toolCallId,
        tool: event.toolName,
        rules: repair.rules,
        stages: repair.stages,
        profile: repair.profile,
        model: repair.model,
        outcome: repair.outcome,
        fingerprint: repair.fingerprint,
      });
    } catch {
      // Persistence is best-effort and intentionally excludes values/notes.
    }
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    const repair = lifecycle.take(event.toolCallId);
    if (!repair || repair.notes.length === 0) return undefined;
    return {
      content: attachRepairNotes(event.content, repair.notes),
    };
  });

  pi.on("session_shutdown", async () => {
    lifecycle.clear();
    repairInfoByCallId.clear();
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
      unknownToolText: displaySettings.unknownGrammarText,
    });
    if (!result.changed) {
      if (result.observed) {
        logTelemetry({
          ts: new Date().toISOString(),
          model: currentModelId,
          outcome: "observed",
          rules: ["grammarObserve"],
          channel: "message",
          grammar: result.detectedGrammars.join(",") || undefined,
          profile: displaySettings.policyProfile,
          stages: ["grammar"],
          observation: true,
        });
      }
      return undefined;
    }

    if (result.promoted) {
      // Tool-keyed telemetry plus direct call-ID association lets the global
      // result hook annotate built-in and cooperating custom-tool calls.
      for (const [index, call] of result.recoveredCalls.entries()) {
        const note = `Recovered a leaked ${call.grammar} tool call for "${call.name}" that the model printed as text instead of emitting a real tool call. Emit a proper tool call next time.`;
        const callId = result.promotedCallIds[index];
        if (callId) {
          const feedback: RepairFeedback = {
            rules: [`grammarRecovery:${call.grammar}`],
            notes: [note],
            stages: ["grammar"],
            profile: displaySettings.policyProfile,
            model: currentModelId,
            outcome: "recovered",
          };
          lifecycle.associate(callId, feedback);
          repairInfoByCallId.set(callId, feedback);
          try {
            pi.appendEntry(REPAIR_ENTRY_TYPE, {
              toolCallId: callId,
              tool: call.name,
              rules: feedback.rules,
              stages: feedback.stages,
              profile: feedback.profile,
              model: feedback.model,
              outcome: feedback.outcome,
            });
          } catch {
            // Persistence is best-effort and intentionally excludes values/notes.
          }
        }
        logTelemetry({
          ts: new Date().toISOString(),
          tool: call.name,
          model: currentModelId,
          outcome: "recovered",
          rules: [`grammarRecovery:${call.grammar}`],
          grammar: call.grammar,
          profile: displaySettings.policyProfile,
          stages: ["grammar"],
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
        profile: displaySettings.policyProfile,
        stages: ["grammar"],
      });
    }

    // The replacement keeps the original assistant role; pi types the message
    // as its own AgentMessage union, so hand it back through `any`.
    return { message: result.message as any };
  });

  const nextGrammarMode = (mode: RepairDisplaySettings["grammarRecovery"]) =>
    mode === "off"
      ? "observe"
      : mode === "observe"
        ? "strip"
        : mode === "strip"
          ? "recover"
          : "off";

  const nextProfile = (profile: RepairDisplaySettings["policyProfile"]) =>
    profile === "conservative"
      ? "adaptive"
      : profile === "adaptive"
        ? "recover"
        : "conservative";

  pi.registerCommand("repair-settings", {
    description:
      "Toggle the tool-repair indicator (🔨), repair-note display, and grammar recovery",
    handler: async (_args, ctx) => {
      for (;;) {
        const profileLabel = `Policy profile: ${displaySettings.policyProfile} — conservative (observe) | adaptive (strip) | recover (promote)`;
        const indicatorLabel = `Repair indicator (🔨 ✓): ${displaySettings.showIndicator ? "on" : "off"} — toggle`;
        const notesLabel = `Repair note text beneath indicator: ${displaySettings.showNotes ? "on" : "off"} — toggle`;
        const grammarLabel = `Grammar override: ${displaySettings.grammarRecovery} — cycle (off → observe → strip → recover)`;
        const unknownLabel = `Unknown-tool grammar text: ${displaySettings.unknownGrammarText} — never executable`;
        const choice = await ctx.ui.select("Tool repair display settings", [
          profileLabel,
          indicatorLabel,
          notesLabel,
          grammarLabel,
          unknownLabel,
          "Close",
        ]);
        if (choice === undefined || choice === "Close") break;
        if (choice === profileLabel) {
          displaySettings.policyProfile = nextProfile(
            displaySettings.policyProfile,
          );
          displaySettings.grammarRecovery =
            displaySettings.policyProfile === "conservative"
              ? "observe"
              : displaySettings.policyProfile === "recover"
                ? "recover"
                : "strip";
        }
        if (choice === indicatorLabel)
          displaySettings.showIndicator = !displaySettings.showIndicator;
        if (choice === notesLabel)
          displaySettings.showNotes = !displaySettings.showNotes;
        if (choice === grammarLabel)
          displaySettings.grammarRecovery = nextGrammarMode(
            displaySettings.grammarRecovery,
          );
        if (choice === unknownLabel)
          displaySettings.unknownGrammarText =
            displaySettings.unknownGrammarText === "preserve"
              ? "strip"
              : "preserve";
        saveDisplaySettings(displaySettings);
      }
      ctx.ui.notify(
        `Repair display: indicator ${displaySettings.showIndicator ? "on" : "off"}, notes ${
          displaySettings.showNotes ? "on" : "off"
        }, policy ${displaySettings.policyProfile}, grammar ${displaySettings.grammarRecovery}, unknown text ${displaySettings.unknownGrammarText} (applies from now on)`,
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
