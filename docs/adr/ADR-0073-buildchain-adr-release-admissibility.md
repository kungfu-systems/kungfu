---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0073
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/731, https://github.com/kungfu-systems/kungfu/pull/737]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/731
qualification_refs: [scripts/adr-release-gate.test.mjs, scripts/release-promotion-rehearsal.test.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-13
theme: buildchain-adr-release-admissibility
confidence: high
evidence_grade: B
last_reviewed: 2026-07-13
---

# ADR-0073: Buildchain promotion is the settlement boundary for ADR implementation truth

- Status: accepted
- Date: 2026-07-13
- Category: release governance / architecture evidence / Buildchain
- Related: [ADR-0009](ADR-0009-load-bearing-self-bootstrap.md) makes the
  adoption path the validation path; [ADR-0010](ADR-0010-adopt-kfd-1-release-versioning.md)
  binds welded surfaces to release versioning; the
  [document metadata contract](../development/document-metadata.md) separates
  decision, implementation, and review state.

## Context

ADR frontmatter is already the machine authority for implementation state, and
the documentation gate rejects malformed, unreachable, or contradictory
implementation evidence. That proves internal metadata consistency. It does not
prevent a feature from entering a channel without declaring which accepted
decision it advances, nor does it prove that a stable release has accounted for
every accepted decision.

Requiring every commit to name an ADR would use the wrong unit. Commits are
frequently rebased or squashed, ordinary fixes may have no architecture impact,
and a decision usually spans several coherent delivery stages. Kungfu already
has a stronger integration unit: protected pull requests flowing through
`dev -> alpha -> release`, with Buildchain owning the expensive qualification
boundary.

The missing mechanism is therefore not a commit-message convention. It is a
release-admissibility contract over pull-request intent, ADR projections, and
promotion evidence.

## Decision

Kungfu uses three increasingly strong ADR gates aligned with its existing
channel topology.

### Development: bounded delivery intent

A feature PR targeting `dev/*` must declare exactly one delivery intent:

- `stage-ready`: the PR completes a bounded, verified stage that is safe to
  integrate while the accepted ADR remains `partial` or `staged`;
- `implemented`: the accepted scope is an implementation-complete candidate,
  with qualification evidence present, awaiting promotion settlement.

This is a PR integration state, not an ADR lifecycle value. In particular,
`stage-ready` does not mean `implementation_status: staged`.

Non-feature fixes, tests, documentation, and chores retain an explicit
`adr-neutral` path. A feature branch cannot use that path, and an ADR-neutral PR
cannot modify an ADR record.

### Alpha: progress settlement after full qualification

An alpha promotion declares the ADR progress included in the promotion, or an
explicit reason that no ADR progress exists. Every declared projection must
match a changed accepted ADR record. The Buildchain candidate build runs the
same settlement gate after the full build and release qualification, so an
implementation-complete development claim becomes an implementation fact only
at an evidence-bearing promotion boundary.

### Stable: release admissibility

A stable promotion enumerates every ADR whose `decision_status` is `accepted`.
It admits the release only when each decision is:

- `implementation_status: implemented` with qualification evidence;
- `not-applicable`; or
- covered by an explicit waiver for the exact release and exact blocking
  conditions.

Proposed decisions are not obligations, and superseded decisions are historical
evidence rather than current obligations. Existing legacy metadata exemptions
do not count as stable waivers.

Stable waivers are versioned risk acceptances, not branch-protection bypasses.
They name the ADR, exact blocking conditions, reason, risk, mitigation, release
administrator, approval PR, and expiry release. The waiver ledger has a
dedicated CODEOWNER. A waiver must match the current stable PR and expires after
that exact version; it cannot silently carry forward.

## Machine authority

The contract is `docs/adr-release.contract.json`. Pull requests carry one JSON
manifest inside the `kungfu-adr-release:v1` marker. The validator emits a
`kungfu.adr-release-report/v1` report containing admitted, waived, blocked, and
invalid records.

`docs/release-promotion-rehearsal.contract.json` extends that authority to the
consumer wiring around Buildchain. Its side-effect-free rehearsal validates
alpha/stable positive and negative fixtures, immutable Buildchain locks,
release-passport evidence, and the dependency edge that prevents promotion
before Kungfu admission succeeds. It does not emulate Buildchain publication.

The gates establish process truth:

```text
dev:    declared bounded integration state
alpha:  qualified implementation-progress settlement
stable: no unaccounted accepted architecture obligation
```

They do not infer semantic fulfillment from filenames, commit text, or test
success. Reviewers still decide whether an implementation actually fulfills an
ADR and whether a waiver's residual risk is acceptable. The machine makes those
decisions explicit, scoped, and impossible to omit silently.

## Consequences

- Stable releases acquire a machine-auditable architecture balance sheet.
- Feature contributors make one bounded delivery declaration, but do not choose
  semantic versions or manually operate the release toolchain.
- Historical `unknown` implementation states become real release debt: they
  must be reconstructed, closed, or explicitly waived before stable.
- Alpha promotion PRs become the natural place to update implementation status
  accurately, because the complete development delta and full qualification
  result are both visible there.
- Release administrators accept named residual risk instead of bypassing a
  generic status check.
- The cost is one repository-local contract, validator, waiver ledger, and PR
  manifest. No service or mutable database is introduced.

## Alternatives considered

### Require every commit to reference an ADR

Rejected. Commit granularity is too small, mutable history weakens authority,
and unrelated fixes would produce low-signal ceremony.

### Update ADR status only after release

Rejected. This leaves development and alpha history under-specified and forces
maintainers to reconstruct progress after the evidence is dispersed.

### Let administrators bypass the stable check

Rejected. A bypass is neither scoped evidence nor a durable risk acceptance and
cannot appear honestly in the release passport.

### Require all proposed ADRs to be implemented

Rejected. A proposal is an open decision, not a product promise. Stable scope
begins when the decision is accepted.
