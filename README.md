# pi-repair-layer

pi-repair-layer repairs the small, predictable tool-call mistakes that can
derail an otherwise productive [pi](https://github.com/earendil-works/pi) turn.
Install it for pi's built-in tools, or follow the
[tool-owner integration guide](docs/tool-owner-integration.md) to bring the
same repair pipeline to tools in your own extension.

No LLM calls. No network requests. No uploaded telemetry.

### Example: Deepseek v4 Pro
![deepseek-v4-pro](https://raw.githubusercontent.com/r3b1s/media-assets/refs/heads/main/pi-things/repair-dsv4pro.webp)

### Example: GLM 5.2
![glm-5.2](https://raw.githubusercontent.com/r3b1s/media-assets/refs/heads/main/pi-things/repair-glm5.2.webp)

## Contents

- [Why use it?](#why-use-it)
- [Install](#install)
- [Terms in plain English](#terms-in-plain-english)
- [What it repairs](#what-it-repairs)
- [Safe by design](#safe-by-design)
- [Use it in your own extension](#use-it-in-your-own-extension)
- [Settings and local telemetry](#settings-and-local-telemetry)
- [Documentation](#documentation)
- [Prior art](#prior-art)
- [Limitations](#limitations)
- [Development](#development)

## Why use it?

Models often understand the task but miss a detail of the tool contract:

| Model sends | Tool expects |
|---|---|
| `{file_path: "/x"}` | `{path: "/x"}` |
| `{include: "src"}` | `{include: ["src"]}` |
| `{offset: null}` | omit optional `offset` |
| `'{"command":"ls"}'` | `{command: "ls"}` |
| flat `old_string` / `new_string` fields | an `edits` array |

Without a pre-validation repair seam, pi may reject the call or convert a bad
value into valid-looking garbage. pi-repair-layer fixes only configured or
schema-proven cases, validates the result, executes it, and returns a
`<repair_note>` so the model learns the correct shape for its next call.

It covers pi's `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools.
Already-valid input takes the fast path and is returned untouched.

## Install

```bash
pi install npm:@r3b1s/pi-repair-layer
```

Or install directly from GitHub:

```bash
pi install git:github.com/r3b1s/pi-repair-layer
```

pi will show a one-time warning that built-in tools were overridden. The
extension reuses pi's real schemas, executors, renderers, and runtime modules;
it adds the pre-validation repair step.

## Terms in plain English

- **Tool call** — the model asking the agent to run a tool with structured arguments.
- **Schema / validation** — the rules for those arguments and the check that they fit.
- **Silent coercion** — a bad value being converted into a valid-looking but unintended value.
- **Grammar leak** — the model printing a tool call as text instead of making the call.
- **Anchor bleed** — stray `^` or `$` grammar characters attached to a non-regex value.
- **Phantom tool call** — a tool-use signal that contains no actual call to run.
- **Repair note** — a short explanation returned to the model after a repair.
- **Fast path** — returning valid input without changing or cloning it.
- **Path selector** — an address such as `/path` or `/edits/*/oldText` for one configured location.
- **Preprocessor** — an explicit cleanup that runs at a path selector before validation.
- **Invariant** — a safety rule that must remain true for every input.
- **Fail closed** — rejecting input when the pipeline cannot prove a safe, valid repair.

## What it repairs

The default adaptive policy handles:

- exact field aliases such as `file_path` → `path`, `cmd` → `command`, and
  `old_string` → `oldText`;
- JSON-stringified objects and arrays, singleton object envelopes, and bare
  strings where a configured object or array is expected;
- invalid optional `null` values and empty object placeholders;
- markdown auto-links in configured filesystem paths;
- the legacy flat edit shape used by several coding agents; and
- model-gated anchor bleed and leaked argument tokens at configured locations.

Unknown keys are not fuzzily renamed or generically deleted. See
[How repair works](docs/how-it-works.md) for the ordered pipeline, complete
repair catalog, grammar handling, and the reasoning behind the hook placement.

## Safe by design

The pipeline recovers the outer argument envelope, chains the tool owner's
compatibility hook, applies explicitly scoped preprocessing, validates strictly,
repairs only reported schema issues, and validates again before returning a
repaired result.

- Valid input stays untouched unless an explicitly configured valid-value
  transform applies.
- Every mutation carries a stable rule ID and model-facing note.
- Repair work is bounded, deterministic, and covered by property and seeded-fuzz tests.
- Unrepairable input produces a model-readable retry error rather than `{}` or guessed values.
- Telemetry stays local and excludes arguments, paths, commands, content, and note text.
- Turning assistant text into an executable tool call always requires explicit `recover` mode.

| Profile | Tool arguments | Grammar text | Promotion |
|---|---|---|---|
| `conservative` | exact, schema-guided repair | observe only | never |
| `adaptive` (default) | adds validated/model-gated recovery | strip known tools | never |
| `recover` | same as adaptive | strip known tools | safety-gated |

Unknown or unavailable tool grammar is preserved by default in every profile.
The [behavior and safety reference](docs/how-it-works.md) explains the gates and
invariants in detail.

## Use it in your own extension

Tools registered by other extensions are not intercepted automatically: their
owner must opt in at the `prepareArguments` boundary.

Working with a coding agent? The integration is packaged as the
[`pi-tool-repair-integration`](https://github.com/r3b1s/pi-dev-skills) agent
skill: `npx skills add r3b1s/pi-dev-skills --skill pi-tool-repair-integration`.

```ts
import { adaptToolDefinition } from "@r3b1s/pi-repair-layer/pi";

pi.registerTool(
  adaptToolDefinition(definition, {
    policy: "adaptive",
    preprocessors: [
      { kind: "alias", selector: "/path", aliases: ["file_path"] },
    ],
  }),
);
```

The adapter chains an existing owner hook and fails closed by default. The
[full integration guide](docs/tool-owner-integration.md) covers selectors,
custom transforms, the side-effect-free `/core` API, call-ID correlation,
`<repair_note>` attachment, privacy, and integration tests.

Public subpaths are compiled ESM with declarations and source maps:

- `@r3b1s/pi-repair-layer/pi` — tool-owner adapter;
- `@r3b1s/pi-repair-layer/core` — pure pipeline, policy, lifecycle, and formatting APIs; and
- `@r3b1s/pi-repair-layer/grammar` — pure grammar parsing and recovery helpers.

Node 22+ is supported; pi 0.80.6 is the verified baseline. Documented exports
follow semantic versioning, and the existing `repairToolInput` API remains
supported for the current major.

## Settings and local telemetry

All telemetry stays on your machine and is used only for debugging and tracing tool-call repairs; nothing is sent or uploaded.

- `/repair-settings` changes the policy, grammar mode, unknown-tool text policy,
  TUI indicator, and visible repair notes.
- `/repair-stats` summarizes local repair outcomes by model, tool, and rule.
- `PI_TOOL_REPAIR_LOG=1` prints decisions to stderr.
- `PI_TOOL_REPAIR_TELEMETRY=off` disables local telemetry.
- `PI_TOOL_REPAIR_PASSTHROUGH=1` restores pi's native behavior for unrepairable input.

Settings persist under `~/.pi/agent/tool-repair/`. See the
[operations guide](docs/operations.md) for paths, record contents, privacy,
diagnostics, and verification commands.

## Documentation

- [Integrating extension-owned tools](docs/tool-owner-integration.md)
- [How repair works: behavior, safety, and limitations](docs/how-it-works.md)
- [Operations, settings, telemetry, and verification](docs/operations.md)
- [Source-backed pi integration research](docs/research.md)

## Prior art

The value-strip rules and grammar-recovery approach originate in Tom X Nguyen's
MIT-licensed [`monotykamary/pi-tool-repair`](https://github.com/monotykamary/pi-tool-repair).
This project adapted its anchor/token cleanup and grammar parsers, then scoped
the transforms, added reporting, and gated executable promotion.

The key integration difference is mechanical: pi runs
`prepareArguments → validation → tool_call → execute`. A malformed call fails
before `tool_call`, so this extension hooks the owning tool's
`prepareArguments`; the sequence and propagation behavior are verified in
[research Claims 1–4](docs/research.md#claim-1--loop-ordering-preparearguments-runs-before-validation-which-runs-before-the-tool_call-event).
See [How repair works](docs/how-it-works.md#prior-art-and-hook-placement) for the
full adaptation notes and comparison.

## Limitations

- Another extension's tools require owner opt-in through `/pi` or `/core`.
- Two extensions overriding the same built-in do not compose; load order wins.
- Similar but unconfigured aliases are not guessed.
- Phantom tool calls are not synthesized into calls.
- Grammar promotion is limited to recognized, non-empty calls for active or
  explicitly allowed tools and never runs on truncated output.

## Development

```bash
pnpm install
mise run ci              # typecheck + lint + tests
pnpm run test:package    # packed clean-consumer smoke test
pnpm run test:fuzz       # deterministic bounded fuzz campaign
test/run-chaos.sh        # scripted real pi-loop exercise
```

Larger fuzz runs and replay instructions are in the
[operations guide](docs/operations.md#verification).
