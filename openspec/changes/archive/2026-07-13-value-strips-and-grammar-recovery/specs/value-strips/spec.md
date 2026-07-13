# value-strips

## ADDED Requirements

### Requirement: Anchor-bleed strip on affected models
The extension SHALL strip leading `^` and trailing `$` characters from string values
(including strings nested in arrays and objects) of built-in tool inputs inside
`prepareArguments`, before the validate-then-repair engine runs, when the current
model ID matches a known anchor-bleed model family (`kimi-k2`, `minimax`, `glm`,
case-insensitive).

#### Scenario: Bled anchors removed from a path value
- **WHEN** the current model matches an anchor-bleed family and a `read` call arrives
  with `{path: "^/home/user/file.ts$"}`
- **THEN** the input passed onward is `{path: "/home/user/file.ts"}` and a repair note
  and telemetry record are emitted for the strip

#### Scenario: Unaffected model is untouched
- **WHEN** the current model does not match any anchor-bleed family and a call arrives
  with `{path: "^/x$"}`
- **THEN** the value is passed through unmodified by the strip pre-pass

### Requirement: Regex-typed fields are exempt from anchor stripping
The anchor-bleed strip SHALL NOT modify fields where regex anchors are legitimate
syntax. The exemption list SHALL contain `grep.pattern`.

#### Scenario: Intentional grep anchor preserved
- **WHEN** the current model matches an anchor-bleed family and a `grep` call arrives
  with `{pattern: "^import React"}`
- **THEN** the pattern is passed through unmodified

#### Scenario: Non-exempt field on the same call is still stripped
- **WHEN** the same `grep` call also carries `{path: "^/src$"}`
- **THEN** `path` is stripped to `/src` while `pattern` remains unmodified

### Requirement: Grammar-token leak strip on affected models
The extension SHALL remove leaked grammar tokens (`<arg_key>`, `</arg_key>`,
`<arg_value>`, `</arg_value>`) from the starts/ends of input object keys and string
values (recursively) inside `prepareArguments`, when the current model ID matches a
known grammar-leak model family (`glm`, case-insensitive).

#### Scenario: Leaked key and value tokens removed
- **WHEN** a `glm`-family model produces `{"<arg_key>pattern</arg_key>": "<arg_value>foo</arg_value>"}`
  for `grep`
- **THEN** the input passed onward is `{pattern: "foo"}` and a repair note and
  telemetry record are emitted

### Requirement: Strips run before the repair engine and reuse its reporting
The strip pre-pass SHALL run at the top of `prepareArguments`, before the
validate-then-repair engine, and SHALL report through the existing repair-note
(`stashRepair` → `<repair_note>` / TUI indicator) and telemetry machinery, with a
distinct rule identifier per strip.

#### Scenario: Strip then engine repair on one call
- **WHEN** a single input both carries a bled anchor and fails schema validation for a
  reason the engine can repair
- **THEN** the strip is applied first, the engine then repairs the stripped input, and
  the surfaced repair note lists both rule identifiers
