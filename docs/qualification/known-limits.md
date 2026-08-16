# Known Limits

What kungfu does *not* yet guarantee, stated plainly. This is part of answering
"why can I trust this complex thing?" — a system you can trust is one that is
honest about its edges, not one that hides them. Each entry says what is not yet
guaranteed, its current status, and where it is tracked.

This document is curated from the project's own decision records and is kept
current; if a limit here is resolved, the entry moves to a guarantee elsewhere
(and links back). Use the [documentation guide](README.md) for the curated
reader path and the [documentation map](../MAP.md) for exhaustive lookup.

## v4 schema compatibility enforcement is designed, not yet complete

The yijinjing schema layout is the v4 compatibility root. Kungfu does not promise
compatibility with v1/v2/v3 layouts, old trading-era APIs, or removed package
names. From the first stable v4 baseline onward, released v4+ data must not be
silently stranded by schema changes; [KF-ADR-019f86da-4f90-7bf2-9789-1b88bf3ed265](../adr/KF-ADR-019f86da-4f90-7bf2-9789-1b88bf3ed265.md)
defines that boundary.
What is **not yet built**:

- a CI check that blocks breaking schema changes (modifying an existing field,
  renumbering) after the stable v4 baseline;
- a runtime/schema load gate for released v4+ schema epochs;
- v4+ compatibility-window declarations;
- a cold-path replay/import/export cross-version test baseline for v4+ data.

So today the invariant exists physically (zero-copy layout), but the *enforcement*
that will make the post-stable v4 compatibility promise mechanically checkable
is pending. Before v4 stable, verify against the current layout; after v4 stable,
schema changes need an explicit compatibility or migration path.

## The remaining control / event axis limit is the Node watcher snapshot model

The Python coroutine private-API limit is resolved by the standards-compatible
bridge and process-isolated service runtime in
[KF-ADR-019fb64f-ba63-7620-a384-063adec7af2f](../adr/KF-ADR-019fb64f-ba63-7620-a384-063adec7af2f.md).
Its exact boundary is machine-readable in the
[Python KFX asyncio runtime contract](python-kfx-asyncio-runtime.contract.json).
Journal/replay ordering remains Core-owned; live service scheduling uses
CPython's standard asyncio loop.

The performance harness now qualifies a retained, exact-revision CPython 3.13
service-plane envelope on macOS ARM64, Linux x64, and Windows x64. Its metrics
remain advisory and platform-specific: it does not qualify journal or
data-plane hot paths, set a universal latency/throughput SLO, or make a claim
for a platform whose exact-revision artifact is missing. See
[Python KFX asyncio Performance Qualification](python-kfx-asyncio-performance.md).

One recorded limit remains: the Node watcher snapshot model makes a whole-state
copy under lock. That becomes relevant at large state sizes, not at current
scale
([KF-ADR-019f86da-4f90-7fb3-a803-393d3bbe6704](../adr/KF-ADR-019f86da-4f90-7fb3-a803-393d3bbe6704.md)).

This is identified and tracked, not silently shipped. It does not affect the
data-plane correctness covered by
[KF-ADR-019f86da-4f90-7179-a900-c40bdb498910](../adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md).

## End-to-end durability is test-qualified in a disposable envelope, not for production

Kungfu currently qualifies release/acquire publication and cross-process
visibility for the mmap journal. It does **not** yet guarantee that every frame
reported as written will survive sudden power loss. The current production mmap
policy rejects unqualified `asynchronous` and `durable` modes rather than
silently treating OS writeback as a durability contract.

