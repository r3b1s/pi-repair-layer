# Research: pi agent-loop facts this extension relies on

This is the tracked, claim-by-claim ledger of the mechanical facts about pi that
`pi-repair-layer` is built on. Every design decision (which hook, why
`prepareArguments`, the grammar-recovery `stopReason` gate, the dropped
schema-anchor defense) traces back to one of the claims below. If a pi upgrade
changes one of these, the corresponding tripwire in `test/upstream-drift.test.ts`
is meant to fail loudly — this document tells the next reader what the tripwire
is protecting and where to re-verify it.

## Verification provenance

- **Verification date:** 2026-07-17
- **Source read:** pi monorepo TypeScript source, clone at `~/Local/docs/pi`,
  git `0e6909f0` (`git describe`: `v0.80.6-24-g0e6909f0`). Package versions in
  the clone: `pi-coding-agent`, `pi-agent-core` (`packages/agent`), and `pi-ai`
  all `0.80.6`.
- **Installed (this repo's `node_modules`):** `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` `0.80.6`.
  Clone citations below remain the source-of-truth citations; installed `dist/`
  line numbers shift but the tripwires execute that published build directly.
- **Method:** direct source reading, plus the behavioral tripwires in
  `test/upstream-drift.test.ts` that execute the claims against the installed
  packages.

Claims 10–14 (optional integration) were added later with their own provenance:

- **Verification date:** 2026-07-18
- **Source read:** the same pi clone (`v0.80.6-24-g0e6909f0`); line citations
  below refer to it.
- **Empirical runs:** a live pi 0.80.10 install (npm-dist `cli.js` under
  Node 24) and the official `pi-linux-x64` release binary v0.80.10 (Bun
  compiled executable), each driven with a throwaway probe extension
  npm-installed into an isolated `$HOME/.pi/agent/npm` scope.

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

### Claim 9 — `tool_result` is global, replaceable, and handler-composed

After any built-in or custom tool finishes, the coding-agent session emits a
global `tool_result` event containing `toolName`, `toolCallId`, validated
`input`, `content`, `details`, and `isError`. A handler may replace `content`,
`details`, or `isError`. The runner threads each replacement through the event
seen by later handlers and returns the final fields to the agent loop.

- Installed `dist/core/agent-session.js:211-238` — `afterToolCall` emits the
  complete result event and returns the hook's replacement, preserving the
  original error flag when no replacement is supplied.
- Installed `dist/core/extensions/runner.js:600-641` — `emitToolResult` copies
  the event, visits handlers in registration order, writes each returned field
  into `currentEvent`, and returns the composed final result.
- `test/upstream-drift.test.ts` — real-loop tripwires cover a successful custom
  tool, a throwing custom tool, replacement content/details/error state, and
  two-handler composition.

**Why it matters:** repair input is prepared before a call ID exists. The layer
queues value-free feedback, binds it at post-validation `tool_call`, then uses
`tool_result` to attach one note to success or error output. Grammar-promoted
custom calls already have IDs and can be associated directly, without wrapping
another extension's executor.

### Claim 10 — pi maintains one shared npm install project per scope, with flat sibling resolution

All `npm:`-installed extensions in a scope are dependencies of a single private
npm project named `pi-extensions`, so their packages sit side by side in one
flat `node_modules`. An end user who runs
`pi install npm:@r3b1s/pi-repair-layer` therefore makes the package resolvable
from every other npm-installed extension in that scope.

- `packages/coding-agent/src/core/package-manager.ts:1933-1944` —
  `ensureNpmProject` writes `{ name: "pi-extensions", private: true }` into the
  install root's `package.json`.
- `packages/coding-agent/src/core/package-manager.ts:1956-1964` —
  `getNpmInstallRoot` returns `join(this.agentDir, "npm")` for the user scope
  (project scope roots under the project's config dir instead).
- Live install (pi 0.80.10): `~/.pi/agent/npm/package.json` has
  `name: "pi-extensions"` with every npm-installed extension as a dependency,
  and `node_modules` holds them as flat siblings (bun-backed, `bun.lock`
  present).

**Why it matters:** this is the mechanism behind the shared-`node_modules`
adoption path in the optional-integration recipe
(`docs/tool-owner-integration.md`). It is observed managed-install layout, not
a documented pi API guarantee — the recipe never *depends* on it (resolution
either succeeds or falls back safely), but the adoption story does.

### Claim 11 — Missing-module error shapes: `MODULE_NOT_FOUND` (jiti/require) vs `ERR_MODULE_NOT_FOUND` (ESM import)

A dynamic import of an uninstalled package surfaces differently depending on
the loader, but always with one of two `code` values and a message that names
the requested module:

- jiti 2.7.0 require path (Node): plain `Error`, `code: "MODULE_NOT_FOUND"`,
  message `Cannot find module '<full specifier>'`.
- Native Node ESM `import()` (Node 24): `Error`,
  `code: "ERR_MODULE_NOT_FOUND"`, message
  `Cannot find package '<package name>'` — **it names the bare package, not
  the full subpath specifier**, so absence checks must match the package name
  (`@r3b1s/pi-repair-layer`), never the `/pi` subpath string.
- Compiled Bun binary (pi-linux-x64 v0.80.10): Bun `ResolveMessage` (an
  `Error` subclass), `code: "ERR_MODULE_NOT_FOUND"` for `import()` and
  `"MODULE_NOT_FOUND"` for a scoped `require`, message
  `Cannot find module '<full specifier>' from '<importer path>'`.

**Why it matters:** the optional-integration recipe treats an import failure
as "package absent" only when the code is one of these two values **and** the
message names `@r3b1s/pi-repair-layer`; anything else rethrows so a broken
install (a *transitive* module missing) is not silently misread as absent.
All three observed shapes pass that discrimination.

### Claim 12 — Git installs and other scopes do not resolve the shared npm siblings

Git-installed extensions are cloned into `<agentDir>/git/<host>/<path>` and get
their **own** dependency install inside the clone; they are not siblings of the
shared npm root. User scope (`~/.pi/agent`) and project scope (`<cwd>/.pi`)
likewise use separate install roots.

- `packages/coding-agent/src/core/package-manager.ts:1820-1846` — `installGit`
  clones into `getGitInstallPath(...)` and runs a dependency install inside the
  clone when it has a `package.json`.
- `packages/coding-agent/src/core/package-manager.ts:2036-2046` —
  `getGitInstallRoot` returns `join(this.agentDir, "git")` (user scope) or
  `join(this.cwd, CONFIG_DIR_NAME, "git")` (project scope).

**Why it matters:** a git-installed or cross-scope consumer cannot resolve an
npm-installed `@r3b1s/pi-repair-layer` sibling, so the optional recipe falls
back there even though the user "installed" the package. Documented as a hard
caveat in the integration guide; `optionalDependencies` is the alternative for
those consumers.

### Claim 13 — Bun-binary probe: the optional dynamic import falls back under the compiled binary, resolves under npm-dist pi

pi loads extensions through jiti (`moduleCache: false`; in the compiled binary
additionally `virtualModules` + `tryNative: false`; under Node, `alias`):

- `packages/coding-agent/src/core/extensions/loader.ts:398-404` — the
  `createJiti` call and both option branches.

End-to-end probe (2026-07-18): a throwaway extension implementing the
documented recipe, npm-installed into an isolated scope, run once with
`@r3b1s/pi-repair-layer` npm-installed as a sibling and once without, under
both pi distributions of v0.80.10:

| runtime | package | observed error (`name`/`code`) | branch taken |
|---|---|---|---|
| npm-dist (Node) | absent | `Error`/`ERR_MODULE_NOT_FOUND` | fallback, note emitted |
| npm-dist (Node) | present | — | **adapted** |
| compiled binary | absent | `ResolveMessage`/`ERR_MODULE_NOT_FOUND` | fallback, note emitted |
| compiled binary | present | `ResolveMessage`/`ERR_MODULE_NOT_FOUND` | fallback, note emitted |

Under the compiled Bun binary, *static* imports of the sibling package do
resolve (jiti's own resolver handles them — verified with a static-import
probe extension in the same scope), but native dynamic `import()` and the
scoped `require` both bypass jiti and hit Bun's embedded resolver, which does
no filesystem `node_modules` resolution — even an absolute-path `import()` of
the package's entry file loads but then dies on its transitive bare specifier
(`typebox/value`). There is no consumer-accessible dynamic path through jiti's
resolver as of this pi version.

**Why it matters:** the optional-integration pattern *activates* only under
Node-based pi installs (npm/bun global install). Under the official compiled
binary it degrades safely — the import failure has exactly the absent-package
shape, so consumers fall back to their raw definition with the one-line note,
even when the package is installed. A hard static dependency, by contrast,
works under both distributions. Both facts are documented in the integration
guide's caveats.

### Claim 14 — Unrecognized preprocessor kinds fall through `preprocessInput` untouched (local guarantee)

This claim is about this repo, not pi: `preprocessInput`
(`src/preprocess.ts`) matches each configured entry against the known `kind`
branches and simply skips entries it does not recognize — no mutation, no
error, no claimed change — and the pipeline still schema-validates the final
result. A consumer configured against a newer options shape therefore degrades
to the recognized subset when running against an older installed version.
Promoted to a spec-level compatibility guarantee by the
`optional-integration-fallback` change and pinned by a unit test in
`test/pipeline.test.ts`.

### Package/runtime assumptions

The published package targets Node 22+ and compiled ESM. `typebox` is a runtime
dependency; pi coding-agent and pi-tui are peers so the host supplies its live
integration/UI runtime. `pnpm run test:package` builds and packs the artifact,
installs it into a clean temporary project, imports `.`, `/core`, `/pi`, and
`/grammar`, runs the APIs, and typechecks the consumer fixture. This is the
tripwire for missing JavaScript, declarations, source maps, or stale exports.

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
9. **`tool_result` lifecycle (Claim 9):** confirm built-in and custom success/error
   results still reach the global hook, replacements still reach conversation
   messages, and handlers still compose in registration order.
10. **Package/runtime:** run `pnpm run test:package`; re-check Node engines,
    peer/runtime dependencies, every `exports` target, and the pi extension path.
11. **Shared npm root (Claim 10):** confirm `ensureNpmProject` still writes one
    `pi-extensions` project per scope and installs remain flat siblings —
    re-read `package-manager.ts` and inspect a live `~/.pi/agent/npm`.
12. **Error shapes (Claim 11):** re-run a missing-module import under jiti, under
    native Node `import()`, and under the compiled binary; confirm the codes are
    still `MODULE_NOT_FOUND` / `ERR_MODULE_NOT_FOUND` and the message still names
    the requested package.
13. **Git/scope boundaries (Claim 12):** confirm git installs still get their own
    clone-local dependency install and scopes still use separate install roots.
14. **Bun-binary probe (Claim 13):** re-run the four-cell probe (npm-dist and
    compiled binary, package present and absent) with a throwaway recipe
    extension npm-installed into an isolated `$HOME`; update the outcome table —
    especially whether dynamic `import()` in the compiled binary has gained
    filesystem `node_modules` resolution, which would let optional consumers
    activate there.
