/**
 * Display settings for the repair layer, persisted at
 * ~/.pi/agent/tool-repair/settings.json and edited via /repair-settings.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface RepairDisplaySettings {
	/** Append a `🔨 ✓ input repaired (...)` line to repaired tool calls in the TUI. */
	showIndicator: boolean;
	/** Also show the repair note text beneath the indicator. */
	showNotes: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: RepairDisplaySettings = {
	showIndicator: true,
	showNotes: false,
};

export function displaySettingsPath(): string {
	return process.env.PI_TOOL_REPAIR_SETTINGS ?? join(getAgentDir(), "tool-repair", "settings.json");
}

export function loadDisplaySettings(path = displaySettingsPath()): RepairDisplaySettings {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return {
			showIndicator:
				typeof parsed.showIndicator === "boolean" ? parsed.showIndicator : DEFAULT_DISPLAY_SETTINGS.showIndicator,
			showNotes: typeof parsed.showNotes === "boolean" ? parsed.showNotes : DEFAULT_DISPLAY_SETTINGS.showNotes,
		};
	} catch {
		return { ...DEFAULT_DISPLAY_SETTINGS };
	}
}

export function saveDisplaySettings(settings: RepairDisplaySettings, path = displaySettingsPath()): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(settings, null, "\t")}\n`);
	} catch {
		// Settings persistence must never break the session.
	}
}
