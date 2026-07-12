---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: reference
review_state: maintainer-reviewed
sensitivity: public
sources: [local-files, user-consensus]
last_reviewed: 2026-07-13
---

# Document Metadata Contract

Kungfu treats documentation metadata as an executable product contract. The
frontmatter identifies what kind of document a file is, which lifecycle axes
apply to it, and which fields tools may trust. It is not decorative YAML.

The machine authority is
[`document-metadata.contract.json`](document-metadata.contract.json). The
deterministic `./shifu docs:check` gate validates the contract, all governed
frontmatter, ADR body projections, and ADR registry rows.

## Profiles

| Profile | Coverage | Required authority |
| --- | --- | --- |
| public document | repository entry documents, `docs/`, and `framework/spec/` | document lifecycle, type, review state, and public sensitivity |
| architecture decision | Core and Shifu ADR records | ADR id, decision status, implementation status, review state, and public sensitivity |
| ADR index | Core and Shifu ADR registries | active index identity and review state; every row must match record metadata |
| repository document | other tracked Markdown that already declares Kungfu metadata | the base document lifecycle profile |
| external schema | issue templates and Kungfu Skills | the schema owned by their consumer, not this contract |

The contract intentionally does not require frontmatter on every nested package
README. A repository document may remain headerless until it needs governed
metadata. Once it declares Kungfu metadata, it must use the current schema.

## Separate lifecycle axes

Do not use a generic `status` field. It previously meant document maturity in
some files and decision state in others.

- `document_status` describes a non-ADR document: `draft`, `active`, `stable`,
  `deprecated`, or `archived`.
- `decision_status` describes an ADR decision: `proposed`, `accepted`, or
  `superseded`.
- `implementation_status` describes the implementation separately:
  `not-started`, `partial`, `staged`, `implemented`, `not-applicable`, or
  `unknown`.
- `review_state` records review evidence. `legacy-unreviewed` is allowed only
  for migrated ADRs whose historical review cannot be reconstructed honestly.

`unknown` and `legacy-unreviewed` are deliberate evidence boundaries. Do not
invent implementation completion, review, dates, sources, or AI provenance to
make an older file look complete.

## Sources and provenance

Use the structured inline `sources` list and only the values declared by the
contract. Do not concatenate source names into a free-form `source_level`
string. `ai_provenance` remains conditional: include it when an AI materially
generated or rewrote the document and the visible generation context is known;
do not fabricate it for historical records.

## ADR projection rule

ADR frontmatter is the machine authority. The visible body status and registry
table remain useful to readers, but they are checked projections:

```yaml
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0069
decision_status: accepted
implementation_status: staged
review_state: self-reviewed
sensitivity: public
```

The body must visibly project the same decision status. The ADR registry must
contain the record and show the same canonical decision status. Implementation
detail belongs in `implementation_status` and the ADR body, not in a compound
registry status cell.

## Changing the contract

Change the JSON contract, validator, fixtures, affected documents, and this
reference together. Add a negative fixture for every new failure mode. Prefer
extending an existing profile over adding one; create a new profile only when a
different consumer or lifecycle semantics make the distinction load-bearing.
