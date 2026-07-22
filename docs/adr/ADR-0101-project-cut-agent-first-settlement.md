---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0101
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/969, https://github.com/kungfu-systems/kungfu/pull/993]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/969
qualification_refs: [framework/project-cut/settlement.contract.json, framework/project-cut/fixtures/public-runtime-episode/bundle.json, framework/project-cut/fixtures/public-runtime-episode/qualification.json, scripts/check-project-cut-settlement.test.mjs, scripts/check-project-cut-settlement-integration.test.mjs, scripts/run-project-cut-entry.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-15
theme: project-cut-agent-first-settlement
confidence: high
evidence_grade: B
last_reviewed: 2026-07-16
---

# ADR-0101: Project Cut settlement is agent-first and hook-optional

- Status: accepted; implementation delivered by PR #969 and public Episode
  seal/settlement qualification extended by PR #993
- Date: 2026-07-15
- Category: Project Cut / Git settlement / recovery
- Related: [ADR-0097](ADR-0097-project-cut-spacetime-and-publication-boundary.md),
  [ADR-0098](ADR-0098-project-cut-v1-canonical-root-and-source-projection.md),
  [ADR-0099](ADR-0099-git-workspace-episode-provider.md), and
  [ADR-0100](ADR-0100-xinfa-qualified-episode-evidence-provider.md)

## Context

Project Cut v1 freezes the semantic binding among one declared source
projection, one Xinfa Atlas, and admitted Episode change. It intentionally does
not decide how an Agent prepares that binding around a Git commit. Making a Git
hook compile or infer the cut would create a second authority, hide partial
failure, and make `--no-verify`, GUI loss, or hook installation state part of
truth.

## Decision

### 1. The Git index is the explicit source candidate

`project-cut prepare` reads exact regular-file blobs from stage 0 of the Git
index. It rejects unmerged entries and private paths, compiles or verifies a
successor Atlas through Xinfa's public CLI, verifies qualified Git Episode
segments, and computes the existing `project.cut/v1` unchanged. Generated
protocol output is excluded from its own projection; the promoted Atlas
manifest remains an explicit authority input.

Prepare is dry-run by default. `--execute` writes only declared immutable
outputs and local rebuildable state. `--stage` adds exactly those declared
outputs and proves that staging did not expand. Commit and push remain caller
actions and the Git commit OID never enters the Project Cut semantic preimage.

### 2. Plans, receipts, and states are separate contracts

The `project.cut.settlement-*/*` schemas carry deterministic plans, action
receipts, and a local recovery state machine. A failed or not-yet-observed
commit is `sealed-unpublished`, not success. Reuse is allowed only when the
source projection still matches; otherwise verification fails visibly and the
candidate can be explicitly abandoned.

### 3. Hooks are thin optional adapters

The pre-commit adapter only invokes public staged verification. The post-commit
adapter only observes the resulting commit and updates ignored, rebuildable
state. Neither adapter compiles, accesses the network, commits, pushes, or owns
fact authority. Hook absence or `--no-verify` therefore cannot manufacture a
receipt; tracked cut material and a later reconcile remain the proof source.

### 4. Reconcile is the stage-0 recovery authority

`project-cut reconcile --commit REF --json` starts from Git objects and tracked
JSON/JSONL. It verifies each cut, Atlas promotion, Episode provider reference,
and committed source projection without GUI, cache, hook state, or runtime
history. Missing cut, Atlas, Episode, or source agreement is an explicit
diagnostic.

## Falsification and acceptance gates

- Repeated dry-runs over one index produce identical roots and no mutation.
- Explicit staging adds only the promotion, cut manifest, and cut receipt.
- Source drift, privacy admission, root mismatch, and partial staging fail
  closed with stable diagnostics.
- A pre-publication observation remains `sealed-unpublished`; a containing
  commit plus reconcile proves publication.
- A real Xinfa binary compiles and verifies the successor Atlas used by the
  settlement path.
- Removing local runtime state does not prevent commit-level reconcile.
- The public Shifu entry emits one JSON document and a non-zero result with an
  exact recovery action when the selected commit has no Project Cut.
- A real public runtime Episode can be sealed through the agent-first surface,
  promoted into a successor Atlas, published in a non-empty Cut, and reconciled
  to identical roots from a fresh checkout.

## Non-claims

This decision does not change `project.cut/v1`, make Git the Episode or Atlas
authority, infer action history from diffs, guarantee a commit or push, or make
hook execution evidence of publication.
