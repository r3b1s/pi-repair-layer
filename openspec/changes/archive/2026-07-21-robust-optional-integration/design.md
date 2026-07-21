## Context

The optional-integration recipe lets a tool-owning extension depend on `@r3b1s/pi-repair-layer` optionally: it dynamically imports `@r3b1s/pi-repair-layer/pi`, and on failure discriminates "package genuinely absent" (fall back to the raw tool definition) from every other error (rethrow). The discrimination is deliberately narrow because a *present-but-broken* install — the package resolves but its own `typebox` runtime dependency does not — throws the same `MODULE_NOT_FOUND` / `ERR_MODULE_NOT_FOUND` codes, and swallowing that would silently run tools unwrapped while the user believes repairs are active.

The recipe discriminated with a bare substring test, `message.includes("@r3b1s/pi-repair-layer")`. The jiti/require and compiled-binary error shapes (Claim 11 in `docs/research.md`) carry the importer *path*, e.g. `Cannot find module 'typebox/value' from '.../node_modules/@r3b1s/pi-repair-layer/dist/src/pipeline.js'`. That message names the missing *transitive* module (`typebox/value`) yet contains `@r3b1s/pi-repair-layer` as a path segment — so the bare substring test misclassified it as "absent."

## Goals / Non-Goals

**Goals:**
- Make the absence matcher immune to the package name appearing as a `node_modules` path segment, so a present-but-broken install rethrows (loud) instead of being misread as absence.
- Express the classification as a discrete, unit-testable predicate.
- Keep the recipe copy-compatible for existing consumers; no breaking change; fixture, snippet, and spec in lockstep.

**Non-Goals:**
- Making the `/pi` entry dependency-free (bundling typebox). Evaluated and dropped — see Decision 2.
- The loader shim package (Roadmap item C).
- Changing repair behavior, the adapter API surface, or the pipeline internals.

## Decisions

### Decision 1: Match the package name as a quoted module specifier

Change the recipe's absence predicate from `message.includes("@r3b1s/pi-repair-layer")` to match the name only where it appears as an imported specifier: an opening quote immediately followed by the name — `message.includes("'@r3b1s/pi-repair-layer")`.

- **No trailing quote.** All three documented shapes render the missing module in single quotes, but jiti and the compiled binary name the *full subpath* (`'@r3b1s/pi-repair-layer/pi'`) while native ESM names the *bare package* (`'@r3b1s/pi-repair-layer'`). Both begin with quote-then-name; a trailing-quote match (`'@r3b1s/pi-repair-layer'`) would fail to match the subpath form and rethrow a genuine absence. So the match is opening-quote + name only.
- **Why this excludes path segments.** In a path-bearing message the importer path is quoted as a whole (`from '/…/node_modules/@r3b1s/pi-repair-layer/…'`); the character after the opening quote is `/` (or a drive letter), never `@r3b1s`. So the package name inside a path segment is never immediately preceded by a quote and cannot match.
- **Keep the code gate.** `(code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND")` remains the first gate; the quoted-name test is the discriminator.
- **Extract for testability.** Lift the predicate into an exported `isRepairPackageAbsent(error)` so a unit test can feed it synthetic error shapes. vitest cannot force a dynamic `import()` to reject with an arbitrary error (a throwing mock factory is wrapped in vitest's own diagnostic), so the pure predicate is the testable seam.

### Decision 2: Rely on the precise matcher; do not make the `/pi` entry dependency-free

The `/pi` chain has exactly one third-party runtime import, `typebox/value`. Eliminating it (so a missing transitive dep is impossible) was considered via `bundledDependencies`, but that mechanism is rejected by pnpm's isolated node-linker — `pnpm publish` errors with `ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED` — and this repo both installs isolated and publishes with `pnpm publish` (and steers away from npm via `scripts/bin/npm`/`npx` shims). The workarounds each cost more than they save:

- **`nodeLinker: hoisted`** — one line, but switches the whole repo off pnpm's strict isolated linking (reintroducing phantom-dependency risk), against the grain of a deliberately strict setup; the hoisted reinstall was also pathologically slow in testing.
- **Publish via npm** — splits the toolchain and fights the repo's pnpm-only shims.
- **esbuild bundling** — robust and mechanism-independent, but adds a bundler to an intentionally `tsc`-only build.

Decisive point: once Decision 1 lands, a present-but-broken install (`typebox` missing) already surfaces **correctly** — the matcher returns "not absent," the recipe rethrows, and the failure is loud at extension load. That is the exact behavior the discrimination always intended. Making the entry dependency-free would only convert a loud-and-correct failure into a can't-happen; it is a robustness nicety, not a correctness requirement. Deferred to the roadmap.

## Risks / Trade-offs

- **[A genuinely broken pi-repair-layer install fails the consumer's extension load]** → this is intended and correct: it is loud and diagnosable, strictly better than silently running unwrapped. Documented in the guide's caveats.
- **[Quote-form assumptions across loaders]** → the opening-quote + name match is validated against all three documented shapes (jiti, native ESM, compiled binary) by the predicate unit test; a future loader change is caught by re-verifying Claim 11.
- **[Snippet/fixture divergence]** → the doc snippet and `test/fixtures/optional-consumer.ts` are edited together; the existing "keep in sync" note flags this and the smoke test exercises the fixture.
