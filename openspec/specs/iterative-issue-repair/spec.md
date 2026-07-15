# iterative-issue-repair

## Purpose

Converge on valid tool input when one repair exposes problems the initial
validation pass could not see — e.g. parsing a JSON-stringified `edits` array
reveals aliased field names inside the parsed elements.

## Requirements

### Requirement: Per-issue repairs iterate until valid or no progress
The repair engine's per-issue stage SHALL re-validate and re-collect issue
sites after any pass in which at least one repair rule fired, and SHALL run
further passes over the newly collected sites. Iteration SHALL stop as soon as
the value validates against the tool schema, when a full pass fires no rule,
or when a bounded maximum pass count is reached — whichever comes first.

#### Scenario: Stringified array with aliased fields inside
- **WHEN** an `edit` call arrives with `edits` as a JSON-stringified array whose
  elements use aliased field names, e.g.
  `{path: "/a.txt", edits: "[{\"old_text\":\"foo\",\"new_text\":\"bar\"}]"}`
- **THEN** the outcome is `repaired` with
  `edits: [{oldText: "foo", newText: "bar"}]`, having fired
  `parseJsonStringifiedArray` on the first pass and `renameAliasedField` on a
  subsequent pass

#### Scenario: No progress terminates iteration
- **WHEN** input fails validation and no repair rule applies to any collected
  issue site
- **THEN** the engine returns `unrepairable` after a single pass, without
  spinning through remaining pass budget

### Requirement: Single-pass repairs are unchanged
Input that the first pass fully repairs SHALL behave exactly as before
iteration existed: the same rules fire once and no additional notes or rule
firings are recorded by subsequent passes.

#### Scenario: Stringified array with valid elements
- **WHEN** an `edit` call arrives with `edits` as a JSON-stringified array whose
  elements already use canonical `oldText`/`newText` fields
- **THEN** the outcome is `repaired` with only `parseJsonStringifiedArray`
  fired
