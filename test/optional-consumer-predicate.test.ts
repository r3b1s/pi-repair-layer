/**
 * Unit coverage for the optional-integration absence predicate. vitest cannot
 * force a dynamic `import()` to reject with an arbitrary error (a mock factory
 * that throws is wrapped in vitest's own diagnostic), so the classification is
 * extracted into `isRepairPackageAbsent` and tested directly against the
 * documented Node/jiti/Bun error shapes (docs/research.md Claim 11).
 */
import { describe, expect, test } from "vitest";
import { isRepairPackageAbsent } from "./fixtures/optional-consumer.ts";

function moduleNotFound(message: string, code = "MODULE_NOT_FOUND"): Error {
  return Object.assign(new Error(message), { code });
}

describe("isRepairPackageAbsent", () => {
  test("native ESM bare-package shape reads as absent", () => {
    const error = moduleNotFound(
      "Cannot find package '@r3b1s/pi-repair-layer' imported from /app/ext.js",
      "ERR_MODULE_NOT_FOUND",
    );
    expect(isRepairPackageAbsent(error)).toBe(true);
  });

  test("jiti/require full-subpath shape reads as absent", () => {
    const error = moduleNotFound(
      "Cannot find module '@r3b1s/pi-repair-layer/pi'",
    );
    expect(isRepairPackageAbsent(error)).toBe(true);
  });

  test("compiled-binary subpath-with-importer shape reads as absent", () => {
    const error = moduleNotFound(
      "Cannot find module '@r3b1s/pi-repair-layer/pi' from '/app/node_modules/my-ext/dist/index.js'",
      "ERR_MODULE_NOT_FOUND",
    );
    expect(isRepairPackageAbsent(error)).toBe(true);
  });

  test("path-bearing transitive-missing error is NOT absent (the false-positive guard)", () => {
    // pi-repair-layer resolves, but a transitive module it imports does not.
    // The message names the transitive module and embeds pi-repair-layer only
    // as a node_modules path segment — a bare substring match would misread
    // this as absence and silently run tools unwrapped.
    const error = moduleNotFound(
      "Cannot find module 'typebox/value' from '/app/node_modules/@r3b1s/pi-repair-layer/dist/src/pipeline.js'",
    );
    expect(isRepairPackageAbsent(error)).toBe(false);
  });

  test("unrelated error rethrows (not classified absent)", () => {
    expect(isRepairPackageAbsent(new TypeError("boom"))).toBe(false);
  });

  test("matching message without a module-not-found code is not absent", () => {
    const error = Object.assign(
      new Error("Cannot find module '@r3b1s/pi-repair-layer/pi'"),
      { code: "EACCES" },
    );
    expect(isRepairPackageAbsent(error)).toBe(false);
  });
});
