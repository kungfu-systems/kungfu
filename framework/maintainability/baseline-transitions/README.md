---
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: 2026-07-27
theme: maintainability-compression
doc_type: policy
sources: [local-files, user-consensus]
confidence: high
sensitivity: internal
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-27
ai_provenance: GPT-5 via Codex on 2026-07-27; based on the protected complexity policy and exact source qualification; no hidden model checkpoint, unobserved approval, or released guarantee is claimed
---

# Code-complexity baseline transitions

The ordinary calibration command can reproduce a candidate baseline, but it
cannot authorize replacing the protected baseline. Once trusted governance is
present on the protected branch, any baseline-root or baseline-ref change
requires exactly one
`kungfu.code-complexity-baseline-transition/v1` JSON record in this directory.

The record binds the protected expected-old measurement root and ref, the
candidate new measurement root and ref, bounded changed-measurement and
aggregate-line counts, the requester, reason, and retirement/decomposition
reference. The source gate recomputes those values and rejects stale roots,
candidate mutation, multiple matching records, and excess scope or delta.

Independent authorization is attached to the protected exact PR head by the
required source check and reviewer approval. Delivery remains fenced by the
Delivery Warrant and `merge_group`; no locally produced authorization artifact
is required or accepted.

The baseline file, waiver records, and transition records are governance
metadata rather than measured source. Their integrity is enforced directly by
exact recomputation, protected expected-old comparison, protected delivery
governance, and merge-queue replay; including them in their own line-count
baseline would create a non-convergent self-reference.