The KFDL v2 append/checkpoint backend remains production-ineligible. The KFD-1
config contract now exposes an explicit default-off current-hardware candidate,
and the standard coordinator executes its admitted receipt path with native
re-admission, deterministic profile rules, batching, deadlines, and exact-id
reconciliation. Retained evidence
covers six named macOS/APFS, Linux/ext4, and Windows/NTFS process-crash reports
plus an agent-120 Linux/ext4 campaign with 360/360 seeded abrupt VM cuts across
six virtual device/cache envelopes, real ENOSPC, repeated fresh reopen,
fsck/hash, Episode load, and same-host external-path restore. The reports keep
physical-host, physical-device, independent-failure-domain, and production
claims false. A separate retained agent-120 to Ubuntu 222 run now verifies a
same-office off-host backup, partial-transfer rejection, empty-root restore,
and repeated restore; it does not change those physical or independent-domain
non-claims. A bounded agent-120 run also crosses a real clean Linux host reboot,
proves the kernel boot identity changed, and reopens the same durable frontier,
Episode, projection, and fenced ownership generations. It is clean-restart
evidence only, not sudden-power-loss or production-eligibility evidence. The
six prerequisite deliveries are now aggregated by a digest-verified
current-hardware admission report; its candidate verdict remains default-off.

What is **not yet built or qualified for production**:

- default-on activation of KFDL ingestion as a dedicated service independent
  of coordinator and projection lifecycle;
- default-on or production-eligible activation of the now-configurable
  `durable_group` and `durable_sync` request/receipt/reconciliation candidate;
- sudden-power-loss qualification on physical macOS, Linux, or Windows hosts,
  plus clean-host-restart qualification outside the named agent-120 Linux
  envelope;
- off-host backup and restore on an independent power/network/site failure domain;
- exact production device/cache qualification and release admission.

The shadow checkpoint currently carries the complete successful request-id
index for its stream epoch so restart deduplication is exact. Retention and
compaction for that growing index are not yet qualified; this is deliberately
kept behind the test-only boundary rather than weakened to last-request-only
deduplication.

A state-service-owned snapshot-through-T plus replay-after-T implementation now
exists for checkpoint-covered KFDL records in tests. Its binary integrity,
schema/cut checks, required/optional/none peer outcomes, deterministic rebuild,
and projection-failure isolation are implementation evidence only. A test-only
projector now covers the actual Hana `StateDataTypes` closed set and proves
same-cut equality with the compatibility state bank plus rollback on malformed
known records. Verified images also hydrate peer state atomically, and a fresh
process reopens KFDL plus the snapshot to prove local restart recovery.
An explicit, default-off projection candidate now validates the complete state
image before required-peer registration and emits it before `RequestStart`,
without coordinator-owned business PUBLIC/SYNC joins or compatibility restore.
The undeclared/default production
path still uses the coordinator compatibility bridge. The candidate reports
`production_eligible: false`; bridge deletion and public production projection
eligibility remain pending even though current-hardware candidate admission is
complete.

KFDL v2 also has a test-only read-only recovery inspector and typed report for
clean, complete-tail, torn-tail, unprovable-checkpoint, and interrupted-Episode
cases. Valid open Episodes contract recovery to degraded capabilities; invalid
or unknown Episode evidence blocks recovery. The inspector performs no mutation
and is not yet a public recovery command.

The maintenance slice can retain a degraded stream in a verified quarantine
package with a typed, idempotent receipt. It deliberately does not switch the
authoritative stream, truncate a tail, or claim that the receipt itself has a
qualified power-loss barrier; destructive repair and crash-ordered replacement
remain pending.

A test-only consistent-backup API now exports an exclusively owned, stable
`READY` cut and restores it into an empty data root. It verifies authoritative
file bytes, durable frontier and record count, sealed Episode content roots and
payload hashes, and an explicit projection rebuild to the same typed state,
cut, and integrity hash. Ownership, quarantine, receipts, and derived
projections are excluded from the bundle. External archive serialization,
institution-operated backup transport/retention, crash-ordered restore
qualification, and a public backup command remain pending.

SQLite WAL, a mapped-region flush, or a resident process is not a substitute for
that evidence. See [Configure durability](../guides/durability-configuration.md)
for the explicit candidate controls and costs, and
[Strong durability and crash recovery](durability-and-crash-recovery.md)
for the current status and [KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca](../adr/KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca.md)
for the staged architecture.

