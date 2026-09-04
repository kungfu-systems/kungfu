---
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: 2026-07-26
theme: maintainability-compression
doc_type: policy
sources: [local-files]
confidence: high
sensitivity: internal
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-27
ai_provenance: GPT-5 via Codex on 2026-07-27; based on the protected maintainability policy, exact gate issue identities, and protected delivery qualification; no hidden model checkpoint, unobserved approval, or released guarantee is claimed
---

# Code-complexity budget waivers

This directory accepts exact, independently reviewed waivers that conform to
`kungfu.code-complexity-budget-waiver/v3`. A waiver never changes the frozen
baseline and cannot authorize a different path or later unrelated growth.

The executing Agent and change author cannot approve their own waiver. Public
compatibility, durable-format, authority-semantic, or other higher-consequence
exceptions retain their existing review gates in addition to this contract.

Every waiver binds the gate-computed issue root, complete sorted path set,
budget classes, baseline/current measurements including content roots, owner,
allowed delta, requester, and retirement reference. Partial-path matches,
requester drift, stale measurements, and later unrelated growth fail closed.
Independent authorization is the protected exact-head review, required source
check, Delivery Warrant, and `merge_group` boundary.

Only JSON records directly inside this directory are active. Superseded P0
records remain under `retired/` as immutable review history; they cannot waive
the P1 ratchet.

The policy has no local waiver-authorization artifact. Adding one cannot grant
an exception; only the protected delivery boundary can authorize the exact
candidate head.
