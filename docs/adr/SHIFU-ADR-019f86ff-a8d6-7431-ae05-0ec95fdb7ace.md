---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: SHIFU-ADR-019f86ff-a8d6-7431-ae05-0ec95fdb7ace
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1211, https://github.com/kungfu-systems/kungfu/pull/1284, https://github.com/kungfu-systems/kungfu/pull/1374]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
last_reviewed: 2026-07-24
---

# SHIFU-ADR-019f86ff-a8d6-7431-ae05-0ec95fdb7ace: ADR identity is distributed UUIDv7 authority

- Status: accepted
- Date: 2026-07-22
- Scope: Core and Shifu architecture-decision identity, authoring, and merge
  concurrency

## Context

Kungfu historically identified Core and Shifu decisions with separate
four-digit sequential schemes. Creating a record therefore required finding the
next number and adding a row to `docs/adr/README.md`. Both steps mutate shared
coordination state. Two otherwise independent ADR branches can choose the same
number or conflict in the same index, so Git serializes work that has no
semantic dependency.

The decision corpus is a public authority surface, so its one-time rename and
reference rewrite was reviewed as an exact-tree operation. That migration is
complete; the retired scheme is no longer a compatibility or authoring surface.

## Decision

Core decisions use `KF-ADR-<UUIDv7>` and Shifu decisions use
`SHIFU-ADR-<UUIDv7>`. UUID text is canonical lowercase RFC 9562 form with
version `7` and the RFC variant. The prefix expresses decision ownership; both
namespaces retain the same metadata, review, evidence, and release obligations.
The UUID timestamp is useful for approximate ordering but is neither decision
time nor truth authority.

`./shifu adr:new -- --owner kungfu|shifu --title "..."` is the only supported
allocation entry. It creates the UUID from local wall time plus operating-system
randomness and writes one ADR file with exclusive-create semantics. It reads no
network service, sequence counter, index, branch, or repository registry. The
canonical filename is exactly the complete identity plus `.md`; descriptive
slugs are not part of the path. Collision handling is to rerun; overwriting is
forbidden. Human-readable titles belong in the heading and Markdown link label.

ADR records do not add a shared identity row to `docs/adr/README.md`. The
directory and metadata audit are the complete machine inventory. The audit also
rejects retired sequential identity tokens from current authority while leaving
content-addressed historical evidence byte-for-byte intact. Supersession edges and PR
manifests use the complete opaque ADR id and do not infer order from it.

## Consequences

- ID-only paths avoid repeating long descriptive slugs in prose while retaining
  the complete, offline-verifiable identity.
- Independent ADR branches create disjoint paths and need no shared allocation
  or index write before merge.
- Existing links and release evidence use the canonical UUIDv7 identities.
- Tools that discover ADRs parse only canonical ID-only paths. A filename that
  merely begins with an ADR identity is not authority.
- UUID randomness makes accidental identity collision negligible, while
  exclusive file creation makes a local collision fail visibly.

## Alternatives considered

- **Keep the sequence and reserve ranges per branch.** Rejected because range
  allocation is still shared coordination and creates permanent ownership debt.
- **Use a central allocation service.** Rejected because ADR authoring must work
  offline and service availability must not gate a local decision record.
- **Keep a permanent compatibility parser after corpus migration.** Rejected
  because it would preserve two identity authorities and allow retired tokens
  to re-enter current source or fixtures.
- **Keep the shared index mandatory for discoverability.** Rejected because Git,
  metadata audit, and documentation inventory already provide deterministic
  discovery without a merge hotspot.
