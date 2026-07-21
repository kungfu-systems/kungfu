---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0130
decision_status: accepted
implementation_status: staged
implementation_prs: []
qualification_refs: [scripts/check-project-cut-settlement.test.mjs, scripts/check-project-cut-settlement-integration.test.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-21
theme: xinfa-baseline-storage-convergence
confidence: high
evidence_grade: B
last_reviewed: 2026-07-21
ai_provenance: Amp on 2026-07-21; based on settlement source, repository measurements, and user-authorized storage convergence; no history rewrite performed
---

# ADR-0130: Xinfa baselines split into tracked witnesses and ignored local material

- Status: accepted; implementation staged in the same change set pending merge
- Date: 2026-07-21
- Category: Xinfa storage / Project Cut settlement / Git publication boundary
- Implements: the storage allocation of
  [ADR-0097 §7](ADR-0097-project-cut-spacetime-and-publication-boundary.md)
  for `.xinfa/baselines`
- Preserves: Project Cut roots, receipts, and reconcile semantics of
  [ADR-0098](ADR-0098-project-cut-v1-canonical-root-and-source-projection.md);
  no published root or historic commit changes meaning

## Context

ADR-0097 §7 allocates `.xinfa/` into tracked declarations, policies, and
promoted manifest inputs, plus ignored immutable stores, indexes, caches, and
generated output. The settlement implementation drifted from that allocation:
`prepareSettlement` staged every file of the retained successor Atlas baseline
under `.xinfa/baselines/sha256/<atlas-root>/`, including `atlas.json`
(≈3.6 MB), `compatibility/context-pack-v1/pack.json` (≈3.5 MB), and views.

With dogfood settlement running many times per day, the repository accumulated
95 baselines in five days: about 555 MB and 869 tracked files, growing roughly
120–180 MB of checkout size per day, linearly forever. The material is
immutable and content-addressed, so Git history compresses it reasonably
(≈46 MiB), but every clone, worktree, and checkout pays the full working-tree
cost, and the tracked file set grows without bound.

Each baseline already carries verifiable pointers: `manifest.json` enumerates
every material file with its `content_root` (SHA-256) and size, and
`receipt.json` seals the compile verdict. The same pair exists one layer down
for the context pack. These witnesses chain to `atlas_root`, which the Project
Cut and the Atlas promotion already commit to.

## Decision

`.xinfa/baselines` is split into two sets with different replication models:

1. **Tracked witnesses.** Every baseline layer keeps exactly its
   `manifest.json` and `receipt.json` in Git (for current baselines: the
   baseline root pair and the `compatibility/context-pack-v1` pair, a few KB
   per baseline). These are the publication outputs of settlement: they appear
   in `plan.outputs`, are staged by `--stage`, and must be present in the
   observed commit.

2. **Ignored local material.** `atlas.json`, `views/`, and pack bodies are
   written to disk as an immutable content-addressed store but never enter the
   Git index. `.gitignore` expresses this as "everything under a baseline is
   ignored except `manifest.json` and `receipt.json` at any layer", matching
   the settlement witness rule by basename.

Verification is derived from the exact tracked witness chain, never from
working-tree copies: the source projection binds the promotion bytes, the
promotion binds the baseline manifest and receipt roots, and the manifest
binds every material file's content root. `verifySettlement` reads the
witnesses from the Git index and `observeSettlementCommit` from the observed
commit; both recompute the manifest/receipt semantic roots, check the
promotion bindings, reject unsafe artifact paths, and only then check every
enumerated artifact on disk against its `content_root`. Corrupted or missing
witnesses fail with `atlas-witness-invalid` / `atlas-witness-drift` /
`atlas-witness-missing`; missing material fails visibly with
`atlas-material-missing` (with restore guidance); drifted material fails
with `atlas-material-drift`. `reconcileCommit` validates the same witness
chain body-independently, so a fresh clone reconciles publication integrity
without the local material.

Existing baseline material was removed from the index with `git rm --cached`
only; working trees keep the bytes, and no history was rewritten. A machine
that retains material re-completes a partially materialized baseline in place
(`writeImmutableDirectory` fills missing files after verifying that present
files match byte-for-byte).

The settlement plan and state schemas are unchanged: `outputs` now means
publication outputs (witnesses), and the material list is derived from the
witness manifest instead of being duplicated in the state.

## Why the material does not move to `.kungfu` or Git LFS

`.xinfa` and `.kungfu` remain distinct authorities per ADR-0097 §7; moving
Atlas bodies under `.kungfu` would only relocate the growth. Git LFS would
keep the linear tracked growth and add an external dependency for every
clone. The material is deterministic compiler output already sealed by
`atlas_root`; peers that need a body restore it from a machine that retains
it or recompile from the recorded source cut, and every consumer that reads a
body verifies it against the tracked witness first. Settlement promotions
additionally seal the Atlas body's semantic roots (`atlasRoots`) under
`promotionRoot`, so a witness-only checkout recovers body-derived roots
from the tracked promotion inside the Project Cut chain, after proving the
promotion binds the exact tracked manifest and receipt. The promotion must
exist; its absence fails closed. Promotions written before that projection
existed resolve through `.xinfa/manifests/legacy-atlas-roots.json`, a closed
backfill extracted once from verified local material by
`scripts/backfill-legacy-atlas-roots.mjs` and pinned by exact digest in the
KFD-1 witness builder, so the legacy set can neither grow nor drift without
a reviewed code change and the witness is never consulted for its own
inputs. Both paths fail closed when material is present but drifts, or when
no authenticated tracked source binds the selected baseline.
Body-dependent product qualification runs in an explicit materialized lane
that defers, visibly, in witness-only checkouts.

## Consequences

- New settlements add ~4 small witness files per baseline to Git instead of
  ~7 MB of material; tracked baseline growth drops from ~120–180 MB/day of
  checkout size to a few KB per settlement.
- A fresh clone contains every witness and reconciles every published cut,
  but does not receive Atlas bodies; successor compiles that need a prior
  body must restore or recompile it, and the failure is explicit rather than
  silent.
- Old commits keep their meaning: historic cuts recorded projections over the
  then-tracked material and still reconcile at those commits. New cuts record
  projections over the witness-only tracked set; both are internally
  consistent because prepare, verify, observe, and reconcile all derive the
  projection from the same tracked entries.
- The retained-material copy under `.kungfu/runtime/project-cut/settlements/`
  is unchanged and remains ignored.