Institutions considering Kungfu as a local system of record should use the
[Single-host institutional trust profile](single-host-institutional-trust.md)
as the adoption checklist. Until the named durability profile and exact
platform/filesystem/device envelope have retained passing evidence, the
institutional status remains evaluation or controlled shadow operation.

## The single-host end-to-end performance release gate is only partially qualified

The existing mmap qualification measures component behavior and prevents
speculative policy tuning. It does not establish a product-level latency,
throughput, resource, replay, recovery, or restore SLO for the complete
single-host institutional profile.

The [Single-host end-to-end performance qualification](single-host-performance-qualification.md)
defines that post-correctness release gate. A first frozen
`linux-ext4-agent120-slo-v1` harness now measures both candidate durability
profiles under latency, batched throughput, rapid rollover, and two 15-minute
soak workloads, together with recovery, projection, same-host backup/restore,
and resource ceilings. It is default-dry-run, build-tree-local, and never
dispatches GitHub CI.

The first retained agent-120 execution passed all eight frozen workloads with
zero violations; its report and raw-histogram digests are indexed under
[`evidence/durability/070e0804b/`](evidence/durability/070e0804b/README.md).
This still does not qualify the complete gate. Visible raw/typed paths, fan-out
and slow-reader behavior, wider Episode paths, cross-platform storage
envelopes, and product capability integration remain pending. Aeron IPC and
Aeron Archive may be used as declared reference comparators, but the current
profile intentionally has no comparator and Kungfu makes no `Aeron-class`,
equivalence, compatibility, or superiority claim.

## The first public v4 Alpha does not open a Stable release line

The v4 build-and-release path produced `v4.0.0-alpha.1` with public desktop and
standalone CLI artifacts, a signed Alpha channel, installers, Release Passport,
and public status readback. That closes the former “release infrastructure not
operational” limit for this exact Alpha. It does not establish a Stable channel,
native package-manager publication, a production support commitment, or
automatic qualification of a later release. Use the
[installation guide](../guides/installing-cli.md),
[Alpha Status](../guides/alpha-status.md), and the exact release evidence rather
than inferring those broader claims from the existence of one Alpha.

## The end-user shell is partial, not complete

The `kungfu` command is the runtime today and the canonical CLI over it. Several
operator-facing slices have landed — for example the interactive bare `kungfu` TUI,
`kungfu managed-run`, Kungfu Skill context injection, and the first skill-manager
view. That is not yet the same as a complete end-user shell.

What is **not yet guaranteed**:

- Stable and native package-manager installation paths for non-contributors;
- full parity between GUI-launched and CLI-launched managed sessions;
- all planned multi-window/session workspace behavior being default-on;
- a final product surface that hides internal implementation terms such as tmux,
  provider CLI details, or development worktree paths.

Treat these as usable pre-release slices, not a finished shell promise.

The Agent Work Lab proves only its exact continuity fixture. The
bundled offline run proves deterministic state recognition across fresh
processes; a selected-agent run binds the executable digest, version, runtime
profile, platform, fixture, oracle, plan, attempts, assessment, and report.
Neither result establishes model intelligence, provider ranking, security,
production fitness, or KFD certification. Providers without a verifiable
workspace-only sandbox are reported with residual confinement risk rather than
silently receiving an unqualified verdict.

The [KFX identity-neutral terminal](kfx-identity-neutral-terminal.md) qualifies
the native authority chain and exact Agent Work Lab Suite cut; it does not turn
KFD, first-party identity, or Product System metadata into permission. The
retained limits are Stable publication, native package-manager channels,
universal native-code confinement, marketplace operation, production
qualification, and independent third-party production adoption. The current
Alpha already includes Linux and Windows desktop artifacts; their existence
does not widen those remaining claims.

## Ecosystem SDK qualification is source-complete on one platform, not released

