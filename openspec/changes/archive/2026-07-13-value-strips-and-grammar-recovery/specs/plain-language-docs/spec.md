# plain-language-docs

## ADDED Requirements

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
