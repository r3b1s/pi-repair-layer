# Operations and verification

This guide covers pi-repair-layer's user settings, local telemetry, diagnostics,
and test commands. Behavior and safety details live in
[How repair works](how-it-works.md).

## Runtime binding

pi's extension loader aliases `@earendil-works/pi-coding-agent` and `typebox` to
the running pi installation, so the extension uses the live runtime's own
modules and validator. This repository's `node_modules/` exists for development,
typechecking, and tests; it is not a second runtime loaded beside pi.

## Display and policy settings

Run this command in pi:

```text
/repair-settings
```

The menu controls:

- policy profile: `conservative`, `adaptive`, or `recover`;
- grammar override: `off`, `observe`, `strip`, or `recover`;
- unknown-tool grammar text: `preserve` or `strip`;
- the `🔨 ✓ input repaired (rules...)` TUI indicator; and
- visible repair-note text beneath the result.

Settings are stored at:

```text
~/.pi/agent/tool-repair/settings.json
```

Override the location with `PI_TOOL_REPAIR_SETTINGS=<path>`. Existing settings
migrate in memory and are not rewritten until the user saves them again.

An optional `grammarAllowedTools` list restricts names eligible for promotion.
When it is empty, the active tool set is used. Unknown or disallowed calls are
never executable.

Repair indicators are persisted as value-free custom session entries, so they
survive `/reload` and session resume. The notes themselves are deliberately not
persisted.

## Telemetry and privacy

Repair outcomes append locally to:

```text
~/.pi/agent/tool-repair/telemetry.jsonl
```

Each JSONL record may include timestamp, tool, model ID, profile, pipeline
stages, stable rule IDs, outcome, issue summary, grammar family, and an FNV-1a
fingerprint of the tool/failure shape.

Records never include raw or repaired arguments, filesystem paths, commands,
content, secrets, or value-bearing note text.

There are two channels:

- Tool records identify `repaired`, `unrepairable`, or `recovered` outcomes.
- Message records describe observe/strip grammar events that have no tool-call
  ID to attach to.

Summarize the local records from pi with:

```text
/repair-stats
```

The report groups outcomes by tool and model and tallies rule and grammar
families. Existing telemetry records remain readable as fields are added.

Environment controls:

| Variable | Effect |
|---|---|
| `PI_TOOL_REPAIR_TELEMETRY=off` | Disable telemetry. |
| `PI_TOOL_REPAIR_TELEMETRY=<path>` | Write telemetry to another file. |
| `PI_TOOL_REPAIR_LOG=1` | Print repair decisions to stderr. |
| `PI_TOOL_REPAIR_PASSTHROUGH=1` | Return unrepairable input to pi's native conversion instead of failing closed. |

## Verification

The repository uses Node 22, pnpm, Vitest, TypeScript, Biome, and ESLint. Tool
versions and combined tasks are managed with mise.

```bash
pnpm install
mise run ci
```

`mise run ci` runs strict typechecking, both linters, and the complete Vitest
suite. Additional release checks are:

```bash
pnpm run test:package
pnpm run test:fuzz
test/run-chaos.sh
```

- `test:package` builds and packs the npm artifact, installs it into a clean
  temporary consumer, imports every public subpath, and typechecks the fixture.
- `test:fuzz` runs the bounded deterministic raw-envelope campaign.
- `run-chaos.sh` registers a scripted provider and drives malformed calls
  through the real pi binary without network requests or tokens.

The in-process upstream-drift suite also drives pi's real agent loop using the
faux provider. It asserts the ordering, event propagation, result replacement,
handler composition, schema shapes, truncation protection, and verified pi
minor version used by this extension.

### Larger and replayed fuzz runs

Run 10,000 local cases:

```bash
pnpm run test:fuzz:large
```

Replay a reported seed and case budget:

```bash
PI_REPAIR_FUZZ_SEED=<seed> \
PI_REPAIR_FUZZ_CASES=<count> \
pnpm run test:fuzz
```

A discovered failure prints its seed and minimized input. Confirmed failures
should become named regression fixtures.

## Upgrading pi

`docs/research.md` records every pi behavior the implementation relies on, with
source locations and the verification date. Before changing the verified pi
minor version, follow the
[re-verification checklist](research.md#re-verification-checklist-run-on-any-pi-minor-bump)
and run all checks above.
