# Single-host institutional trust profile

This page is for an institution deciding whether Kungfu can serve as a local
runtime ledger. It translates the technical contracts into an adoption
decision: what is guaranteed now, what still requires qualification, which
failures are covered, what evidence must exist, and which responsibilities stay
with the operator.

It is not a certification, procurement promise, or substitute for an
institution's own risk assessment. Technical details remain authoritative in
[Strong durability and crash recovery](durability-and-crash-recovery.md),
[Single-host end-to-end performance qualification](single-host-performance-qualification.md),
[Known Limits](known-limits.md), and the linked architecture decisions.

## Current decision

**Kungfu v4 currently supports engineering evaluation, fault-model review, and
controlled non-authoritative or shadow workloads. It is not yet qualified as a
strongly durable institutional system of record for acknowledged facts across
sudden power loss.**

Today Kungfu qualifies cross-process visibility, typed journal integrity, and
deterministic replay from readable journal data. The stronger
`durable_group` and `durable_sync` profiles, producer-visible durable receipts,
deterministic recovery of an acknowledged frontier, and retained power-loss
qualification evidence are designed but not yet implemented end to end.

An institution that requires every acknowledged critical fact to survive
power loss should therefore treat the current release as **not admitted** for
that role. Kungfu must not be promoted from evaluation to an authoritative
local ledger until the relevant named profile and deployment envelope have
retained passing evidence.

## Qualified deployment envelope

The first institutional profile is deliberately single-host:

- one trusted host and one authoritative data root per workspace instance;
- multiple local processes and readers;
- one active writer per stream;
- one active state/durability service owner per data root, protected by an
  owner generation or fence token;
- explicit `visible`, `durable`, and `projected` frontiers;
- deterministic local crash recovery for the qualified profile;
- verified export, external backup, and empty-data-root restore;
- a trusted host administrator and trusted local operating-system boundary.

Qualification is specific to a declared Kungfu version, platform, filesystem,
storage/device profile, and durability profile. Evidence from one combination
does not silently qualify another.

This envelope does not include high availability, distributed consensus,
network-partition behavior, cross-host ordering, malicious-administrator
resistance, or recovery from whole-device loss without a verified external
backup.

## Guarantee matrix

| Guarantee | Current state | Required evidence before institutional claim | Operator responsibility |
|---|---|---|---|
| Complete frames become visible to local readers in publication order | Implemented | release/acquire and frame-integrity qualification | keep the deployment inside a supported process and storage envelope |
| Readable authoritative journals can be replayed and projections rebuilt | Implemented in staged slices | replay, fsck, projection-loss, and idempotent-rebuild evidence | retain authoritative journals and monitor integrity reports |
| A `durable_group` receipt survives the qualified local crash/power-loss model | Not implemented end to end | named platform/filesystem/device qualification with retained fault evidence | select only a qualified profile and reject degraded substitutions |
| A `durable_sync` receipt establishes the critical fact and required metadata | Not implemented end to end | barrier-ordering, torn-write, ENOSPC, I/O-error, and recovery evidence | use it for institution-defined critical facts once qualified |
| Recovery identifies the last durable frontier without inventing facts | Designed | repeated crash/recovery tests and machine-readable recovery reports | review loss, quarantine, and repair outcomes before resuming authority |
| Projection failure cannot erase a durably acknowledged raw fact | Designed | independent ingest/projection failure and rebuild qualification | treat SQLite as a rebuildable query projection, not the raw authority |
| Whole data-root loss can be recovered | Depends on external backup | consistent export, backup, empty-root restore, fsck, and replay round trip | operate, protect, and periodically restore-test an external backup |
| A second owner cannot concurrently acknowledge writes for the same data root | Designed | ownership-fencing, stale-owner, and fail-closed tests | avoid unsupported shared-data-root or multi-host mounts |

No row becomes a product guarantee merely because its implementation exists.
The corresponding named qualification evidence must also pass and be retained.

## Failure and recovery expectations

| Failure | Required behavior in the qualified profile | Current institutional status |
|---|---|---|
| Writer or peer process crash | preserve acknowledged durable frontier; classify any visible tail | not yet end-to-end qualified |
| Durability service crash | restart with a new fenced owner generation; never acknowledge an unknown outcome as durable | designed, not yet qualified |
| Projection service or SQLite loss | raw durable facts remain authoritative; rebuild from the recorded projection frontier | rebuild model exists; full profile qualification pending |
| Clean host restart | reopen the whole data root and resume from verified frontiers | qualification pending |
| Sudden power loss | recover only the proven durable frontier; report lost or quarantined visible tail | not yet qualified |
| ENOSPC, permission loss, or I/O error | fail closed; do not issue a false durable receipt | qualification pending |
| Torn/corrupt tail or stale checkpoint | detect, bound, quarantine or truncate by retained evidence; never invent facts | qualification pending |
| Whole device or data-root loss | restore only from a verified external backup and report its cut/RPO | operator-owned; verified round trip pending |

