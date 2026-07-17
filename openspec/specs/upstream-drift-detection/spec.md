# upstream-drift-detection

## Purpose

Detect when upstream pi changes break assumptions this extension relies on, via tripwire tests and schema snapshots.

## Requirements

### Requirement: Loop-ordering tripwire
The test suite SHALL verify, against the installed pi packages, that
`prepareArguments` runs before argument validation and that the `tool_call` event
does not fire for calls that fail validation.

#### Scenario: prepareArguments sees raw failing input
- **WHEN** an instrumented tool is driven through pi's real agent loop with input that
  fails schema validation
- **THEN** the test asserts `prepareArguments` received the raw input and no
  `tool_call` handler fired for that call

### Requirement: Event-propagation tripwire
The test suite SHALL verify pi's event-result propagation semantics that this
extension depends on: in-place mutation of a `tool_call` event's `input` reaches
`execute`, reassignment of `event.input` does not, and a `message_end` handler's
replacement message has its toolCalls executed in the same turn.

#### Scenario: In-place mutation propagates, reassignment is dropped
- **WHEN** one `tool_call` handler mutates `event.input` in place and another test run
  reassigns `event.input` to a new object
- **THEN** the executed arguments reflect the in-place mutation but not the reassignment

#### Scenario: message_end replacement executes same-turn
- **WHEN** a `message_end` handler returns a same-role replacement containing a
  toolCall
- **THEN** that toolCall's tool executes before the turn completes

### Requirement: Built-in schema-shape snapshot
The test suite SHALL snapshot the live `parameters` schema of every built-in tool the
extension wraps against a checked-in fixture, failing on any drift, and SHALL assert
that no built-in schema contains a regex `pattern` keyword.

#### Scenario: Field rename is caught
- **WHEN** a pi upgrade renames or retypes a field in a wrapped built-in's schema
- **THEN** the snapshot test fails, identifying the changed tool and field

#### Scenario: No-regex-pattern assumption holds
- **WHEN** the suite inspects all wrapped built-in schemas
- **THEN** it asserts none contains a JSON-schema `pattern` keyword

### Requirement: Length-truncation protection assertion
The test suite SHALL verify that pi fails all toolCalls on assistant messages with
`stopReason: "length"`, since the grammar-recovery stopReason gate defers to this
behavior.

#### Scenario: Truncated toolCalls are failed by pi
- **WHEN** an assistant message with `stopReason: "length"` and a toolCall is driven
  through the loop
- **THEN** the test asserts the toolCall is failed rather than executed

### Requirement: Verified-version canary
The repository SHALL declare a `VERIFIED_PI_VERSION` constant recording the pi
minor version the research claims were verified against. A test SHALL fail when the
installed `pi-coding-agent` minor version differs, with a failure message pointing to
the re-verification checklist in `docs/research.md`. Patch-version differences SHALL
pass.

#### Scenario: Minor bump forces re-verification
- **WHEN** the installed pi-coding-agent moves from 0.80.x to 0.81.0
- **THEN** the canary test fails and its message names the research.md checklist

#### Scenario: Patch bump passes
- **WHEN** the installed pi-coding-agent moves from 0.80.6 to 0.80.7
- **THEN** the canary test passes

### Requirement: Tool-result propagation tripwire
The test suite SHALL verify against the installed pi packages that a global
`tool_result` handler receives successful and failed results for built-in and custom
tools, and that returning replacement `content`, `details`, or `isError` values is
observed by the agent loop. The tripwire SHALL also verify the handler-composition
semantics relied on by repair-note attachment.

#### Scenario: Replacement result reaches the conversation
- **WHEN** a `tool_result` handler prepends a repair note to a successful built-in
  tool result
- **THEN** the result stored in the conversation contains the note and preserves the
  original result fields

#### Scenario: Failed custom-tool result is observable
- **WHEN** a custom tool owned by a cooperating extension returns an error result
- **THEN** the global handler receives its call ID and may attach a correlated note
  without changing the error status

### Requirement: Public-package drift tripwire
The test suite SHALL install or pack the published artifact shape and import every
documented subpath using Node's ESM resolver, so source-only imports or missing build
outputs fail before release.

#### Scenario: Missing compiled subpath is caught
- **WHEN** a documented package export points to a file absent from the packed npm
  artifact
- **THEN** the packaging tripwire fails with the missing export path
