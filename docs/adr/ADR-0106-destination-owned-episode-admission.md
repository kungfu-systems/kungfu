---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0106
decision_status: accepted
implementation_status: staged
implementation_prs: []
qualification_refs: [framework/episode-admission/episode-admission.contract.json, framework/core/tests/python/test_episode_admission.py, scripts/check-episode-admission-contract.test.mjs, framework/api/tests/storage.test.ts]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-16
theme: destination-owned-episode-admission
confidence: high
evidence_grade: B
last_reviewed: 2026-07-16
---

# ADR-0106: Episode Admission is destination-owned and transport-neutral

- Status: accepted; implementation stage-ready
- Date: 2026-07-16
- Category: Storage / Episode / Workspace / Project Cut
- Related: [ADR-0043](ADR-0043-episode-identity-sealed-content-root.md),
  [ADR-0053](ADR-0053-self-contained-episode-bundles.md),
  [ADR-0097](ADR-0097-project-cut-spacetime-and-publication-boundary.md), and
  [ADR-0103](ADR-0103-shadow-only-workspace-continuation.md)

## Context

Kungfu can export and materialize one self-contained Episode bundle, but a
workspace-to-workspace move needs a protocol above that primitive. It must
select multiple sealed Episodes, include causal dependencies, detect source and
destination drift, survive interruption, and leave a destination proof. A
local path, an offline bundle, and a remote stream are delivery mechanisms; if
they produce different admission truth, transport has accidentally become an
authority.

`push` and `pull` also describe who initiated a proposal, not who owns the
destination ledger. A source must not overwrite an open or conflicting
destination Episode, force a root rewrite, clean up its own material, or mutate
Git as a hidden side effect.

## Decision

### 1. One Core operation owns the protocol

`episode_admission` in libkungfu owns `contract`, `plan`, `execute`, `inspect`,
`resume`, `reconcile`, and `cancel`. Python, TypeScript, CLI, Agent, and future
GUI surfaces are thin projections. `Workspace Pull` uses the
`destination-pull` initiator and `Workspace Push` uses `source-push`; both call
the same operation and receive the same per-Episode dispositions.

### 2. Planning is read-only and rooted

A plan binds declared source and destination identities, their sealed/open
frontiers, selected Episode roots and qualification roots, policy, initiation
view, transport, and optional Project Cut roots. Its canonical root is stable
for the same inputs. Planning declares its destination-only write intent and
does not create admission state.

Only `local-direct` may derive a source identity from a normalized local
runtime path. Bundle and remote adapters must carry an explicit source
identity; ambient process paths cannot silently become protocol identity.

### 3. The destination decides each Episode disposition

Only sealed, self-contained, non-degraded Episodes with complete material are
eligible. Local-direct additionally runs source-scoped frame verification. The
destination classifies each proposed root as `missing`, `already-present`,
`refused`, or `conflicted`. There is no force mode. Materialization reuses the
ADR-0053 import gate so root equality, journal ordering, and destination fsck
remain Core-owned invariants.

### 4. Execution is drift-aware and recoverable

Execution accepts an exact plan root and rechecks source and destination
frontiers before writing. Durable destination-side state records the current
phase and completed roots. An interrupted execution can be inspected, resumed,
cancelled without cleanup, or reconciled only when the new destination
frontier consists of the original roots plus roots selected by the plan.
Missing or rewritten pre-existing roots are conflicts.

The final receipt binds the plan, destination before/after frontiers, accepted
and already-present roots, errors, transport observation, and a destination
authority proof. The source remains read-only throughout.

### 5. Transport and Project Cut remain separate axes

`local-direct`, `bundle`, and `remote-stream` all supply the same bundle-shaped
candidate objects to the same admission core. Transport kind is observable but
has no truth effect.

Admission may carry Project Cut roots and its receipt may become later
settlement evidence. Admission itself never stages, commits, pushes, rewrites,
or deletes source material. A coordinator such as Atlas command 2 may consume
only a successful exact-plan receipt before running its separately governed Git
publication and cleanup flow.

## Falsification and acceptance gates

- a plan creates no admission state and reports no source, Git, or cleanup
  write intent;
- source or destination frontier drift rejects execution before state creation;
- a non-local transport without declared source identity fails closed;
- push, pull, local-direct, bundle, and remote-stream preserve the same
  per-Episode roots, qualification roots, and dispositions;
- conflicting, open, unsealed, incomplete, or degraded Episodes never become
  accepted roots;
- successful execution reproduces the selected root at the destination and
  emits a destination proof receipt; and
- no admission action stages Git or removes source material.

## Consequences

Workspace exchange now has one authority boundary instead of separate copy,
bundle, and remote semantics. The protocol adds explicit identity and frontier
inputs and retains destination-side state, so callers must handle drift and
recovery rather than treating transfer as a filesystem copy. Git publication
and source cleanup remain deliberately outside this protocol.
