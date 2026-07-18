## ADDED Requirements

### Requirement: Long-form docs carry a table of contents
`README.md` and `docs/tool-owner-integration.md` SHALL each begin with a table of contents linking to their top-level sections, kept in sync with the section headings as the documents grow.

#### Scenario: Reader navigates the integration guide
- **WHEN** a reader opens `docs/tool-owner-integration.md`
- **THEN** a table of contents near the top links to every top-level section, including the optional-integration section

#### Scenario: TOC stays consistent
- **WHEN** a top-level section is added to or renamed in either document
- **THEN** the table of contents in that document reflects the change
