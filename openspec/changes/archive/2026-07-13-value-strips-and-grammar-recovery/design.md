# Design: value-strips-and-grammar-recovery

## Context

pi-repair-layer repairs malformed built-in tool inputs inside `prepareArguments` (a
`pi.registerTool({ same name })` override), the only seam that runs before pi's
`validateToolArguments` throws. This was verified against pi's TypeScript source
(clone at `~/Local/docs/pi`, exactly 0.80.6, matching `node_modules`) on 2026-07-13:

- Ordering: `prepareArguments` → `validateToolArguments` → `beforeToolCall` → `execute`
  (`packages/agent/src/agent-loop.ts:619-621`).
- `emitToolCall` returns only `{block, reason}`; reassigning `event.input` is dropped,
  but `event.input === validatedArgs` so *in-place mutation propagates*
  (`runner.ts:881`, `agent-session.ts:435`).
- `emitMessageEnd` propagates a returned message via `_replaceMessageInPlace`
  (`agent-session.ts:657`), which mutates the loop's own message object; agent listeners
  are awaited (`agent.ts:572`) before the loop filters toolCalls — so a replacement's
  toolCalls execute same-turn. Replacement must keep the original role (`runner.ts:804`).
- `stopReason:"error"` is terminal (`agent-loop.ts:196`); `stopReason:"length"` causes
  pi to fail all toolCalls in the message (`agent-loop.ts:207`).
- Built-in schemas contain no regex `pattern` keywords (all plain `Type.String`).

