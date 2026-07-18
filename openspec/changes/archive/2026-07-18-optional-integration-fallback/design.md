## Context

`adaptToolDefinition` (`src/pi.ts`) is a pure decorator: it accepts a `ToolDefinition` and returns a `ToolDefinition` of the same type, so the natural fallback when pi-repair-layer is absent is the identity function. Extension factories are awaited by pi's loader (`await factory(api)`), so an `await import(...)` inside activation is supported.

Empirical facts verified in this session (to be recorded in `docs/research.md` during implementation):

- pi's package manager maintains one private npm project per scope (e.g. `~/.pi/agent/npm/package.json`, name `pi-extensions`) whose dependencies are all npm-installed extensions. Packages are siblings in a flat `node_modules`, so `import("@r3b1s/pi-repair-layer/pi")` from another npm-installed extension's directory resolves. Verified against a live install (bun-backed, `bun.lock` present).
- pi loads extensions through jiti (`moduleCache: false`; in the compiled binary, `tryNative: false` with `virtualModules`). A missing package under jiti throws a plain `Error` with `code: "MODULE_NOT_FOUND"`; native Node ESM throws `ERR_MODULE_NOT_FOUND`.
- `applyPreprocessors` (`src/preprocess.ts`) falls through every branch on an unrecognized `kind`: no mutation, no error, and the pipeline still schema-validates the final result. Version-skewed configs degrade safely today.
- Git-installed extensions get their own `node_modules` (pi runs an install inside the clone), and user/project scopes use separate npm roots — sibling resolution does not cross those boundaries.

## Goals / Non-Goals

**Goals:**

- A copy-pasteable, hardened fallback recipe in `docs/tool-owner-integration.md` that a tool owner can adopt without adding a hard dependency.
- Positioning: optionality presented as a first-class property of the API early in the guide, to soften adoption for authors of standalone extensions.
- A documented compatibility contract optional consumers can rely on: stable subpaths, stable `adaptToolDefinition` signature, unknown-preprocessor-kinds-ignored degradation.
- Both docs navigable via a table of contents.
- The recipe's two failure-sensitive claims (module-not-found discrimination; absent-package degradation) covered by the package smoke test; the Bun-binary path verified once empirically.

**Non-Goals:**

- No runtime changes to `src/` in this change. The recipe lives consumer-side; the contract promotes existing behavior to a guarantee rather than adding code.
- No shim/micro package (`pi-repair-optional`): it would reintroduce the dependency the pattern exists to avoid. Revisit only on demonstrated demand.
- No discovery or wrapping of other extensions' tools (unchanged ownership boundary).
- No API-version constant or capability probe yet — unknown-kind fallthrough plus schema validation makes skew safe without one. Add later only if a skew-sensitive feature demands it.

## Decisions

1. **Docs recipe + documented contract, not a helper export.** A helper cannot live in pi-repair-layer (it must run when the package is absent), and a separate micro-package contradicts the goal. The recipe is ~15 lines; the value pi-repair-layer adds is the *contract* that makes those 15 lines safe to write once.

2. **Detection = dynamic import with discriminating catch.** Match `error.code` against both `"MODULE_NOT_FOUND"` (jiti) and `"ERR_MODULE_NOT_FOUND"` (native ESM), and require the message to name the `@r3b1s/pi-repair-layer` specifier. Rationale: a broken pi-repair-layer install (its own transitive dep missing) also throws MODULE_NOT_FOUND but names the *transitive* module — swallowing it would silently disable repairs while the user believes they are active. Non-matching errors rethrow.

3. **Fallback branch logs one stderr line** (e.g. `"[my-extension] @r3b1s/pi-repair-layer not found; <tool> running unwrapped"`). Rationale: the two branches differ in coercion behavior (see risk below); a silent divergence is undiagnosable from a session transcript.

4. **Types via `devDependencies` + optional peer dependency.** `import type` is erased at compile time; repair options are pure data (`satisfies PiToolOwnerAdapterOptions`), so consumers typecheck without a runtime dependency. Documented `package.json` shape: `devDependencies` entry plus `peerDependencies` + `peerDependenciesMeta { optional: true }`.

5. **Document both adoption paths, shared-node_modules first.** The end-user opt-in story (installing pi-repair-layer for built-in repairs also lights up consenting extensions) is the default narrative; `optionalDependencies` is the author-controlled alternative. The scope/source asymmetry is stated as a hard caveat, not fine print, because it leans on pi's managed-install layout, which is observed behavior rather than a pi API guarantee.

6. **Contract additions land in specs, not code.** `public-repair-api` gains the unknown-kind-ignored requirement (behavior already exists in `applyPreprocessors`; the change is promising it). Subpath and signature stability are already covered by the existing compatibility-contract requirement; the new capability spec references rather than duplicates them.

7. **Verification split.** The absent-package and broken-install discrimination cases go into `scripts/package-smoke.mjs` (clean-project scenarios, cheap to run in CI). The Bun-binary end-to-end check is a one-time manual probe with a throwaway extension against a real pi binary, recorded as a claim in `docs/research.md` with version and date — matching the repo's existing research-citation convention — because CI cannot reasonably host a pi binary session.

## Risks / Trade-offs

- [Shared npm root is undocumented pi behavior] → Record it in `docs/research.md` with pi version and re-verification checklist (the repo's `upstream-drift-detection` convention); the recipe itself never depends on it — resolution either succeeds or falls back, so a future pi layout change degrades gracefully rather than breaking.
- [Fallback restores pi's native `Value.Convert` coercion — the silent-garbage behavior this project exists to prevent] → Documented as an explicit warning: degraded mode is *baseline pi*, not "repair minus notes." Consumers are told to test both branches; checklist items added to the guide's testing section.
- [Catch-all-adjacent error handling can mask real failures] → Mitigated by decision 2 (code + specifier match, rethrow otherwise) and decision 3 (stderr note); the smoke test pins both behaviors.
- [Bun-binary behavior verified once, not continuously] → Acceptable: the mechanism (jiti filesystem resolution) is identical to the tested Node path; the research.md entry carries a re-verification step for pi upgrades.
- [Recipe duplication drift: consumers copy the snippet and never update it] → The contract is deliberately minimal (subpaths, signature, error codes, degradation), so old copies stay correct; anything stronger would need the shim package we chose not to build.

## Open Questions

- None blocking. If the Bun-binary probe fails (unexpected), the fallback recipe still behaves safely (falls back with a logged note); the fix would land as a follow-up contract adjustment, not a redesign.
