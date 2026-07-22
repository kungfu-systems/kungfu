---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0077
decision_status: accepted
implementation_status: partial
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/771, https://github.com/kungfu-systems/kungfu/pull/804, https://github.com/kungfu-systems/kungfu/pull/805]
review_state: maintainer-reviewed
sensitivity: public
sources: [local-files, user-decision]
theme: agent-coordination-on-live-runtime
last_reviewed: 2026-07-14
---

# ADR-0077: agent coordination on the live runtime — same-host locks, signals, and audited Episodes

- Status: accepted (direction decided 2026-07-13; maintainer-reviewed)
- Date: 2026-07-13
- Category: runtime architecture / peer communication / agent runtime
- Related: [ADR-0070](ADR-0070-peer-communication-primitives-layering.md)
  (peer communication primitives — this is the first post-trading consumer it
  anticipated), [ADR-0057](ADR-0057-domain-neutral-live-runtime-terminology.md)
  (domain-neutral runtime terminology), [ADR-0013](ADR-0013-cli-runtime-extension-isolation-trusted-channel.md)
  (capability relay / sandbox — the deferred confinement layer), the rewind
  capture stack (`kungfu.rewind`), and the workspace supervisor/coordinator split
  (`kungfu.runtime_service`, `kungfu.workspace`).

## Context

The product's near-term focus is agents running long-cycle tasks. The realistic
shape is several agents running concurrently on one host, each carrying its own
task context. Two needs arise that are not served today:

1. **Coordination between agents.** When two agents both integrate their work
   into the shared mainline through git, they currently spin-poll the same
   repository lock; that retry loop is run by the agent itself, so it burns
   model tokens. A multi-repo
   upgrade (e.g. `kfd` + `buildchain` + `kungfu`) is naturally three agents whose
   progress is interdependent, and today that dependency is conveyed through git.
2. **Audit of what agents did and decided.** Coordination and decisions live in
   git-based cards and lock files; there is no replayable, tracked record of the
   coordination itself.

The live runtime already provides the substrate for exactly this:

- **Data plane** — peers communicate through append-only, memory-mapped journals
  (same host, no network, no daemon on the byte path).
- **Wakeup plane** — the nng notice bus lets a reader block (`observer->wait()`)
  and wake on new data instead of polling.
- **Control/arbitration plane** — the per-workspace coordinator owns registration,
  naming, and topology; the machine-level supervisor owns `routes.json` and route
  leases (`ROUTE_LEASE_TTL_SECONDS`).
- **Capture** — the rewind supervisor brackets one traced run as one journal
  writer and one Episode, with L1 model-wire proxy and L2 interpreter hooks
  (`sitecustomize.py`, `--require rewind_hook.js`) feeding a local ingest endpoint.
- **`coloop`** — `LiveEventLoop` (an `asyncio.AbstractEventLoop` driven by
  `reactor.step()`) provides native coroutines on the reactor.
- **Workspace** is already a first-class identity (`kungfu.workspace`).

[ADR-0070](ADR-0070-peer-communication-primitives-layering.md) deferred its
Phase 2/3 until "the first post-trading peer consumer appears in v4 — … agent-to-
agent coordination". This is that consumer.

## Decision

Build agent coordination as a live-runtime consumer on the existing substrate,
**same-host v1, cooperative trust model**.

1. **Each agent-run is a bounded-mission peer** — one run = one journal writer =
   one Episode. Reuse the rewind supervisor; agents do not link `libkungfu`.
2. **Coordination primitives are `kungfu` CLI verbs backed by `coloop`
   coroutines** — named-lock `acquire`/`release`, `signal`/`await`, instruct
   injection, and fire-and-forget `report`. No Python threads (see Concurrency).
3. **The per-workspace coordinator arbitrates** — a named-lock table with a
   lease TTL and heartbeat renewal, reusing the route-lease pattern so a crashed
   holder's lock auto-releases.
4. **Two capture layers.** L1 *coordination* is self-instrumenting: the arbiter
   records every grant/decision because an agent that does not call `acquire`
   does not get the lock — coordination is a precondition, not author discipline.
   L2 *behavior* is passive: interpreter audit hooks record what the agent's free
   Python/JS actually `exec`/`open`ed.
5. **First slice: a named-lock arbiter for git mainline integration** — `kungfu
   lock-acquire mainline-integration` blocks on the grant frame (zero poll) and
   takes the agent's model out of the retry loop entirely.

### Delivery status (partial)

