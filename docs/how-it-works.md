# How repair works

This document is the detailed behavior and safety reference for
pi-repair-layer. For a shorter overview and installation instructions, start
with the [README](../README.md). Tool authors should also read the
[integration guide](tool-owner-integration.md).

## Pipeline

Tool arguments move through these ordered stages:

1. bounded raw-envelope recovery;
2. the tool owner's compatibility `prepareArguments` hook;
3. selector-guided preprocessing;
4. policy/model-gated cleanup of values that already satisfy the schema;
5. strict validation without native conversion;
6. bounded iterative repair at reported schema-issue locations;
7. native conversion and final validation; and
8. structured outcome and result feedback.

Every mutation has a stable rule ID, pipeline stage, and explanatory note. A
`repaired` outcome is impossible unless the final value passes the supplied
schema. An `unrepairable` outcome preserves the original input and reports no
claimed changes.

### Profiles

| Profile | Envelope, exact preprocessing, schema repair | Truncated completion and model-gated value cleanup | Grammar text | Promotion |
|---|---|---|---|---|
| `conservative` | yes | observe only | observe only | never |
| `adaptive` | yes | schema-validated | strip known tools | never |
| `recover` | yes | schema-validated | strip known tools | gated known-tool calls |

`adaptive` is the default for new and migrated non-recover installs. Existing
users who explicitly enabled grammar recovery migrate to `recover` without
losing that choice.

Unknown or disallowed tool grammar is preserved under every profile. A separate
`unknownGrammarText: "strip"` setting can remove it, but can never make the
unknown call executable. The narrow grammar override supports `off`, `observe`,
`strip`, and `recover`.

## Repair catalog

### Envelope recovery

Before inspecting individual fields, the pipeline can:

- decode recursively JSON-stringified argument objects within configured limits;
- escape raw control characters inside JSON strings;
- unwrap a singleton array containing one plain object; and
- under adaptive/recover policy, try a fixed set of closing suffixes for a
  truncated object.

A truncated candidate is accepted only if the complete downstream pipeline
validates it. Non-singleton arrays are never discarded into defaults, and
unrecoverable input never becomes `{}`.

### Schema-guided repairs

The iterative engine repairs only locations reported by strict validation. Its
fixed rules include:

| Rule | Example | Result |
|---|---|---|
| exact alias | `{file_path: "/x"}` | `{path: "/x"}` |
| drop invalid optional null | `{path: "/x", offset: null}` | `{path: "/x"}` |
| drop empty object placeholder | `{tags: {}}` where array expected | omit `tags` |
| parse stringified array | `{include: '["a","b"]'}` | `{include: ["a", "b"]}` |
| parse stringified object | object field contains JSON text | parsed object |
| wrap string as array | `{include: "foo"}` | `{include: ["foo"]}` |
| wrap root string | `"echo hi"` for bash | `{command: "echo hi"}` |
| structural edit fold | flat old/new fields | canonical `edits` array |

Aliases and structural changes must be configured by the tool owner. The
pipeline does not use edit distance, semantic guessing, or generic unknown-key
deletion. Built-in alias configuration covers common Claude Code shapes such as
`file_path`, `old_string`, and `new_string`; aider-style `search` and `replace`;
and generic alternatives including `cmd`, `query`, `text`, and `contents`,
including configured nested edit fields.

### Selector-guided preprocessing

Some bad values pass validation because they have the right JSON type.
Preprocessors address only configured semantic locations such as `/path`,
`/files/*`, or `/edits/*/oldText`.

Available selector preprocessors include:

- markdown auto-link cleanup on filesystem paths;
- string-or-array and scalar compatibility conversions;
- exact optional aliases that would otherwise pass as extra keys;
- model-gated anchor bleed cleanup; and
- model-gated `<arg_key>` / `<arg_value>` token cleanup.

