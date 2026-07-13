---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0074
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/741]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/741
qualification_refs: [scripts/adr-audit.test.mjs, scripts/document-metadata-contract.test.mjs, scripts/check-docs.test.mjs]
review_state: maintainer-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: ongoing
theme: canonical-adr-authority-and-lifecycle-audit
confidence: high
evidence_grade: A
last_reviewed: 2026-07-13
---

# ADR-0074: Canonical ADR authority and lifecycle audit

- Status: accepted and implemented
- Date: 2026-07-13
- Scope: architecture-decision ownership, metadata, evidence, documentation
  topology, and release admissibility
- Related: [ADR-0073](ADR-0073-buildchain-adr-release-admissibility.md)
  defines the channel settlement rules that consume this authority.

## Context

Kungfu architecture decisions accumulated in two physically separate places:
Core records under `framework/core/docs/adr/` and Shifu records under
`docs/shifu/adr/`. The separate Shifu namespace correctly expressed ownership,
but the directory split implied a difference in authority and made readers,
contributors, metadata contracts, and release gates carry repository-layout
knowledge.

That implication was false. A Shifu decision can constrain the development
entrypoint, toolchain, cache behavior, and release process just as directly as a
Core decision constrains runtime behavior. Both are load-bearing architecture
and must carry the same review, implementation evidence, qualification, alpha
settlement, and stable-admission obligations.

The registry also needed a complete lifecycle view. Separate decision,
implementation, and review axes already existed, but supersession was expressed
only in prose, terminal proposal outcomes were incomplete, and maintainers had
no single deterministic inventory of historical debt and stable blockers.

## Decision

`docs/adr/` is the only architecture-decision authority in this repository.

- `ADR-*` identifies Kungfu product, runtime, and Core ownership.
- `SHIFU-ADR-*` identifies Shifu development and execution ownership.
- The namespace expresses ownership and future portability, not governance
  rank. Both namespaces pass one metadata, evidence, dev, alpha, and stable
  contract.
- The former `framework/core/docs/` and `docs/shifu/adr/` roots are retired.
  They contain no Markdown, including redirects, and the documentation gate
  rejects any attempt to recreate a document beneath either path.
- Decision lifecycle states are `proposed`, `accepted`, `superseded`,
  `rejected`, and `withdrawn`. Terminal states use
  `implementation_status: not-applicable`.
- Supersession uses reciprocal `supersedes` / `superseded_by` edges. Missing
  targets, self-reference, one-sided edges, and cycles fail the documentation
  gate.
- `./shifu adr:audit` is the whole-registry balance sheet. Its default mode
  fails structural contradictions, `--json` exposes every record and debt item,
  `--strict` makes review/evidence debt blocking, and `--release stable` fails
  every unwaived stable obligation without publishing a release.

Historical uncertainty remains explicit. `unknown`, `legacy-unreviewed`, and
legacy evidence exemptions are not normalized by inference. They are retired
only through reviewable Git, PR, test, and qualification reconstruction.

## Consequences

- Readers and tools have one stable architecture entrypoint.
- Shifu remains independently identifiable without becoming a second-class
  decision system.
- The repository carries one source path for each architecture decision; old
  source paths do not silently regain authority.
- Stable readiness can be inspected at any time, including before real release
  channels exist, without weakening the exact-release waiver mechanism.
- The current debt inventory may be large. That is an honest migration result,
  not a reason to fabricate completion or make ordinary development fail on
  unresolved history.

## Qualification

The deterministic gate proves:

- canonical Core and Shifu records are governed by the same contract;
- every Markdown file under either retired root is rejected;
- reciprocal acyclic supersession is accepted and invalid graphs are rejected;
- structural, strict, and stable audit dispositions remain distinct;
- the Markdown publication graph has no compatibility-page exception.
