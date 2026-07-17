## Context

The extension currently repairs pi's seven built-in tools by overriding their definitions, chaining each built-in `prepareArguments`, running a TypeBox-based validate/repair engine, wrapping `execute` to attach model-facing notes, and wrapping `renderResult` for a TUI indicator. Separate modules handle valid-but-corrupted value strips and assistant-text grammar recovery. These mechanisms work, but their ordering, safety level, reporting, and public reuse are implicit.

Pi's loop imposes two hard constraints. First, only a tool owner's `prepareArguments` runs before validation; one extension cannot automatically repair another extension's invalid custom-tool input. Second, pi's post-execution `tool_result` event can replace any built-in or custom tool's result content, which is a better global seam for attaching already-computed feedback. The npm package currently ships TypeScript internals without a stable `exports` contract, so consumers can deep-import the engine but cannot rely on that path or API across releases.

This change makes the safety boundaries explicit and exposes the repair machinery for voluntary use by tool-owning extensions. It does not attempt to register CommandCode tools or make claims pi's API cannot support.

## Goals / Non-Goals

**Goals:**

- Establish one ordered, bounded repair pipeline with structured changes and one final validity decision.
- Recover common malformed envelopes without guessing missing argument values or executing unvalidated repairs.
- Repair exact configured aliases and field shapes even when pi's permissive schemas would otherwise accept the wrong optional key.
- Separate lossless/schema-guided behavior from model heuristics and execution recovery through named policy profiles.
- Deliver repair notes consistently by tool-call ID through `tool_result`, including grammar-recovered custom tools.
- Publish a documented, compiled, typed npm API usable by other pi extensions that own their tools.
- Enforce safety as invariants across generated inputs, reproducible fuzz cases, lifecycle tests, and narrow terminal widths.
- Preserve existing installations and telemetry/settings data through explicit migration.

**Non-Goals:**

- Registering or emulating CommandCode's `diagnostics` tool or any provider/IDE-specific executor.
- Automatically intercepting another extension's arguments before validation; pi has no such middleware API today.
- Fuzzy field-name matching, generic removal of unknown fields, or turning unrecoverable input into `{}`.
- Making grammar promotion the default or promoting calls outside the known/allowed active tool set.
- Uploading inputs or telemetry, or including argument values in local telemetry.

## Decisions

### D1. One pipeline owns ordering and produces structured changes

The pipeline order is:

1. raw-envelope recovery;
2. tool-owner compatibility shim (`prepareArguments`, when supplied);
3. configured path-scoped preprocessing;
4. model/policy-gated valid-value transforms;
5. strict schema validation;
6. bounded structural and iterative issue repair;
7. final native conversion/check; and
8. a structured verdict containing stage-tagged changes and model-facing notes.

Envelope recovery runs before the owner shim so a shim can see an object that was merely encoded incorrectly. An unparseable bare string is preserved for later root-string repair rather than discarded. Every mutation records a stable rule ID, stage, and note. A `repaired` verdict is impossible unless the final value validates.

Alternative considered: keep independent preprocess/engine/grammar entry points wired in the extension. Rejected because consumers would reproduce ordering and reporting differently, and safety profiles could not describe the whole operation.

### D2. Envelope recovery is conservative, bounded, and fail-closed

The envelope module accepts JSON-domain input and attempts only configured operations: plain-object pass-through, recursively encoded JSON object decoding with a small depth cap, raw-control-character escaping inside JSON strings, singleton-plain-object-array unwrapping, and an allowlisted set of truncated-object closing suffixes. Truncated completion is available only in adaptive/recover policies and succeeds only when the candidate passes the downstream schema.

The module limits input bytes, nesting depth, decode attempts, candidates, and elapsed work. Failed recovery returns the original input and an explicit non-success verdict; it never substitutes `{}`. Objects are constructed/cloned without allowing prototype mutation.

