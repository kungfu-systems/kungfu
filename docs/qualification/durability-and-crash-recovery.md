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

**Kungfu has completed the current-hardware engineering work for the default-off
`Single-Host Institutional Production Candidate v1`. Exact retained evidence
covers live candidate receipts, projection authority, process and disposable-VM
faults, agent-120 SLOs, same-office off-host restore, and one real clean
agent-120 reboot. This is a production candidate, not production eligibility:
sudden physical power loss and an independent failure domain remain unqualified,
so `production_eligible` stays false.**

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

The end-to-end strong-durability path is **implemented and evidence-admitted as
a default-off current-hardware production candidate, but not production-qualified**.
Test-only implementations exist for projection bootstrap, crash classification,
and backup/restore. The KFD-1 config contract now lets a user or workspace
request the matching candidate, choose `visible`, `durable_group`, or
`durable_sync` deterministically, and tune bounded batch, segment, timeout, and
reconciliation behavior. The standard coordinator carries that policy into the
state service, which independently re-derives admission and owns typed append,
barrier, retry, and restart reconciliation. This does not change the default
visible path or the product admission verdict. See
[Configure durability](../guides/durability-configuration.md) for the complete
mechanism and cost model. A
versioned local qualification harness now produces separate `durable_group`
and `durable_sync` process-crash reports for named macOS/APFS, Linux/ext4, and
Windows/NTFS profiles. A retained disposable Linux/ext4 QEMU run additionally
passes 20/20 abrupt VM cuts, real ENOSPC, repeated fresh reopen, filesystem/hash
checks, and a same-host external-path restore drill. That evidence explicitly
excludes physical-host restart or power loss and production eligibility. A
separate retained `987201493` run transfers a completed package from agent-120
to Ubuntu 222, rejects a manifest-only partial transfer, verifies every digest,
restores an empty root, validates the durable frontier, Episode and rebuilt
projection, and repeats restore idempotently. Both hosts are in the same office,
so independent power, network, site, and administrator failure domains remain
unqualified. Kungfu still does not expose a production-qualified durable-ingest
service or a power-loss-qualified durable watermark across the journal,
Episode manifest, and projections.

The retained `17e807700` clean-restart run prepares a durable root and fsynced
resume token, crosses a separately authorized clean reboot, requires the Linux
kernel boot ID to change, and then uses a fresh process to recover the same
durable frontier, three records, closed Episode, projection state/cut, and
strictly newer service/writer generations. The harness cannot reboot or control
the host itself. This qualifies only clean restart on the named
Linux/x86_64/ext4/NVMe agent-120 envelope; physical power loss and production
eligibility remain false.

The final admission inventory binds all six prerequisite deliveries to exact
implementation, delivery, artifact, environment, and rerun coordinates. Its
derived `passed-current-hardware-production-candidate` verdict fails closed on
source, digest, profile, or environment drift. The retained report is
[`production-candidate-v1/admission-report.json`](evidence/durability/production-candidate-v1/admission-report.json),
with the complete input ledger beside it. Episode recovery is candidate-qualified
and Storage backup/restore is same-office off-host-qualified; neither result
widens the physical or failure-domain claims.

Candidate receipts are accepted only through the per-data-root state service
with explicit activation and matching qualification evidence. A repeated exact
request is idempotent. After caller timeout or restart, C++, Python, Node, and
`kungfu storage durability-reconcile` report the same checkpoint-derived
`reconciled`, `unknown`, or `terminal_failure` state; missing evidence remains
`outcome_unknown` and is never guessed into success or failure. Candidate
status includes barrier, unknown, recovery/reconciliation, queue, byte, and
latency counters. The capability report intentionally remains
`production_eligible: false`.

