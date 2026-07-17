# envelope-recovery

## Purpose

Recover bounded, lossless argument envelopes before tool-owner and schema-specific repair while preserving fail-closed behavior.

## Requirements

### Requirement: Bounded lossless envelope recovery
Before tool-owner and schema-specific preprocessing, the pipeline SHALL recover plain-object arguments from recursively JSON-stringified objects, raw control characters inside JSON strings, and singleton arrays containing one plain object. Decode depth, input bytes, nesting, attempts, and candidate counts SHALL be bounded.

#### Scenario: Double-encoded object is recovered
- **WHEN** the raw arguments are a JSON string whose decoded value is another JSON string containing an argument object within the configured depth limit
- **THEN** the envelope stage returns the decoded object and records each envelope repair

#### Scenario: Singleton object array is unwrapped
- **WHEN** the raw arguments are an array containing exactly one plain object and the root schema expects an object
- **THEN** the envelope stage returns that object with an explanatory repair change

### Requirement: Schema-validated truncated-object completion
The adaptive and recover policies MAY try a fixed allowlist of closing suffixes for an object-shaped truncated JSON string. A candidate SHALL be accepted only when it parses to a plain object and the complete downstream pipeline validates it; conservative policy SHALL NOT synthesize closers.

#### Scenario: Valid truncated object is completed under adaptive policy
- **WHEN** an allowlisted closing suffix makes a truncated object parse and the resulting arguments pass final validation under adaptive policy
- **THEN** the result is repaired and names the truncated-object completion rule

#### Scenario: Schema-invalid completion is rejected
- **WHEN** a closing suffix produces JSON that still fails the tool schema
- **THEN** the pipeline returns an unrepairable verdict and does not execute the candidate

### Requirement: Envelope recovery fails closed
The envelope stage SHALL never replace unrecoverable input with `{}`, invent field values, silently drop array elements, or report success without final schema validity. Unrecoverable input SHALL remain available for later configured root repair or produce a model-readable retry verdict.

#### Scenario: Non-singleton array is not discarded into defaults
- **WHEN** the root input is an array with zero or multiple elements and no configured root repair applies
- **THEN** the pipeline returns unrepairable rather than substituting an empty object

### Requirement: Prototype-safe JSON-domain handling
Envelope recovery SHALL treat input as JSON data, SHALL NOT mutate caller-owned values or object prototypes, and SHALL produce deterministic, idempotent results for inputs within its limits.

#### Scenario: Prototype-looking keys remain inert data
- **WHEN** an input contains keys such as `__proto__` or `constructor`
- **THEN** normalization does not modify global or local prototypes and repeated normalization yields the same data verdict
