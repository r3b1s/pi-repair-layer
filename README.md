# pi-repair-layer

A tool-input repair layer for the [pi coding agent](https://github.com/earendil-works/pi), doing
what commandcode's repair layer does: catch the small, finite set of malformed
tool calls that open models emit, fix them at the exact paths the validator
flags, and tell the model what was fixed so it can self-correct next turn.

No LLM calls, no network, no uploaded telemetry.

## Glossary

Plain-English first, precise meaning after — for readers new to LLM tool-calling.

- **Tool call** — the model asking the agent to run a tool (read a file, run a
  shell command). Concretely, a structured request with a tool name and a JSON
  arguments object that the agent validates and executes.
- **Schema / validation** — the rulebook for a tool's arguments, and the check
  against it. Each built-in tool declares a schema (which fields exist, their
  types, which are required); pi validates every call against it and rejects
  calls that don't fit.
- **Silent coercion** — when a wrong value gets quietly bent into a valid-looking
  one and runs anyway. pi's validator runs TypeBox `Value.Convert` first, which
  turns `null` into the string `"null"` and `'["a"]'` into `['["a"]']` — the call
  then passes validation and executes with garbage instead of erroring.
- **Grammar leak** — the model prints its tool call as text instead of actually
  making one. Different model families use different tool-call "grammars" (XML
  tags, sentinel tokens); when one leaks, a block like
  `<tool_call>read<arg_key>path</arg_key>…` shows up in the assistant's prose and
  no tool runs.
- **Anchor bleed** — regex anchor characters (`^`, `$`) stuck onto a value that
  isn't a regex. Some models emit `read {path: "^/x$"}` where the `^`/`$` bled in
  from the tool-call grammar and were never meant to be part of the path.
- **Phantom tool call** — the model signals "I'm calling a tool" but sends no
  actual call. On some providers the stream ends with a tool-use stop reason but
  zero tool-call blocks, leaving the loop with nothing to run. (Out of scope
  here — see [Limitations](#limitations).)
- **Repair note** — the short explanation this layer hands back to the model
  after fixing a call, so it can self-correct. It rides along as a
  `<repair_note>…</repair_note>` line prefixed to the tool result.

## Install

```bash
pi install npm:@r3b1s/pi-repair-layer
```

Or from git:

```bash
pi install git:github.com/r3b1s/pi-repair-layer
```

pi's TUI will show a one-time warning that built-in tools were overridden —
that is this extension working as intended.

At runtime pi's extension loader aliases `@earendil-works/pi-coding-agent` and
`typebox` to the running instance's own modules, so the extension always binds
to your live pi and its exact validator version. The `node_modules/` here is
only used for the tests and `tsc`.

```bash
pnpm install   # once, if you want to run the tests
pnpm test      # pure engine unit tests + end-to-end against pi's real tools
```

The toolchain is managed with [mise](https://mise.jdx.dev/) (`mise.toml` pins
node/pnpm). `mise run ci` runs typecheck + lint + test.

## What it repairs

| Rule | Example | Fix |
|---|---|---|
| `renameAliasedField` | `{file_path: "/x"}` for `read` | `{path: "/x"}` |
| `dropNullOrUndefinedField` | `{path: "/x", offset: null}` | `{path: "/x"}` |
| `dropEmptyObjectPlaceholder` | `{tags: {}}` where array expected | field dropped |
| `parseJsonStringifiedArray` | `{include: '["a","b"]'}` | `{include: ["a","b"]}` |
| `parseJsonStringifiedObject` | stringified object for object field | parsed |
| `wrapBareStringAsArray` | `{include: "foo"}` | `{include: ["foo"]}` |
| `wrapRootStringAsObject` | `"echo hi"` as the whole input to `bash` | `{command: "echo hi"}` |
| `parseJsonStringifiedRootObject` | `'{"command":"ls"}'` as the whole input | parsed |
| `unwrapMarkdownAutoLink` | `path: "/x/[notes.md](http://notes.md)"` | `path: "/x/notes.md"` |
| `foldFlatEditFields` | `{path, old_string, new_string}` for `edit` | `{path, edits: [{oldText, newText}]}` |

Alias tables cover the contracts models actually leak: Claude Code's
`file_path`/`old_string`/`new_string`, aider's `search`/`replace`, generic
`cmd`/`query`/`text`/`contents`, at any nesting depth (e.g. inside `edits[n]`).

Every repair is surfaced to the model as a `<repair_note>` prefixed to the tool
result, e.g.:

```
<repair_note>Renamed `file_path` to `path` for tool "read". `file_path` is not a valid field for this tool — use `path` next time.</repair_note>
```

Transparency over silent magic: the model sees what was picked and can correct
itself on the next turn.

## Model-gated value strips

Before the validate-then-repair engine runs, a small pre-pass
(`src/value-strips.ts`) cleans two model-specific artifacts that are *valid
strings* and so slip past validation entirely:

- **Anchor bleed** — leading `^` / trailing `$` bled into a value
  (`read {path: "^/x$"}` → `{path: "/x"}`).
- **Grammar-token leaks** — GLM `<arg_key>`/`<arg_value>` markers stuck onto
  object keys or values (`{"<arg_key>pattern</arg_key>": "<arg_value>foo</arg_value>"}`
  → `{pattern: "foo"}`).

Both are gated on the current model id — anchor bleed on `kimi-k2` / `minimax` /
`glm`, grammar tokens on `glm` — since these are model-specific quirks. Each
strip emits a `<repair_note>` and telemetry exactly like an engine repair, and
the strips are adapted from [pi-tool-repair](#prior-art). One improvement over
upstream: the anchor strip **skips `grep.pattern`**, the one built-in field
that is a real regex, where a `^`/`$` may be intended syntax and is
indistinguishable from a bled anchor — so it is never guessed at.
(`find.pattern` is a glob, not a regex, so it is *not* exempt.) Whether anchor
bleed happens on pi at all is an open empirical question; shipping the strips
instrumented answers it for free.

## Grammar-leak recovery (opt-in)

When a model prints a tool call as text (a [grammar leak](#glossary)) instead of
emitting a real one, `src/grammar-recovery.ts` (adapted from
[pi-tool-repair](#prior-art), 10 grammar families, code-fence-aware) handles it
on pi's `message_end` hook. Modes, set via `/repair-settings`:

- **`off`** — never touch assistant text.
- **`strip`** (default) — remove the leaked grammar from the text on gated
  models, but never promote it to an executable call.
- **`recover`** — additionally promote the parsed call to a real tool call that
  executes the same turn and re-enters this layer's `prepareArguments` repair
  path. A recovery note is stashed so the executed call surfaces
  `<repair_note>recovered a leaked … tool call…</repair_note>`.

Because promotion turns model *text* into *execution*, it is guarded: opt-in
`recover` mode, a known-tool allowlist, an empty-arguments skip, role
preservation, and a **stopReason gate** — a call is promoted only when the
original message's `stopReason` is `"stop"`. Upstream promotes regardless and
overwrites `stopReason: "length"`, which would defeat pi's protection that fails
all tool calls on truncated output ([research.md Claim 7][r-claim7]). Stripping
leaked text is allowed on any stopReason; only promotion is gated.

## Design: validate-then-repair, hooked pre-validation

pi's agent loop runs, per tool call ([research.md Claim 1][r-claim1]):

```
tool.prepareArguments(raw) → validateToolArguments() → tool_call event → execute
```

Every mechanical claim in this section is verified against pi's source, with
file:line citations and a verification date, in
[`docs/research.md`](docs/research.md); the linked claim numbers point at the
specific entries. Automated tripwires in `test/upstream-drift.test.ts` execute
these claims against the installed pi so a pi upgrade can't invalidate them
silently.

Two consequences drove the architecture:

1. **The `tool_call` extension event fires *after* validation**
   ([research.md Claims 1–2][r-claim1]). A validation
   failure short-circuits to an error result before any event handler runs, so
   an extension listening on `tool_call` can never see — let alone repair —
   malformed input. (This is why repair extensions built on that hook can't
   work for built-in tools.) The only pre-validation seam is
   `prepareArguments`, which extensions reach by overriding a built-in tool via
   `pi.registerTool({ same name })`. Each override here spreads the original
   definition (`createReadToolDefinition(cwd)` etc. are exported from pi's
   root), so renderers, prompt metadata, and execution are the real built-ins;
   only `prepareArguments` is chained and `execute` thinly wrapped for notes.

2. **pi's own coercion (`Value.Convert`) silently corrupts the classic failure
   modes.** Measured on typebox 1.1.38, which pi validates with:

   | Model sends | Convert produces | Then |
   |---|---|---|
   | `'["a","b"]'` for an array | `['["a","b"]']` | passes validation, executes with garbage |
   | `null` for an optional string | `"null"` | passes, e.g. greps for the string `null` |
   | `null` for a required `path` | `"null"` | passes, reads a file named `null` |
   | `null` for an optional number | `0` | passes, offset silently zero |

   So this engine checks **strictly first** (no Convert) and repairs at the
   strict-error sites before Convert can mangle them. Benign coercions
   (`"5"` → `5`) still fall through to pi's native behavior untouched. The
   repair layer therefore doesn't just recover calls that would have errored —
   it fixes calls pi currently executes *wrongly*.

The engine itself follows the validate-then-repair shape commandcode's author
described publicly: parse as-is; if it succeeds, ship it untouched (fast path
returns the original object by reference); on failure, walk the validator's own
issue list and spend repair budget only at the paths the schema disagreed with;
re-validate; never ship a repair that doesn't verify. Rule order is fixed —
JSON-array parsing before bare-string wrapping, renames before null-drops.

The one deliberate preprocess (not validate-then-repair) is markdown auto-link
unwrapping on path fields, because `"/x/[notes.md](http://notes.md)"` is a
perfectly valid string that validation can never flag. It unwraps only the
degenerate case where the link text equals the URL minus its protocol; real
markdown links pass through, and content fields are never touched.

## Telemetry (local only)

Repair outcomes append to `~/.pi/agent/tool-repair/telemetry.jsonl`: timestamp,
tool, model id, outcome, rules fired, an issue summary, and an FNV-1a
fingerprint of the (tool, failure-shape) pair — the same shape-fingerprint
trick commandcode uses to count distinct failure signatures. Inputs themselves
are never logged.

Records come on two channels. The **tool channel** (the default; records with no
`channel` field, so old logs read unchanged) keys on a tool, with `outcome` one
of `repaired`, `unrepairable`, or `recovered` (a promoted grammar-leak call).
The **message channel** (`channel: "message"`) records grammar strip-only events
— a leak removed with nothing promoted, so there is no tool to key on — with the
grammar family that was stripped. `/repair-stats` summarizes both:

```
/repair-stats
```

It reports repairs/recoveries by tool and by model, grammar strip-only events by
family, and a rules-fired tally. Watch per-model rates to catch a model
regressing on a specific contract.

Env switches: `PI_TOOL_REPAIR_LOG=1` logs decisions to stderr;
`PI_TOOL_REPAIR_TELEMETRY=off` disables telemetry (or set it to a path).

## Chaos test (deterministic live exercise)

`test/run-chaos.sh` + `test/chaos-provider.ts` register a scripted fake
provider that replays canned malformed tool calls through pi's real agent loop
(print mode via the `pi` binary, no network, no tokens), then reports the
`<repair_note>` lines the "model" saw and asserts on them. It exercises the full
path end-to-end — streaming, preflight, validation, repair, execution, and note
surfacing — and passes against pi 0.80.6:

```bash
test/run-chaos.sh
```

(An earlier pi release resolved the stream function before an extension's
custom provider finished registering, so this hung; 0.80.6 streams through the
registered provider correctly.) The `test/upstream-drift.test.ts` suite drives
the same real loop fully in-process (via pi-ai's faux provider), so the loop
behaviors this layer depends on are covered by `pnpm test` too, without the
`pi` binary.

## Display settings

Repaired tool calls get a `🔨 ✓ input repaired (rules...)` line appended to
their result row in the TUI; optionally the repair note text renders beneath
it. `/repair-settings` toggles the indicator and the note text independently,
and cycles the grammar-leak recovery mode (`off → strip → recover`; default
`strip`). All three persist to `~/.pi/agent/tool-repair/settings.json` (or
`PI_TOOL_REPAIR_SETTINGS=<path>`), alongside an optional `grammarAllowedTools`
list that restricts which tool names a leaked call may be promoted to (when
empty, the active tool set is used). Indicators are persisted per session via
custom entries, so they survive `/reload` and session resume.

## Unrepairable input

When repairs can't make the input valid, the layer raises a model-readable
retry error (`Invalid input for tool "write". Fix these issues and retry: ...`)
instead of passing the input through — passing through would let pi's
`Value.Convert` coerce it into garbage (`content: null` becomes the literal
string `"null"` on disk) and execute anyway. Set `PI_TOOL_REPAIR_PASSTHROUGH=1`
to restore pi's native behavior.

## Prior art

The value strips and the grammar-leak recovery approach come from
[`monotykamary/pi-tool-repair`](https://github.com/monotykamary/pi-tool-repair)
(MIT), Tom X Nguyen's pi extension. What this project adapted from it:

- The anchor-bleed and grammar-token-leak strips (`src/value-strips.ts`),
  reworked to run inside `prepareArguments`, to skip the `grep.pattern` regex
  field, and to report through this layer's repair-note / telemetry machinery.
- The grammar-leak recovery parsers, candidate selection, code-fence handling,
  and range removal (`src/grammar-recovery.ts`, ~10 grammar families), adapted
  in place with a one-line provenance header, plus the new `stopReason`
  promotion gate.

The two projects also share a common Command Code lineage in their
validate-then-repair engines (near-identical rule names and alias tables).

Where they differ is **which hook reaches a malformed built-in call**, and that
is mechanical, not a matter of quality. pi runs
`prepareArguments → validateToolArguments → tool_call event → execute`
([research.md Claim 1][r-claim1]). A malformed built-in call makes
`validateToolArguments` **throw** before the `tool_call` event ever fires
([Claim 2][r-claim1]), so a repair that keys on `tool_call` cannot see it; and
even for a call that does pass, the `tool_call` event only propagates a handler's
*in-place* mutation of `event.input`, never a reassignment ([Claim 3][r-claim3]).
pi-tool-repair's built-in repair keys on `tool_call`; this project overrides the
built-in tool so its repair runs in `prepareArguments`, the one seam ahead of
validation. That is why the two hooks reach different cases — see the cited
research entries for the source. Conversely, the capabilities assimilated here
(value strips, grammar recovery) live on hooks that *do* propagate their results
(`prepareArguments`, `message_end` — [Claim 4][r-claim4]), which is why adapting
them is sound.

[r-claim1]: docs/research.md#claim-1--loop-ordering-preparearguments-runs-before-validation-which-runs-before-the-tool_call-event
[r-claim3]: docs/research.md#claim-3--tool_call-event-in-place-input-mutation-propagates-reassignment-does-not
[r-claim4]: docs/research.md#claim-4--message_end-replacement-mutates-the-loops-message-in-place-listeners-are-awaited-and-the-replacement-executes-same-turn-with-a-role-guard
[r-claim7]: docs/research.md#claim-7--stopreason-length-causes-pi-to-fail-all-tool-calls-in-the-message

## Limitations

- Only pi's seven built-in tools are wrapped. Custom tools from other
  extensions aren't (pi has no API to wrap another extension's execute), but
  they can import `repairToolInput` from `src/repair-engine.ts` and use it in
  their own `prepareArguments`.
- Wrong-but-optional fields are invisible to validation by design: pi's schemas
  allow extra keys, so `grep {pattern, directory: "src"}` validates and
  silently searches the cwd. No validate-then-repair layer can catch this
  (commandcode's included); it would take strict schemas or key-similarity
  heuristics, both with false-positive costs.
- Unrepairable input falls through to pi's stock validation error, which is
  already model-readable (per-path issues plus the received arguments).
- If another extension also overrides a built-in tool, load order decides which
  override wins — they don't compose.
- Phantom tool calls (a tool-use stop reason with zero tool-call blocks) are not
  handled. On pi 0.80.6 that state is a clean terminal stop, not a recoverable
  retry ([research.md Claim 6][r-claim6]), so normalizing it would be cosmetic;
  it will be revisited only if a concrete stuck state is reproduced on a
  provider.

[r-claim6]: docs/research.md#claim-6--stopreason-error-and-aborted-is-terminal-not-a-retry
