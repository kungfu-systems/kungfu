---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0086
decision_status: accepted
implementation_status: implemented
implementation_commits: [69b0b82ebdf972a39f09e9a2737b0456314c2de8]
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/876, https://github.com/kungfu-systems/kungfu/pull/885, https://github.com/kungfu-systems/kungfu/pull/967, https://github.com/kungfu-systems/kungfu/pull/977, https://github.com/kungfu-systems/kungfu/pull/979]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/979
qualification_refs: [framework/core/src/libkungfu/tests/peer_continuity_tests.cpp, framework/core/tests/python/test_runtime_service.py, framework/core/tests/python/test_runtime_broker.py, framework/core/tests/python/test_peer_lifecycle.py, framework/agent-session/tests/peer-transport.test.mjs, framework/core/tests/qualification/live-peer-continuity/run.mjs, framework/core/tests/qualification/live-peer-continuity/native_campaign.py, .github/workflows/core-build-profiles.yml, scripts/run-zero-burden-product-qualification.mjs, docs/qualification/zero-burden-desktop-runtime.md]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-14
theme: live-peer-continuity-coordinator-authority
confidence: high
evidence_grade: B
last_reviewed: 2026-07-16
---

# ADR-0086: Live peers reconnect through fenced coordinator authority

- Status: accepted; implemented and qualified on macOS, Linux, and Windows
- Date: 2026-07-14
- Category: Core runtime / Peer lifecycle / coordinator recovery
- Related: [ADR-0064](ADR-0064-runtime-error-propagation-and-stop-ownership.md),
  [ADR-0068](ADR-0068-tiered-durability-and-crash-recovery.md),
  [ADR-0077](ADR-0077-agent-coordination-on-live-runtime.md),
  [ADR-0080](ADR-0080-topology-neutral-capability-driven-runtime-activation.md),
  and [ADR-0081](ADR-0081-durable-agent-session-capsule-control-plane.md)

## Context

A live Peer historically treated registration and start as a one-shot startup
handshake. When the Coordinator exited, the Peer removed topology state but did
not enter a bounded re-registration path. A replacement Coordinator could
therefore exist while surviving Peers remained disconnected, or an old command
frame could appear to complete a new bootstrap.

PID liveness cannot repair this boundary. A PID is process placement evidence,
not runtime authority, and it can be reused. Continuity also cannot be inferred
from terminal text, GUI presence, a Supervisor heartbeat, or the mere existence
of a journal.

## Decision

### 1. Coordinator authority is a two-dimensional fence

Every product Coordinator carries:

```text
(runtime_generation, coordinator_epoch)
```

`runtime_generation` comes from the admitted runtime activation. It advances
when the broker replaces that runtime generation. `coordinator_epoch` is a
positive, monotonically increasing value allocated under a portable file lock
in the workspace runtime state. It advances for every Coordinator process,
including a restart within one runtime generation.

The persisted authority rejects a lower runtime generation. A corrupt or
unsupported continuity record fails closed instead of resetting to epoch one.
PID, wall clock, and journal time are not authority sources.

### 2. Registration carries one shared continuity schema

Peer registration and Coordinator acknowledgement use
`kungfu.runtime.peer-continuity/v1`. Integer identities are decimal strings at
JSON edges and positive `uint64` values inside native Core.

A Peer reports its last admitted authority and reconnect attempt. A Coordinator
rejects a Peer that has already observed a newer runtime generation or a newer
Coordinator epoch in the same generation. A Peer rejects a lower runtime
generation and rejects a non-advancing Coordinator epoch within the same
generation. A higher runtime generation may begin again at any positive
Coordinator epoch.

Agent Session Capsule transport consumes the same schema and admission rule. Its
session stream epoch, Capsule generation, Supervisor generation, and controller
lease remain separate authorities and do not reset merely because a Coordinator
restarts.

### 3. Reconnect is bounded and bootstrap precedes readiness

After Coordinator loss, a live Peer enters `Disconnected`, then performs
non-blocking registration attempts with exponential backoff bounded between
100 ms and 5 s. A visible registration timeout reports failure but does not
terminate the retry loop.

An admitted acknowledgement moves the Peer to `Recovering`. The Peer clears
candidate projection state and rejoins the replacement Coordinator command
journal at the accepted registration cut. Only the corresponding `RequestStart`
may move it to `Ready` and invoke `on_start`. Old command frames cannot satisfy
the replacement bootstrap.

### 4. Legacy admission is deliberately narrow

A Peer with no previously admitted authority may connect once to a legacy
Coordinator through the synthetic authority `(1, 1)`. Once continuity has been
observed, a later acknowledgement without the schema is rejected. This permits
one additive transition without claiming restart safety from an unversioned
peer.