Alternative considered: port CommandCode's complete permissive normalizer, including non-object-to-`{}` coercion. Rejected because all-optional tools could execute defaults after information was discarded, which conflicts with a local side-effecting tool layer's fail-closed posture.

### D3. Preprocessors use explicit schema locations, not global key heuristics

Configuration addresses fields with JSON-Pointer-like selectors plus an array wildcard, for example `/path`, `/files/*`, and `/edits/*/oldText`. Semantic transform kinds distinguish filesystem paths, filesystem-path arrays, glob strings, string-or-array fields, scalar coercions, aliases, and structural folds. The public names will not overload “path” to mean both a filesystem path and an object location.

Exact alias preprocessing runs before the strict-valid fast path. It may move an alias only when the selector and alias are configured, the canonical field is absent/undefined, or the canonical value is empty and the schema/config declares empty equivalent to missing. Both values must satisfy the configured compatibility guard. Unknown keys are otherwise retained.

Existing built-in tables are migrated internally to the selector representation. A compatibility adapter may accept the old `ToolRepairConfig` shape for one major version, but the new selector form is the documented API.

Alternative considered: fuzzy edit-distance matching of unknown keys. Rejected because optional extra keys are common and a false positive can redirect a path or command.

### D4. Policies select safety classes; small explicit overrides remain

Three profiles select coherent behavior:

- `conservative`: lossless envelope operations, exact configured preprocessing, strict/schema-guided repair, fail-closed verdicts, and grammar detection without text mutation.
- `adaptive`: conservative behavior plus schema-validated truncated-envelope completion, model-gated value strips, and stripping of recognized grammar for known tools.
- `recover`: adaptive behavior plus grammar promotion under the existing role, known-tool, empty-arguments, existing-call, and `stopReason === "stop"` gates.

For backward compatibility, existing settings without a profile migrate to `adaptive`; an existing `grammarRecovery: "recover"` migrates to `recover`. New installs also retain `adaptive` as the default in this change, avoiding an unannounced behavior reversal. A future major version may reconsider the default using observe-mode telemetry.

Unknown-tool grammar text is preserved by all built-in profiles. A dedicated `unknownGrammarText: "preserve" | "strip"` override permits stripping only after explicit user choice. Grammar also gains `observe`, which records recognized candidates without changing text or creating calls.

Alternative considered: dozens of independent rule toggles. Rejected because combinations become difficult to explain, test, migrate, and support.

### D5. The library API is pure at its core and explicit at pi boundaries

The published package retains its extension entry point and adds explicit compiled ESM subpaths:

- `@r3b1s/pi-repair-layer/core` — pipeline, envelope, policies, result/config types, note formatting;
- `@r3b1s/pi-repair-layer/pi` — tool-owner adapter and pi lifecycle helpers; and
- `@r3b1s/pi-repair-layer/grammar` — pure grammar detection/recovery utilities.

Build output includes JavaScript, declarations, and source maps. Pi and TypeBox remain external/peer-compatible rather than bundled into a second runtime copy. The pure core performs no filesystem writes, event registration, UI work, telemetry, or network access. Consumers receive structured outcomes and decide how to report them. The existing `repairToolInput` behavior remains available as a compatibility facade during the current major version.

The pi adapter wraps only definitions passed to it by the tool owner. It chains the owner's shim and returns a definition suitable for `registerTool`; it never scans or replaces tools registered by other extensions.

Alternative considered: expose internal source paths as the API. Rejected because internal refactors would become accidental breaking changes and ordinary Node consumers cannot rely on TypeScript-source execution.

### D6. Notes move through call-ID correlation and `tool_result`

`prepareArguments` still lacks a tool-call ID, so repaired built-in calls enter a bounded pending queue keyed by tool plus deterministic argument serialization. A global `tool_call` handler, which runs after successful validation, consumes the matching pending record and associates it with `toolCallId`. A global `tool_result` handler prepends notes to the returned text content for both successful and error results, then clears the association.

