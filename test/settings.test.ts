import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_DISPLAY_SETTINGS,
  loadDisplaySettings,
  saveDisplaySettings,
} from "../src/settings.ts";

function settingsFile(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "repair-settings-"));
  const path = join(directory, "settings.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("settings migration", () => {
  test("new installs default to adaptive with unknown grammar preserved", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "repair-settings-")),
      "missing",
    );
    expect(loadDisplaySettings(path)).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  test.each([
    ["off", "adaptive", "off"],
    ["strip", "adaptive", "strip"],
    ["recover", "recover", "recover"],
  ] as const)("legacy grammar mode %s migrates behaviorally", (grammarRecovery, profile, expectedGrammar) => {
    const path = settingsFile({ grammarRecovery });
    const before = readFileSync(path, "utf8");
    expect(loadDisplaySettings(path)).toMatchObject({
      policyProfile: profile,
      grammarRecovery: expectedGrammar,
      unknownGrammarText: "preserve",
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("profile defaults apply when no grammar override is stored", () => {
    expect(
      loadDisplaySettings(settingsFile({ policyProfile: "conservative" })),
    ).toMatchObject({
      policyProfile: "conservative",
      grammarRecovery: "observe",
    });
    expect(
      loadDisplaySettings(settingsFile({ policyProfile: "recover" })),
    ).toMatchObject({ policyProfile: "recover", grammarRecovery: "recover" });
  });

  test("new shape is written only on an explicit save", () => {
    const path = settingsFile({ grammarRecovery: "strip" });
    const loaded = loadDisplaySettings(path);
    saveDisplaySettings(loaded, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      policyProfile: "adaptive",
      unknownGrammarText: "preserve",
    });
  });
});
