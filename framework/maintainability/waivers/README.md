---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
period: 2026-07-26
theme: maintainability-compression
doc_type: policy
sources: [local-files]
confidence: high
sensitivity: internal
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-26
ai_provenance: GPT-5 via Codex on 2026-07-26; based on the frozen maintainability policy and local repository contracts; no hidden model checkpoint, unobserved approval, or released guarantee is claimed
---

# Code-complexity budget waivers

This directory accepts exact, independently approved, expiring waivers that
conform to `kungfu.code-complexity-budget-waiver/v1`. A waiver never changes
the frozen baseline and cannot authorize a different path or later unrelated
growth.

The executing Agent and change author cannot approve their own waiver. Public
compatibility, durable-format, authority-semantic, or other higher-consequence
exceptions retain their existing review gates in addition to this contract.
