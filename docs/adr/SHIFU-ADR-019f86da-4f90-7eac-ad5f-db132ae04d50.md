---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: SHIFU-ADR-019f86da-4f90-7eac-ad5f-db132ae04d50
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/965, https://github.com/kungfu-systems/kungfu/pull/984, https://github.com/kungfu-systems/kungfu/pull/1583]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/984
qualification_refs: [scripts/check-kungfu-gate-catalog.test.mjs, commit:db0010dacd76f913a8dc2704faf0cfceb55b1553, docs/qualification/gates/workflow-authority.json, product/release/component-distribution.contract.json, .github/workflows/release-shifu.yml]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: ongoing
theme: closed-world-release-admission
confidence: high
evidence_grade: B
last_reviewed: 2026-07-27
---

# SHIFU-ADR-019f86da-4f90-7eac-ad5f-db132ae04d50: Closed-world workflow and release admission

- Status: accepted and implemented; protected component-release extension is
  stage-ready pending review, merge, and publication
- Date: 2026-07-15
- Scope: Kungfu workflow authority, qualifying evidence, product publication,
  and channel promotion
- Related: [SHIFU-ADR-019f86da-4f90-79a1-bc85-4b542fecf011](./SHIFU-ADR-019f86da-4f90-79a1-bc85-4b542fecf011.md),
  [KF-ADR-019f86da-4f90-7b6b-ae6d-76cea57487f2](./KF-ADR-019f86da-4f90-7b6b-ae6d-76cea57487f2.md), and
  [KF-ADR-019f86da-4f90-7d6c-926a-ddd27dbde8ab](./KF-ADR-019f86da-4f90-7d6c-926a-ddd27dbde8ab.md)

## Context

The Shifu Gate catalog already closes direct Gate, profile, and registered
controller invocation in both directions. That proves declared Gate routing,
but it does not classify every workflow job and shell step, bind activation and
permission drift, or prevent an unrelated write-capable job from being mistaken
for release authority.

Buildchain now provides a project-neutral sealed publication authority,
controller evidence, runner provenance, control-plane audit, artifact-byte
verification, and a sealed consumer-predicate handoff before provider writes.
Kungfu consumes that protocol without copying Buildchain's workflow internals
or letting its own manifest self-certify a release.

## Decision

Kungfu owns one closed-world workflow authority manifest. Every workflow, job,
and step has an exact definition digest and a finite authority class. Workflow
activation, permissions, runner, Environment, secret/OIDC surface, reusable
workflow identity, action ref, inputs, conditions, and shell body are included
in the digests. Unknown inventory and drift fail source acceptance.

Evidence publication, diagnostic writes, product publication, and channel
promotion are distinct authorities. A workflow that contains qualifying or
publication authority may use external actions only at immutable commit SHAs.
Write and OIDC permissions live on the smallest job that requires them.

Kungfu product publication requires the project-neutral Buildchain sealed
capability and a second project-owned predicate. The predicate fixes the
Buildchain version/runtime/contract, publisher workflow, product, target,
allowed channels, Gate profile, current Gate registry, and three required
platforms. Alpha and release each bind their exact moving-channel resolution
and contract lock. The predicate rejects stale or replayed admission, missing
or failing receipts, runner downgrade, control-plane drift, source/runtime
substitution, and artifact-byte substitution. Unknown or diagnostic execution
may still run and publish failure evidence, but it cannot obtain product
capability.

The checked-in policy and authority manifest are not proof that live GitHub,
OIDC, registry, or runner state is correct. Those facts enter only through a
fresh Buildchain audit and provenance receipt, and unreadable state is denial.

## Authority boundaries

| Owner | Authority |
| --- | --- |
| Kungfu | Gate policy, workflow classification, activation contract, product/channel admission decision |
| Shifu | Gate plan/run and source-bound Gate receipts |
| Buildchain | controller/runtime evidence, sealed capability protocol, runner and external control-plane verification |
| Provider | final credential exchange and product write after all predicates pass |

## Consequences

- Adding a harmless workflow still requires classification, which is deliberate
  closed-world maintenance cost.
- Refreshing digests cannot authorize mutable actions or publication classes.
- Windows failure evidence can be uploaded immediately without granting a
  product release.
- Missing sealed inputs block the current promotion controller instead of
  falling back to a legacy release path.
- A successful local fixture proves the predicate implementation, not live
  provider state; a real canary must record the exact source, runtime, run, and
  receipt/passport digests.

## Alternatives considered

- **Scan only known Gate commands** — rejected because unknown jobs, permissions,
  and triggers remain outside the proof.
- **Treat every successful workflow as qualifying** — rejected because job
  success does not prove source, runtime, artifact, runner, or provider state.
- **Reimplement Buildchain publication authority in Kungfu** — rejected because
  it would create a divergent trust protocol.
- **Prevent all unknown code from running** — rejected as an unprovable claim;
  the enforceable boundary is that unknown execution cannot obtain product
  publication authority.