### 5. Process placement uses one independent fenced host per declaration

Peer process lifecycle is separate from Coordinator authority. A declaration
creates one small host for one Peer; it does not create a third global daemon.
The host executes an argv vector directly, never through a shell, and exposes
`plan`, `start`, `ensure`, `status`, `health`, `stop`, and `restart` through the
machine-readable `peer-lifecycle` contract.

Every control action is fenced by host generation plus host PID/process-start
identity. Peer adoption and signalling additionally require Peer generation,
Peer PID/process-start identity, and the exact readiness token issued for that
process. PID liveness alone is never registration, Ready, or adoption evidence.
A host crash may therefore expose a still-running Peer as `orphaned` and
`adoptable`; an unknown or reused process identity reports
`ownership-unknown` and fails closed.

Each Peer must declare what process loss means:

- `restart` requires a named durable recovery boundary and uses a bounded
  restart budget before reporting `crash-loop`;
- `lost-control` forbids process restart and requires the caller to follow the
  declaration's recovery guidance.

AgentSession Capsule declares `lost-control`: a surviving Capsule can be
adopted after its outer host is lost, but Capsule process loss ends the old PTY
attempt. Provider-supported resume may create a new attempt; it is not OS
process recovery.

## Implementation stages

1. Add the pure Core continuity contract, admission decisions, bounded tracker,
   and native tests.
2. Make live Peer registration repeatable and recovery cut-bound; project the
   activation generation through routes and process environments; persist a
   monotonic Coordinator epoch.
3. Bind the exact authority into Python Coordinator construction and share the
   JSON-edge semantics with Agent Session Capsule transport.
4. Qualify real process kill/restart continuity, stale/future authority
   rejection, projection rebootstrap, and product-visible failure handling on
   every supported desktop platform.
5. Add the independent Peer host, fenced host adoption, explicit recovery
   declarations, bounded Peer restart, and stale-host negative campaign.

Stages 1 through 5 are implemented. The full-profile Core matrix runs the real
cross-process campaign on macOS, Linux, and Windows and retains the report plus
compressed raw logs as per-platform CI artifacts. Source/unit checks do not by
themselves establish a platform qualification claim; all three full-profile
jobs must pass for promotion.

The closure evidence is bound to source tree
`6f28b9557e0f589c27c61c5431dea2d5e9717567` through synthetic merge revision
`2393f68672c0c6c3cf6950aec89b8017be3c6d8a`, whose parents are base
`4f7f48a5ee0d1af53d431f2eb0fb9ddf4a8a1453` and implementation head
`37e8ff1817f5b154f3c63eab2d02260b68adfaf8`:

- [Core build profiles run 29463399076](https://github.com/kungfu-systems/kungfu/actions/runs/29463399076)
  passed all six profile/platform jobs and retained
  `peer-lifecycle-macOS-ARM64`, `peer-lifecycle-Linux-X64`, and
  `peer-lifecycle-Windows-X64`. Each full-profile report has four passing
  suites, no violations, all thirteen native-campaign coverage claims true,
  and a hash-bound ten-entry raw-log bundle. The Peer lifecycle suite reports
  18 passed plus one Windows-only skip on macOS/Linux and 19 passed on Windows.
- [Core affected native run 29463399082](https://github.com/kungfu-systems/kungfu/actions/runs/29463399082)
  passed the embedded-SQLite closure: 29 selected build targets, 15 registered
  CTest tests, a verified plan digest, and four non-empty retained step logs.

These artifacts qualify single-host process continuity. They deliberately do
not claim physical power-loss recovery or cross-host high availability.

## Rejected alternatives

### Treat Supervisor liveness or PID as continuity

Rejected because process placement does not identify the activation generation
or prove that a replacement Coordinator is newer than one already observed.

### Restart every Peer process

Rejected because it discards valid provider, controller, and session state and
turns Coordinator maintenance into product interruption.

### Retry registration without an authority fence

Rejected because a delayed old Coordinator or stale command journal could be
accepted after a newer authority.

## Consequences

- Coordinator restart can be a recoverable runtime event rather than a desktop
  process restart requirement.
- The activation broker, Supervisor route, Coordinator process, and Peer agree
  on one explicit generation.
- Runtime state gains one small locked continuity record per workspace.
- Each managed Peer gains one runtime-local declaration, state record, log,
  and independent host process.
- Legacy peers remain operable for first connection but cannot claim restart
  continuity.
- Promotion remains blocked until real restart and stale-authority scenarios
  retain raw logs and pass the declared qualification profile.