Grammar recovery creates tool-call IDs itself and can associate notes immediately, including for active custom tools. This fixes the current case where a custom recovered call executes but its note remains in the built-in-only stash. Notes are inserted once even if another layer already included the same tagged note. TTLs, queue caps, session shutdown cleanup, and collision tests bound state.

Built-in definitions retain render wrappers only for TUI decoration; they no longer need execute wrappers solely for notes. Every appended indicator/note line passes through pi's ANSI-aware wrapping helper at the requested width. Session entries continue to restore indicators after reload/resume.

Alternative considered: keep execute wrappers. Rejected because they cannot attach recovery feedback to custom tools and couple result delivery to each wrapped executor.

### D7. Telemetry records decisions, never values

Telemetry gains pipeline stage, policy profile, and stable rule IDs while retaining backward readability. It records failure shapes/fingerprints but never raw input, repaired values, paths, commands, or note text containing values. Observe-only grammar detections use the message channel. Public-core consumers receive an optional outcome callback; the core does not choose a storage path.

### D8. Safety properties are executable invariants

The test suite combines example tests with property-based generators and deterministic seeded fuzzing. The envelope/pipeline invariants include: no throw/hang on bounded JSON-domain input, no caller mutation, determinism, idempotence, valid-input preservation, final validity for repaired outcomes, fail-closed behavior, bounded work, no unconfigured content parsing, prototype safety, note coverage for every mutation, and value-free telemetry.

Fuzz failures print the seed and minimized input; confirmed failures become named regression fixtures. Lifecycle tests cover built-in and custom result notes, duplicate prevention, error results, concurrent identical calls, and cleanup. Rendering tests use 40/58/66/80/120 columns and assert every line's visible width is within the supplied width.

## Risks / Trade-offs

- **[Pipeline refactor changes subtle ordering]** → Lock current behavior in characterization tests before moving code; implement phase-by-phase with compatibility facades.
- **[Alias preprocessing mutates inputs that previously passed]** → Require explicit selectors/aliases, canonical absence or declared-empty semantics, compatibility checks, notes, and profile-controlled reporting.
- **[Truncated JSON completion can infer the wrong closing shape]** → Allowlist suffixes, cap candidates, restrict to adaptive/recover, require final schema validity, and preserve fail-closed fallback.
- **[Policy migration surprises existing users]** → Map current settings to behavior-equivalent profiles and test every legacy settings shape.
- **[`tool_call` correlation can collide for identical concurrent arguments]** → Use FIFO queues per deterministic key, tool-call IDs after validation, caps/TTLs, and concurrency tests.
- **[`tool_result` handlers compose with other extensions]** → Return only replaced content, preserve details/error state, deduplicate tagged notes, and add ordering/composition tests against multiple handlers.
- **[Compiled exports create packaging complexity]** → Add a packed-tarball smoke test that imports every subpath from a clean temporary consumer.
- **[Property fuzzing becomes slow or flaky]** → Use deterministic seeds, bounded generators, a small CI budget, and a separate larger local fuzz command.

## Migration Plan

1. Add characterization, width, lifecycle, and settings-migration tests before refactoring behavior.
2. Introduce structured outcomes, envelope recovery, selectors, and policies behind compatibility facades; keep the current extension wiring functional.
3. Move built-in integration to the pipeline and call-ID/result lifecycle, then remove execute wrappers used only for notes.
4. Add compiled subpath exports and verify the packed npm artifact in an isolated consumer.
5. Migrate persisted settings in memory on load and save the new shape only after a user changes settings; continue reading old telemetry records.
6. Update research/docs and run the full CI, chaos harness, packed-package test, and targeted narrow-width/fuzz suites before release.

Rollback is a package-version downgrade. Settings readers remain tolerant of new keys, and no destructive telemetry migration occurs.

## Open Questions

- Whether the larger local fuzz campaign should use the same property-testing dependency as CI or a small repository-owned deterministic generator. The specs require reproducible seeds, not a particular library.
- Whether the compatibility facade for the old config/result types is removed in the next major version or retained longer based on actual external adoption.
