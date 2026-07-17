## Why

pi-repair-layer has grown from a small built-in alias repair into several useful but separately wired mechanisms: strict schema repair, model-gated value cleanup, grammar-leak recovery, notes, telemetry, and TUI feedback. It now needs one explicit, reusable pipeline so those mechanisms have consistent safety policies, can be tested as a whole, and can be consumed through a supported npm API by tool-owning extensions without duplicating the engine.

## What Changes

- Refactor repair into named, bounded phases: conservative raw-envelope recovery, the tool owner's compatibility shim, configured preprocessing, strict validation, iterative schema-guided repair, final validation/conversion, and result feedback.
- Add fail-closed envelope recovery for double-encoded JSON objects, raw control characters in JSON strings, and singleton object arrays; permit narrowly bounded truncated-object completion only when final validation succeeds. Never replace unrecoverable input with `{}`.
- Add path-scoped configurable preprocessors for exact aliases (including optional aliases that otherwise pass validation), string-or-array fields, scalar coercions, filesystem paths, filesystem-path arrays, glob fields, and tool-specific structural folds. Do not use fuzzy alias matching or generic unknown-field deletion.
- Fix alias semantics so a configured non-empty alias may replace an empty canonical value only when the schema/config declares that empty value invalid or equivalent to missing.
- Introduce coherent `conservative`, `adaptive`, and `recover` policy profiles, plus grammar observation that records detections without modifying assistant text. Unknown-tool grammar text is preserved by conservative behavior and may only be stripped under an explicit policy.
- Replace ad-hoc result-note delivery with call-id correlation and pi's global `tool_result` result-mutation hook, so recovered custom-tool calls can receive feedback even though this extension cannot repair another extension's arguments pre-validation.
- Publish compiled JavaScript, TypeScript declarations, and explicit npm subpath exports for the pure repair core, pi tool-owner adapters, and pure grammar utilities. Deep internal imports cease to be the integration contract.
- Add property-based and reproducible seeded-fuzz coverage for the raw-envelope parser and pipeline invariants; add narrow-terminal rendering tests and lifecycle tests for built-in and custom-tool results.
- Correct current contract drift, including unknown-tool grammar behavior, unrepairable-input documentation, and research coverage for `tool_result` propagation.
- Explicitly exclude CommandCode's IDE `diagnostics` tool, automatic interception of other extensions' tools, arbitrary garbage-to-`{}` coercion, and provider-specific tool executors.

## Capabilities

### New Capabilities

- `public-repair-api`: Stable compiled npm entry points and typed APIs for the pure repair core, grammar utilities, policy/configuration types, and pi tool-owner adapters.
- `envelope-recovery`: Conservative, bounded, fail-closed recovery of malformed raw tool-argument envelopes before schema repair.
- `schema-guided-preprocessing`: Path-scoped exact-alias and field preprocessor configuration, including optional aliases and safe empty-canonical replacement.
- `repair-policy-profiles`: Named safety profiles that select lossless, schema-guided, heuristic, and executable-recovery behavior without a toggle for every rule.
- `repair-result-lifecycle`: Tool-call-id correlation, global `tool_result` note attachment, telemetry/persistence integration, and width-safe TUI feedback.
- `repair-safety-invariants`: Always-true safety properties enforced with unit, property-based, seeded-fuzz, lifecycle, and narrow-width tests.

### Modified Capabilities

- `grammar-leak-recovery`: Add observe-only behavior, policy-controlled handling of unknown-tool text, and result-note delivery that also works for promoted custom tools.
- `value-strips`: Make model-gated valid-value mutations selectable through policy profiles while preserving regex-field exemptions and transparent reporting.
- `upstream-drift-detection`: Add tripwires for the `tool_result` content-replacement semantics used by the new note lifecycle.
- `plain-language-docs`: Document the pipeline stages, safety levels, policy profiles, invariants, and supported npm integration contract in beginner-accessible language.

## Impact

- **Core/source:** `src/repair-engine.ts`, `src/tables.ts`, `src/value-strips.ts`, `src/grammar-recovery.ts`, and new focused core/policy/envelope/adapter modules.
- **Extension integration:** `src/index.ts` changes from execute-wrapped note delivery to event-based call/result correlation while retaining built-in `prepareArguments` overrides.
- **Public package:** `package.json` gains explicit exports and build artifacts; the npm package becomes both an installable pi extension and a supported library. Existing extension installation remains supported.
- **Settings/telemetry:** persisted settings gain policy/observe selections with backward-compatible migration; telemetry gains stage/policy metadata without argument values.
- **Tests/docs/OpenSpec:** expanded safety and API compatibility tests, refreshed research claims, and updated user/integrator documentation.
- **External boundary:** another extension must still opt in and wrap the tools it owns; pi-repair-layer cannot globally repair another extension's invalid arguments under pi's current pre-validation API.