The built-in tools use exact aliases, filesystem-path cleanup, model-gated
artifact cleanup, and the edit structural fold at their known-safe locations.
Custom tool owners can opt into the other selector kinds described in the
[integration guide](tool-owner-integration.md#configure-only-known-safe-transforms).

Anchor cleanup is never applied to `grep.pattern`, where `^` and `$` are valid
regex syntax. Content fields are not parsed or path-cleaned just because their
text resembles JSON or a filename. Markdown path cleanup unwraps only the
degenerate auto-link whose link text equals its URL without the protocol; real
markdown links remain unchanged.

The built-in model gates apply anchor cleanup to `kimi-k2`, `minimax`, and `glm`
families and grammar-token cleanup to `glm`. Custom tool owners choose their own
selectors and model-family expressions.

## Grammar-leak handling

A grammar leak occurs when a model prints its intended call as assistant text
instead of emitting a real tool call. The parser recognizes ten grammar
families adapted from pi-tool-repair and ignores examples inside fenced code.

- `off` leaves the message alone and records nothing.
- `observe` classifies recognized candidates without changing the message.
- `strip` removes recognized known-tool grammar without executing it.
- `recover` may promote a recognized call into a real same-turn tool call.

Promotion turns text into execution, so all of these gates must pass:

- the user explicitly selected `recover`;
- the message role is assistant;
- the original stop reason is `stop`, never `length`, `error`, or `aborted`;
- the message contains no real tool call already;
- the parsed arguments are non-empty; and
- the named tool is active or explicitly allowed.

The stop-reason gate preserves pi's protection that fails tool calls from
truncated output; see [research Claim 7](research.md#claim-7--stopreason-length-causes-pi-to-fail-all-tool-calls-in-the-message).

Unknown-tool text remains visible by default. Even the explicit unknown-text
strip setting removes text only; it cannot promote an unavailable tool.

When promotion succeeds, the generated call ID is associated directly with the
repair lifecycle so the eventual result receives one `<repair_note>`.

## Why repair runs before validation

pi's call sequence is:

```text
tool.prepareArguments(raw) → validateToolArguments() → tool_call → execute
```

The exact sequence, replacement propagation, and result lifecycle are verified
against pi source in [research Claims 1–5](research.md#claim-1--loop-ordering-preparearguments-runs-before-validation-which-runs-before-the-tool_call-event)
and exercised by upstream-drift tests.

A validation failure occurs before `tool_call`, so an event listener cannot
repair an invalid built-in call. pi-repair-layer instead replaces each built-in
definition with the original definition plus a chained `prepareArguments`.
Schemas, executors, prompt metadata, and renderers remain pi's own.

This ordering also prevents native conversion from silently changing classic
failure modes:

| Model sends | Native conversion can produce | Risk |
|---|---|---|
| `'["a","b"]'` for an array | `['["a","b"]']` | executes with one garbage item |
| `null` for an optional string | `"null"` | searches for or writes an unintended string |
| `null` for a required path | `"null"` | targets a file literally named `null` |
| `null` for an optional number | `0` | silently changes behavior |

The pipeline checks strictly first and repairs those issue locations before
native conversion. Benign conversion remains pi's responsibility when no
repair rule fires.

## Safety invariants

Property tests and deterministic fuzzing enforce that the core:

- does not throw or hang on bounded JSON-domain input;
- does not mutate caller-owned input or object prototypes;
- is deterministic and idempotent;
- preserves strictly valid input when no configured valid-value transform applies;
- records a note and stable rule ID for every mutation;
- reports repaired only after final schema validity; and
- terminates within configured byte, depth, attempt, candidate, and work limits.

Lifecycle queues are capped, expire stale entries, use FIFO collision handling,
and clear at session shutdown. Persisted indicators and telemetry contain only
value-free metadata. See the [operations guide](operations.md#telemetry-and-privacy)
for the exact record shape.

## Fail-closed behavior

If no bounded repair validates, the extension throws a model-readable retry
error before execution. This avoids returning raw input to native conversion,
which could turn `content: null` into the literal string `"null"` and write it.

`PI_TOOL_REPAIR_PASSTHROUGH=1` restores native behavior for compatibility, but
it weakens this guarantee and should be used deliberately.

## Prior art and hook placement

The value-strip rules and grammar-recovery approach come from Tom X Nguyen's
MIT-licensed [`monotykamary/pi-tool-repair`](https://github.com/monotykamary/pi-tool-repair).
This project adapted:

- anchor-bleed and grammar-token cleanup, moved to path-scoped preprocessing
  before validation, exempting regex fields, and reporting through the shared
  lifecycle; and
- grammar parsers, candidate selection, code-fence handling, and range removal,
  with stricter role, tool, empty-argument, and stop-reason promotion gates.

Both projects draw on Command Code's validate-then-repair approach. The
different built-in hook follows directly from pi's sequence: a malformed call
fails validation before `tool_call`, and a successful `tool_call` propagates
in-place mutation but not input reassignment. Those facts are documented with
source citations in [research Claims 1–4](research.md#claim-1--loop-ordering-preparearguments-runs-before-validation-which-runs-before-the-tool_call-event).

## Limitations

- The installable extension wraps pi's seven built-ins. Other tools require
  explicit owner integration through the compiled `/pi` adapter or `/core` API.
- Two extensions that replace the same built-in do not compose; load order
  determines which definition wins.
- Unconfigured aliases, structural guesses, and unknown-field deletion are out
  of scope.
- Phantom tool calls are not repaired. At the verified pi version, a tool-use
  stop with no call is a clean terminal state rather than a stuck retry loop;
  see [research Claim 6](research.md#claim-6--stopreason-error-and-aborted-is-terminal-not-a-retry).
- Grammar promotion cannot recover empty arguments, unavailable tools, existing
  real calls, or truncated output.
