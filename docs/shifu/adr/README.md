---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: adr-index
review_state: self-reviewed
sensitivity: public
sources: [local-files]
period: ongoing
theme: shifu-architecture-decisions
confidence: high
evidence_grade: B
last_reviewed: 2026-07-12
---

# Shifu Architecture Decision Records

This registry tracks decisions owned by Shifu rather than by Kungfu Core. It
uses the independent `SHIFU-ADR-*` namespace so the history can move with Shifu
if the tool later becomes a separate project.

Records are append-only. A changed decision is superseded by a new record; the
old record stays as evidence.

Frontmatter is the machine authority. Body and registry status are checked
projections under the [Document Metadata Contract](../../document-metadata.md),
with decision and implementation state kept on separate axes.

| ADR | Status | Decision |
|---|---|---|
| [SHIFU-ADR-0001](SHIFU-ADR-0001-cache-profile-contract-and-ownership.md) | accepted | Cache profiles are Shifu-owned contracts; inventories project instances, Buildchain owns process |

Kungfu Core decisions that constrain Shifu remain in the Core ADR registry.
In particular, [ADR-0044](../../../framework/core/docs/adr/ADR-0044-shifu-delegation-protocol.md)
defines the installed-binary delegation protocol that old binaries bake in.
