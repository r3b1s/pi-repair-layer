## ADDED Requirements

### Requirement: Repairs are correlated to tool-call IDs
Pre-validation repairs SHALL enter a bounded pending queue until successful validation reaches `tool_call`, at which point the matching repair SHALL be associated with `toolCallId`. Grammar-recovered calls, whose IDs are created by this extension, SHALL be associated directly. Queues SHALL have FIFO collision handling, caps, TTLs, and session cleanup.

#### Scenario: Concurrent identical calls retain distinct lifecycle records
- **WHEN** two same-tool calls with identical repaired arguments are prepared concurrently and both validate
- **THEN** each tool-call ID receives exactly one corresponding repair record and neither record leaks to a later call

### Requirement: Global tool_result hook attaches model feedback
The extension SHALL use pi's `tool_result` event to prepend pending `<repair_note>` feedback to successful and error result content for built-in and custom tools. It SHALL preserve existing result details and error status and SHALL NOT insert the same tagged note more than once.

#### Scenario: Recovered custom tool receives its note
- **WHEN** grammar recovery promotes an allowed custom tool and that tool produces a result
- **THEN** the result returned to the model contains one recovery note even though pi-repair-layer did not wrap the custom tool's arguments or executor

#### Scenario: Error result retains error semantics
- **WHEN** a repaired call executes and returns an error result
- **THEN** the note is attached while `isError` and existing details remain unchanged

### Requirement: Result UI is width safe
Every line added by repair indicators or displayed repair notes SHALL be wrapped or truncated with pi's ANSI-aware width helpers using the renderer-supplied width. Built-in renderer behavior SHALL otherwise be preserved.

#### Scenario: Long repair note at narrow widths
- **WHEN** a repaired result with a long note is rendered at 40, 58, 66, 80, and 120 columns
- **THEN** every returned line has visible width less than or equal to the supplied width

### Requirement: Lifecycle reporting remains local and value free
Lifecycle telemetry and persisted indicator entries SHALL include tool, model, profile, stage, rule IDs, outcome, and non-value failure fingerprints as applicable, but SHALL NOT include raw/repaired arguments, paths, commands, content, or value-bearing note text. Existing telemetry records SHALL remain readable.

#### Scenario: Repair of a secret-bearing command is recorded safely
- **WHEN** a repair occurs on input containing a secret string
- **THEN** telemetry and session metadata identify the rule/outcome without containing the secret or repaired value
