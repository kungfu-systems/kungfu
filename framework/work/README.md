---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: architecture-guide
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-09-05
theme: work-package-boundary
confidence: high
evidence_grade: B
last_reviewed: 2026-09-05
ai_provenance: GPT-6 via Codex on 2026-09-05; based on checked-in contracts and the user-approved owner convergence; no claim about unpublished runtime evidence
---

# `@kungfu-tech/work`

This package owns portable, domain-neutral Work semantics: Action Geometry,
Initiative and Assignment declarations, Work lifecycle operations, evidence
envelopes, and Project Cut composition and settlement.

It does not own a writer, journal, storage engine, lease authority, or native
fold. Those remain in `@kungfu-tech/core`. Portable byte formats and registry
projections remain in `@kungfu-tech/spec`. Product assembly and repository
governance tools remain outside `framework/`.

The root export exposes four stable namespaces. Explicit subpaths expose
Action, Assignment Runtime, Evidence, Project Cut, Work Design, history selection,
and Episode provider protocols. Consumers declare `@kungfu-tech/work` and import
these package entries; implementation paths such as `project-cut/src/*` remain
private.

Repository qualification and execution helpers have narrow additional exports.
Those helpers can require checkout inputs and development dependencies; they do
not carry the standalone guarantees of the portable protocol entries. The clean
consumer check in `scripts/qualify-work-package.mjs` installs local tarballs,
imports the portable entries, and verifies that private deep imports are rejected.
