# Document Metadata Contract

Kungfu treats documentation metadata as an executable product contract. It
identifies what kind of document a file is, which lifecycle axes apply to it,
and which fields tools may trust. Metadata is not decorative YAML, and public
readers should not have to see maintenance records before the document title.

The machine authority is
[`document-metadata.contract.json`](document-metadata.contract.json). Public
sidecar records live in
[`document-metadata.registry.json`](document-metadata.registry.json). The
deterministic `./shifu docs:check` gate validates both authorities, governed
frontmatter, ADR body projections, immutable implementation evidence, and ADR
registry rows.

## One authority per governed document

The contract routes a governed document to one metadata mode:

- `registry`: public entry, guide, and reference pages keep metadata in the
  sidecar registry so GitHub and documentation renderers begin with the title.
- `inline`: ADRs, ADR indexes, qualification contracts, and bounded engineering
  evidence keep audit context beside the claim it qualifies.
- `external`: issue templates and Kungfu Skills retain the schema required by
  their native consumer.

`inline-optional` is the catch-all for package-local repository notes that are
not part of the governed public reading surface. If one declares Kungfu
metadata, the same field contract applies. A governed file cannot appear in
both frontmatter and the registry, and stale registry entries fail the gate.

## Profiles

| Profile | Mode | Coverage | Required authority |
| --- | --- | --- | --- |
| public document | registry | repository entry documents, `docs/`, and `framework/spec/` | document lifecycle, type, review state, and public sensitivity |
| architecture decision | inline | Core and Shifu ADR records | ADR id, decision and implementation state, review state, evidence, and public sensitivity |
| ADR index | inline | Core and Shifu ADR registries | active index identity and review state; every row must match record metadata |
| engineering evidence | inline | selected spikes, qualification contracts, and implementation slices | local audit context for a bounded engineering claim |
| repository document | inline optional | other tracked Markdown that declares Kungfu metadata | the base document lifecycle profile |
| external schema | external | issue templates and Kungfu Skills | the schema owned by their consumer, not this contract |

The contract intentionally does not require metadata on every nested package
README. A repository document may remain ungoverned until it needs typed
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
invent implementation completion, review, dates, or sources to make an older
file look complete.

## Sources and public maintenance boundary

Use the structured `sources` list and only the values declared by the contract.
Do not concatenate source names into a free-form `source_level` string. Public
Kungfu metadata records evidence about the product and its decisions; it does
not carry tool-generation or automated-maintenance attribution. Private work
coordination may retain that information in its own authority, but it is not
part of the public product contract.

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

## ADR implementation evidence

An implementation state is a claim, so ADRs may bind it to immutable evidence:

```yaml
implementation_commits: [68dc33a3f3daa56ac1893f9e8671575c6e85f9a8]
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/123]
closure_commit: 68dc33a3f3daa56ac1893f9e8671575c6e85f9a8
qualification_refs: [framework/core/docs/qualification/mmap-performance.md]
```

- `implementation_commits` contains full 40-character SHAs for implementation
  slices.
- `implementation_prs` contains stable pull-request URLs when review history is
  part of the evidence.
- `closure_commit` identifies the reachable commit at which the accepted scope
  was considered fulfilled. It may be the final implementation slice or a
  dedicated closure record.
- `qualification_refs` contains existing repository-relative evidence paths or
  `commit:<full-sha>` references.

The gate validates shape, repository identity, local commit existence,
reachability from the checked-out mainline, and contradictions such as evidence
on a `not-started` ADR. It cannot prove that code semantically fulfills a
decision. That judgment remains a review responsibility.

Implemented, staged, and partial legacy ADRs without reconstructed immutable
evidence must appear in the contract's reviewed exemption ledger. New claims do
not silently inherit that exemption. Stale exemptions fail the gate once the
required evidence is present or the status no longer needs it. Do not invent a
convenient commit to make coverage look complete.

## Changing the contract

Change the JSON contract, registry, validator, fixtures, affected documents,
and this reference together. Add a negative fixture for every new failure mode.
Prefer extending an existing profile over adding one; create a new profile only
when a different consumer or lifecycle semantics make the distinction
load-bearing.
