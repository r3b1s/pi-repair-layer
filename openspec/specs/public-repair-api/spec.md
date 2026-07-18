# public-repair-api

## Purpose

Provide stable compiled entry points for pure repair, pi tool-owner integration, and grammar parsing without source-level imports.

## Requirements

### Requirement: Stable compiled npm subpath exports
The package SHALL publish compiled ESM JavaScript, TypeScript declarations, and source maps for documented `core`, `pi`, and `grammar` subpath exports while retaining the installable extension entry point. Published consumers SHALL NOT need to deep-import `src/` files or execute TypeScript source.

#### Scenario: Clean consumer imports every public entry point
- **WHEN** the packed npm artifact is installed into an otherwise clean Node project
- **THEN** the project can import the extension entry point and each documented subpath with matching TypeScript declarations

### Requirement: Pure repair core
The `core` entry point SHALL expose the repair pipeline, envelope normalizer, policy/configuration types, structured outcome types, and repair-note formatter without registering pi events, writing files, emitting telemetry, accessing UI, making network calls, or importing extension-global state. Consumers MAY supply observation and final-outcome callbacks, but the core SHALL treat those callbacks as best-effort reporting and SHALL NOT choose or own their storage.

#### Scenario: Core repair runs without a pi session
- **WHEN** a Node consumer imports `core` and repairs input using a supplied schema and configuration
- **THEN** it receives a structured result without constructing an ExtensionAPI or causing external side effects

#### Scenario: Consumer receives one final outcome
- **WHEN** a consumer supplies a final-outcome callback for a core repair
- **THEN** the core invokes it once with the returned structured result, and a callback failure does not change the repair verdict

### Requirement: Explicit pi tool-owner adapter
The `pi` entry point SHALL expose an adapter that wraps only a tool definition explicitly supplied by its owner, chains that tool's compatibility shim, and integrates the public repair pipeline before pi validation. It SHALL NOT claim or attempt to discover and wrap tools owned by other extensions.

#### Scenario: Custom extension opts into repair
- **WHEN** a custom extension passes its own tool definition and repair configuration to the adapter
- **THEN** the returned definition can be registered by that extension and malformed arguments traverse the configured pipeline

### Requirement: Graceful degradation across version skew
The preprocessing pipeline SHALL ignore configured preprocessor entries whose `kind` it does not recognize — applying no mutation, raising no error, and recording no change for them — and the final result SHALL still be validated against the supplied schema. This behavior is a compatibility guarantee: a consumer configured against a newer options shape SHALL degrade to the recognized subset when running against an older installed version of the package.

#### Scenario: Unknown preprocessor kind is ignored
- **WHEN** a repair configuration includes a preprocessor entry whose `kind` the installed version does not implement, alongside recognized entries
- **THEN** the recognized entries apply, the unknown entry produces no mutation, error, or claimed change, and the result must still pass schema validation

#### Scenario: Skewed consumer stays functional
- **WHEN** a consumer built against a newer minor version of the options types runs with an older installed package
- **THEN** repair proceeds using the subset of configuration the installed version recognizes, without throwing at configuration time

### Requirement: Public API compatibility contract
Documented exports and result/config types SHALL follow semantic versioning, SHALL be covered by compile-time and runtime API tests, and SHALL retain a compatibility facade for the existing `repairToolInput` API throughout the current major version.

#### Scenario: Internal refactor does not break consumer fixture
- **WHEN** internal modules are reorganized without a major version change
- **THEN** the checked-in public-consumer fixture continues to typecheck and run through documented subpaths