- **Delivered.** A same-host named lock (`kungfu lock run NAME -- <command>`) with
  crash-safe auto-release via holder-pid liveness, and Episode audit of each
  run's wait/acquire/release. The stdlib lock is dependency-free and tested
  cross-process; the audit and CLI run on a local core build.
- **Runtime plumbing (PR #799).** The live-runtime primitives the
  journal-native arbiter is built on: a Python-overridable peer react hook
  (`on_react`/`on_start` trampolines plus `observe(carrier_type, callback)` and
  the `request_read_from` / `request_write_to` / `get_public_writer` bindings),
  so a live consumer written outside C++ can react to journal frames without a
  bespoke C++ reactor subclass; and a coordinator-side fix so a peer that has
  just registered no longer crashes the coordinator when its PUBLIC / SYNC /
  command journals do not yet exist — the coordinator reader creates the missing
  page instead of failing the read-only open. Both are validated on a local core
  build (nine native journal / durability / crash-recovery tests plus a
  three-process live peer round-trip).
- **Foreground product projection (PR #804).** Desktop tray and status
  bar present one workspace-level runtime state instead of exposing supervisor
  and coordinator processes as separate user concerns. Process health proves
  only `Workspace online`; the stronger `Workspace ready`, `reconnecting`, and
  recovery states require explicit continuity evidence. Raw process diagnostics
  remain available in the advanced System Status view.
- **Arbiter body (this increment).** The journal-native arbiter that consumes
  the react hook — the first live Python peer and the first `coloop`-style
  grant-await consumer in the tree. A pure `LockTable` (FIFO request / release /
  forget; stdlib-only, unit-tested off the runtime) plus a resident
  `Arbiter(peer)` that observes `coordination.lock.request` / `release` frames,
  is the single writer of a `coordination.lock.grant` stream on its public
  journal, and records the whole stream as one replayable coordination Episode
  (the native audit that subsumes the first slice's per-run `audit.py`). A
  contending `LockClient` awaits its grant frame with no table poll. Auto-release
  keeps the ADR invariant on both paths: a clean holder sends a release frame; a
  hard-killed holder is reclaimed by a same-host pid-liveness reaper on the
  arbiter (each request carries the client pid), because the live runtime emits
  no deregister for an ungraceful death — a centralized, model-token-free check
  rather than N agents polling a table. The instruct-injection path (a one-shot
  writer addressing a worker's location so it reacts while holding a lock) is
  included. Custom `coordination.*` action types ride the action envelope with no
  C++ schema change. Proven end-to-end on a local core build by a cross-process
  harness — two workers serialize with zero poll, a SIGKILLed holder's lock is
  reclaimed and granted onward, an instruction is delivered to a lock-holding
  worker, and the coordination stream replays as a closed audit Episode — plus
  the `LockTable` unit suite.
- **Arbiter merged into the coordinator (this increment).** The lock arbiter no
  longer runs as a standalone resident `Arbiter(peer)`; the per-workspace
  coordinator hosts the `LockTable` directly, so a workspace keeps a single
  resident process as this ADR intends (the rejected alternative was a per-agent
  daemon). The react hook `observe(carrier_type, callback)` moved down to the
  common `reactor` base, the coordinator gained an `on_react()` hook and admits
  the lock action envelope in `is_reactable()`, and it grants by writing straight
  to the holder's command journal. Crash-safe auto-release now uses the registry
  pid the coordinator already owns (`Register` carries pid), so a lock request no
  longer carries a pid and the standalone pid-liveness reaper is gone — the tax
  the arbiter paid for living outside the registry. Audit stays frame-native
  without a bolted-on Episode: request / release frames are recorded centrally on
  the coordinator inbound journal and grants on the holder journals, so the whole
  lock history remains replayable while the arbitration surface stays narrow and
  storage failure never couples into the workspace lifeline. Proven end-to-end on
  a local core build by the same cross-process harness (race serializes with zero
  poll, a SIGKILLed holder is reclaimed to the waiter, an instruction reaches a
  lock-holding worker); the `LockTable` unit suite is unchanged.
- **Deferred to a follow-up.** Switching the `kungfu lock` CLI onto the
  coordinator lock backend as a managed resident service (the coordinator now
  hosts the mechanism; the CLI still drives the file-backed lock). Cross-host
  coordination and hard confinement remain out of scope.

### Architecture — reuse vs build

| Capability | Today | Action |
| --- | --- | --- |
| Resident authority (registration / naming arbitration) | machine supervisor (routes/leases) + per-workspace coordinator | reuse |
| Lock + liveness (crash auto-release) | route lease TTL + heartbeat | reuse the pattern; build a named-lock table |
| One worker = one peer = one Episode | rewind run supervisor | reuse |
| Behavior capture (interpreter hooks, not kernel syscalls) | L1 proxy + L2 `sitecustomize` / `rewind_hook.js` + ingest | reuse |
| Episode audit replacing git cards/comms | `RuntimeEpisodeLifecycle` + workspace Episode layout | reuse |
| Coordination verbs (lock / await / instruct / report) | — | build (thin, `coloop` coroutines) |

### Concurrency model — `coloop`, not threads

`LiveEventLoop` is single-threaded **by construction**: `call_soon_threadsafe`,
`run_in_executor`, and `run_until_complete` are unimplemented, so a coroutine
cannot be resumed from another thread. Coordination verbs are therefore
coroutines that `await` a future resolved when the arbiter's grant/signal frame
is delivered by `reactor.step()`. This is the single-thread-solves-concurrency
model applied to agent coordination, and it keeps the journal's single-writer
discipline by construction — the same choice the rewind capture layer already
makes with its queue plus one drain thread.

### Trust / deployment model — three layers, v1 cooperative

- **Coordination (this ADR)** — active semantic verbs; self-instrumenting.
- **Capture (rewind)** — observational; interpreter hooks, never kernel syscall
  hooks or a relaxed sandbox (observation is not containment).
- **Confinement ([ADR-0013](ADR-0013-cli-runtime-extension-isolation-trusted-channel.md) capability relay)** — a sandboxed
  guest reaches only its declared capabilities; an undeclared one is "never
  built". **Deferred.** v1 treats our own agents as cooperative: the `kungfu`
  CLI is the sanctioned driver and any escape is visible through L2 capture.
  Hard confinement for untrusted agent code is a known, available upgrade path;
  it is not built in v1 to avoid paying the cross-platform sandbox cost before
  the prototype has taught us what to confine.

## Relationship to ADR-0070

This consumer uses **Phase-1 outlet** (named-output *creation*, already
implemented) if and when an agent exposes multiple independently-subscribable
named streams. It does **not** trigger **Phase 2** (decoupling named output from
off-thread writing): agent coordination is same-thread-ordered or process-level,
and multi-thread capture is already solved by the rewind queue-plus-single-drain,
not by thread-affinity writers. Phase 2/3 remain deferred; the Phase-2
exploration was archived on this basis.

## Alternatives considered

- **Hook system calls (ptrace / eBPF / seccomp / sandbox trap) to capture agent
  behavior.** Rejected. A syscall wiretap *observes* but does not *coordinate*;
  the motivating cases (locks, dependency signals) are coordination, not
  observation, and a wiretap cannot grant a lock or make a waiter block.
  Cross-platform kernel hooking (macOS / Windows / Linux) is high-burden and at
  the wrong altitude (a `sys_write` firehose is not an Episode). Interpreter-level
  audit hooks give behavior capture at the right altitude, cross-platform, with
  no discipline.
- **A resident per-agent gateway daemon.** Rejected in favour of bounded-mission
  CLI + `coloop`: only one resident process per workspace (the coordinator);
  agents stay thin process-launchers and do not link the runtime.
- **A constrained coordination DSL for agents.** Rejected: it fights the agent's
  strength (models write ordinary code well). Free Python/JS plus capture is
  lower friction; a `kfx` script engine can emit Episodes structurally so
  "good-enough reporting" does not depend on author discipline.
- **Hard confinement now.** Deferred (see trust model).
- **Cross-host coordination now.** Deferred: journals are same-host shared memory;
  cross-host would use the nng transport and is out of v1 scope.

## Consequences

- Positive: removes the lock-poll token waste; moves agent coordination and audit
  from git into replayable Episodes; dogfoods the fact ledger; reuses almost all
  of the existing supervisor / coordinator / workspace / lease / capture / coloop
  substrate.
- Cost: a named-lock arbiter table, a coordination event schema, and the `coloop`
  verb glue are new (bounded). A per-workspace coordinator must be running.
- Deferred surface: hard confinement, cross-host coordination, ADR-0070 Phase 2/3.

## Open questions (to scope the first slice)

- Named-lock lease TTL default and renewal cadence (reuse the route 30 s?), and
  the waiter fairness policy (FIFO vs priority).
- Instruct-injection addressing: how a running run-peer's location is named under
  coordinator arbitration so a second one-shot can write to it uniquely.
- Episode write latency at coordination frequency — expected fine for coarse
  agent coordination; confirm on the first slice.
- Where the verbs live: a new `kungfu lock` / `kungfu coord` command group versus
  folding into the existing `kungfu agent` surface.
