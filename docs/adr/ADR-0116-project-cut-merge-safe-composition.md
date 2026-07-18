---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0116
decision_status: accepted
implementation_status: staged
implementation_prs: []
qualification_refs: [framework/project-cut/composition.contract.json, scripts/check-project-cut-composition.test.mjs, scripts/check-project-cut-composition-gate.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-18
theme: project-cut-merge-safe-composition
confidence: high
evidence_grade: B
last_reviewed: 2026-07-18
ai_provenance: GPT-5 via Codex on 2026-07-18; based on repository sources and user-authorized design constraints; no claim about unobserved runtime behavior or unpublished implementation evidence
---

# ADR-0116: Project Cut composition binds concurrent publications without rewriting task Cuts

- Status: accepted; implementation complete pending closure PR
- Date: 2026-07-18
- Category: Project Cut / merge queue / source admission
- Related: [ADR-0098](ADR-0098-project-cut-v1-canonical-root-and-source-projection.md),
  [ADR-0101](ADR-0101-project-cut-agent-first-settlement.md), and
  [ADR-0102](ADR-0102-project-cut-git-history-bindings.md)

## Context

An immutable task Cut correctly names the source projection seen by one task.
Two concurrent tasks can therefore publish two valid leaf Cuts from a common
baseline. A merge queue candidate contains both source deltas, so its complete
tree cannot equal either task projection. Treating every historical leaf as if
it described the current tree produces false source drift; ignoring those
diagnostics lets missing parents, mismatched receipts, or ambiguous composition
enter mainline.

Git publication observations solve rewrite identity but do not state which
bounded set of task Cuts a particular merge candidate composes. A separate
receipt is required. It must remain reconstructable from tracked Git objects
and public protocol evidence in a clean clone.

## Decision

### 1. Task, publication, and composition are separate identities

`project.cut/v1` remains frozen and contains no Git object id. A history
observation continues to bind one semantic Cut set to a publication commit.
The new `project.cut.composition/v1` receipt binds an exact base and candidate,
their commits, trees and parents, the Cuts changed in that scope, each Cut's
publication coordinates, source/Atlas/Episode roots, semantic parents and
changed paths, plus the candidate output source root.

The receipt has its own canonical `compositionRoot`. It may map many task Cuts
to one output projection without claiming that their Cut roots are equal or
superseded.

### 2. Admission is scoped; global audit remains explicit

The merge gate evaluates Cut manifests and receipts, plus sealed Episode
provider evidence, added, changed, or deleted between the exact base and
candidate. Each affected input Cut is verified at the commit that first
published its manifest, where its declared source projection must match. Parent
Cuts and Cut receipts must exist in the candidate.

An empty changed-Cut scope is a scoped no-op only. It cannot be reported as a
global Project Cut DAG pass. History reconciliation remains a separate global
surface that retains published, superseded, archived and orphaned outcomes.

### 3. Concurrent deltas need an unambiguous mapping

For each input, the semantic parent Cut's publication snapshot is the default
delta baseline. Disjoint path deltas compose directly. Overlapping active leaves
remain ambiguous until a successor Cut names the exact conflicting Cut roots as
parents, binds an admitted Integration Episode provider present in the
candidate, and matches the candidate output source projection. Missing or
unrelated provider evidence is not inferred from a commit message or merge
topology.

Episode admission reuses the Git workspace provider's canonical evidence
verifier. A self-consistent hash is insufficient: manifest and claims schemas,
provider algorithm, canonical bytes, qualification schema and policy, Episode
identity, lifecycle, and `export_evidence` capability must all pass the same
fsck semantics used by provider export.

The receipt records omissions and conflicts even when incomplete. Recovery is
forward-only: restore the missing evidence, resolve the overlap with an
Integration Episode, or publish a successor Cut; never rewrite an existing Cut.

### 4. Source Acceptance runs the build-free clean-clone verifier

The source gate reconstructs the scoped receipt from Git objects and tracked
JSON, verifies its root a second time, and fails closed before build or release
lifecycles. The verifier requires no GitHub API, cache, native build, network
service, or mutable runtime state, so the same result is available in a clean
clone and a merge-group checkout.

## Falsification and acceptance gates

- Two and three disjoint concurrent task Cuts from one baseline compose into a
  qualified N:M receipt after merge commits, moving main, and rewritten commit
  identities.
- Clean-clone reconstruction returns the identical `compositionRoot`.
- Missing parent manifests, missing Cut receipts, source drift, and tampered
  receipt roots fail closed.
- Overlapping deltas without an exact-parent successor Cut and its admitted
  Integration Episode remain incomplete.
- A self-consistent provider with forged manifest, claims, qualification,
  policy, or Episode identity remains unadmitted.
- A no-Cut scope reports a scoped no-op and does not suppress global history
  findings.
- Existing Project Cut v1 golden roots and history/settlement tests remain
  unchanged and passing.

## Consequences

Concurrent tasks keep their exact evidence instead of minting a fictional
"latest leaf". Merge queue admission gains a candidate-specific proof while
historical reconciliation preserves its broader responsibility. The extra Git
walk and source projection rebuild add bounded source-gate cost only when a Cut
changes.
