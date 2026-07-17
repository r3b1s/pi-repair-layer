## ADDED Requirements

### Requirement: Preprocessors are scoped to explicit schema locations
Configurable preprocessors SHALL address fields using documented object-location selectors, including an array-item wildcard, and SHALL distinguish filesystem paths, filesystem-path arrays, glob strings, string-or-array fields, scalar coercions, aliases, and structural transforms. Unconfigured content SHALL remain untouched even when it resembles JSON, a path, or a grammar token.

#### Scenario: Configured array items are cleaned
- **WHEN** `/files/*` is configured as a filesystem-path item selector and an item contains a markdown auto-link representation of the same path
- **THEN** only matching array items are unwrapped and an explanatory change is recorded

#### Scenario: JSON-looking file content is preserved
- **WHEN** a write tool's `/content` field contains a JSON-looking string but has no structured-data preprocessor
- **THEN** preprocessing leaves the content byte-for-byte unchanged

### Requirement: Exact optional aliases run before strict-valid fast return
An exact configured alias SHALL be eligible before the pipeline returns strictly valid input, including when pi's permissive object schema accepts the alias as an extra key and the canonical optional field is absent. The alias SHALL be moved only at its configured selector and only when its value passes the configured compatibility guard.

#### Scenario: Wrong optional alias would otherwise validate
- **WHEN** a tool accepts optional `/path`, the input contains configured alias `directory` but no `path`, and the object otherwise validates
- **THEN** preprocessing renames `directory` to `path` and reports the repair before the fast return

### Requirement: Empty canonical replacement is schema/config gated
A non-empty configured alias MAY replace a present empty canonical value only when that canonical selector is invalid-empty under its schema or explicitly configured as empty-equivalent-to-missing. Empty values that are semantically valid SHALL block alias replacement.

#### Scenario: Empty required path is replaced
- **WHEN** `/path` rejects an empty string, `path` is empty, and configured alias `file_path` contains a compatible non-empty value
- **THEN** preprocessing replaces `path`, removes `file_path`, and reports the alias repair

#### Scenario: Empty file content remains valid
- **WHEN** `/content` permits an empty string and an unrelated content alias is also present
- **THEN** preprocessing preserves the canonical empty content and does not choose the alias

### Requirement: No fuzzy or generic unknown-field repair
The default pipeline SHALL NOT use edit distance, semantic guessing, or generic unknown-key deletion. Keys outside explicit alias/structural configuration SHALL be preserved for normal schema handling.

#### Scenario: Similar unknown key is not guessed
- **WHEN** input contains `paht` and configuration does not list it as an alias for `/path`
- **THEN** preprocessing does not rename or delete it
