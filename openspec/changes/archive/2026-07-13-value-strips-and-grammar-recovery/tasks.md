# Tasks: value-strips-and-grammar-recovery

Ordering follows the design's migration plan: pin the ground truth first
(research doc + drift tests), then value strips, then grammar recovery, then README.

## 1. Ground truth: research doc and upstream-drift tests

- [x] 1.1 Write `docs/research.md`: claim-by-claim verification table (loop ordering, validateToolArguments throw semantics, tool_call propagation/in-place nuance, message_end in-place replacement + awaited listeners + role guard, before_provider_request propagation, stopReason "error" terminal, stopReason "length" toolCall failure, no regex `pattern` in built-in schemas), each with pi 0.80.6 source citations (file:line), verification date 2026-07-13, and a re-verification checklist for pi upgrades
- [x] 1.2 Reduce HANDOFF.md to a pointer at `docs/research.md` (correct §2's "inert for built-ins" nuance — upstream's in-place anchor strip does propagate — as part of the move)
- [x] 1.3 Create `test/upstream-drift.test.ts` scaffold driving the installed pi in-process (reuse the harness approach from `test/extension.test.ts`)
- [x] 1.4 Add ordering tripwire: prepareArguments receives raw failing input; tool_call handler never fires for a validation-failing call
- [x] 1.5 Add propagation tripwires: in-place `event.input` mutation reaches execute, reassignment does not; message_end same-role replacement's toolCall executes same-turn
- [x] 1.6 Add built-in schema-shape snapshot fixture + test for all wrapped tools, including the no-regex-`pattern` assertion
- [x] 1.7 Add length-protection assertion: stopReason "length" toolCalls are failed by pi, not executed
- [x] 1.8 Add `VERIFIED_PI_VERSION` constant and minor-version canary test (patch bumps pass; failure message names the research.md checklist)

## 2. Value-strip pre-pass

- [x] 2.1 Create `src/value-strips.ts` with model-gate regexes (anchor bleed: kimi-k2/minimax/glm; grammar tokens: glm) and provenance header noting adaptation from pi-tool-repair (MIT)
- [x] 2.2 Implement anchor-bleed strip (recursive over strings/arrays/objects) with the regex-field skip-list (`grep.pattern`)
- [x] 2.3 Implement grammar-token-leak strip for keys and values (recursive), `<arg_key>`/`<arg_value>` families
- [x] 2.4 Wire the pre-pass at the top of the `prepareArguments` override in `src/index.ts`, before the repair engine, emitting per-strip rule identifiers through `stashRepair` and `logTelemetry`
- [x] 2.5 Unit tests: path strip on gated model, no-op on ungated model, grep.pattern exemption (with sibling field still stripped), grammar-token key/value strip, strip-then-engine-repair combined note

## 3. Grammar-leak recovery

- [x] 3.1 Create `src/grammar-recovery.ts` adapted in place from `~/Local/ext-clones/pi-tool-repair/src/grammar-repair.ts` (one-line provenance header; keep grammar-family parsers, candidate selection, code-fence awareness, removeRanges)
- [x] 3.2 Preserve upstream safety gates: assistant-role only, known-tool allowlist, empty-args skip, strip-only when real toolCalls already present, strip/recover modes
- [x] 3.3 Add the stopReason gate: promotion only when original stopReason is "stop"; stripping permitted regardless; never overwrite "length"/"error"/"aborted"
- [x] 3.4 Extend `src/settings.ts` with `grammarRecovery: "off" | "strip" | "recover"` (default "strip") and optional allowed-tools list; surface in `/repair-settings`
- [x] 3.5 Register the `message_end` handler in `toolRepairExtension(pi)`, honoring settings mode and model gate; stash a recovery note at promotion time so the executed call surfaces `<repair_note>`
- [x] 3.6 Extend telemetry: tool-keyed `recovered` outcome for promotions; message-level channel record for strip-only events (old JSONL records must parse unchanged); update `/repair-stats` to report both
- [x] 3.7 Port upstream's pure-function grammar tests and add new tests: stopReason gate (length not promoted), default-settings never promotes, unknown-tool strip-only, empty-args skip, recovery note surfaced on executed recovered call

## 4. README and finish

- [x] 4.1 Add README glossary (tool call, schema/validation, silent coercion, grammar leak, anchor bleed, phantom tool call, repair note) — one plain-English sentence first, precise meaning after
- [x] 4.2 Add README prior-art section crediting pi-tool-repair (what was adapted, mechanical explanation of the prepareArguments seam, links to research.md entries for every mechanical claim)
- [x] 4.3 Document new settings, telemetry channels, and `/repair-stats` output in README usage sections
- [x] 4.4 Full suite run (`pnpm test`) including chaos provider script; verify repair notes/indicator behavior end-to-end against pi's real tools
