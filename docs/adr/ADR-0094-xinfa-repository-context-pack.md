---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0094
decision_status: accepted
implementation_status: staged
implementation_prs: []
qualification_refs: [xinfa/qualification/repository-pack-v1.json, xinfa/qualification/standalone-smoke-v1.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-15
theme: xinfa-repository-context-pack
confidence: high
evidence_grade: B
last_reviewed: 2026-07-15
---

# ADR-0094: Xinfa compiles portable repository context packs

- Status: accepted; implementation staged
- Date: 2026-07-15
- Category: Context Pack / deterministic compilation / impact analysis
- Related: [ADR-0092](ADR-0092-xinfa-product-and-incubation-boundary.md),
  [ADR-0093](ADR-0093-xinfa-dual-first-verified-context-contract.md), and
  [SHIFU-ADR-0006](SHIFU-ADR-0006-documentation-protocol-and-provider-boundary.md)

## Context

ADR-0093 establishes a stable project protocol and one Context IR for human and
Agent routes. A Context IR printed to a terminal is not yet a portable repository
artifact: it does not bind observed source bytes, expose bidirectional coverage,
prove its own serialization root, or explain the impact of a changed source.
Agents and people would still need to reconstruct these facts by hand, and a
cache or product adapter could silently become a second authority.

The first Pack must remain narrow enough to extract from the monorepo. It must
not execute repository content, infer claims from prose, or use search ranking
to decide what is current.

## Decision

### 1. A Pack binds one explicit repository cut

`xinfa compile --project FILE --output DIR --json` compiles
`xinfa.context-pack/v1`. The project file remains authority. The compiler reads
only exact repository-relative files declared by `exact-file-manifest`
providers and emits:

- a canonical source inventory with UTF-8 payloads, byte roots, and sizes;
- filtered Context IR nodes, edges, and complete human/Agent parity groups;
- source, policy, cut, authority, coverage, and Pack roots;
- bidirectional claim and implementation coverage;
- fail-visible diagnostics and compiler provenance; and
- a manifest and non-qualifying compile receipt.

The existing `compile --project FILE --json` Context IR surface remains
compatible. Supplying `--output` selects Pack publication.

### 2. Roots are layered and non-circular

Each component root is SHA-256 over canonical JSON with a trailing newline. The
Pack root covers the complete Pack body except the `roots.pack` field itself.
The manifest independently binds the exact `pack.json` bytes. The receipt binds
the Pack and manifest roots, declares that it is neither qualifying nor
self-certifying, and records that v1 did not use or write a cache.

Absolute checkout paths, output paths, timestamps, host state, and monorepo
identity are excluded. A Pack can move to another directory and verify offline.

### 3. Visibility filtering preserves dual-first groups

Compilation defaults to `public`. Broader `internal` or `private` output needs
an explicit option. A parity group is either included with both human and Agent
routes or omitted as a group. Included routes retain the same authority root,
node statuses, evidence cut, and invalidation semantics. Different entrypoints
and presentation order remain allowed by ADR-0093.

### 4. Provider drift and unsafe acquisition fail closed

V1 embeds UTF-8 source payloads so a transferred Pack is consumable and its
inventory remains independently verifiable; unsupported encodings fail closed.
The observed root of each included provider is SHA-256 over the canonical,
path-sorted array of `{path, contentRoot, size}` records and must equal its
declared revision.
Missing files, symlinks, path escape, sensitive path classes, oversized files,
and unsupported provider kinds are stable errors. External adapters are not
executed by the compiler. Repository Markdown, source comments, examples,
hooks, and probes are data, never commands.

Compilation constructs every artifact in memory and publishes through an owned
temporary directory followed by one rename. Existing output is never
overwritten. A failed compile leaves no directory that can be mistaken for the
current Pack.

### 5. Coverage and impact are explicit, not heuristic

The Pack records both claim-to-document/implementation/proof/route coverage and
implementation-to-claim/document/route coverage. Missing machine-bearing
coverage and orphan nodes are visible diagnostics.

`xinfa impact --since PACK --project FILE --json` compares source and node
roots, then follows declared verification dependencies and typed edges. An
implementation or evidence change reaches dependent claims, documents, and
routes. An expressive `non-claim` source change may affect its document and
route but does not create claim drift.

### 6. Cache is derived state

V1 deliberately compiles without a cache and records `cacheUsed: false` and
`writesCache: false`. This is the falsifiable baseline for a future cache:
deleting cache state must reproduce the same artifacts, and cache contents may
never participate in authority or Pack roots.

## Public surface

```text
xinfa schema context-pack|pack-manifest|pack-receipt
xinfa compile --project FILE --output DIR [--root DIR] [--visibility LEVEL] --json
xinfa inspect --pack FILE|DIR --json
xinfa verify --pack FILE|DIR --json
xinfa impact --since FILE|DIR --project FILE [--root DIR] [--visibility LEVEL] --json
```

## Consequences

- Humans and Agents can exchange one portable, inspectable authority cut rather
  than copying unbounded repository text.
- Project authors must update provider revisions when declared source bytes
  change. This cost makes drift visible instead of silently current.
- V1's exact-file and 4 MiB-per-source bounds exclude large or generated
  provider ecosystems until a non-executing materialization protocol exists.
- `verify` proves Pack integrity and parity, not real-world fitness, probe
  execution, human approval, or release qualification.

## Acceptance gates

- Small and medium repositories compile to deterministic roots; the checked-in
  small golden pins every component, manifest, and receipt root.
- Public filtering excludes internal material while retaining complete parity
  groups and provenance closure.
- A relocated Pack verifies offline; an existing output directory is not
  overwritten.
- Provider drift, unsupported provider, sensitive path, symlink, and malformed
  input cases fail visibly without a partial Pack.
- Implementation change impact reaches the bound claim, document, and routes;
  expressive non-claim change produces no affected claim.
- Clean standalone extraction builds, tests, compiles, verifies, inspects, and
  impacts a Pack without Kungfu or Shifu runtime state.

## Non-claims

This decision does not implement Task Context Capsule selection, token ranking,
incremental services, distributed caches, provider execution, embeddings,
search-based authority, GUI rendering, or release attestation.

## Version impact

Register additive pre-release `xinfa.context-pack/v1`, manifest, receipt,
inspection, verification, and impact surfaces on the Xinfa `0.1.0` incubation
line. No stable line is opened. A change to canonical roots, visibility,
coverage, or invalidation meaning requires an explicit new pre-release protocol
decision rather than reinterpretation of v1 artifacts.
