# value-strips

## MODIFIED Requirements

### Requirement: Anchor-bleed strip on affected models
The extension SHALL strip leading `^` and trailing `$` characters from string values
at configured semantic path fields inside `prepareArguments`, before the
validate-then-repair engine runs, only when the current model ID matches a configured
anchor-bleed family and the active policy permits the transform. The transform SHALL
be schema/path scoped rather than recursively applied to every string.

#### Scenario: Bled anchors removed from a configured path value
- **WHEN** the current model matches an anchor-bleed family, the active policy permits
  the transform, and a `read` call arrives with `{path: "^/home/user/file.ts$"}`
- **THEN** the input passed onward is `{path: "/home/user/file.ts"}` and a repair note
  and telemetry record are emitted for the strip

#### Scenario: Conservative policy observes but does not strip
- **WHEN** a matching model supplies `{path: "^/x$"}` under a policy that permits
  observation but not anchor mutation
- **THEN** the value is unchanged and any observation record contains no input value

#### Scenario: Unaffected model is untouched
- **WHEN** the current model does not match any configured anchor-bleed family and a
  call arrives with `{path: "^/x$"}`
- **THEN** the value is passed through unmodified by the strip pre-pass

### Requirement: Grammar-token leak strip on affected models
The extension SHALL remove configured leaked grammar tokens such as `<arg_key>`,
`</arg_key>`, `<arg_value>`, and `</arg_value>` from configured object-key and string
value selectors inside `prepareArguments`, only when the current model ID matches a
configured grammar-leak family and the active policy permits the transform. The
extension SHALL NOT recursively strip arbitrary keys and values outside those
selectors.

#### Scenario: Leaked key and value tokens removed at configured selectors
- **WHEN** a `glm`-family model produces
  `{"<arg_key>pattern</arg_key>": "<arg_value>foo</arg_value>"}` for `grep`, the
  selectors cover those positions, and the active policy permits stripping
- **THEN** the input passed onward is `{pattern: "foo"}` and a repair note and
  telemetry record are emitted

#### Scenario: Policy disables grammar-token mutation
- **WHEN** a matching model produces grammar tokens under a policy that does not
  permit the transform
- **THEN** the input is unchanged by this preprocessor

### Requirement: Strips run before schema repair and reuse pipeline reporting
The configured value-strip preprocessors SHALL run before strict/schema-guided
repair and SHALL report through the shared structured change, call-ID lifecycle,
`<repair_note>`, TUI indicator, and value-free telemetry machinery, with a stable
rule identifier per strip. Tool-specific structural folds configured as
preprocessors SHALL use the same ordering and reporting path rather than relying on
an extension-only legacy pre-pass.

#### Scenario: Strip then schema repair on one call
- **WHEN** a single input both carries a bled anchor and fails schema validation for a
  reason the schema repair stage can repair
- **THEN** the strip is applied first, schema repair receives the stripped input, and
  the surfaced repair feedback lists both stable rule identifiers

#### Scenario: Configured edit fold runs in selector preprocessing
- **WHEN** an edit call uses the configured legacy flat edit fields
- **THEN** the selector preprocessing stage folds them into the canonical edit array
  before schema repair and reports the structural rule through the shared lifecycle
