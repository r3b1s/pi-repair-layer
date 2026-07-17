## 1. Characterize Current Contracts

- [x] 1.1 Add characterization tests for current repair ordering, strict-valid fast returns, notes, telemetry, settings migration inputs, and unrepairable fail-closed behavior.
- [x] 1.2 Add pi loop tripwires for global `tool_result` replacement, error-result preservation, custom-tool visibility, and multiple-handler composition.
- [x] 1.3 Add renderer tests at 40, 58, 66, 80, and 120 columns that assert every repair-added line stays within the supplied visible width.

## 2. Establish the Pure Pipeline Core

- [x] 2.1 Define public pipeline configuration, policy, stage-tagged change, structured verdict, and value-free observation types without pi or extension-global dependencies.
- [x] 2.2 Refactor the engine behind one ordered pipeline while retaining `repairToolInput` as a behavior-compatible facade for the current major version.
- [x] 2.3 Implement deterministic cloning, stable rule IDs, mutation-note coverage, final strict/native validation, and explicit fail-closed unrepairable verdicts.
- [x] 2.4 Add unit tests proving ordering, no caller mutation, deterministic/idempotent results, valid-input preservation, and final validity for every repaired verdict.

## 3. Add Bounded Envelope Recovery

- [x] 3.1 Implement byte, depth, decode-attempt, candidate, and work limits plus prototype-safe plain-object handling.
- [x] 3.2 Implement bounded double-encoded object decoding, raw JSON-string control-character escaping, and singleton plain-object-array unwrapping.
- [x] 3.3 Implement allowlisted truncated-object completion for adaptive/recover policies, accepting a candidate only after downstream schema validation.
- [x] 3.4 Add example and boundary tests proving unrecoverable input stays unrepaired, never becomes `{}`, and cannot trigger prototype mutation or unbounded work.

## 4. Make Preprocessing Schema and Selector Guided

- [x] 4.1 Introduce documented object-location selectors with array wildcards and semantic field kinds for filesystem paths, path arrays, globs, string-or-array fields, scalar coercions, aliases, and structural folds.
- [x] 4.2 Migrate built-in repair tables to selectors and add a current-major compatibility adapter for the existing `ToolRepairConfig` shape.
- [x] 4.3 Run exact configured optional aliases before the strict-valid fast return, with selector-local compatibility guards and no fuzzy or generic unknown-field repair.
- [x] 4.4 Fix alias collision handling so a non-empty alias replaces an empty canonical value only when schema/config declares empty equivalent to missing.
- [x] 4.5 Convert markdown-path cleanup, anchor bleed, and grammar-token cleanup into configurable path-scoped preprocessors while preserving regex-field exemptions.
- [x] 4.6 Add tests for nested array selectors, optional aliases that otherwise validate, empty canonical values, JSON-looking content preservation, and unconfigured-key preservation.

## 5. Add Policy Profiles and Grammar Observation

- [x] 5.1 Implement `conservative`, `adaptive`, and `recover` profiles with the transform boundaries specified in the design.
- [x] 5.2 Add grammar `observe` behavior and value-free message-channel observations without changing assistant content, stop reason, or tool calls.
- [x] 5.3 Preserve unknown/disallowed-tool grammar text in every built-in profile and add an explicit persisted `unknownGrammarText: preserve | strip` override that can never promote the call.
- [x] 5.4 Update grammar recovery to consume policy decisions while retaining role, allowed-tool, non-empty-arguments, existing-call, code-fence, and `stopReason === "stop"` gates.
- [x] 5.5 Migrate legacy settings in memory to behavior-equivalent profiles, defer rewriting until the next settings save, and retain old telemetry readability.
- [x] 5.6 Add a compact profile matrix to `/repair-settings` and tests covering every profile, override, legacy settings shape, and unknown-tool outcome.

## 6. Unify Notes, Results, Telemetry, and UI

- [x] 6.1 Implement bounded pending repair queues keyed by tool plus deterministic prepared-argument serialization, with FIFO matching, caps, TTLs, and session cleanup.
- [x] 6.2 Correlate validated pending repairs to call IDs in `tool_call`, and directly correlate grammar-recovered calls at promotion time.
- [x] 6.3 Attach deduplicated `<repair_note>` feedback through global `tool_result` while preserving original content, details, and error status for built-in and custom tools.
- [x] 6.4 Remove execute wrappers used only for note delivery and retain render wrappers only for width-safe TUI decoration and persisted session indicators.
- [x] 6.5 Extend local telemetry with profile, stage, stable rule IDs, and observations while ensuring records, fingerprints, and session metadata contain no argument values or value-bearing notes.
- [x] 6.6 Add lifecycle tests for success/error results, recovered custom tools, duplicate prevention, identical concurrent calls, stale cleanup, handler composition, and reload/resume indicators.

## 7. Publish a Supported Library API

- [x] 7.1 Split pure core, grammar utilities, and pi adapter modules so importing `core` performs no event registration, filesystem, UI, telemetry, network, or extension-global work.
- [x] 7.2 Implement the pi tool-owner adapter that wraps only an explicitly supplied definition and chains its compatibility shim before validation.
- [x] 7.3 Add the build pipeline and package exports for compiled ESM JavaScript, declarations, and source maps at the extension entry point plus `/core`, `/pi`, and `/grammar`.
- [x] 7.4 Add runtime and compile-time consumer fixtures for documented exports and the current-major `repairToolInput` compatibility facade.
- [x] 7.5 Add a clean temporary-consumer smoke test that packs, installs, imports, typechecks, and exercises every public npm subpath.

## 8. Strengthen Fuzzing, Research, and Documentation

- [x] 8.1 Select and configure a deterministic property-testing approach with a bounded CI campaign, a larger local campaign, printed replay seeds, and minimized failures.
- [x] 8.2 Add generated invariant coverage for JSON-domain inputs, malformed envelopes, prototype-looking keys, limits, note coverage, telemetry privacy, and configured-versus-unconfigured content.
- [x] 8.3 Promote every confirmed fuzz failure to a named regression fixture and document the exact seed replay command.
- [x] 8.4 Update `docs/research.md` with verified `tool_result` mechanics, handler composition, package/runtime assumptions, source citations, verification date, and upgrade checklist.
- [x] 8.5 Update the README/API guide with the pipeline, public exports, tool-owner boundary, concise glossary additions, profile matrix, migration behavior, and corrected unrepairable-input limitations.
- [x] 8.6 Run typecheck, lint, full tests, chaos harness, packed-package smoke test, narrow-width suite, bounded fuzz suite, and OpenSpec validation; record any environment-only skips.

Validation record (2026-07-17): typecheck, lint, 105-test suite, chaos harness, packed clean-consumer import/typecheck, narrow-width coverage, bounded seeded fuzz, and OpenSpec validation passed. No environment-only skips.