The product reports this boundary from the C++ authority through the Python,
Node, and agent CLI projections. `kungfu agent capabilities --json` includes a
`durability` report with the schema `kungfu.durability.capability/v1`, retained
evidence digests, per-profile availability, restore scope, trust assumptions,
and explicit non-claims. `durable_group` and `durable_sync` remain
`candidate-explicit` and `production_eligible: false`. The nested `admission`
object reports candidate completion, default-off activation, clean restart,
off-host restore, freshness policy, and every remaining false claim from the
same C++ authority; it does not turn qualification evidence into a default or
production runtime feature.

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

A projection bootstrap substrate now consumes only those verified,
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
An explicit, default-off live candidate now carries required/optional/none as
an additive registration JSON extension. It requires a matching `candidate/*`
profile, reopens the existing KFDL and snapshot after process restart, verifies
the qualified cut, and validates required hydration before registry
publication. The retained qualification fixture separately proves same-cut
typed parity against the compatibility bank.
Candidate peers do not join coordinator-owned business PUBLIC/SYNC streams or
invoke compatibility restore; optional failures are visibly degraded. Peers
without the declaration retain the compatibility bridge as rollback authority.
C++, Python, Node, and CLI inspect the same status. This is admitted candidate/cutover
evidence, not production eligibility: the path remains default-off and reports
`production_eligible: false`; public durable profiles remain disabled.

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
rebuilt projection state/cut/hash equal the backup cut. The versioned transport
package publishes its completion marker last and a bounded local Shifu harness
now verifies it across the named two-host path. This is still a
production-candidate protocol and harness, not a scheduled operator service or
independent-disaster-domain backup procedure.

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
| C. Unified position, watermark, receipt, and requested-policy vocabulary | **implemented (candidate edge)** | C++ owns stable stream positions, four typed watermarks, named profiles, receipts/errors, deduplication, explicit unknown outcomes, and restart reconciliation; KFD-1 config plus Python/Node/CLI expose requested/admission/effective policy and one canonical digest. Stronger profiles require explicit default-off candidate activation and native re-admission, and remain production-ineligible |
| D. State-service separation and durable ingest | **partially implemented** | coordinator no longer owns the projection store directly; the in-process state-service boundary has independent lifecycle, shadow comparison, single-host owner/writer fencing, and an explicit live candidate append/barrier/reconcile seam. Default production cutover remains pending |
| E. Independent KFDL segment/checkpoint backend | **implemented (test-only shadow)** | append-only binary records, SHA-256 coverage, rollover, dual-slot atomic checkpoint, explicit data/checkpoint/directory barriers, persisted request deduplication, cooperative deadline/unknown handling, typed service-unavailable, fenced generations, fail-stop unknown append sessions, and retained tails; production profiles remain disabled |
| F. Snapshot-through-T projection bootstrap | **implemented (candidate edge)** | versioned binary snapshot, integrity/schema/cut verification, strict replay-after-T, typed required/optional/none outcomes, deterministic rebuild, same-cut compatibility parity, complete hydration validation before required-peer registration, state emission before `RequestStart`, and state-service ownership; the explicit path is default-off and production-ineligible, while default cutover and bridge deletion remain pending |
| G. Local strong-durability qualification | **implemented for named process/disposable, agent-120 clean-restart, and same-office off-host envelopes** | retained three-platform process-crash reports plus the agent-120 Linux/ext4 candidate runs cover 360/360 seeded VM/device-model cuts, real ENOSPC, repeated reopen, fsck/hash, Episode load, one real clean host reboot, same-host external-path restore, and an agent-120 to Ubuntu 222 verified backup/empty-root restore; the machine reports remain fail-closed for production, sudden physical power loss, and independent failure domains |
| H. Single-host end-to-end performance release gate | **qualified for one named durability candidate slice** | retained `070e0804b` agent-120 evidence passes the frozen `linux-ext4-agent120-slo-v1` absolute `durable_group`/`durable_sync` latency, throughput, rollover, 30-minute soak, resource, recovery, projection, and same-host backup/restore ceilings; the wider visible/typed/multi-reader product surfaces remain separate admission work |
| I. Current-hardware candidate admission and configurable execution | **complete** | one digest-verified inventory admits the default-off live receipt, projection, agent-120 fault/SLO/clean-restart, and same-office off-host restore slices; the KFD-1 policy reaches native state-service append/barrier/reconcile execution while fixing production, physical-power-loss, independent-domain, HA, replication, and consensus claims to false |
| J. Replication and HA | **future** | add a separate replicated watermark and policy only after local durability is trustworthy |

