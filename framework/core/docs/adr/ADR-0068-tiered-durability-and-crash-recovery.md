---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0068
decision_status: accepted
implementation_status: staged
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-12
theme: tiered-durability-and-crash-recovery
confidence: high
evidence_grade: B
last_reviewed: 2026-07-12
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-12
  invisible_context_boundary: Exact hidden model build, future implementation behavior, and unqualified device guarantees are unknown
---

# ADR-0068: tiered durability separates hot visibility, durable fact admission, projections, and replication

- Status: accepted; staged
- Date: 2026-07-12
- Category: journal architecture / storage / crash recovery
- Subsystem: yijinjing journal, runtime live topology, state cache,
  projections, Storage, Episode, SDK receipts, qualification
- Related: [ADR-0001](ADR-0001-yijinjing-publish-barrier.md),
  [ADR-0029](ADR-0029-frame-checksum-v2-crc32c.md),
  [ADR-0041](ADR-0041-episode-manifest-first-class-journal-structure.md),
  [ADR-0042](ADR-0042-episode-atomic-safety-and-qualification.md),
  [ADR-0055](ADR-0055-retire-journal-session-and-separate-runtime-state-from-projection.md),
  and [ADR-0058](ADR-0058-yijinjing-explicit-mapping-policies.md)
- Public contract: [Strong durability and crash recovery](../../../../docs/durability-and-crash-recovery.md)
- Design: [Strong-durability and crash-recovery design](../strong-durability-and-crash-recovery-design.md)

## Context

Kungfu's mmap journal is optimized for low-latency publication and zero-copy
live consumption. ADR-0001 defines the release/acquire publication boundary;
ADR-0058 deliberately qualifies only the `visibility` mapping policy and
rejects `asynchronous` and `durable` policies until crash evidence exists.

Other parts of the architecture already establish the right authority
boundaries: typed journal records are authoritative, SQLite is derived and
rebuildable, content objects have an explicit publication option, and Episode
recovery is evidence-preserving. These decisions do not yet form an end-to-end
answer to a producer asking, "Has this fact survived the failure class I care
about?"

The current live coordinator also owns `runtime::state_cache`, joins business
journals, feeds their frames into SQLite-backed state, and restores that state
to peers. That couples membership/control, business-data fan-in, and projection
lifecycle. The state cache uses WAL with SQLite synchronous mode off; it is a
low-latency projection, not a strong-durability service.

Adding per-frame `fsync` to the mmap writer would not resolve these boundaries.
It would put storage latency on every hot writer, still leave metadata/device
ordering platform-specific, conflate projection with fact admission, and offer
no common durable position or producer receipt.

## Decision

### 1. Kungfu has one logical fact stream and distinct physical planes

The journal fact stream remains the semantic authority. Its physical handling
is split into independently accountable planes:

1. **hot mmap plane** publishes complete typed frames to live readers;
2. **durable-ingest plane** persists the typed fact stream and advances the
   recovery frontier;
3. **projection plane** derives query state and can always be rebuilt from
   durable facts;
4. **replication plane** is a later, independent policy and does not block the
   local durability design.

The planes do not create competing facts. They report how far the same ordered
stream has progressed under different contracts.

### 2. Durability is explicit and selectable

The public contract uses named profiles:

| Profile | Required completion condition |
|---|---|
| `visible` | release/acquire publication is observable by qualified live readers |
| `durable_group` | the fact is included in a completed, qualified batch durability barrier |
| `durable_sync` | the fact's required data and metadata have completed the qualified local durability barrier |
| `replicated` | a future declared replication policy has acknowledged the fact |

The default may vary by operation, but it must be declared. Episode terminal
records, load-bearing action receipts, and similar boundaries may require a
stronger profile than reconstructible telemetry. A caller must be able to
request a profile and receive either a matching receipt or an explicit failure.

The existing mmap `durable` policy remains rejected until separately qualified.
It may later support specialized direct-mapping profiles, but it is not the
primary architecture for end-to-end durability.

### 3. Stable positions and four watermarks are first-class typed facts

Every durability receipt refers to a stable logical stream position. The exact
wire layout is an implementation decision, but the identity must survive page
rollover and distinguish stream/container epochs. A page pathname or timestamp
alone is insufficient.

Kungfu exposes at least:

- `visible_watermark`;
- `durable_watermark`;
- `projection_watermark`;
- `replicated_watermark` when replication exists.

Watermarks are monotonic within their declared stream epoch. In the normal
pipeline:

```text
replicated_watermark <= durable_watermark <= visible_watermark
projection_watermark is independently reported and may lag durable_watermark
```

Projection progress is not a prerequisite for raw fact durability. A schema or
projector failure cannot retract the durable watermark.

### 4. Receipts never overstate the established frontier

