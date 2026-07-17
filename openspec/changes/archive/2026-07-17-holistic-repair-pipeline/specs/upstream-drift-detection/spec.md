# upstream-drift-detection

## ADDED Requirements

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
