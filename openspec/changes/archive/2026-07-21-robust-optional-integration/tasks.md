## 1. Robust absence matcher

- [x] 1.1 In `test/fixtures/optional-consumer.ts`, extract the absence classification into an exported `isRepairPackageAbsent` predicate and change the match from the bare substring to the opening-quoted specifier `'@r3b1s/pi-repair-layer` (no trailing quote — the jiti/binary absence error names the `/pi` subpath); keep the `code` gate unchanged
- [x] 1.2 Update the recipe snippet in `docs/tool-owner-integration.md` to match the fixture exactly (quoted-specifier match + extracted predicate), keeping snippet and fixture in sync

## 2. Docs

- [x] 2.1 Rewrite the "Discriminate before falling back" bullet in `docs/tool-owner-integration.md`: explain the opening-quoted match and why a `node_modules` path segment no longer reads as absence; keep the point that a present-but-broken install rethrows loudly (now actually achieved)
- [x] 2.2 Update the "Absence detection semantics" bullet in the "Stability contract for optional consumers" section: state that the matcher keys on the quoted specifier `'@r3b1s/pi-repair-layer` rather than a bare substring
- [x] 2.3 Update `docs/research.md` Claim 11 "why it matters" to record the quoted-specifier refinement and the path-segment false-positive it prevents (with pi version + verification date per the research.md convention)

## 3. Tests

- [x] 3.1 Add a unit test that invokes the exported predicate with a synthetic path-bearing transitive-missing error (`Cannot find module 'typebox/value' from '.../node_modules/@r3b1s/pi-repair-layer/...'`, code `MODULE_NOT_FOUND`) and asserts it is NOT absent, plus the native-ESM bare-package and jiti/binary full-subpath shapes asserting they ARE absent
- [x] 3.2 Run `pnpm run test`, `pnpm run test:package`, `pnpm run lint`, and `pnpm run check`; confirm both optional-consumer branches still pass

## 4. Spec sync

- [ ] 4.1 After implementation is verified, run the OpenSpec sync so the modified `optional-integration` delta lands in `openspec/specs/`