A write result distinguishes publication from durability. A receipt includes
the stream position, requested profile, achieved profile/frontier, and typed
failure when the request cannot be satisfied.

- no durable receipt is emitted before the relevant durable barrier succeeds;
- timeout is not silently converted into success;
- ENOSPC, I/O failure, sync failure, and service unavailability cannot advance
  the durable watermark;
- retry/deduplication uses stable frame or operation identity;
- receipts are themselves recordable facts, but recording a receipt does not
  recursively redefine the barrier it reports.

### 5. Coordinator owns control; a per-data-root state service owns persistence

The coordinator converges on membership, topology, channel authority, and
control routing. It must not remain the mandatory reader of all business
journals or the owner of their durable/projection lifecycle.

A separately supervised, per-data-root state service owns two internal
responsibilities with a strict boundary:

- `durable_ingest`: consumes declared streams, persists raw typed facts,
  advances durable watermarks, and emits receipts;
- `projection_service`: consumes the durable stream or a pinned durable cut,
  updates SQLite/query projections, and advances projection watermarks.

They may initially share a process for operational simplicity. They do not
share authority or commit semantics. SQLite remains derived and rebuildable.

### 6. Bootstrap is snapshot plus an explicit cut

A state-requiring peer obtains a snapshot/projected view at position `T` and
then consumes facts strictly after `T`. The peer declares whether state is
`required`, `optional`, or `none`.

Coordinator registration no longer implies that coordinator-owned state
restore is complete. A required-state peer waits or fails explicitly if a
qualified snapshot/cut cannot be supplied; an optional peer may start degraded
with that condition visible.

### 7. Recovery preserves evidence and reports uncertainty

Recovery validates container/segment identity, frame integrity, checkpoint
metadata, and durable frontier evidence. It must never invent a complete frame
or silently promote an unacknowledged visible tail to durable.

The recovery result names:

- last valid visible and durable positions;
- discarded, quarantined, repaired, or uncertain ranges;
- projection rebuild/resume position and lag;
- interrupted Episode classification;
- exact durability profile and qualification envelope used for the claim.

Recovery and repair are idempotent at the semantic level and preserve verified
facts according to ADR-0042.

### 8. Strong claims are profile- and evidence-scoped

No product surface may claim power-loss durability merely because a sync API
was called. Qualification must cover data/metadata ordering, error propagation,
torn writes, crash points, projection rebuild, repeated recovery, load, and the
limits of the platform/filesystem/device profile.

Process-kill tests are necessary but are not equivalent to sudden power loss.
Each supported profile retains a machine-readable report; untested profiles and
platforms remain explicit non-claims.

## Consequences

- Hot writers keep the `visible` path and zero-copy behavior.
- Stronger operations can pay an explicit and measurable durability cost.
- State/query failure is isolated from raw fact admission.
- The coordinator becomes smaller and no longer scales by joining every
  business stream.
- Callers can reason about visible, durable, projected, and later replicated
  progress without guessing from process or file state.
- Recovery can prove its frontier and expose loss instead of presenting a
  best-effort restart as a guarantee.
- The implementation gains a service, metadata, and qualification cost; that
  cost is the price of an honest strong-durability contract.

## Adoption stages

1. Add stable typed positions, watermarks, and receipt vocabulary without
   changing current `visible` behavior.
2. Extract state-cache ingestion and projection behind separate interfaces,
   initially preserving same-process behavior and comparing old/new results.
3. Introduce the per-data-root state service and shadow durable ingest while
   coordinator remains the active compatibility path.
4. Switch bootstrap to snapshot-at-`T` plus replay-after-`T`; remove coordinator
   business-journal ownership.
5. Qualify and expose `durable_group`, then `durable_sync`, on named local
   platform/filesystem profiles.
6. Consider replication only after local durability and recovery evidence are
   stable.

Every stage must retain rollback and must not change POD/FlatBuffers authority,
journal wire compatibility, or edge-only JSON rules accidentally.

## Rejected alternatives

- **Make every mmap write synchronously durable.** Rejected as the default: it
  destroys latency choice and still lacks an end-to-end receipt/recovery
  contract.
- **Treat SQLite WAL as the durable fact authority.** Rejected: projections can
  lag, fail on schema/projector errors, and must remain rebuildable.
- **Keep persistence inside coordinator.** Rejected: control availability and
  business-data fan-in scale/fail for different reasons.
- **Return success and recover whatever the OS happened to write.** Rejected:
  this cannot support strict or testable durability claims.
- **Build replication first.** Rejected: replication multiplies an ambiguous
  local persistence contract instead of fixing it.

## Current implementation status

This ADR records the target decision and is not a statement that strong
durability is already shipped. Current production mmap qualification remains
`demand + visibility`. State cache/projections remain asynchronous derived
state. Dedicated durable ingest, unified watermarks/receipts, coordinator
separation, and power-loss qualification are pending.
