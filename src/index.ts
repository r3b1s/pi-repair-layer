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
import { type RepairResult, repairToolInput } from "./repair-engine.ts";
import {
  loadDisplaySettings,
  type RepairDisplaySettings,
  saveDisplaySettings,
} from "./settings.ts";
import { REPAIR_CONFIGS } from "./tables.ts";

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
  tool: string;
  model: string | undefined;
  outcome: "repaired" | "unrepairable";
  rules: string[];
  issues: string | undefined;
  fingerprint: string | undefined;
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
          const result = repairToolInput({
            toolName: name,
            schema: original.parameters,
            input: shimmed,
            config,
          });
          if (result.outcome === "valid") return shimmed;
          diag(name, result);
          logTelemetry({
            ts: new Date().toISOString(),
            tool: name,
            model: currentModelId,
            outcome: result.outcome,
            rules: result.rulesFired,
            issues: result.issueSummary,
            fingerprint: result.fingerprint,
          });
          if (result.outcome === "repaired") {
            stashRepair(
              name,
              JSON.stringify(result.args),
              result.rulesFired,
              result.notes,
            );
            return result.args;
          }
          // Unrepairable. Raise a model-readable retry error: pi's loop turns
          // it into an error tool result. Passing the input through instead
          // would let Value.Convert coerce it (null -> "null") and execute.
          if (result.retryMessage && !passthroughEnabled()) {
            throw new Error(result.retryMessage);
          }
          return shimmed;
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

  pi.registerCommand("repair-settings", {
    description:
      "Toggle the tool-repair indicator (🔨) and repair-note display",
    handler: async (_args, ctx) => {
      for (;;) {
        const indicatorLabel = `Repair indicator (🔨 ✓): ${displaySettings.showIndicator ? "on" : "off"} — toggle`;
        const notesLabel = `Repair note text beneath indicator: ${displaySettings.showNotes ? "on" : "off"} — toggle`;
        const choice = await ctx.ui.select("Tool repair display settings", [
          indicatorLabel,
          notesLabel,
          "Close",
        ]);
        if (choice === undefined || choice === "Close") break;
        if (choice === indicatorLabel)
          displaySettings.showIndicator = !displaySettings.showIndicator;
        if (choice === notesLabel)
          displaySettings.showNotes = !displaySettings.showNotes;
        saveDisplaySettings(displaySettings);
      }
      ctx.ui.notify(
        `Repair display: indicator ${displaySettings.showIndicator ? "on" : "off"}, notes ${
          displaySettings.showNotes ? "on" : "off"
        } (applies to tool calls rendered from now on)`,
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
      const byTool = new Map<
        string,
        { repaired: number; unrepairable: number }
      >();
      const byRule = new Map<string, number>();
      const byModel = new Map<
        string,
        { repaired: number; unrepairable: number }
      >();
      for (const record of records) {
        const tool = byTool.get(record.tool) ?? {
          repaired: 0,
          unrepairable: 0,
        };
        tool[record.outcome] += 1;
        byTool.set(record.tool, tool);
        const model = byModel.get(record.model ?? "unknown") ?? {
          repaired: 0,
          unrepairable: 0,
        };
        model[record.outcome] += 1;
        byModel.set(record.model ?? "unknown", model);
        for (const rule of record.rules)
          byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      }
      const lines = [
        `Tool repair telemetry (${records.length} events)`,
        "",
        "By tool:",
      ];
      for (const [tool, counts] of [...byTool].sort(
        (a, b) => b[1].repaired - a[1].repaired,
      )) {
        lines.push(
          `  ${tool}: ${counts.repaired} repaired, ${counts.unrepairable} unrepairable`,
        );
      }
      lines.push("", "By model:");
      for (const [model, counts] of [...byModel].sort(
        (a, b) => b[1].repaired - a[1].repaired,
      )) {
        lines.push(
          `  ${model}: ${counts.repaired} repaired, ${counts.unrepairable} unrepairable`,
        );
      }
      lines.push("", "Rules fired:");
      for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${rule}: ${count}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
