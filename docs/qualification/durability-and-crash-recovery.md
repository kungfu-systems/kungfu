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

The end-to-end strong-durability path is **staged but not activated or
power-loss qualified**. Test-only implementations exist for durable ingest,
receipts, projection bootstrap, crash classification, and backup/restore. A
versioned local qualification harness now produces separate `durable_group`
and `durable_sync` process-crash reports for named macOS/APFS, Linux/ext4, and
Windows/NTFS profiles. Its schema makes power-loss and production-profile
eligibility false by construction. Kungfu still does not expose a production
durable-ingest service, producer-visible durable acknowledgement, or a
power-loss-qualified durable watermark across the journal, Episode manifest,
and projections.

An independent KFDL v2 segment/checkpoint backend now exists in test-only shadow
form. It verifies logical position and SHA-256 records across restart, preserves
unacknowledged tails, and exercises data/checkpoint/directory barrier ordering.
Unknown append completion requires reopen before further writes, checkpoint-
covered request identities survive restart for retry reconciliation, and
deadline/service failures stay typed without advancing the durable watermark.
Each v2 record also preserves the frame source/destination, generation and
trigger context required to rebuild existing typed state without consulting a
live mmap frame.
Restart verifies the complete sealed-segment chain and the test fixture compares
an actually published mmap frame with the decoded durable record by logical
position, carrier, and payload after reopen.
It accepts success receipts only under `test/*` qualification fixtures; this
is implementation evidence, not a production durability claim.

A test-only projection bootstrap substrate now consumes only those verified,
checkpoint-covered KFDL records. It writes a versioned binary snapshot through
logical position `T`, verifies its SHA-256 integrity and projection schema after
restart, and replays strictly after `T`. Required peers fail closed when the
snapshot/cut is absent or invalid; optional peers report degraded state; peers
declaring no state dependency remain independent. Projection corruption or a
failed rebuild does not advance its watermark and does not block durable ingest.
The shadow now includes a projector over the authoritative Hana
`StateDataTypes` closed set. At one durable cut its binary derived image is
compared with the compatibility `state<DataType>` bank, including type/uid,
source/destination, update time, and data; malformed known records fail closed
while the previous snapshot remains available for rollback.
Verified images can now hydrate a staging peer state bank and atomically replace
the target only after every type, uid, and payload validates. A two-process
fixture creates the durable cut and snapshot in one process, then reopens KFDL,
bootstraps, and hydrates typed peer state in a fresh process.
This is shadow/cutover evidence: the production coordinator compatibility
restore remains active and public durable profiles remain disabled.

A test-only read-only recovery inspector now runs
`DISCOVER -> VERIFY -> SELECT -> CLASSIFY -> REPORT` over KFDL v2 without
creating a replacement active segment. It deterministically reports READY for
a clean checkpoint, DEGRADED for complete or torn unacknowledged tails, and
BLOCKED when checkpoint evidence exists but no frontier is provable. It never
promotes or deletes tail bytes and records the required local restart order as
supervisor, state service, projection, then peers.

For degraded evidence, a test-only maintenance API now produces a deterministic
quarantine preview bound to the complete source-file digest. Applying that
preview first revalidates the source and acquires exclusive data-root and writer
ownership, then publishes a byte-verified retained-evidence package plus typed
receipt. Repeated apply is idempotent, stale previews fail closed, and source
KFDL bytes are never changed. Authority replacement or truncation is not yet
implemented.

For whole-data-root recovery, a test-only typed backup API now accepts only an
exclusively owned `READY` cut with no unacknowledged visible tail. It verifies
two identical source scans, binds every authoritative file digest plus sealed
Episode roots and payload hashes, and excludes ownership, quarantine, receipts,
and derived projections. Restore accepts an empty root or byte-identical partial
progress, publishes a receipt last, and then requires projection rebuild. The
fixture proves the restored durable frontier, records, Episode identities, and
rebuilt projection state/cut/hash equal the backup cut. This is not yet an
external archive format, operator command, or qualified backup procedure.

The test-only completion fixture now reopens the whole data root in a fresh
process and executes the declared restart gate: supervisor report verification,
state-service durable/Episode reopen, projection bootstrap, then required-peer
authorization. `BLOCKED` recovery cannot start the state service, and
`DEGRADED` recovery cannot authorize required peers. Recovery also reports a
sealed Episode with a missing dependency as a named `episode_findings` entry
while leaving an independent Episode unaffected; this composes the existing
typed Episode qualification that is checked against the independent semantic
oracle. Interrupted quarantine package publication resumes only exact files or
known pending files and rejects extra evidence before mutation.

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
| E. Independent KFDL segment/checkpoint backend | **implemented (test-only shadow)** | append-only binary records, SHA-256 coverage, rollover, dual-slot atomic checkpoint, explicit data/checkpoint/directory barriers, persisted request deduplication, cooperative deadline/unknown handling, typed service-unavailable, fenced generations, fail-stop unknown append sessions, and retained tails; production profiles remain disabled |
| F. Snapshot-through-T projection bootstrap | **implemented (test-only shadow)** | versioned binary snapshot, integrity/schema/cut verification, strict replay-after-T, typed required/optional/none outcomes, deterministic rebuild, independent projection watermark, and state-service ownership; production bootstrap cutover remains pending |
| G. Local strong-durability qualification | **partially implemented** | versioned named-platform process-crash profiles, report schema, raw evidence retention, and fail-closed Shifu harness are implemented; retained three-platform reports and disposable volume/VM/device power-loss evidence remain pending |
| H. Single-host end-to-end performance release gate | **planned** | after correctness passes, qualify absolute latency, throughput, long-tail, resource, replay, recovery, and restore ceilings without weakening semantics |
| I. Replication and HA | **future** | add a separate replicated watermark and policy only after local durability is trustworthy |

Until Stage F passes for a named platform/filesystem/profile, public product
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
- [ADR-0068](../adr/ADR-0068-tiered-durability-and-crash-recovery.md)
  fixes the authority, watermarks, receipts, service boundaries, and staged
  adoption decision.
- [Strong-durability design](../architecture/strong-durability-and-crash-recovery-design.md)
  defines the component contracts, recovery state machine, failure behavior,
  migration plan, and qualification work.
- [ADR-0058](../adr/ADR-0058-yijinjing-explicit-mapping-policies.md)
  records why current mmap production policy qualifies visibility only.
- [Episode atomicity qualification](episode-atomicity-qualification.md) defines
  the related Episode fault-containment evidence program.
