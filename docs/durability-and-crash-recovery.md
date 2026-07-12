---
status: draft
period: 2026-07-12
theme: strong-durability-and-crash-recovery
doc_type: capability-overview
source_level: local-files + architecture-decisions
confidence: high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-12
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-12
  invisible_context_boundary: Exact hidden model build, untested hardware behavior, and future implementation results are unknown
---

# Strong durability and crash recovery

Kungfu's target is unusual but deliberate: preserve the low-latency and
zero-copy advantages of a memory-mapped journal while adding strict,
verifiable, and selectable durability and crash-recovery profiles.

This page is the short, public contract. It states the target, the design, and
the implementation stage without requiring a reader to reconstruct the answer
from ADRs or source code.

Institutions evaluating Kungfu as an authoritative local ledger should also
read the [Single-host institutional trust profile](single-host-institutional-trust.md),
which translates this technical contract into an adoption decision, required
evidence, operator responsibilities, and explicit non-claims.

## Current answer

**Today, Kungfu qualifies cross-process journal visibility and deterministic
replay from readable journal data. It does not yet claim end-to-end power-loss
durability for an acknowledged journal frame.**

The foundations are implemented:

- a writer publishes a complete frame with a release operation and readers
  observe it with acquire semantics;
- mmap access, creation, residency, and durability requests are explicit;
- production mmap profiles currently accept `visibility` and reject unqualified
  `asynchronous` and `durable` requests;
- frame checksums, typed journal authority, rebuildable SQLite projections,
  content-addressed payload storage, and Episode recovery/qualification
  surfaces exist in staged form.
- coordinator calls now cross an explicit state-service boundary with an
  independently controlled projection lifecycle; one active service per data
  root and one writer per physical stream journal are fail-closed through
  local generation/fence evidence.

The end-to-end strong-durability path is **designed but not implemented**. In
particular, Kungfu does not yet have a dedicated durable-ingest service, a
producer-visible durable acknowledgement, or a crash-qualified durable
watermark across the journal, Episode manifest, and projections.

Do not interpret `MAP_SHARED`, `msync`, `FlushViewOfFile`, SQLite WAL, process
residency, or a successful write call as a power-loss guarantee. A guarantee is
made only by a named profile with retained qualification evidence.

## Target guarantees

Kungfu will expose durability as an explicit per-operation policy instead of a
single global claim:

| Profile | Completion means | Intended use |
|---|---|---|
| `visible` | the frame is published and available to live readers | lowest-latency telemetry and reconstructible work |
| `durable_group` | the frame is at or below a batch durable watermark | normal durable agent facts with amortized sync cost |
| `durable_sync` | the frame's required data and metadata have crossed the qualified local durability barrier | critical decisions, receipts, and Episode closure |
| `replicated` | a future replication policy has acknowledged the frame | later high-availability profiles; not a current implementation target |

The implementation must never return a stronger receipt than the selected
profile has established. Backpressure or an explicit error is preferable to a
false acknowledgement.

## Design in one picture

```text
peer writer
    |
    v
hot mmap journal  ----->  live readers
    |
    v
durable ingest  ----->  durable typed fact log  ----->  recovery / replay
                              |
                              v
                       projection service  ----->  SQLite query state

coordinator: membership, topology, and control; not the durable data owner
```

This is one logical fact stream with several independently observable
frontiers, not several competing authorities:

- `visible_watermark`: live readers may consume through this position;
- `durable_watermark`: the selected local durability contract holds through
  this position;
- `projection_watermark`: derived query state includes facts through this
  position;
- `replicated_watermark`: reserved for a later replicated profile.

The durable typed fact log is the recovery boundary for durable profiles.
SQLite remains a rebuildable projection. Projection lag or failure must not
undo a durable fact or prevent the raw durable log from advancing.

## Crash-recovery contract

For a qualified durability profile, restart must be deterministic:

1. validate segment/container identity, frame structure, checksums, and durable
   checkpoint metadata;
2. recover the last valid durable watermark without inventing facts;
3. classify any visible tail beyond that watermark as unacknowledged,
   recoverable, quarantined, or truncated according to retained evidence;
