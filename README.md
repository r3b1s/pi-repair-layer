# pi-repair-layer

A tool-input repair layer for the [pi coding agent](https://github.com/earendil-works/pi), doing
what commandcode's repair layer does: catch the small, finite set of malformed
tool calls that open models emit, fix them at the exact paths the validator
flags, and tell the model what was fixed so it can self-correct next turn.

No LLM calls, no network, no uploaded telemetry. ~600 lines total.

## Install

```bash
ln -s /home/dev/Local/personal/pi-commandcode-conundrum ~/.pi/agent/extensions/pi-repair-layer
```

pi auto-discovers `~/.pi/agent/extensions/*/index.ts`. Remove the symlink to
uninstall. pi's TUI will show a one-time warning that built-in tools were
overridden — that is this extension working as intended.

At runtime pi's extension loader aliases `@earendil-works/pi-coding-agent` and
`typebox` to the running instance's own modules, so the extension always binds
to your live pi and its exact validator version. The `node_modules/` here is
only used for `bun test` and `tsc`.

```bash
bun install   # once, if you want to run the tests
bun test      # 29 tests: pure engine + end-to-end against pi's real tools
```

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

## Design: validate-then-repair, hooked pre-validation

pi's agent loop runs, per tool call:

```
tool.prepareArguments(raw) → validateToolArguments() → tool_call event → execute
```

Two consequences drove the architecture:

1. **The `tool_call` extension event fires *after* validation.** A validation
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
are never logged. Watch per-model repair rates to catch a model regressing on a
specific contract:

```
/repair-stats
```

Env switches: `PI_TOOL_REPAIR_LOG=1` logs decisions to stderr;
`PI_TOOL_REPAIR_TELEMETRY=off` disables telemetry (or set it to a path).

## Chaos test (deterministic live exercise) — KNOWN ISSUE, not yet passing

`test/run-chaos.sh` + `test/chaos-provider.ts` register a scripted fake
provider that replays canned malformed tool calls through pi's real agent loop
(print mode, no network, no tokens), then reports the `<repair_note>` lines the
"model" saw. **Current status: blocked on pi's custom-provider streaming.**
Findings so far, for whoever picks this up:

- With `api: "openai-completions"` + custom `streamSimple`, pi streams via the
  *builtin* openai-completions transport (openai SDK "Connection error." to the
  dummy baseUrl) — the `registerApiProvider` override registered by
  `ModelRegistry.applyProviderConfig` is not consulted at stream time.
- With a unique api id (`api: "chaos-scripted"`), the run hangs instead.
- `pi.registerProvider` itself works: the model resolves, and without `-e` pi
  correctly reports "Unknown provider".
- Suspects: pi's jiti extension loader may hand extensions a separate pi-ai
  module instance (separate `apiProviderRegistry`) than the one
  `agent-session`/`sdk.js` stream through, or print mode resolves the stream
  function before extension providers finish applying.

The repair mechanics themselves are fully covered by `bun test` (33 tests),
which drives pi's real tool definitions and validation pipeline in-process.

## Display settings

Repaired tool calls get a `🔨 ✓ input repaired (rules...)` line appended to
their result row in the TUI; optionally the repair note text renders beneath
it. Toggle each independently with `/repair-settings` (persisted to
`~/.pi/agent/tool-repair/settings.json`, or `PI_TOOL_REPAIR_SETTINGS=<path>`).
Indicators are persisted per session via custom entries, so they survive
`/reload` and session resume.

## Unrepairable input

When repairs can't make the input valid, the layer raises a model-readable
retry error (`Invalid input for tool "write". Fix these issues and retry: ...`)
instead of passing the input through — passing through would let pi's
`Value.Convert` coerce it into garbage (`content: null` becomes the literal
string `"null"` on disk) and execute anyway. Set `PI_TOOL_REPAIR_PASSTHROUGH=1`
to restore pi's native behavior.

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
