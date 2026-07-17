## ADDED Requirements

### Requirement: Core safety invariants hold across generated inputs
Automated property tests SHALL exercise bounded JSON-domain inputs and assert that normalization/repair does not throw or hang, does not mutate caller input, is deterministic and idempotent, preserves strictly valid input when no configured valid-value transform applies, and reports `repaired` only for a final schema-valid result.

#### Scenario: Generated input campaign
- **WHEN** the property suite generates objects, arrays, primitives, nested strings, malformed JSON strings, and prototype-looking keys within configured limits
- **THEN** every case satisfies all core invariants or reports a reproducible failing seed and minimized input

### Requirement: Seeded fuzz failures are reproducible
The repository SHALL provide a deterministic seeded fuzz target for raw-envelope recovery with bounded CI and larger local budgets. A discovered failure SHALL print its seed and minimized input, and confirmed failures SHALL become named regression fixtures.

#### Scenario: Replay a failing seed
- **WHEN** a developer reruns the fuzz target with a previously reported seed
- **THEN** it generates the same case and reproduces the same invariant verdict

### Requirement: Configuration boundaries are tested
Tests SHALL prove that unconfigured content is not parsed/transformed, unrecoverable envelopes do not become `{}`, all mutations have notes/stable rule IDs, work limits terminate processing, and telemetry contains no argument values.

#### Scenario: JSON content and malformed envelope differ by selector
- **WHEN** identical JSON-looking text appears once in an unconfigured content field and once as a configured envelope
- **THEN** only the configured envelope is eligible for parsing

### Requirement: Integration contracts have lifecycle and packaging tests
The suite SHALL cover public subpath imports from a packed artifact, adapter use by a custom tool owner, built-in and custom result-note delivery, handler composition, concurrent identical calls, cleanup, legacy settings/telemetry migration, and narrow-width rendering.

#### Scenario: Packed API and runtime lifecycle pass together
- **WHEN** CI builds and packs the package, imports it from a clean consumer, and drives a repaired custom tool through pi's real loop
- **THEN** the public API loads, the tool validates/executes, feedback attaches once, and all width/privacy assertions pass
