# Document Metadata Contract

Kungfu treats documentation metadata as an executable product contract. It
identifies what kind of document a file is, which lifecycle axes apply to it,
and which fields tools may trust. Metadata is not decorative YAML, and public
readers should not have to see maintenance records before the document title.

The machine authority is
[`document-metadata.contract.json`](../document-metadata.contract.json). Public
sidecar records live in
[`document-metadata.registry.json`](../document-metadata.registry.json). The
deterministic `./shifu docs:check` gate validates both authorities, governed
frontmatter, ADR body projections, immutable implementation evidence, and the
canonical ADR identity graph.

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

Coverage is the disjoint union of unique registry-authoritative documents and
unique inline-authoritative documents:

```text
metadata coverage = registry authority + inline authority
                  = 124 + 173
                  = 297 documents at source cut 24340c2fbd58d96de1d1b0040f59911aa1df5038
```

The counts are a reproducible observation at that source cut, not an eternal
constant:

```sh
node --input-type=module <<'NODE'
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { parseFrontmatter } from './scripts/document-metadata-contract.mjs';

const files = childProcess.execFileSync('git', ['ls-files', '-z', '*.md'])
  .toString().split('\0').filter(Boolean);
const registry = new Set(Object.keys(
  JSON.parse(fs.readFileSync('docs/document-metadata.registry.json')).documents,
));
const inline = new Set(files.filter((file) =>
  parseFrontmatter(fs.readFileSync(file, 'utf8'))
    ?.fields.get('metadata_schema')?.value === 'kungfu.document-metadata/v1'));
const overlap = [...registry].filter((file) => inline.has(file));
console.log({ registry: registry.size, inline: inline.size,
  total: registry.size + inline.size, overlap });
NODE
```

The `overlap` array must be empty: overlap would create two authorities for one
document and the validator rejects it. Parsing only the leading frontmatter is
intentional; a repository-wide text match would miscount fenced examples as
metadata. The same validator rejects missing governed documents and orphaned
registry records, so the sum is meaningful rather than a count of unchecked
metadata fragments.

## Profiles

| Profile | Mode | Coverage | Required authority |
| --- | --- | --- | --- |
| public document | registry | repository entry documents, `docs/`, and `framework/spec/` | document lifecycle, type, review state, and public sensitivity |
| architecture decision | inline | canonical `docs/adr/` Core and Shifu records | ADR id, decision and implementation state, review state, evidence, and public sensitivity |
| ADR index | inline | `docs/adr/README.md` ADR navigation and operating guidance | active index identity and review state; identity authority comes only from canonical ADR files |
| engineering evidence | inline | selected spikes, qualification contracts, and implementation slices | local audit context for a bounded engineering claim |
| repository document | inline optional | other tracked Markdown that declares Kungfu metadata | the base document lifecycle profile |
| external schema | external | issue templates and Kungfu Skills | the schema owned by their consumer, not this contract |

The contract intentionally does not require metadata on every nested package
README. A repository document may remain ungoverned until it needs typed
metadata. Once it declares Kungfu metadata, it must use the current schema.

## Directory authority

Canonical public documents live under the directory taxonomy declared in
`docs.contract.json`. `docs/README.md` and `docs/MAP.md` are the only canonical
Markdown entry files at the `docs/` root. Section indexes make every canonical
document reachable from the public graph, and the gate rejects a new flat
canonical page or a document placed outside the declared taxonomy.

Flat `docs/*.md` pages are forbidden. There is no repository compatibility
facade: moving a document into the taxonomy removes its former path. This is
intentional while Kungfu has no published documentation compatibility contract.
If a future publication surface needs redirects, that surface must own and
qualify them without recreating duplicate Markdown authorities in this
repository.

## Separate lifecycle axes

Do not use a generic `status` field. It previously meant document maturity in
some files and decision state in others.

- `document_status` describes a non-ADR document: `draft`, `active`, `stable`,
  `deprecated`, or `archived`.
- `decision_status` describes an ADR decision: `proposed`, `accepted`,
  `superseded`, `rejected`, or `withdrawn`.
- `implementation_status` describes the implementation separately:
  `not-started`, `partial`, `staged`, `implemented`, `not-applicable`, or
  `unknown`.
- `review_state` records review evidence. `legacy-unreviewed` is allowed only
  for migrated ADRs whose historical review cannot be reconstructed honestly.

`unknown` and `legacy-unreviewed` are deliberate evidence boundaries. Do not
invent implementation completion, review, dates, or sources to make an older
file look complete.

Terminal decision states are explicit. `superseded` points to its replacement
through `superseded_by`; the replacement declares the reciprocal `supersedes`
edge. `rejected` means the proposal was considered and declined; `withdrawn`
means its sponsor removed it before acceptance. All three use
`implementation_status: not-applicable`. The gate rejects missing targets,
one-sided edges, self-reference, and supersession cycles.

