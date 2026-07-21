## Why

The optional-integration recipe's absence detection uses a bare substring test (`message.includes("@r3b1s/pi-repair-layer")`), which false-positives when the package name appears as a `node_modules` path segment in a path-bearing error message (jiti and compiled-binary error shapes carry the importer path). A consumer integrating the recipe recently hit exactly this: a *present-but-broken* install — pi-repair-layer resolves but its `typebox` dependency does not — threw an error naming the missing transitive module while embedding pi-repair-layer only as a path segment, and the bare substring misclassified it as "absent," which would silently run tools unwrapped while the user believed repairs were active.

## What Changes

- Harden the absence-detection matcher in the canonical recipe to match the package name only as an **imported module specifier** — an opening quote immediately followed by the name (`'@r3b1s/pi-repair-layer`, no trailing quote so it matches both the bare-package ESM error and the `/pi` subpath error) — rather than a bare substring. A `node_modules/@r3b1s/pi-repair-layer/...` path segment is preceded by `/`, not a quote, so it can no longer read as absence.
- Extract the classification into an exported `isRepairPackageAbsent(error)` predicate so it is directly unit-testable (a dynamic `import()` cannot be forced to reject with an arbitrary error under vitest).
- With the corrected matcher, a present-but-broken install now surfaces **correctly** as a loud rethrow at load rather than a silent fallback — the discrimination the recipe always intended, now actually achieved.
- Update the canonical recipe fixture (`test/fixtures/optional-consumer.ts`), the `docs/tool-owner-integration.md` snippet and caveats, and the `optional-integration` spec accordingly, keeping snippet and fixture in sync.
- Add a matcher unit test proving a path-bearing transitive-missing error is not classified as absent.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `optional-integration`: the documented absence check matches the package name as a quoted module specifier rather than a bare substring; the classification is expressed as an exported, unit-tested predicate; and the fixture/test coverage is extended with the path-segment false-positive case.

## Impact

- **Docs:** `docs/tool-owner-integration.md` recipe snippet, the "Discriminate before falling back" caveat, and the "Absence detection semantics" stability-contract bullet; `docs/research.md` Claim 11 detection-semantics rationale.
- **Tests:** `test/fixtures/optional-consumer.ts` (extracted predicate + corrected matcher), a new matcher unit test.
- **Specs:** modified `optional-integration`.
- **No packaging/build change.** Making the `/pi` entry dependency-free (bundling `typebox`) was evaluated and dropped: it collides with the repo's pnpm isolated node-linker (`pnpm publish` rejects `bundledDependencies`) and the alternatives (repo-wide `nodeLinker: hoisted`, or publishing via npm) run against the repo's strict pnpm-only posture. The corrected matcher makes a broken install fail loudly and correctly, so eliminating the dependency is unnecessary for correctness (recorded as a roadmap consideration, not this change).
- **Consumers:** no breaking change — the recipe stays copy-compatible; the matcher change is strictly more precise.
