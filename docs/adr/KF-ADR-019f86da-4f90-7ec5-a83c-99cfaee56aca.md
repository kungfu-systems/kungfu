---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/668, https://github.com/kungfu-systems/kungfu/pull/673, https://github.com/kungfu-systems/kungfu/pull/682, https://github.com/kungfu-systems/kungfu/pull/687, https://github.com/kungfu-systems/kungfu/pull/691, https://github.com/kungfu-systems/kungfu/pull/693, https://github.com/kungfu-systems/kungfu/pull/697, https://github.com/kungfu-systems/kungfu/pull/701, https://github.com/kungfu-systems/kungfu/pull/705, https://github.com/kungfu-systems/kungfu/pull/754, https://github.com/kungfu-systems/kungfu/pull/770, https://github.com/kungfu-systems/kungfu/pull/783, https://github.com/kungfu-systems/kungfu/pull/784, https://github.com/kungfu-systems/kungfu/pull/788, https://github.com/kungfu-systems/kungfu/pull/794, https://github.com/kungfu-systems/kungfu/pull/795, https://github.com/kungfu-systems/kungfu/pull/809, https://github.com/kungfu-systems/kungfu/pull/813, https://github.com/kungfu-systems/kungfu/pull/820, https://github.com/kungfu-systems/kungfu/pull/821, https://github.com/kungfu-systems/kungfu/pull/824, https://github.com/kungfu-systems/kungfu/pull/826, https://github.com/kungfu-systems/kungfu/pull/833, https://github.com/kungfu-systems/kungfu/pull/836]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-12
theme: tiered-durability-and-crash-recovery
confidence: high
evidence_grade: B
last_reviewed: 2026-07-14
---

# KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca: tiered durability separates hot visibility, durable fact admission, projections, and replication

- Status: accepted; staged
- Date: 2026-07-12
- Category: journal architecture / storage / crash recovery
- Subsystem: yijinjing journal, runtime live topology, state cache,
  projections, Storage, Episode, SDK receipts, qualification
- Related: [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910](KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md),
  [KF-ADR-019f86da-4f90-7a7d-99ba-c5c18088d450](KF-ADR-019f86da-4f90-7a7d-99ba-c5c18088d450.md),
  [KF-ADR-019f86da-4f90-737e-893f-c095b9a05cae](KF-ADR-019f86da-4f90-737e-893f-c095b9a05cae.md),
  [KF-ADR-019f86da-4f90-7516-b7ed-5b39a527cefb](KF-ADR-019f86da-4f90-7516-b7ed-5b39a527cefb.md),
  [KF-ADR-019f86da-4f90-7fa3-8045-32c1220ecd72](KF-ADR-019f86da-4f90-7fa3-8045-32c1220ecd72.md),
  and [KF-ADR-019f86da-4f90-7f8a-9bff-e4f7683da35f](KF-ADR-019f86da-4f90-7f8a-9bff-e4f7683da35f.md)
- Public contract: [Strong durability and crash recovery](../qualification/durability-and-crash-recovery.md)
- Design: [Strong-durability and crash-recovery design](../architecture/strong-durability-and-crash-recovery-design.md)

## Context

Kungfu's mmap journal is optimized for low-latency publication and zero-copy
live consumption. KF-ADR-019f86da-4f90-7179-a900-c40bdb498910 defines the release/acquire publication boundary;
KF-ADR-019f86da-4f90-7f8a-9bff-e4f7683da35f deliberately qualifies only the `visibility` mapping policy and
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

The first live adoption seam is an explicit, default-off
`production_candidate` activation. It is available only through the per-data-root
state service, requires a matching qualified `candidate/*` profile, and keeps
the normal `visible` path unchanged. A timeout or interrupted caller does not
guess whether a barrier completed: the caller reconciles the exact request id,
position, profile, and writer resource against checkpoint-covered receipt
evidence after restart. The only reconciliation outcomes are `reconciled`,
`unknown`, and `terminal_failure`; absence is `unknown`, never inferred failure
or success. Python, Node, and CLI surfaces are projections of this C++ result.

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

The first live cutover is an explicit, default-off projection candidate carried
as an additive JSON extension to the existing registration message. The
coordinator validates the complete required candidate image before publishing
the peer into the registry, then emits it before `RequestStart`; an optional
candidate may publish only with an explicit degraded result, while `none`
remains independent. Candidate peers do not join
the coordinator-owned business PUBLIC/SYNC streams or invoke the compatibility
restore bridge. Peers without the declaration retain the compatibility path,
which remains the rollback authority until production eligibility. C++, Python,
Node, and CLI expose the same `kungfu.projection-candidate-status/v1` status,
including `production_eligible: false`.

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
facts according to KF-ADR-019f86da-4f90-7516-b7ed-5b39a527cefb.

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
   The default-off live receipt candidate and restart reconciliation seam are
   implemented at this stage; they do not enable a production profile.
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

This ADR remains staged and is not a statement that strong durability is
already shipped. The integrated development stages now provide typed durability
positions and receipts, append-only durable ingest with checkpoint barriers, a
separate state-service boundary, typed snapshot-at-`T` projection bootstrap,
read-only crash classification, retained-evidence quarantine, and typed
interrupted-Episode classification. A test-only consistent-backup contract now
accepts only an exclusively owned, twice-verified `READY` cut; it excludes
ownership and derived projections, binds sealed Episode roots and payload
hashes, and restores idempotently into an empty data root before requiring an
explicit projection rebuild. Recovery inspection is deterministic and does not
silently abort, resume, repair, or promote uncertain facts.