Python `kungfu-storage`, Node `@kungfu-tech/storage`, and the Rust
`kungfu-sdk` crate are thin adapters over the same versioned libkungfu storage
contract. Their shared clean-environment fixture has exact-artifact Darwin ARM64
evidence for Episode lifecycle, head/historical query, fsck, and export without
sibling SDKs or the GUI.

What is **not yet guaranteed**:

- publication of those package names to PyPI, npm, or crates.io;
- equivalent exact-artifact reports for Linux x64 and Windows x64;
- a cross-platform peak-resident-memory measurement in the one-shot SDK gate;
- a stable compatibility promise before the v4 release channel promotes them.

The artifact matrix therefore keeps all three ecosystem SDK rows `staged` even
when a source-built qualification report passes on a named platform.

## Runtime storage service is designed, not complete

Kungfu has the grounded pieces for a local runtime fact ledger: append-only
journals, frame provenance, location/channel runtime identity, portable export
direction, schema registry direction, SQLite projections, and a first
Atlas-scoped payload import/fsck/export/verify loop. The unified storage service
described in [`runtime-storage-service.md`](../architecture/runtime-storage-service.md) is still
staged.

What is **not yet guaranteed**:

- large payload bodies are not yet uniformly stored behind hash-addressed
  references across every runtime scope;
- generic `kungfu source sync` across machines by range/Episode/hash inventory;
- complete `storage fsck` coverage for all journal, payload, manifest, schema,
  projection, and remote cursor classes;
- range/Episode/hash import-export is not yet the remote sync substrate;
- destructive-safe `gc` / `compact` with archive and rollback reporting;
- repair of arbitrary journal corruption;
- an authority migration path where an imported source becomes the single source
  of truth.

Treat current Storage/Episode query, export, fsck, repair, GC-plan, compaction-
plan, domain storage, and source import/export slices as proof surfaces for the
storage contract, not as a completed distributed storage protocol. Legacy
loose-file journal archive/clean commands are retired; this release deliberately
has no destructive retention command.

## Runtime activation is process-host qualified, not universally embedded

[KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c](../adr/KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c.md) now has one retained qualification harness for daemonless storage,
the directly callable no-fork engine seam, exact-cut process activation,
generation/lease/crash recovery, Profile action admission, surface parity, and
the current-platform product artifact. Native readiness coordinates are
published only after durability/projection authority succeeds and are
revalidated when consumed.

What is **not guaranteed**:

- a production `EmbeddedRuntimeHost`, thread model, re-entrancy contract, or
  external executor ABI;
- semantic readiness from PID, route, service-install, GUI, or descriptor-file
  existence;
- distributed election, cross-machine leases, replication, or HA;
- default-on production durability/projection candidate profiles;
- physical-host or sudden-power-loss recovery from process-crash evidence;
- a universal activation latency/resource SLO; or
- product qualification on a platform without its own retained complete report.

See [Runtime activation and product delivery](runtime-activation-and-product-delivery.md)
for the exact matrix and report semantics.

## KFX runtime confinement is staged

The trust boundary is decided in
[KF-ADR-019f86da-4f90-79f1-8716-aca36b142847](../adr/KF-ADR-019f86da-4f90-79f1-8716-aca36b142847.md)
and the uniform capability surface is decided in
[KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9](../adr/KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9.md).
The first guest-host and sandbox primitives exist, but the ecosystem-facing
surface is still staged.

What is **not yet guaranteed**:

- the proposed `service` facet is not a stable published extension surface yet
  ([KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be](../adr/KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be.md));
- stronger read-scope narrowing, shadow-file reconciliation, and resource
  ceilings are follow-ups beyond the permissive first delivery;
- untrusted instrumentation adapters are refused rather than sandboxed, because
  capture-side instrumentation must run inside the traced process.

So "sandboxed" should be read as a precise tier/property for the relevant host
and facet, not as a blanket statement that every extension form is safely
contained.

