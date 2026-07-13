# grammar-leak-recovery

## ADDED Requirements

### Requirement: Leaked tool-call grammar is stripped from assistant text
The extension SHALL detect, on the `message_end` hook, tool-call grammar leaked
into assistant text content (the grammar families adapted from pi-tool-repair) and
SHALL return a replacement message with the leaked ranges removed, whenever grammar
recovery is enabled (mode `strip` or `recover`) and the model gate matches. Detection SHALL be
code-fence-aware (fenced examples are not treated as leaks).

#### Scenario: Leaked DSML block removed from text
- **WHEN** an assistant message's text contains a recognizable leaked tool-call block
  for a known tool
- **THEN** the `message_end` handler returns a same-role replacement message whose text
  no longer contains the leaked block

#### Scenario: Code-fenced grammar is not a leak
- **WHEN** an assistant message quotes tool-call grammar inside a fenced code block
- **THEN** the message is not modified

### Requirement: Recovery mode promotes leaked calls to executable toolCalls
When mode is `recover`, the extension SHALL parse leaked grammar into tool calls and
append them as `toolCall` content on the replacement message with
`stopReason: "toolUse"`, so they execute in the same turn and re-enter the
extension's `prepareArguments` repair path. A recovery note SHALL be stashed at
promotion time so the executed call surfaces a `<repair_note>` describing the
recovery.

#### Scenario: Recovered call executes with a note
- **WHEN** mode is `recover` and an assistant message with `stopReason: "stop"`, no
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
toolCall content (strip-only in that case).

#### Scenario: Unknown tool is not promoted
- **WHEN** a leaked call names a tool that is not registered/allowed
- **THEN** the leaked text is stripped but no toolCall is appended

#### Scenario: Empty-argument candidate is skipped
- **WHEN** a leaked fragment parses to a tool name with an empty argument object
- **THEN** it is not promoted to a toolCall

### Requirement: Recovery mode is opt-in via settings
Grammar recovery SHALL be configured through the extension's persisted settings
(`/repair-settings`), with modes `off` | `strip` | `recover`. The default SHALL be
`strip` (still subject to the model gate). `recover` SHALL require explicit
opt-in.

#### Scenario: Default configuration never promotes
- **WHEN** the user has not changed grammar-recovery settings
- **THEN** leaked text may be stripped on gated models but no toolCall is ever promoted

### Requirement: Message-level telemetry for strip-only events
Strip-only grammar events (leak removed, nothing promoted) SHALL be recorded on a
message-level telemetry channel (no tool key) that `/repair-stats` reports alongside
tool-keyed records; promoted calls SHALL be recorded tool-keyed with a `recovered`
outcome. Existing telemetry records SHALL remain readable unchanged.

#### Scenario: Strip-only event appears in stats
- **WHEN** a leak is stripped without promotion and the user runs `/repair-stats`
- **THEN** the summary includes the strip-only event with its grammar family
