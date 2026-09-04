---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: architecture-guide
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-09-04
theme: work-package-boundary
confidence: high
evidence_grade: B
last_reviewed: 2026-09-04
ai_provenance: GPT-5 via Codex on 2026-09-04; based on checked-in contracts and the user-approved owner convergence; no claim about unpublished runtime evidence
---

# `@kungfu-tech/work`

This package owns portable, domain-neutral Work semantics: Action Geometry,
Initiative and Assignment declarations, Work lifecycle operations, evidence
envelopes, and Project Cut composition and settlement.

It does not own a writer, journal, storage engine, lease authority, or native
fold. Those remain in `@kungfu-tech/core`. Portable byte formats and registry
projections remain in `@kungfu-tech/spec`. Product assembly and repository
governance tools remain outside `framework/`.

The root export exposes four stable namespaces. Narrow subpath exports preserve
the previously reviewed Action, Assignment Runtime, Evidence, and Project Cut
seams without publishing every repository-internal helper.
