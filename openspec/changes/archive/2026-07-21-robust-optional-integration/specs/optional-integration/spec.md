## MODIFIED Requirements

### Requirement: Documented optional integration recipe
The tool-owner integration guide SHALL contain an optional-integration section presenting a complete, copyable fallback recipe by which a tool-owning extension attempts a dynamic import of the `pi` subpath and, when the package is absent, registers its unmodified tool definition. The recipe SHALL treat an import failure as "absent" only when the error code is `MODULE_NOT_FOUND` or `ERR_MODULE_NOT_FOUND` **and** the error message names `@r3b1s/pi-repair-layer` as a quoted module specifier — matched as an opening quote immediately followed by the package name (`'@r3b1s/pi-repair-layer`), with no trailing quote so it matches both the bare-package error (`'@r3b1s/pi-repair-layer'`) and the full-subpath error (`'@r3b1s/pi-repair-layer/pi'`) — rather than as a bare substring, so that the package name appearing only as a `node_modules` path segment does not classify a failure as absence; any other error SHALL be rethrown. The recipe SHALL express this classification as a discrete, exported, unit-testable predicate. The fallback branch SHALL emit a one-line stderr (or debug-channel) note identifying the extension and stating that its tools run unwrapped.

#### Scenario: Package absent
- **WHEN** a consumer following the recipe activates in a pi install where `@r3b1s/pi-repair-layer` is not resolvable
- **THEN** the extension registers its raw tool definition, emits the single fallback note, and activation succeeds

#### Scenario: Package present
- **WHEN** the same consumer activates in an install where the package is resolvable
- **THEN** the extension registers the adapted definition and no fallback note is emitted

#### Scenario: Broken install is not misread as absent
- **WHEN** the dynamic import fails with a module-not-found error naming a different (transitive) module
- **THEN** the recipe rethrows instead of silently registering the unwrapped definition

#### Scenario: Path-segment name does not cause a false positive
- **WHEN** the classification predicate is given a module-not-found error whose message names a different missing module but includes `@r3b1s/pi-repair-layer` only as a `node_modules` path segment (e.g. `Cannot find module 'typebox/value' from '.../node_modules/@r3b1s/pi-repair-layer/...'`)
- **THEN** the predicate does not classify the failure as absence and the recipe rethrows

### Requirement: Optional-consumer fixture and smoke coverage
The repository SHALL contain an optional-consumer fixture implementing the documented recipe, and the package smoke test SHALL exercise the recipe in a clean project in both states: with the packed package installed (adapter branch taken) and without it (fallback branch taken, fallback note emitted, raw definition registered). The fixture SHALL express the absence classification as an exported predicate, and the repository SHALL contain a unit test that feeds that predicate the documented module-not-found shapes — including a path-bearing transitive-missing error — and asserts that only genuine package absence is classified as absent.

#### Scenario: Smoke test covers the absent branch
- **WHEN** the package smoke test runs the optional-consumer fixture in a clean project without installing the package
- **THEN** the fixture activates successfully, reports the fallback branch, and the run fails if the fallback note is missing or an error escapes

#### Scenario: Predicate rejects a path-bearing transitive-missing error
- **WHEN** the unit test invokes the exported absence predicate with a synthetic module-not-found error naming a transitive module while embedding `@r3b1s/pi-repair-layer` only as a path segment
- **THEN** the predicate returns that the package is not absent

#### Scenario: Predicate accepts the documented absent-package shapes
- **WHEN** the unit test invokes the exported absence predicate with the native-ESM bare-package error and the jiti/compiled-binary full-subpath error
- **THEN** the predicate returns that the package is absent for each