## Profile Suites are qualified pre-release, not a universal workflow builder

[KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1](../adr/KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1.md)
adds `kungfu.profile-suite/v1`, shared validation, content-bound facets, and
installed CLI schema discovery to the KFX contract.

Core computes a content-bound Profile root and records append-only install,
qualification, activation, supersession, rollback, and removal facts. The
installed Agent SDK adds deterministic scaffold/validation, semantic diff,
full/thin source portability, declarative actions, KFD-1 contract composition,
[KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104](../adr/KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104.md) query families, and [KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302](../adr/KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302.md) purpose-bound assessment. Work Control
uses that public path, and an independently authored Week/Day/Action Suite has
qualified coexistence, rollback, removal/reinstall, and portable evidence on
macOS ARM64.

What is **not yet guaranteed**:

- semantic qualification checks beyond Core's source-contract, content-closure,
  and runtime-contract policy;
- equivalent frozen-product qualification on Linux x64 and Windows x64;
- a stable compatibility promise before the v4 release channel promotes this
  surface;
- a no-code Profile/ontology builder, marketplace, remote registry, or automatic
  acquisition of third-party Profile members;
- cryptographic verification that the actor named in a decision answer owns the
  declared authority;
- arbitrary executable Profile logic outside the existing KFX facet,
  capability, and confinement boundaries;
- reconstruction from a thin bundle, which intentionally contains roots and
  inventory rather than source, payload, schema, or frame bytes.

A schema-valid Profile proves only that its declared source closure satisfies
the current contract. Lifecycle receipts prove a specific Core transition;
query and assessment receipts add cut- and purpose-bound evidence. They do not
turn a source assertion into universal external truth or prove that a real-world
action achieved the user's intended outcome.

## Kungfu Skills have a first slice, not a marketplace

Kungfu Skills are accepted as the agent-facing context layer above kfx
([KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf](../adr/KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf.md)).
The first slices cover `SKILL.md` parsing, compact catalogs, context envelopes,
managed-run injection, audit sidecars, SDK scaffolding, and a first skill-manager
view.

What is **not yet guaranteed**:

- marketplace discovery and remote publishing;
- automatic permission elevation;
- kfx artifact acquisition for unresolved skill dependencies;
- third-party runtime facet execution through a skill wrapper;
- uninstalling shared kfx dependencies as a side effect of removing a skill.

A skill can request, explain, and compose. It cannot bypass the kfx trust gate.

## Detached Agent Session recovery is provider-qualified, not uniform

The runtime-scoped detached worker now owns the real Capsule/PTY surface, and
the Mac source qualification passes GUI-main reconnect, provider exit fencing,
worker-loss fail-closed behavior, bounded overflow, receipt privacy, and local
RPC latency. Authenticated Codex 0.144.3 now passes the complete retained
interaction loop through the pinned App Server structured route. The current
Codex PTY screen does not match its older qualified signature, so PTY is a
manual recovery/new-attempt fallback rather than structured authority.

What is **not yet guaranteed**:

- Claude Code 2.1.209 tool approval did not converge to a supported
  `approval-needed` signature during authenticated Mac dogfood, so no deny key
  was sent and no approval outcome is claimed;
- Capsule worker loss and machine reboot end the old attempt; recovery requires
  a new attempt or provider-native resume and never adopts a stale PTY;
- equivalent packaged evidence on Linux and Windows; and
- Claude automatic approval/deny parity with the structured Codex route.

The Claude result is deliberately `degraded`, not passed, and remains a block
for claiming a complete Claude tool-approval loop. It does not turn typed Codex
events into Claude facts or block provider-scoped Codex structured promotion.
Terminal frames stay volatile and bounded; retained evidence contains only
state, counts, latency, versions, and path digests.

## Reference extensions are mid-migration

The repository's reference extensions double as build-time coverage probes.
Trading-specific ones from earlier versions are being retired and their coverage
role moved to neutral replacements that exercise the same paths; during this
migration both may be present.
