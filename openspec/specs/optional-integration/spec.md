# optional-integration

## Purpose

Define the documented and tested pattern by which a tool-owning extension integrates the repair adapter as an optional dependency and degrades to its raw tool definition when pi-repair-layer is absent — recipe, adoption paths, caveats, and detection semantics.

## Requirements

### Requirement: Documented optional integration recipe
The tool-owner integration guide SHALL contain an optional-integration section presenting a complete, copyable fallback recipe by which a tool-owning extension attempts a dynamic import of the `pi` subpath and, when the package is absent, registers its unmodified tool definition. The recipe SHALL treat an import failure as "absent" only when the error code is `MODULE_NOT_FOUND` or `ERR_MODULE_NOT_FOUND` **and** the error message names the `@r3b1s/pi-repair-layer` specifier; any other error SHALL be rethrown. The fallback branch SHALL emit a one-line stderr (or debug-channel) note identifying the extension and stating that its tools run unwrapped.

#### Scenario: Package absent
- **WHEN** a consumer following the recipe activates in a pi install where `@r3b1s/pi-repair-layer` is not resolvable
- **THEN** the extension registers its raw tool definition, emits the single fallback note, and activation succeeds

#### Scenario: Package present
- **WHEN** the same consumer activates in an install where the package is resolvable
- **THEN** the extension registers the adapted definition and no fallback note is emitted

#### Scenario: Broken install is not misread as absent
- **WHEN** the dynamic import fails with a module-not-found error naming a different (transitive) module
- **THEN** the recipe rethrows instead of silently registering the unwrapped definition

### Requirement: Documented adoption paths and caveats
The optional-integration section SHALL document both adoption paths — end-user opt-in via pi's shared npm install root (presented first) and author-controlled `optionalDependencies` — and SHALL state as explicit caveats: that git-installed extensions and installs in a different pi scope do not resolve the npm-installed sibling; that under the compiled (Bun-binary) pi distribution the dynamic import cannot resolve npm-installed siblings, so the recipe falls back safely even when the package is installed and the pattern activates only under Node-based pi installs; that fallback mode restores pi's native argument coercion behavior rather than merely disabling repairs; and that no double-wrapping can occur because the installable extension only overrides pi's built-in tools.

#### Scenario: Author evaluates degraded behavior
- **WHEN** an extension author reads the optional-integration section to decide whether fallback is acceptable for their tool
- **THEN** the section states that in fallback mode invalid input may be natively coerced by pi rather than repaired or rejected, and directs the author to test both branches

#### Scenario: Author diagnoses a non-resolving sibling
- **WHEN** an author's git-installed extension fails to resolve an npm-installed pi-repair-layer
- **THEN** the documented scope/source asymmetry caveat explains why and names `optionalDependencies` as the alternative

#### Scenario: Compiled-binary user sees safe fallback
- **WHEN** a consumer following the recipe activates under the standalone compiled pi binary with the package npm-installed
- **THEN** the import failure has the absent-package shape, the consumer falls back to its raw definition with the note, and the documented caveat explains that the pattern activates only under Node-based pi installs

### Requirement: Documented consumer manifest pattern
The optional-integration section SHALL document the consumer `package.json` shape: `@r3b1s/pi-repair-layer` in `devDependencies` for typechecking, declared under `peerDependencies` with `peerDependenciesMeta` marking it optional, and repair options authored as pure data validated with a type-only import so no runtime import is required for compilation.

#### Scenario: Consumer typechecks without runtime dependency
- **WHEN** a consumer project declares the documented manifest shape and compiles with the package present only in `devDependencies`
- **THEN** the extension typechecks, and its built output activates in an install without the package

### Requirement: Optional-consumer fixture and smoke coverage
The repository SHALL contain an optional-consumer fixture implementing the documented recipe, and the package smoke test SHALL exercise the recipe in a clean project in both states: with the packed package installed (adapter branch taken) and without it (fallback branch taken, fallback note emitted, raw definition registered).

#### Scenario: Smoke test covers the absent branch
- **WHEN** the package smoke test runs the optional-consumer fixture in a clean project without installing the package
- **THEN** the fixture activates successfully, reports the fallback branch, and the run fails if the fallback note is missing or an error escapes

### Requirement: Research-backed loading claims
The mechanical claims the optional pattern relies on — pi's shared per-scope npm install project, jiti's module-not-found error code, git/scope resolution boundaries, and the compiled-binary loading behavior — SHALL be recorded in `docs/research.md` with the verified pi version, date, and a re-verification checklist, and the compiled (Bun-binary) pi build SHALL be probed end-to-end at least once with the result recorded there.

#### Scenario: Claim is auditable after a pi upgrade
- **WHEN** a maintainer upgrades the verified pi baseline
- **THEN** research.md lists the optional-integration claims with a checklist sufficient to re-verify sibling resolution and error-code behavior against the new version
