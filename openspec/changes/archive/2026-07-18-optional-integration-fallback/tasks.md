## 1. Research record

- [x] 1.1 Add entries to `docs/research.md` for the verified claims: shared per-scope npm install project (`pi-extensions` package.json, flat node_modules sibling resolution), jiti missing-module error shape (`Error` with `code: "MODULE_NOT_FOUND"`; native ESM `ERR_MODULE_NOT_FOUND`), git-install/scope resolution boundaries, and unknown-preprocessor-kind fallthrough in `applyPreprocessors` — each with pi version (0.80.6 baseline), verification date, and re-verification checklist steps
- [x] 1.2 Run the Bun-binary end-to-end probe: a throwaway extension implementing the recipe, loaded once by a compiled pi binary with the package absent and once with it npm-installed; record both outcomes (error code observed, branch taken) in `docs/research.md`

## 2. Documentation

- [x] 2.1 Write the "Optional integration" section in `docs/tool-owner-integration.md`: hardened recipe (dynamic import, dual error-code + specifier discrimination, rethrow otherwise, identity fallback, one-line stderr note), consumer `package.json` shape (devDependencies + optional peer), and repair options authored as pure data with a type-only `satisfies` check
- [x] 2.2 Document both adoption paths (shared-node_modules end-user opt-in first, `optionalDependencies` second) and the caveats: git-install/scope asymmetry, fallback restores pi's native coercion baseline, no double-wrap with the installable extension
- [x] 2.3 Document the optional-consumer stability contract: stable subpath names and `adaptToolDefinition` signature (referencing the existing compatibility contract) plus the unknown-preprocessor-kind-ignored degradation guarantee
- [x] 2.4 Extend the guide's "Test the integration" checklist with both-branch items: fallback branch registers the raw definition and emits the note; valid input behaves identically in both branches
- [x] 2.5 Position optionality early in the guide (brief mention in the install/intro section pointing to the optional-integration section) so standalone-extension authors see it before committing to a hard dependency
- [x] 2.6 Add a table of contents to `docs/tool-owner-integration.md` covering all top-level sections
- [x] 2.7 Add a table of contents to `README.md` covering all top-level sections

## 3. Fixture and smoke coverage

- [x] 3.1 Add `test/fixtures/optional-consumer.ts` implementing the documented recipe verbatim (typechecks via type-only imports; exports a marker of which branch was taken for test assertion)
- [x] 3.2 Extend `scripts/package-smoke.mjs` with an absent-package scenario: run the optional-consumer fixture in a clean project without the tarball installed; assert fallback branch, emitted note, successful registration of the raw definition
- [x] 3.3 Extend the smoke test present-package scenario to run the same fixture with the tarball installed; assert adapter branch and no fallback note
- [x] 3.4 Add a unit test pinning unknown-preprocessor-kind fallthrough in `applyPreprocessors` (unknown kind alongside a recognized one: no mutation, no error, no claimed change, schema-validated result) so the new spec guarantee is enforced by CI

## 4. Verification

- [x] 4.1 Run `pnpm run check`, `pnpm run lint`, `pnpm test`, and `pnpm run test:package`; confirm all pass
- [x] 4.2 Verify docs render: TOC anchors resolve in both documents; recipe snippet compiles as written (fixture and doc snippet stay in sync)
