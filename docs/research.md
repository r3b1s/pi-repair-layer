# Research: pi agent-loop facts this extension relies on

This is the tracked, claim-by-claim ledger of the mechanical facts about pi that
`pi-repair-layer` is built on. Every design decision (which hook, why
`prepareArguments`, the grammar-recovery `stopReason` gate, the dropped
schema-anchor defense) traces back to one of the claims below. If a pi upgrade
changes one of these, the corresponding tripwire in `test/upstream-drift.test.ts`
is meant to fail loudly — this document tells the next reader what the tripwire
is protecting and where to re-verify it.

## Verification provenance

- **Verification date:** 2026-07-13
- **Source read:** pi monorepo TypeScript source, clone at `~/Local/docs/pi`,
  git `0e6909f0` (`git describe`: `v0.80.6-24-g0e6909f0`). Package versions in
  the clone: `pi-coding-agent`, `pi-agent-core` (`packages/agent`), and `pi-ai`
  all `0.80.6`.
- **Installed (this repo's `node_modules`):** `@earendil-works/pi-ai` `0.80.6`,
  `@earendil-works/pi-coding-agent` `0.80.3`. The coding-agent patch level
  installed here (`.3`) trails the source clone (`.6`); nothing in the claims
  below depends on that patch delta, and the version canary (Claim 8) treats
  patch differences as compatible by design. All line citations are against the
  clone source at the commit above; a `dist/` build shifts line numbers but not
  behavior.
- **Method:** direct source reading, plus the behavioral tripwires in
  `test/upstream-drift.test.ts` that execute the claims against the installed
  packages.

## Claims

### Claim 1 — Loop ordering: `prepareArguments` runs before validation, which runs before the `tool_call` event

Per tool call, pi runs, in order: `tool.prepareArguments(raw)` →
`validateToolArguments(...)` → (if configured) the `beforeToolCall` hook, which
is what surfaces the `tool_call` extension event → `tool.execute(validatedArgs)`.

- `packages/agent/src/agent-loop.ts:588-600` — `prepareToolCallArguments` calls
  `tool.prepareArguments(toolCall.arguments)`.
- `packages/agent/src/agent-loop.ts:618-621` — inside `prepareToolCall`:
  `prepareToolCallArguments(...)` then `validateToolArguments(tool, preparedToolCall)`
  then `config.beforeToolCall(...)`.
- `packages/agent/src/agent-loop.ts:653-657` — only after the above does the
  call resolve to `{ kind: "prepared", ... args: validatedArgs }` for execution.

**Why it matters:** `prepareArguments` is the *only* seam that sees the raw input
before validation can throw. This is the founding reason the extension overrides
built-in tools rather than handling the `tool_call` event.

### Claim 2 — `validateToolArguments` throws on failure (Convert-then-Check)

`validateToolArguments` clones the args, runs TypeBox `Value.Convert` (coercion),
then `validator.Check`; on failure it throws a formatted `Error`.

- `packages/ai/src/utils/validation.ts:278-309` — `structuredClone` →
  `Value.Convert(tool.parameters, args)` → `validator.Check(args)` → on failure,
  builds an error message and `throw new Error(errorMessage)` (line 309).

**Why it matters:** two things. (a) A validation failure throws before the
`tool_call` event fires, so that event can never repair a failing built-in call
(basis of Claim 1's consequence). (b) `Value.Convert` runs *first* and silently
coerces (`null` → `"null"`, `'["a"]'` → `['["a"]']`), which is why the repair
engine checks strictly **before** Convert — see `src/repair-engine.ts`.

### Claim 3 — `tool_call` event: in-place `input` mutation propagates, reassignment does not

The `tool_call` event's `input` is the very `validatedArgs` object the loop will
execute with, so mutating it in place reaches `execute`. But the event dispatcher
returns only the handler's `{ block, reason }` result — a handler that
*reassigns* `event.input = newObject` has that new object dropped.

- `packages/agent/src/agent-loop.ts:621-626` — `beforeToolCall` is passed
  `args: validatedArgs`.
- `packages/coding-agent/src/core/agent-session.ts:424-436` — `beforeToolCall`
  forwards to `runner.emitToolCall({ ..., input: args })`; `input` **is** the
  `validatedArgs` reference.
- `packages/coding-agent/src/core/extensions/runner.ts:881-902` — `emitToolCall`
  returns the handler result and the caller reads only `.block`
  (`agent-loop.ts:638`). The executed object is the separate `validatedArgs`
  reference (`agent-loop.ts:657`), so a reassignment of `event.input` is never
  read back.

**Why it matters:** this is why an upstream extension that does
`event.input = repairedClone` on the `tool_call` event cannot repair a built-in
call even setting aside Claim 2 — its computed repair is discarded.

### Claim 4 — `message_end` replacement mutates the loop's message in place, listeners are awaited, and the replacement executes same-turn (with a role guard)

A `message_end` handler that returns `{ message }` has that message written back
onto the loop's own assistant-message object **in place**, before the loop
filters the message for tool calls — so a replacement whose content includes a
`toolCall` block is executed in the same turn. The replacement must keep the
original role.

- `packages/agent/src/agent-loop.ts:359,372` — `streamAssistantResponse` emits
  `message_end` with `finalMessage`, then `return finalMessage` (line 373).
- `packages/agent/src/agent.ts:571-572` — the emit path awaits every listener
  (`for (const listener of this.listeners) await listener(event, signal)`), so
  the replacement is applied before `streamAssistantResponse` returns.
- `packages/coding-agent/src/core/agent-session.ts:709-726` — on `message_end`,
  `emitMessageEnd` returns a replacement which is written via
  `_replaceMessageInPlace(event.message, normalized)`.
- `packages/coding-agent/src/core/agent-session.ts:657-671` —
  `_replaceMessageInPlace` deletes the target's keys and `Object.assign`s the
  replacement onto the *same object reference* the loop holds.
- `packages/coding-agent/src/core/extensions/runner.ts:804-808` — role guard:
  a handler result whose `message.role !== currentMessage.role` is rejected with
  an error and skipped.
- `packages/agent/src/agent-loop.ts:203` — back in the loop, tool calls are read
  from `message.content` *after* `streamAssistantResponse` returns; because the
  replacement mutated that same object, injected `toolCall` blocks are seen and
  executed this turn.

**Why it matters:** grammar-leak recovery hooks `message_end`, returns a
same-role replacement with the leaked text stripped, and (in `recover` mode)
appends `toolCall` blocks that execute same-turn and re-enter our
`prepareArguments` repair path. All of that depends on this claim.

### Claim 5 — `before_provider_request` propagates the returned payload

A `before_provider_request` handler's return value replaces the outgoing request
payload for later handlers and the provider.

- `packages/coding-agent/src/core/extensions/runner.ts:965-997` —
  `emitBeforeProviderRequest` threads `currentPayload = handlerResult` whenever a
  handler returns a non-`undefined` value, and returns the final payload.

**Why it matters:** this is the hook the *dropped* schema-anchor defense would
have used. It is documented here so that if scope ever broadens to non-built-in
tools with regex `pattern` schemas (see Claim 7), the mechanism is known-good.

### Claim 6 — `stopReason: "error"` (and `"aborted"`) is terminal, not a retry

When the assistant message's `stopReason` is `"error"` or `"aborted"`, the loop
emits `turn_end` + `agent_end` and returns — it does not auto-retry.

- `packages/agent/src/agent-loop.ts:196-200`.

**Why it matters:** it demotes the upstream "phantom toolUse → error triggers
auto-retry" claim (that normalization is out of scope here — a clean stop, not a
retry, on this pi). Also bounds what the grammar-recovery `stopReason` gate may
safely do.

### Claim 7 — `stopReason: "length"` causes pi to fail all tool calls in the message

If tool calls are present but `stopReason` is `"length"` (output truncated by the
token limit), pi fails every tool call rather than executing possibly-truncated
arguments.

- `packages/agent/src/agent-loop.ts:207-214` — when `toolCalls.length > 0`,
  `message.stopReason === "length"` routes to
  `failToolCallsFromTruncatedMessage(toolCalls, emit)` instead of
  `executeToolCalls(...)`.
- `packages/agent/src/agent-loop.ts:383` — `failToolCallsFromTruncatedMessage`
  definition.

**Why it matters:** this is exactly the protection the grammar-recovery
`stopReason` gate must not bypass. Upstream promotes leaked calls regardless of
`stopReason`, overwriting `"length"` with `"toolUse"` and defeating this
truncation guard. Our gate only *promotes* on `stopReason: "stop"` (stripping is
allowed on any `stopReason`), so a truncated message keeps failing its calls.

### Claim 8 — Built-in tool schemas carry no regex `pattern` keyword

Every field in the seven wrapped built-in tool schemas is a plain
`Type.String({ description })` / `Type.Number` / etc. No field declares a
JSON-schema `pattern` (regex) keyword. The literal string `pattern` appears only
as a *field name* (grep's and find's search-pattern parameter) and in
descriptions.

- `packages/coding-agent/src/core/tools/grep.ts:25` — `pattern: Type.String({
  description: "Search pattern (regex or literal string)" })` — a plain string
  field, no schema-level `pattern` keyword.
- `packages/coding-agent/src/core/tools/find.ts:21-23` — `pattern: Type.String({
  description: ... })` — likewise a glob string, no regex keyword.
- The remaining tool files (`read.ts`, `write.ts`, `edit.ts`, `bash.ts`,
  `ls.ts`) declare only plain-typed fields.

**Why it matters:** (a) it justifies dropping the schema-anchor poisoning defense
(there is no regex schema to sanitize among built-ins). (b) It justifies the
anchor-strip exemption for `grep.pattern`: because `grep`'s pattern *is* a real
regex field, a leading `^` / trailing `$` there may be intentional syntax and is
indistinguishable from bled anchors, so we never strip it.

## Re-verification checklist (run on any pi minor bump)

The version canary in `test/upstream-drift.test.ts` fails when installed
`pi-coding-agent` changes minor version (`VERIFIED_PI_VERSION`). When it does,
work through this list and update the citations/date above:

1. **Loop ordering (Claim 1):** confirm `prepareArguments` still runs before
   `validateToolArguments`, which still runs before the `tool_call`/`beforeToolCall`
   hook. Re-read `packages/agent/src/agent-loop.ts` `prepareToolCall`.
2. **Validation throws (Claim 2):** confirm `validateToolArguments` still does
   `Value.Convert` then `Check` then `throw`. Re-read
   `packages/ai/src/utils/validation.ts`.
3. **`tool_call` propagation (Claim 3):** confirm the event's `input` is still the
   executed `validatedArgs` reference and that the dispatcher still reads only
   `.block`. If pi adds an args-return channel to `tool_call`, revisit the
   founding decision.
4. **`message_end` in-place replacement (Claim 4):** confirm replacement still
   mutates the loop's message object in place, listeners are still awaited, the
   role guard still holds, and toolCalls are still filtered after the stream
   returns (so recovery still executes same-turn).
5. **`before_provider_request` (Claim 5):** confirm it still propagates the
   returned payload.
6. **`stopReason` terminality (Claims 6, 7):** confirm `"error"`/`"aborted"` are
   still terminal and `"length"` still fails all tool calls.
7. **Built-in schema shape (Claim 8):** re-run the schema-shape snapshot test and
   confirm no wrapped built-in gained a regex `pattern` keyword. If any did,
   revisit the `grep.pattern` exemption and the dropped schema-anchor defense.
8. Update `VERIFIED_PI_VERSION`, the verification date, and the commit hash above,
   then commit the refreshed snapshot fixture deliberately.
