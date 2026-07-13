/**
 * Display settings for the repair layer, persisted at
 * ~/.pi/agent/tool-repair/settings.json and edited via /repair-settings.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Grammar-leak recovery mode:
 *  - "off": never touch assistant text.
 *  - "strip": remove leaked tool-call grammar from text (model-gated), but never
 *    promote it to an executable call. This is the default.
 *  - "recover": additionally promote leaked calls to real toolCalls that execute
 *    in the same turn. Opt-in, because it promotes model text into execution.
 */
export type GrammarRecoveryMode = "off" | "strip" | "recover";

export interface RepairDisplaySettings {
  /** Append a `🔨 ✓ input repaired (...)` line to repaired tool calls in the TUI. */
  showIndicator: boolean;
  /** Also show the repair note text beneath the indicator. */
  showNotes: boolean;
  /** Grammar-leak recovery mode. Default "strip" (still subject to the model gate). */
  grammarRecovery: GrammarRecoveryMode;
  /**
   * Optional allowlist of tool names a leaked call may be promoted to. When
   * empty, the active tool set is used (a leaked call is only promoted when its
   * name is a currently-registered tool).
   */
  grammarAllowedTools: string[];
}

export const DEFAULT_DISPLAY_SETTINGS: RepairDisplaySettings = {
  showIndicator: true,
  showNotes: false,
  grammarRecovery: "strip",
  grammarAllowedTools: [],
};

const GRAMMAR_MODES: GrammarRecoveryMode[] = ["off", "strip", "recover"];

function isGrammarMode(value: unknown): value is GrammarRecoveryMode {
  return (
    typeof value === "string" && (GRAMMAR_MODES as string[]).includes(value)
  );
}

export function displaySettingsPath(): string {
  return (
    process.env.PI_TOOL_REPAIR_SETTINGS ??
    join(getAgentDir(), "tool-repair", "settings.json")
  );
}

export function loadDisplaySettings(
  path = displaySettingsPath(),
): RepairDisplaySettings {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return {
      showIndicator:
        typeof parsed.showIndicator === "boolean"
          ? parsed.showIndicator
          : DEFAULT_DISPLAY_SETTINGS.showIndicator,
      showNotes:
        typeof parsed.showNotes === "boolean"
          ? parsed.showNotes
          : DEFAULT_DISPLAY_SETTINGS.showNotes,
      grammarRecovery: isGrammarMode(parsed.grammarRecovery)
        ? parsed.grammarRecovery
        : DEFAULT_DISPLAY_SETTINGS.grammarRecovery,
      grammarAllowedTools:
        Array.isArray(parsed.grammarAllowedTools) &&
        parsed.grammarAllowedTools.every((t: unknown) => typeof t === "string")
          ? parsed.grammarAllowedTools
          : [...DEFAULT_DISPLAY_SETTINGS.grammarAllowedTools],
    };
  } catch {
    return { ...DEFAULT_DISPLAY_SETTINGS };
  }
}

export function saveDisplaySettings(
  settings: RepairDisplaySettings,
  path = displaySettingsPath(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(settings, null, "\t")}\n`);
  } catch {
    // Settings persistence must never break the session.
  }
}