The test-only recovery completion contract additionally reopens the whole data
root in a fresh process, mechanically authorizes supervisor -> state service ->
projection -> required peers, retains sealed cross-Episode dependency failures
as named findings without contaminating independent Episodes, and resumes only
exact interrupted quarantine packages. Episode capability truth remains owned
by the existing typed qualification and its independent semantic oracle rather
than being duplicated in recovery.

A versioned, dry-run-first local qualification harness now binds process-crash
evidence to the exact source revision, clean tree, platform/filesystem profile,
toolchain, fault matrix, and Shifu command surface. It retains separate
`durable_group` and `durable_sync` reports plus raw logs. The named macOS/APFS,
Linux/ext4, and Windows/NTFS profiles have passed this process envelope at the
same revision through local Shifu builds and qualification runs. The report
schema fixes power-loss qualification and production-profile eligibility to
false, so these results cannot activate a stronger public claim.

The Core dependency acquisition path used by that qualification now preserves
the RocksDB codeload archive type explicitly. Local no-controller-cache Shifu
Core builds passed on macOS, Linux, and Windows at `1140d28d`; this establishes
cross-platform buildability of the qualification path, not additional crash or
power-loss evidence.

The retained `Single-Host Institutional Profile v1` qualification slice now
adds a disposable Linux/ext4 QEMU device envelope. Both durable profiles passed
the same 20 record-write, data-sync, checkpoint, directory-sync, and
post-receipt power-cut trials. A separate real filesystem-full trial returned
an unknown I/O outcome without a durable watermark; fresh reopen retained only
the classified unacknowledged tail. Three whole-guest reopens recovered the
same durable frontier, and an offline block-image backup restored onto an
absent data device passed hash comparison, read-only fsck, and fresh-boot chain
verification at a quiesced RPO-zero cut. The retained report binds those facts,
the current-head ownership/recovery/projection suites, and the Episode smoke
qualification to raw evidence hashes.

The next qualification slice has a default-dry-run v2 QEMU campaign contract.
It freezes three full seeded cycles across raw/qcow2 virtual data devices and
`none`, `writethrough`, and `writeback` QEMU cache modes. A runner records each
trial to fsynced JSONL before continuing, emits an aggregate digest, and leaves
failed or interrupted workspaces intact instead of enabling selective reruns.
This is device-model evidence only; its schemas fix physical power-loss,
physical device-cache, and production eligibility claims to false.

The first absolute current-hardware SLO slice is now retained for
`linux-ext4-agent120-slo-v1`. Its thresholds were frozen before execution and
all eight required latency, throughput, rapid-rollover, and 15-minute soak
workloads passed at source `070e0804b` with zero correctness or SLO violations.
The evidence binds the report to agent-120, Linux/x86_64, ext4 on NVMe, the
profile digest, complete histogram/raw digests, recovery and projection times,
same-host backup/restore, and resource peaks. This is one named durability
candidate SLO, not qualification of the mmap visible path, another platform,
physical power loss, off-host backup, a comparator, or production eligibility.

The adjacent default-off off-host slice now has a versioned
manifest/data/completion-marker-last package and a bounded local Shifu harness.
The retained `987201493` execution exported the checkpoint-covered cut from
agent-120, rejected a manifest-only partial transfer, verified every package
digest on Ubuntu 222, restored an empty root, matched records, Episode,
projection state and cut, and repeated restore idempotently. This upgrades only
the named same-office two-host backup/restore fact. It does not establish
independent power, network, site, or administrator failure domains, physical
power-loss durability, scheduled backup operations, or production eligibility.

The adjacent clean-host-restart slice freezes one agent-120
Linux/x86_64/ext4/NVMe profile and separates preparation from verification.
Preparation durably writes a source-bound resume token and then relinquishes
control; the repository harness contains no reboot or host-service command.
After an independently authorized clean reboot, verification requires a changed
kernel boot ID and a fresh process that recovers the same frontier, records,
closed Episode and projection while advancing both fenced owner generations.
The retained `17e807700` execution qualifies only that clean-restart envelope;
it keeps sudden physical-power-loss and production eligibility false.

The current-hardware admission slice now freezes the six prerequisite
deliveries, exact source and delivery commits, PRs, Shifu rerun commands,
environment envelopes, artifact digests, and freshness invalidators. Its
machine-readable verdict is
`passed-current-hardware-production-candidate`. C++ remains the capability
authority; Python, Node, CLI, Episode, and Storage views project the same
default-off status. The verdict explicitly keeps physical power loss,
independent failure domain, production eligibility, HA, replication, and
consensus false. The coordinator compatibility bridge remains the default and
rollback authority until a future production qualification permits deletion.

The production mmap claim remains `demand + visibility`. The backup/restore
round trip and projection cut equality are implementation evidence, not an
operator-facing backup format or qualified power-loss guarantee. Production
bootstrap authority cutover, independent-failure-domain backup operations,
sudden physical-power-loss qualification, clean-host-restart qualification
outside the named agent-120 envelope, macOS/Windows device-tier qualification,
and production-eligible activation remain pending. The public product contract
now reports current-hardware candidate completion without widening those gates. In particular, the
disposable guest, clean-restart, and same-office off-host results do not qualify
a whole-device loss, an independent backup failure domain, or a production
profile.