Recovery is not complete merely because the process starts. A qualified restart
must emit a machine-readable report naming the recovered durable frontier,
visible tail disposition, repairs, quarantine, projection lag, selected
profile, and any capability contraction.

## Evidence an institution should require

Before approving Kungfu as an authoritative local ledger, require evidence for
the exact deployment envelope:

1. a machine-readable capability report naming the Kungfu version, platform,
   filesystem/device profile, durability profiles, and explicit non-claims;
2. retained qualification results for process death, power loss, torn writes,
   stale checkpoints, ENOSPC, permission loss, I/O errors, and repeated
   recovery;
3. ownership-fencing evidence proving that a second or stale owner fails
   closed;
4. recovery reports that reconcile visible, durable, and projected frontiers
   and disclose any lost visible tail;
5. a consistent export and external-backup procedure, plus a recent successful
   empty-data-root restore, fsck, replay, and projection rebuild;
6. schema/version compatibility and migration evidence for the intended
   retention period;
7. release provenance for the exact binaries being admitted.
8. a passing Single-Host Performance Profile report covering absolute
   latency/throughput/resource thresholds, regression ceilings, long-tail
   behavior, sustained load, replay, recovery, and restore time.

Missing or stale evidence is a failed adoption gate, not an invitation to infer
the guarantee from `mmap`, `fsync`, SQLite WAL, process residency, or a
successful write call.

## Institutional and operator responsibilities

Kungfu can make local durability and recovery contracts testable; it cannot
replace the institution's operating controls. The adopting institution remains
responsible for:

- physical and operating-system security, host administration, access control,
  encryption-at-rest policy, key management, and malware defense;
- selecting only a qualified platform/filesystem/device/profile combination;
- capacity, disk-health, I/O-error, projection-lag, backup-age, and recovery
  monitoring;
- protecting external backups from the same failure domain as the primary
  host;
- periodically performing and retaining restore drills;
- defining which facts require `durable_sync`, which permit
  `durable_group`, and which are safely reconstructible under `visible`;
- validating upgrades, migrations, retention, export, and rollback procedures;
- reviewing recovery reports before the restored ledger resumes authoritative
  operation.

## Explicit non-claims

The single-host profile does not claim:

- zero downtime or automatic failover;
- replication, quorum durability, or distributed consensus;
- cross-machine ordering or network-partition tolerance;
- tamper resistance against a trusted host administrator becoming malicious;
- survival of whole-device loss without a valid external backup;
- qualification outside the exact named platform, filesystem, device, Kungfu
  version, and durability profile;
- that a readable or visible frame was durably acknowledged;
- that SQLite projection state is the authoritative raw ledger.

Replication and HA require a later, separately named profile. They must not be
implied by the local durability design.

## Adoption gates

| Stage | Appropriate use | Minimum gate |
|---|---|---|
| Engineering evaluation | API, integration, replay, and fault-model review | current limits accepted; no authoritative production claim |
| Shadow operation | record a copy of work whose authority remains elsewhere | operational monitoring and recovery rehearsal in place |
| Limited authoritative pilot | bounded institution-selected facts on one qualified host | named durable profile implemented; exact correctness envelope qualified; backup/restore drill passed; performance candidate characterized |
| Authoritative local ledger | institution-approved production scope | correctness and Single-Host Performance Profile release gates passed; all applicable evidence above retained, independently reviewed, and continuously monitored |

The current project state is between engineering evaluation and controlled
shadow operation. Later implementation work must update this page from retained
evidence; it must not advance the adoption status from design intent alone.

## Audit path

- [Strong durability and crash recovery](durability-and-crash-recovery.md) —
  durability profiles, watermarks, service boundaries, recovery contract, and
  implementation stages.
- [Single-host end-to-end performance qualification](single-host-performance-qualification.md)
  — absolute release thresholds, end-to-end workloads, retained evidence, and
  the informative Aeron comparison boundary.
- [Known Limits](known-limits.md) — current non-guarantees across durability,
  compatibility, release provenance, and product completeness.
- [Runtime storage service](runtime-storage-service.md) — authoritative records,
  projections, maintenance, and repair surfaces.
- [Episode atomicity qualification](episode-atomicity-qualification.md) — fault
  containment, capability contraction, and retained qualification evidence.
- [Contracts](contracts.md) — current layout, publication, replay, and
  compatibility contracts.
- [ADR-0068](../framework/core/docs/adr/ADR-0068-tiered-durability-and-crash-recovery.md)
  — the authority decision for tiered durability and crash recovery.