A later accepted ADR may narrow or correct only part of an earlier accepted
decision without retiring the rest. In that case the later record declares
`amends`, the earlier record declares reciprocal `amended_by`, and both remain
accepted. Amendment edges are not a weaker spelling of supersession: they must
name an exact scope in prose, are checked for reciprocity and cycles, and do not
change either record's implementation status.

## Sources and public maintenance boundary

Use the structured `sources` list and only the values declared by the contract.
Do not concatenate source names into a free-form `source_level` string. Public
Kungfu metadata records evidence about the product and its decisions; it does
not carry tool-generation or automated-maintenance attribution. Private work
coordination may retain that information in its own authority, but it is not
part of the public product contract.

## ADR projection rule

ADR frontmatter under [`docs/adr/`](../adr) is the machine authority. The visible
body status is a checked projection. `docs/adr/README.md` is navigation and
operating guidance, not an identity registry:

```yaml
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f8758-0efc-7011-a233-445566778899
decision_status: accepted
implementation_status: staged
review_state: self-reviewed
sensitivity: public
```

The body must visibly project the same decision status. Implementation detail
belongs in `implementation_status` and the ADR body.

New records use `KF-ADR-<UUIDv7>` or `SHIFU-ADR-<UUIDv7>` and are equal
architecture records. Create them without a shared counter or index write via
`./shifu adr:new -- --owner kungfu|shifu --title "..."`. UUIDs are generated
offline from local time and operating-system randomness; their time order is not
decision authority. Their filename is exactly the complete identity plus `.md`;
put descriptive wording in the heading and link label, not a repeated path slug.
The retired sequential identity scheme has no current parser, inventory, or
authoring surface; any such token in current authority fails the audit. The
prefix identifies Kungfu versus Shifu ownership and
does not change metadata, evidence, review, or release gates. The
former `framework/core/docs/` and `docs/shifu/adr/` roots are retired and must
contain no Markdown. They do not carry redirects or compatibility metadata.
Negative fixtures prove that any new Markdown, including a fully formed
architecture decision, is rejected under either retired root.

In authored Markdown, a canonical ADR identity is a citation and must be a
direct local link to its canonical `docs/adr/<identity>.md` record.
`./shifu docs:check` rejects naked identities, missing targets, malformed
current identities, and identity links that point at a different record. The
checker ignores frontmatter, code, generated surfaces, and historical
append-only material; those surfaces retain their own authority and lifecycle
rules rather than receiving a blind repository rewrite.

Run `./shifu adr:audit -- --json` to inspect every lifecycle and evidence state.
The normal audit fails on structural contradictions. `--strict` also fails on
explicit governance debt such as unknown implementation, legacy review, or
missing qualification. `--release stable` evaluates all accepted records as
stable obligations without publishing or mutating release state.

## ADR implementation evidence

An implementation state is a claim, so ADRs may bind it to immutable evidence:

```yaml
implementation_commits: [68dc33a3f3daa56ac1893f9e8671575c6e85f9a8]
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/123]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/123
qualification_refs: [docs/qualification/mmap-performance.md]
```

- `implementation_commits` contains full 40-character SHAs for implementation
  slices that are already reachable from the target mainline. Do not record a
  commit that exists only on the current pull-request branch: rebase and squash
  merges rewrite that identity. Use `implementation_prs` while the work is in
  review, then add the merged mainline SHA in a later change when commit-level
  evidence is still useful.
- `implementation_prs` contains stable pull-request URLs when review history is
  part of the evidence.
- `closure_commit` identifies the reachable commit at which the accepted scope
  was considered fulfilled. It may be the final implementation slice or a
  dedicated closure record. `closure_pr` is the stable alternative for a
  repository whose rebase/squash merge policy rewrites every PR commit SHA;
  implemented ADRs require one of the two, not both.
- `qualification_refs` contains existing repository-relative evidence paths or
  `commit:<full-sha>` references.

The gate validates shape, repository identity, local commit existence,
reachability from the checked-out mainline, canonical repository identity for
PR evidence, and contradictions such as evidence on a `not-started` ADR. On a
pull request, the blocking documentation workflow pins reachability to the
exact base SHA, so a commit that exists only in the merge preview fails before
it can enter the mainline. The gate cannot prove that code semantically
fulfills a decision. That judgment remains a review responsibility.

## Release admissibility projection

Metadata consistency and release admissibility are related but separate gates.
This document defines what an ADR implementation claim means and how its
evidence is represented. The
[version and release mechanism](version-release-design.md#adr-implementation-and-release-admissibility)
defines when those claims are allowed to enter `dev`, settle at `alpha`, and
become obligations for `stable`.

The release gate reads ADR frontmatter; it does not infer completion from commit
messages. A development feature PR declares a bounded delivery intent, an alpha
promotion reconciles the declaration with the changed ADR projection after full
qualification, and a stable promotion fails on every accepted ADR that is not
implemented and qualified, not applicable, or covered by an exact-release
administrator waiver. The machine contract is
`docs/adr-release.contract.json`; waivers live in the separately owned
`docs/adr-release-waivers.json` ledger.

Implemented, staged, and partial historical ADRs without reconstructed immutable
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