Passing Stage G in a disposable VM does not qualify a production deployment.
Public product language must name the exact evidence envelope and continue to
refuse physical-host power-loss, independent-failure-domain, or production
durability claims until separately retained evidence and release admission
exist.

A retained v2 production-candidate campaign now reaches the current local
evidence ceiling without widening Stage G: 360/360 required trials passed
across two durability profiles, ten cut points, raw/qcow2 virtual data devices,
three QEMU cache models, and three deterministic seeds. The harness fsynced
every result before continuing and used fresh data and verification boots. The
adjacent process and institutional reports also retain complete Episode load,
real ENOSPC, three whole-guest reopens, fsck/hash, and same-host offline
backup/restore evidence. See the
[agent-120 evidence index](evidence/durability/791e09a70/README.md). These
reports qualify only their named process and QEMU device-model envelopes,
never physical NVMe cache, sudden host power loss, an independent failure
domain, or a production profile.

The adjacent [off-host evidence index](evidence/durability/987201493/README.md)
retains the exact source, manifest, completion, target verification, restore,
and aggregate reports from agent-120 to Ubuntu 222. It upgrades only the named
same-office off-host transfer/restore fact; it does not widen the QEMU power-cut
envelope or establish an independent disaster domain.

The adjacent [clean-restart evidence index](evidence/durability/17e807700/README.md)
retains the exact pre/post reports, resume token, and aggregate report across a
real clean agent-120 reboot. It upgrades only that named clean-host restart
fact and keeps sudden physical power loss and production eligibility false.

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

The first post-correctness executable gate is
`./shifu durability:slo -- --run-id SOURCE-agent120-slo-v1`. It is a
default-dry-run, project-local harness: no GitHub workflow or self-hosted runner
is involved. Its profile was frozen before measurement, a correctness failure
stops later workloads, and every raw result is fsynced before the aggregate
verdict. Even a passing result remains a named agent-120 durability candidate,
not physical-power-loss evidence or production eligibility.

The retained `070e0804b` run passed all eight required workloads with zero
violations. It preserves the exact 174,665-byte aggregate report and
71,003-byte raw histogram log on agent-120 by SHA-256, with a checked-in
[evidence index](evidence/durability/070e0804b/README.md). This advances only
the named current-hardware durability SLO slice; it does not widen Stage G's
power-loss envelope or activate a production profile.

## Detailed records

- [Single-host institutional trust profile](single-host-institutional-trust.md)
  defines the first institutional deployment envelope, adoption gates,
  evidence requirements, operator responsibilities, and non-claims.
- [Single-host end-to-end performance qualification](single-host-performance-qualification.md)
  defines the post-correctness release gate and the strict boundary for any
  Aeron comparison.
- [KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca](../adr/KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca.md)
  fixes the authority, watermarks, receipts, service boundaries, and staged
  adoption decision.
- [Strong-durability design](../architecture/strong-durability-and-crash-recovery-design.md)
  defines the component contracts, recovery state machine, failure behavior,
  migration plan, and qualification work.
- [KF-ADR-019f86da-4f90-7f8a-9bff-e4f7683da35f](../adr/KF-ADR-019f86da-4f90-7f8a-9bff-e4f7683da35f.md)
  records why current mmap production policy qualifies visibility only.
- [Episode atomicity qualification](episode-atomicity-qualification.md) defines
  the related Episode fault-containment evidence program.
