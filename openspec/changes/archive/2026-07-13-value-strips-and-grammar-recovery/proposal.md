# Proposal: value-strips-and-grammar-recovery

## Why

pi-repair-layer wins the overlap with [`monotykamary/pi-tool-repair`](https://github.com/monotykamary/pi-tool-repair) on built-in tool-input repair (our `prepareArguments` seam runs pre-validation; their `tool_call` hook is largely unreachable for built-ins), but that extension has genuinely valuable capabilities on *other* hooks that we lack entirely: model-specific value cleanup (anchor bleed, grammar-token leaks) and recovery of tool calls that leak into assistant text. Source verification against the pi 0.80.6 clone (2026-07-13) confirmed both target hooks (`message_end`, `before_provider_request`) propagate handler results, and that a `message_end` replacement's toolCalls execute same-turn — so assimilating these capabilities is mechanically sound. At the same time, all of our claims rest on pi's current loop ordering and schemas; we need automated tripwires so a pi upgrade can't silently invalidate them, and user-facing docs that explain this niche domain in plain language.

## What Changes

- **New value-strip pre-pass** (`src/value-strips.ts`): model-gated strips that run at the top of `prepareArguments`, before the existing validate-then-repair engine. Two strips, adapted from pi-tool-repair: anchor-bleed (`^`/`$` stuck to values) and GLM grammar-token leaks (`<arg_key>`/`<arg_value>` in keys/values). Improvement over upstream: skip regex-typed fields (`grep.pattern`) where anchors are legitimate syntax — a bled anchor and an intended anchor are indistinguishable there, so we don't guess. Strips emit `<repair_note>` and telemetry via existing `stashRepair` machinery.
- **New grammar-leak recovery** on the `message_end` hook: adapted in place (not vendored verbatim) from pi-tool-repair's `grammar-repair.ts` (MIT; one-line provenance header retained). Detects tool calls a model printed as text (10 grammar families), strips the leaked text, and — in opt-in `recover` mode — promotes them to real toolCalls that execute same-turn and re-enter our `prepareArguments`. Improvement over upstream: a stopReason gate (recover only on `stopReason: "stop"`) so recovery cannot bypass pi's length-truncation protection by overwriting `stopReason: "length"`.
- **New upstream-drift test suite**: behavioral tripwires against the real installed pi — loop-ordering, event-propagation, built-in schema-shape snapshot (including the no-regex-`pattern` assertion), `stopReason:"length"` toolCall-failure behavior, and a `VERIFIED_PI_VERSION` minor-version canary that forces a deliberate re-verification on pi upgrades.
- **New docs**: tracked `docs/research.md` holding the claim-by-claim, source-cited verification (successor to the untracked HANDOFF.md); README gains a plain-English glossary (grammar leak, anchor bleed, silent coercion, phantom tool call, repair note), a humble prior-art section crediting pi-tool-repair, and links to research.md wherever the README makes a mechanical claim.
- **Telemetry extension**: a message-level channel for strip-only grammar events (no tool to key on) so `/repair-stats` can report them alongside the existing tool-keyed outcomes.
- No upstream communication or contribution is in scope; this is adaptation with attribution.

## Capabilities

### New Capabilities

- `value-strips`: model-gated pre-pass that removes anchor-bleed and grammar-token leaks from tool-call values inside `prepareArguments`, with a regex-field skip-list, repair notes, and telemetry.
- `grammar-leak-recovery`: opt-in `message_end` capability that strips leaked tool-call grammar from assistant text and (in recover mode) promotes parsed calls to executable toolCalls, with stopReason/role/known-tool/empty-args safety gates and message-level telemetry for strip-only events.
- `upstream-drift-detection`: test suite that executes our founding assumptions about pi's agent loop, event propagation, and built-in schemas against the installed pi, plus a version canary tied to a re-verification checklist.
- `plain-language-docs`: README glossary, prior-art credit, and a tracked research document that backs every mechanical claim with source citations.

### Modified Capabilities

None (no existing specs; this change introduces the first ones).

## Impact

- **Code**: new `src/value-strips.ts`, new grammar-recovery module (e.g. `src/grammar-recovery.ts`), edits to `src/index.ts` (pre-pass call, `message_end` handler registration), `src/settings.ts` (recovery mode + model-gate settings), `src/tables.ts`/telemetry (message-level channel, `/repair-stats` output).
- **Tests**: new upstream-drift suite alongside existing `test/extension.test.ts`; ported pure-function tests for adapted strip/recovery logic; unit tests for the grep.pattern skip and stopReason gate.
- **Docs**: new `docs/research.md`; substantial README additions; HANDOFF.md retired or reduced to a pointer.
- **Dependencies**: none added; adapted code is self-contained. Pinned against installed `pi-coding-agent`/`pi-agent-core`/`pi-ai` 0.80.6 with an explicit version canary.
- **Risk surface**: grammar recovery promotes assistant text into execution — mitigated by opt-in mode, known-tool gating, empty-args skip, stopReason gate, and same-turn re-entry through our existing repair engine.
