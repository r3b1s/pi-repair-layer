# grammar-leak-recovery

## Purpose

Detect and recover tool-call grammar that LLMs leak into assistant text content instead of emitting as proper tool calls. Supports strip-only and full recovery modes.

## Requirements

### Requirement: Leaked tool-call grammar is stripped from assistant text
The extension SHALL detect, on the `message_end` hook, tool-call grammar leaked
into assistant text content (the grammar families adapted from pi-tool-repair).
Detection SHALL be code-fence-aware. A matched range SHALL be removed only when
the active grammar policy permits stripping or promotion; observation and
preservation policies SHALL leave assistant text unchanged.

#### Scenario: Leaked DSML block removed in strip mode
- **WHEN** an assistant message's text contains a recognizable leaked tool-call block
  for a known tool and the active policy permits stripping
- **THEN** the `message_end` handler returns a same-role replacement message whose text
  no longer contains the leaked block

#### Scenario: Observation does not modify text
- **WHEN** an assistant message contains a recognizable grammar leak and the active
  policy permits observation but not stripping or promotion
- **THEN** the message content is unchanged and a value-free observation is recorded

#### Scenario: Code-fenced grammar is not a leak
- **WHEN** an assistant message quotes tool-call grammar inside a fenced code block
- **THEN** the message is not modified or recorded as a leak

### Requirement: Recovery mode promotes leaked calls to executable toolCalls
When recovery is explicitly enabled, the extension SHALL parse leaked grammar into
tool calls and append them as `toolCall` content on the replacement message with
`stopReason: "toolUse"`, so they execute in the same turn and re-enter the consuming
tool owner's `prepareArguments` repair path. The extension SHALL correlate the
promoted call with its call ID so the global result lifecycle surfaces a
`<repair_note>` describing the recovery, including when the promoted tool is owned
by a cooperating extension.

#### Scenario: Recovered call executes with a note
- **WHEN** recovery is enabled and an assistant message with `stopReason: "stop"`, no
  existing toolCalls, and a parseable leaked call for a known tool ends
- **THEN** the replacement message carries the parsed toolCall, the tool executes in
  the same turn, and its result includes a `<repair_note>` describing the recovery

### Requirement: Recovery is gated on stopReason
The extension SHALL promote leaked calls to toolCalls only when the original
message's `stopReason` is `"stop"`. Messages with `stopReason` `"length"`, `"error"`,
or `"aborted"` SHALL never have calls promoted (text stripping remains permitted).
This preserves pi's protection that fails all toolCalls on truncated
(`stopReason: "length"`) output.

#### Scenario: Truncated message is not promoted
- **WHEN** mode is `recover` and a message with `stopReason: "length"` contains a
  parseable leaked call
- **THEN** no toolCall is appended and `stopReason` is not modified

### Requirement: Upstream safety gates are preserved
Recovery SHALL apply only to assistant-role messages, SHALL keep the replacement
message's role identical to the original, SHALL only promote calls whose tool name is
in the active/allowed tool set, SHALL skip candidates that parse to an empty argument
object, and SHALL NOT promote any call when the message already contains real
toolCall content. Text for an unknown or disallowed tool SHALL be preserved by
default; it MAY be stripped only by an explicit unknown-tool stripping policy.

#### Scenario: Unknown tool is preserved and not promoted
- **WHEN** a leaked call names a tool that is not registered or allowed and no
  explicit unknown-tool stripping policy is active
- **THEN** the leaked text remains in the assistant message and no toolCall is appended

#### Scenario: Explicit policy strips an unknown tool without promotion
- **WHEN** a leaked call names an unknown tool and explicit unknown-tool stripping is
  active
- **THEN** the leaked text is removed but no toolCall is appended

#### Scenario: Empty-argument candidate is skipped
- **WHEN** a leaked fragment parses to a tool name with an empty argument object
- **THEN** it is not promoted to a toolCall

### Requirement: Recovery mode is opt-in via settings
Grammar handling SHALL support `off`, `observe`, `strip`, and `recover` behaviors
selected by the active repair policy profile, with a narrow explicit override
available in persisted settings. Promotion SHALL always require explicit `recover`
selection. Existing `off`, `strip`, and `recover` settings SHALL migrate without a
behavior change.

#### Scenario: Existing strip setting remains strip-only
- **WHEN** settings written by the previous release contain grammar mode `strip`
- **THEN** leaked text may be stripped on gated models but no toolCall is promoted

#### Scenario: Recovery remains opt-in
- **WHEN** neither the selected profile nor its explicit override enables `recover`
- **THEN** the extension never promotes assistant text into an executable toolCall

### Requirement: Message-level telemetry for strip-only events
Strip-only grammar events (leak removed, nothing promoted) SHALL be recorded on a
message-level telemetry channel (no tool key) that `/repair-stats` reports alongside
tool-keyed records; promoted calls SHALL be recorded tool-keyed with a `recovered`
outcome. Existing telemetry records SHALL remain readable unchanged.

#### Scenario: Strip-only event appears in stats
- **WHEN** a leak is stripped without promotion and the user runs `/repair-stats`
- **THEN** the summary includes the strip-only event with its grammar family
