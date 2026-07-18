## Why

Extension authors hesitate to adopt the tool-wrapping API (`adaptToolDefinition`) when it forces a hard dependency on pi-repair-layer onto every downstream user of an otherwise standalone extension. Presenting the API as explicitly optional — with a documented, verified fallback to the raw, unwrapped tool definition when the package is absent — removes that adoption barrier and turns "also install pi-repair-layer" into a user opt-in rather than an author-imposed requirement.

Session research confirmed the mechanics this relies on: pi's package manager installs all npm extensions into one shared `node_modules` project (so an end user installing pi-repair-layer makes it resolvable to sibling npm-installed extensions), pi's jiti loader surfaces a missing package as `code: "MODULE_NOT_FOUND"` (plain Node ESM surfaces `ERR_MODULE_NOT_FOUND`), and the preprocessing pipeline already ignores unrecognized preprocessor kinds without error — so a version-skewed consumer degrades safely.

## What Changes

- Add an "Optional integration" section to `docs/tool-owner-integration.md` documenting a hardened dynamic-import fallback recipe:
  - type-only imports plus `devDependencies` for typechecking, optional peer dependency at runtime;
  - catch both `MODULE_NOT_FOUND` (jiti) and `ERR_MODULE_NOT_FOUND` (native ESM), and verify the error names the `@r3b1s/pi-repair-layer` specifier so a present-but-broken install is not silently misread as absent;
  - emit a one-line stderr/debug note when the fallback branch is taken so degraded sessions are debuggable;
  - identity-function fallback that registers the unmodified tool definition.
- Document the two adoption paths: shared-`node_modules` end-user opt-in (the default story) and author-controlled `optionalDependencies`.
- Document the caveats: install-source/scope asymmetry (git-installed extensions and cross-scope installs do not resolve the npm-installed sibling), fallback restores pi's baseline `Value.Convert` coercion behavior (not merely "no repairs"), and no double-wrap is possible (the installable extension only overrides built-in tools).
- Document a stability contract for optional consumers: stable subpath names, stable `adaptToolDefinition` signature, and unknown-preprocessor-kind-ignored degradation as a spec-level guarantee.
- Add a table of contents to `docs/tool-owner-integration.md` and `README.md`.
- Add an optional-consumer test fixture alongside `test/fixtures/public-consumer.ts` and extend the package smoke test to exercise the recipe in a clean project both with and without the package installed.
- Verify the fallback recipe end-to-end under the compiled (Bun-binary) pi build via a throwaway probe extension; record the result in `docs/research.md`.

## Capabilities

### New Capabilities

- `optional-integration`: the documented and tested pattern by which a tool-owning extension integrates the repair adapter as an optional dependency and degrades to its raw tool definition when pi-repair-layer is absent — recipe, adoption paths, caveats, and detection semantics.

### Modified Capabilities

- `public-repair-api`: add a graceful-degradation requirement — unrecognized preprocessor kinds SHALL be ignored (never fatal) and results still schema-validated, promoting existing behavior to a compatibility guarantee optional consumers can rely on across version skew.
- `plain-language-docs`: add a requirement that `README.md` and `docs/tool-owner-integration.md` carry a table of contents once they exceed a screenful, keeping the growing docs navigable.

## Impact

- **Docs**: `docs/tool-owner-integration.md` (new section + TOC), `README.md` (TOC), `docs/research.md` (verified claims: shared npm install root, jiti error codes, Bun-binary probe result).
- **Code**: no runtime source changes required in `src/`; the recipe lives consumer-side. Only if the probe or smoke test reveals a gap would a small contract export (e.g., an API-version constant) be added.
- **Tests**: new `test/fixtures/optional-consumer.ts` fixture; `scripts/package-smoke.mjs` gains an absent-package scenario.
- **Dependencies**: none added. The pattern exists precisely to avoid imposing one.
