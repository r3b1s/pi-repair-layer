# plain-language-docs

## ADDED Requirements

### Requirement: Public repair API is documented for tool owners
The README or a linked guide SHALL document each supported npm subpath, the stable
types and functions it exports, a minimal `prepareArguments` integration example,
the tool-owner boundary, supported Node and pi versions, and the package's semantic
versioning commitment. It SHALL state that installing the pi extension does not
automatically wrap tools registered by other extensions.

#### Scenario: Custom tool owner can integrate without source imports
- **WHEN** an extension author follows the public API guide
- **THEN** they can repair their own tool's arguments using a compiled npm subpath
  without importing `src/` files or depending on pi-specific modules in the pure core

### Requirement: Policy and safety terminology is taught concisely
The documentation SHALL define `fast path`, `path selector`, `invariant`,
`fail closed`, `preprocessor`, and each policy profile in plain language before
using those terms in detailed design material. It SHALL distinguish preserving
unknown grammar text in the assistant message from recording value-free telemetry.

#### Scenario: Reader can compare profiles quickly
- **WHEN** a reader opens the policy documentation
- **THEN** a compact comparison identifies which transforms each profile permits and
  which behaviors always require explicit opt-in

### Requirement: Tracked research and limitation claims stay synchronized
Implementation SHALL update `docs/research.md` with the verified global
`tool_result` lifecycle, package/runtime assumptions, source citations, verification
date, and upgrade checklist. README limitations and behavior descriptions SHALL be
checked against executable tests and SHALL NOT retain known contradictions such as
claiming that unrepairable input falls through when the default behavior throws.

#### Scenario: Documentation drift is caught before completion
- **WHEN** the holistic pipeline implementation is prepared for release
- **THEN** its review verifies every changed mechanical claim against tracked
  research and the relevant test, and removes or corrects contradictory text