4. replay the durable log to rebuild projections and resume from their recorded
   watermark;
5. classify interrupted Episodes from manifest evidence, preserving verified
   work and contracting unsafe capabilities instead of silently reporting
   completion;
6. emit a machine-readable recovery report naming loss, repair, quarantine,
   projection lag, and the profile that was actually qualified.

Crashes of the projection service must not destroy durable facts. Failure or
ENOSPC in durable ingest must not produce a durable acknowledgement. Damage to
one Episode must not silently invalidate unrelated Episodes.

## Implementation stages

| Stage | State | Meaning |
|---|---|---|
| A. Visibility and integrity foundations | **implemented** | release/acquire publication, explicit mmap policy, frame integrity, typed journal records, rebuildable projections |
| B. Episode and storage safety model | **staged** | typed Episode fold, fsck/repair/capability reporting and fault qualification exist in slices; the complete contract remains under qualification |
| C. Unified position, watermark, and receipt vocabulary | **implemented (contract-only)** | C++ owns stable stream positions, four typed watermarks, named profiles, receipts/errors, deduplication, and explicit unknown outcomes; Python/Node expose typed edge adapters, while current behavior remains `visible` only and rejects stronger profiles |
| D. State-service separation and durable ingest | **partially implemented** | coordinator no longer owns the projection store directly; the in-process state-service boundary has independent lifecycle, shadow comparison, and single-host owner/writer fencing. Moving business-journal ingestion out of coordinator and persisting raw facts before projection remain pending |
| E. Local strong-durability qualification | **not implemented** | qualify `durable_group` and `durable_sync` across macOS, Linux, and Windows with crash, torn-write, ENOSPC, ordering, and recovery evidence |
| F. Single-host end-to-end performance release gate | **planned** | after correctness passes, qualify absolute latency, throughput, long-tail, resource, replay, recovery, and restore ceilings without weakening semantics |
| G. Replication and HA | **future** | add a separate replicated watermark and policy only after local durability is trustworthy |

Until Stage E passes for a named platform/filesystem/profile, public product
language must continue to say that power-loss durability is not claimed.

## Qualification standard

`kill -9` and ordinary restart tests are necessary but insufficient. A strong
durability report must cover, for its declared platform and storage profile:

- process death at every publication and checkpoint boundary;
- torn or partial writes, corrupt tails, and stale/checkpoint disagreement;
- file-data and directory/metadata ordering;
- ENOSPC, permission loss, I/O errors, and failed sync propagation;
- projection loss and deterministic rebuild;
- repeated recovery and idempotence;
- sustained load without weakening receipt semantics;
- the limits of OS, filesystem, device cache, virtualization, and test harness.

Evidence is profile-scoped. Passing one filesystem or host does not silently
qualify another.

Correctness qualification is necessary but not sufficient for institutional
release admission. The independent
[Single-host end-to-end performance qualification](single-host-performance-qualification.md)
must then prove the declared operational envelope. Its release authority comes
from Kungfu's frozen absolute thresholds and retained evidence; Aeron IPC and
Aeron Archive may be reported as reference comparators but do not define the
pass/fail contract.

## Detailed records

- [Single-host institutional trust profile](single-host-institutional-trust.md)
  defines the first institutional deployment envelope, adoption gates,
  evidence requirements, operator responsibilities, and non-claims.
- [Single-host end-to-end performance qualification](single-host-performance-qualification.md)
  defines the post-correctness release gate and the strict boundary for any
  Aeron comparison.
- [ADR-0068](../framework/core/docs/adr/ADR-0068-tiered-durability-and-crash-recovery.md)
  fixes the authority, watermarks, receipts, service boundaries, and staged
  adoption decision.
- [Strong-durability design](../framework/core/docs/strong-durability-and-crash-recovery-design.md)
  defines the component contracts, recovery state machine, failure behavior,
  migration plan, and qualification work.
- [ADR-0058](../framework/core/docs/adr/ADR-0058-yijinjing-explicit-mapping-policies.md)
  records why current mmap production policy qualifies visibility only.
- [Episode atomicity qualification](episode-atomicity-qualification.md) defines
  the related Episode fault-containment evidence program.
