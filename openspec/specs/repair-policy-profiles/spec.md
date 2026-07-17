# repair-policy-profiles

## Purpose

Define coherent named safety profiles for observation, bounded repair, and explicitly enabled executable grammar recovery.

## Requirements

### Requirement: Named profiles select coherent safety levels
The extension and public pipeline SHALL provide `conservative`, `adaptive`, and `recover` profiles. Conservative SHALL enable bounded lossless envelope operations and exact schema/config-driven repair without mutating assistant grammar text; adaptive SHALL additionally enable schema-validated truncated completion, model-gated value strips, and known-tool grammar stripping; recover SHALL additionally permit grammar promotion under all recovery safety gates.

#### Scenario: Conservative profile detects without heuristic mutation
- **WHEN** conservative policy encounters recognized leaked grammar or model-gated anchor bleed on otherwise valid input
- **THEN** it may record an observation but does not strip text, alter the valid value, or create a tool call

#### Scenario: Recover profile still obeys safety gates
- **WHEN** recover policy sees a leaked call on `stopReason: "length"`
- **THEN** it does not promote the call despite executable recovery being enabled

### Requirement: Unknown-tool text is preserved unless explicitly overridden
Every built-in profile SHALL preserve leaked grammar text whose tool is not in the active/allowed set. A separate persisted `preserve` or `strip` policy SHALL control unknown-tool text, defaulting to `preserve`; this choice SHALL never make the unknown call executable.

#### Scenario: Unknown call under default policy
- **WHEN** grammar detection recognizes a call to an unavailable tool and the unknown-text policy is unset
- **THEN** the assistant text remains unchanged, no call is promoted, and observation metadata may be recorded

### Requirement: Observe mode reports without mutation
Grammar observation SHALL detect and classify candidates using the same parser and model gates as strip/recover behavior while leaving assistant text, stop reason, and content blocks unchanged.

#### Scenario: Observe known leak
- **WHEN** observation is active and a known-tool leak is recognized
- **THEN** a message-channel observation is recorded without stripping or promotion

### Requirement: Existing settings migrate behaviorally
Settings without a profile SHALL migrate in memory to behavior-equivalent profiles: existing non-recover configurations to `adaptive` and existing grammar recover configuration to `recover`. Unknown-tool text SHALL migrate to `preserve`. Old settings SHALL remain readable and SHALL only be rewritten when settings are next saved.

#### Scenario: Existing recover user remains opted in
- **WHEN** settings from version 0.2 contain `grammarRecovery: "recover"` and no profile
- **THEN** loading selects the recover profile without requiring the user to opt in again