[`monotykamary/pi-tool-repair`](https://github.com/monotykamary/pi-tool-repair)
(local clone: `~/Local/ext-clones/pi-tool-repair`, MIT per package.json) has three
subsystems we lack: value strips (anchor bleed, grammar-token leaks), grammar-leak
recovery (~1,000 lines, 10 grammar families), and phantom-toolUse normalization
(demoted — terminal on 0.80.6, not a retry). This change assimilates the first two,
improving on both, and hardens our founding assumptions with automated tripwires
plus plain-language documentation.

Current extension structure: `src/index.ts` (overrides + notes + telemetry +
`/repair-stats` + `/repair-settings`), `src/repair-engine.ts` (validate-then-repair,
strict-before-Convert), `src/settings.ts` (persisted display settings),
`src/tables.ts`, tests in `test/`.

## Goals / Non-Goals

**Goals:**
- Model-gated value-strip pre-pass in `prepareArguments`, with a regex-field skip-list.
- Grammar-leak recovery on `message_end`, adapted in place, with a stopReason gate
  upstream lacks; strip behavior model-gated, `recover` mode opt-in.
- Behavioral upstream-drift tests that execute our §Context claims against the
  installed pi, plus a version canary.
- README glossary + prior-art credit; tracked `docs/research.md` backing every
  mechanical claim with source citations.
- Message-level telemetry channel so strip-only grammar events appear in `/repair-stats`.

**Non-Goals:**
- Schema-anchor poisoning defense on `before_provider_request` (dropped: built-in
  schemas carry no regex patterns — nothing to sanitize).
- Phantom-toolUse normalization (build only on reproduced evidence; not in this change).
- Packaging/`pi install` manifest work (independent; separate change).
- Upstream communication, contribution, or coordination of any kind.
- Repairing non-built-in (extension-registered) tools.

## Decisions

### D1. Value strips are a pre-pass module, not engine rules
`src/value-strips.ts`, called at the top of our `prepareArguments` override before the
validate-then-repair engine. The engine's rules fire on schema-invalid input; strips
must transform input that is valid both before and after (an anchor-bled string still
validates as a string). Different trigger semantics → separate module. Strips reuse
`stashRepair` + `logTelemetry` so notes/indicator/stats need no new plumbing.
*Alternative considered:* new engine rules — rejected because the engine would need a
"run even when valid" mode, complicating its contract.

### D2. Anchor strip skips regex-typed fields (policy b)
Strip leading `^` / trailing `$` from string values only in fields where anchors are
never legitimate syntax. Skip-list: `grep.pattern` (the only true regex field among
built-ins; `find.pattern` is a glob). Rationale: in a regex field, a bled anchor and an
intended anchor are the same bytes — no repair can distinguish them, so we don't guess.
Upstream strips all fields and would eat an intentional `grep '^import'`.
*Alternative considered:* full parity with upstream — rejected (false positives on
legitimate greps); heuristic full-wrap-only stripping — rejected (still hits `^foo$`).

### D3. Model gating mirrors upstream's regexes, checked against `currentModelId`
Anchor bleed: `/kimi-k2/i`, `/minimax/i`, `/glm/i`. Grammar-token leaks: `/glm/i`.
Gate on the `currentModelId` already tracked in the extension closure. Since pi's
built-in schemas carry no regex patterns (the hypothesized *cause* of bleed), it is an
open empirical question whether anchor bleed occurs on pi at all — telemetry counters
answer this for free, which is itself a reason to ship the strips instrumented.

### D4. Grammar recovery is adapted in place, in our own module
`src/grammar-recovery.ts`, adapted (not vendored verbatim) from pi-tool-repair's
`src/grammar-repair.ts`, with a one-line provenance header ("adapted from
monotykamary/pi-tool-repair, MIT"). Adapting lets us integrate telemetry, settings,
and gates cleanly; we accept losing easy upstream diffing. Registered as a
`pi.on("message_end", …)` handler in the same `toolRepairExtension(pi)` function.
Preserved upstream safety gates: assistant-role only, known-tool allowlist, empty-args
skip, strip-only when the message already has real toolCalls, `strip`/`recover` modes.

### D5. New stopReason gate on recovery (improvement over upstream)
Recover (promote parsed calls to toolCalls, set `stopReason:"toolUse"`) **only when
the original `stopReason` is `"stop"`**. Upstream recovers regardless and overwrites
`stopReason:"length"`, bypassing pi's deliberate truncation protection (pi fails all
toolCalls on `"length"` because args may be cut off). Text stripping (leak removal
without promotion) remains allowed on any stopReason; only *promotion* is gated.

### D6. Recovery defaults: strip available under model gate; recover opt-in
Promoting assistant text into execution is the one genuinely risky capability here.
`recover` mode must be explicitly enabled in settings. Strip-only behavior follows the
model gate. *Alternative:* default-on recovery for known-leaky models — rejected;
conservative posture first, telemetry can justify loosening later.

### D7. Settings extend the existing `settings.ts` pattern
Same persisted-JSON file (`~/.pi/agent/tool-repair/settings.json`), same
load-with-defaults/save-never-throws shape, edited via `/repair-settings`. New keys
(indicative): `grammarRecovery: "off" | "strip" | "recover"` (default `"strip"`,
which still requires the model gate to fire) and optional `grammarAllowedTools`.
No second config file (upstream uses one; we don't).

### D8. Telemetry gains a message-level channel
Current `TelemetryRecord` is tool-keyed with `outcome: "repaired" | "unrepairable"`.
Recovered calls fit (keyed by recovered tool name, new outcome `"recovered"`).
Strip-only events have no tool: add a message-level record variant (e.g.
`channel: "message"`, `outcome: "stripped"`, `grammar: <family>`). `/repair-stats`
reports both sections. JSONL stays append-only and backward-readable: old records
lack `channel` and default to the tool channel.

### D9. Upstream-drift tests are behavioral, plus one version canary
New `test/upstream-drift.test.ts` driving the real installed pi (in-process, like
`test/extension.test.ts`):
1. **Ordering tripwire** — instrumented tool through the real loop: `prepareArguments`
   receives raw input for a call that fails validation; a `tool_call` handler never
   fires for that call.
2. **Propagation tripwire** — in-place mutation of `event.input` reaches execute;
   reassignment does not; a `message_end` replacement's toolCalls execute same-turn.
3. **Schema-shape snapshot** — live `parameters` of every wrapped built-in vs a
   checked-in fixture; plus assert no built-in schema contains a regex `pattern`
   keyword (standing assumption behind D2 and the dropped schema-poisoning defense).
4. **Length-protection assertion** — `stopReason:"length"` messages get their
   toolCalls failed by pi (the behavior D5 defers to).
5. **Version canary** — `VERIFIED_PI_VERSION` constant (`0.80.x`) asserted against the
   installed `pi-coding-agent`; patch bumps pass, minor bumps fail with a message
   pointing at the re-verification checklist in `docs/research.md`.
*Alternative considered:* source-fingerprint tests on pi's dist — rejected as brittle
and indirect; behavior is the actual contract.

### D10. Docs: research.md is the tracked claim ledger; README speaks plainly
`docs/research.md` holds the claim-by-claim verification table (claims, citations to
pi source files/lines at 0.80.6, verification date, re-verification checklist).
README additions: a glossary defining, in one plain sentence each before the precise
meaning — *tool call, schema/validation, silent coercion, grammar leak, anchor bleed,
phantom tool call, repair note*; a prior-art section crediting pi-tool-repair as the
origin of the strip rules and grammar-recovery approach, stating what we adapted and
explaining mechanically (linking research.md) why the `prepareArguments` seam reaches
cases the `tool_call` event cannot — credit by sequence diagram, not by comparison
adjectives. HANDOFF.md retires to a pointer at research.md.

## Risks / Trade-offs

- [Grammar recovery promotes text into execution] → opt-in `recover` mode (D6),
  known-tool gate, empty-args skip, stopReason gate (D5), role preservation, and
  recovered calls re-enter the full `prepareArguments` repair path. A recovery note is
  stashed at promotion time so the executed call surfaces
  `<repair_note>recovered a leaked tool call…</repair_note>`.
- [Anchor strip false positives outside the skip-list] (e.g. a bash command
  legitimately ending in `$`) → gated to three model families; every strip emits a
  visible repair note and telemetry, so a bad strip is observable, not silent.
- [Adapted module drifts from upstream fixes] → accepted cost of adapt-in-place (D4);
  ported pure-function tests pin current behavior.
- [Schema snapshot churn on pi upgrades] → that is the feature (loud signal); fixture
  updates are deliberate, reviewed, and paired with the research.md checklist.
- [Version canary is annoying] → scoped to minor bumps only; failure message tells the
  developer exactly what to re-verify and where.
- [In-process tests depend on pi internals staying importable] → same dependency the
  existing `test/extension.test.ts` already carries; failures are themselves drift
  signals.

## Migration Plan

Additive, no breaking changes, no data migration. Telemetry JSONL gains new record
shapes; existing records remain readable (D8). Settings file gains new keys with safe
defaults on load. Rollback = revert; no persisted state requires cleanup. Suggested
implementation order keeps commits reviewable: research.md + drift tests (pins the
ground truth) → value strips → grammar recovery → README.

## Open Questions

- Exact `TelemetryRecord` field names for the message channel (settled during
  implementation; constraint: old records must parse unchanged).
- Whether `find.pattern` needs glob-specific strip caution beyond anchors (current
  evidence: no — anchors are never glob syntax).
