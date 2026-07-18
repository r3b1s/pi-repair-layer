# plain-language-docs

## Purpose

Ensure the repository's documentation is accessible, well-sourced, and properly credits upstream work.

## Requirements

### Requirement: Tracked research document backs mechanical claims
The repository SHALL contain a tracked `docs/research.md` recording, claim by claim,
the verified facts about pi's agent loop, event propagation, and built-in schemas that
this extension's design relies on — each with a citation to pi source (file and line
at the verified version), the verification date, and a re-verification checklist to
run on pi upgrades. HANDOFF.md SHALL be retired or reduced to a pointer at this
document.

#### Scenario: A claim can be audited
- **WHEN** a reader questions a mechanical claim made in the README
- **THEN** the README links to the specific research.md entry containing the claim's
  source citation and verification date

### Requirement: README glossary in plain English
The README SHALL define the domain terminology it uses — at minimum: tool call,
schema/validation, silent coercion, grammar leak, anchor bleed, phantom tool call,
and repair note — each with one plain-English sentence accessible to a general
audience before any precise technical elaboration.

#### Scenario: A newcomer understands "grammar leak"
- **WHEN** a user unfamiliar with LLM tool-calling reads the glossary entry for
  "grammar leak"
- **THEN** the first sentence explains it without assuming prior knowledge (e.g. "the
  model prints its tool call as text instead of actually making one")

### Requirement: Prior-art credit for pi-tool-repair
The README SHALL contain a prior-art section that names pi-tool-repair as the origin
of the value-strip rules and the grammar-recovery approach, states what was adapted,
and explains mechanically — by describing pi's tool-call sequence and linking
research.md — why this extension hooks `prepareArguments`. Comparative claims SHALL
be grounded in the cited mechanism rather than qualitative superiority language, and
adapted source files SHALL carry a one-line provenance header.

#### Scenario: Credit is specific and verifiable
- **WHEN** a reader of the prior-art section follows its links
- **THEN** they find the upstream project named, the adapted pieces identified, and a
  research.md citation for each mechanical claim about hook behavior

#### Scenario: Adapted module carries provenance
- **WHEN** a reader opens the adapted grammar-recovery source file
- **THEN** its header names the upstream project and license

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

### Requirement: Long-form docs carry a table of contents
`README.md` and `docs/tool-owner-integration.md` SHALL each begin with a table of contents linking to their top-level sections, kept in sync with the section headings as the documents grow.

#### Scenario: Reader navigates the integration guide
- **WHEN** a reader opens `docs/tool-owner-integration.md`
- **THEN** a table of contents near the top links to every top-level section, including the optional-integration section

#### Scenario: TOC stays consistent
- **WHEN** a top-level section is added to or renamed in either document
- **THEN** the table of contents in that document reflects the change

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
