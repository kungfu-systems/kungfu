---
metadata_schema: kungfu.document-metadata/v1
doc_type: reference
document_status: active
review_state: self-reviewed
sensitivity: public
sources: [local-files]
period: 2026-07-20
theme: invariant-verification-system
confidence: high
evidence_grade: B
last_reviewed: 2026-07-20
ai_provenance: GPT-5 via Codex on 2026-07-20; based on repository contracts, tests, and user-authorized design constraints; no claim about unpublished release artifacts or unobserved third-party implementations
---

# Kungfu invariant system

This directory contains the machine-owned cross-domain invariant contract,
registry, and schemas. Start with:

```sh
./shifu invariant:verify -- --list --json
./shifu invariant:verify -- --level source --json
```

The registry references Fact and Episode authorities by JSON pointer and
content root. Do not copy domain rules into it. When an authoritative pointer
changes, update roots with the reviewed source change and provide a successor
declaration where required:

```sh
./shifu invariant:verify -- --sync-roots
./shifu invariant:verify -- --baseline OLD-REGISTRY.json --successors DIR --json
```

Use `--sync-roots --write` and `--sync-artifacts --write` only as explicit
source-maintenance operations; their read-only forms report drift.

See [KF-ADR-019f86da-4f90-77b2-863d-f04dbb185e00](../../docs/adr/KF-ADR-019f86da-4f90-77b2-863d-f04dbb185e00.md),
[architecture](../../docs/architecture/invariant-verification-system.md), and
[qualification](../../docs/qualification/invariant-verification.md).
