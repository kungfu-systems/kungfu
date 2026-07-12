---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0058
decision_status: accepted
implementation_status: implemented
implementation_commits: [5d4240edde731e857ec4ca8fba8dead7104e0b9b, 81f6b61ca3fbf75399c49b32f75310c25e52962d]
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/599]
closure_commit: 81f6b61ca3fbf75399c49b32f75310c25e52962d
qualification_refs: [framework/core/docs/qualification/mmap-performance.md]
review_state: maintainer-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-11
theme: yijinjing-explicit-mapping-policies
confidence: high
evidence_grade: A
last_reviewed: 2026-07-11
---

# ADR-0058: yijinjing mmap behavior is expressed as explicit policies

- Status: accepted; implemented
- Date: 2026-07-11
- Category: journal architecture / mmap / compatibility
- Related: [ADR-0001](ADR-0001-yijinjing-publish-barrier.md),
  [ADR-0024](ADR-0024-location-role-and-journal-page-policy.md), and
  [ADR-0057](ADR-0057-domain-neutral-live-runtime-terminology.md)
- Qualification: [mmap performance](../qualification/mmap-performance.md)

## Context

The historical mmap surface combined several independent decisions in
`is_writing` and `lazy` booleans. Depending on the call site, those booleans
selected read/write access, file creation, page pre-creation, page-size
discovery, attempted residency locking, and cleanup behavior. A caller could
not state which authority or operating property it required, and adding a new
mode risked changing unrelated behavior hidden behind the same boolean.

The journal wire-v1 layout, closed Hana POD layout, zero-copy frame access, and
single-writer publication protocol are compatibility invariants. Separating
mapping policy must not change any of them.

## Decision

File mappings use a `mapping_policy` composed from four orthogonal axes:

| Axis | Values | Meaning |
|---|---|---|
| access | `read_only`, `read_write` | memory protection and write authority |
| creation | `existing_only`, `create_or_grow` | whether the path may create or extend a file |
| residency | `demand`, `prefault`, `pinned` | requested physical-page residency behavior |
| durability | `visibility`, `asynchronous`, `durable` | requested writeback contract |

The current qualified truth table is deliberately small:

| Access | Creation | Residency | Durability | Qualified |
|---|---|---|---|---|
| read-only | existing-only | demand | visibility | yes |
| read-write | existing-only | demand | visibility | yes |
| read-write | create-or-grow | demand | visibility | yes |
| read-only | create-or-grow | any | any | no: structurally invalid |
| any | any | prefault or pinned | any | no: not performance-qualified |
| any | any | any | asynchronous or durable | no: not crash-qualified |

Named but unqualified requests are rejected before the filesystem is mutated.
They remain enum values so future work must qualify an explicit contract rather
than reusing a boolean with a new meaning.

`visibility` preserves the existing shared-mapping and explicit-flush behavior.
It is not a claim of power-loss durability. A future `durable` policy must
define and test file-data and metadata ordering, platform differences, device
cache behavior, error propagation, and crash recovery before it is accepted.

## Journal intents

Journal code does not assemble low-level policies ad hoc. It uses explicit
page intents:

- `reader` and `header_probe` open existing pages read-only;
- `writer` opens or grows the current writable page;
- `reader_preload` opens an existing next page read-only;
- `writer_preload` opens or grows the next writable page;
- `coordinator_precreate` alone grants coordinator-owned page pre-creation.

Reader construction similarly distinguishes `peer` and `coordinator` policy.
Page-size discovery and next-page pre-creation follow those policies rather
than the historical interpretation of `lazy`.

## Compatibility boundary

The typed policy API is canonical for C++, journal/runtime internals, and new
embedders. Deprecated boolean overloads remain temporarily at source and
language-binding edges:

- old C++ `is_writing` / `lazy` overloads translate immediately to a typed
  policy;
- the existing Python `lazy` argument remains accepted and is translated at
  binding entry;
- Node and internal runtime call sites use typed policy directly.

The adapters may be removed after a minor release has published the typed API,
repository and known external consumers no longer call the old overloads, and
the normal versioning process approves the source break. They must not gain new
semantics during that period.

## Invariants and consequences

- Journal wire-v1, Hana POD sizes and offsets, frame addresses, and zero-copy
  access are unchanged.
- The ADR-0001 release/acquire publication protocol and single-writer rule are
  unchanged.
- Read paths cannot silently create or stretch page files.
- Coordinator pre-creation is an explicit authority, not a residency or
  latency side effect.
- Demand paging remains the only qualified residency policy; the historical
  best-effort `mlock` path is retired.
- The qualification harness measures the existing demand/visibility baseline
  without granting unqualified policy requests or changing production defaults.
- This is an internal contract refactor with compatibility adapters and has
  patch-level version impact. Qualifying residency or durability modes later
  requires new evidence and may have independent version impact.
