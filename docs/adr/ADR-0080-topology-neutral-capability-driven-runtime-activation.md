---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0080
decision_status: accepted
implementation_status: partial
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/815, https://github.com/kungfu-systems/kungfu/pull/818, https://github.com/kungfu-systems/kungfu/pull/819, https://github.com/kungfu-systems/kungfu/pull/822]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-14
theme: topology-neutral-capability-driven-runtime-activation
confidence: high
evidence_grade: B
last_reviewed: 2026-07-14
---

# ADR-0080: live runtime activation is capability-driven and topology-neutral

- Status: accepted; implementation partial
- Date: 2026-07-14
- Category: runtime architecture / activation / recovery / embedding boundary
- Related: [ADR-0035](ADR-0035-workspace-local-kungfu-data-home.md),
  [ADR-0057](ADR-0057-domain-neutral-live-runtime-terminology.md),
  [ADR-0064](ADR-0064-runtime-error-propagation-and-stop-ownership.md),
  [ADR-0068](ADR-0068-tiered-durability-and-crash-recovery.md),
  [ADR-0069](ADR-0069-agent-first-kfx-profile-suite-runtime.md), and
  [ADR-0077](ADR-0077-agent-coordination-on-live-runtime.md)
- Contract:
  [kungfu-runtime.contract.json](../../framework/runtime/kungfu-runtime.contract.json)
- Fixtures:
  [runtime-contract-topology-neutral](../../tests/fixtures/runtime-contract-topology-neutral)

## Context

Kungfu has two valid execution modes today:

- closed-data and Episode operations can use the durable storage substrate
  without a resident daemon; and
- live discovery, routing, projections, assessments, and coordination use the
  current supervisor/coordinator process topology.

The public Python runtime service and its JSON status currently expose that
topology directly. A running supervisor and coordinator are useful diagnostic
facts, but they do not prove that recovery completed, a durable cut was
established, required projections reached that cut, or a requested capability
is ready. Treating process existence as workspace readiness would make recovery
unsafe and would force every future host placement to imitate the current PID,
socket, signal, and service-manager shape.

The opposite mistake would be to design a production embedded runtime before a
second implementation exists. Kungfu needs a stable semantic seam now without
inventing a thread model, external executor ABI, or in-process lifetime contract
that has not been qualified.

## Decision

### 1. Operations declare a runtime requirement, not a process topology

Every operation that may touch live runtime behavior belongs to one class:

| Class | Activation behavior | Missing live capability |
| --- | --- | --- |
| storage-only | must remain daemonless | not applicable |
| live-optional | attempt activation | continue only with an explicit degraded receipt naming every missing capability |
| live-required | require activation | fail closed with a typed error |

The requirement names the workspace, required capability ids, requested
runtime authority, optional minimum cut, and whether degradation is allowed.
It does not name a supervisor, coordinator PID, socket, GUI window, launchd
unit, systemd service, or thread.

Storage-only does not mean "start the runtime just in case." It is a hard
side-effect boundary. Live-required does not mean "best effort." It cannot
silently fall back to daemonless behavior or a reduced capability set.

### 2. Core issues one topology-neutral handle and receipt vocabulary

The activation authority is the Core runtime broker. CLI, Python, Node, GUI,
KFX, and libkungfu-facing product surfaces are request sources and projections
of the same result; none is a separate activation authority.

The canonical edge values are:

- kungfu.runtime.requirement/v1;
- kungfu.runtime.readiness/v1;
- kungfu.runtime.handle/v1;
- kungfu.runtime.lease/v1;
- kungfu.runtime.activation-receipt/v1; and
- kungfu.runtime.snapshot/v1.

A handle binds the workspace, runtime identity, requirement, generation,
capabilities, granted runtime authority, readiness evidence, and a host
descriptor. Host kind and diagnostics are visible for support, but consumers
branch on capabilities and readiness rather than host kind.

An activation receipt reports the exact requirement, outcome, achieved and
missing capabilities, granted authority, handle or absence of one, degraded
state, and typed error. A source-specific success path is forbidden: GUI and
agent callers receive the same receipt as CLI and bindings.

### 3. Readiness is semantic and cut-bound

Ready requires a verified durable cut from ADR-0068 and retained evidence that
the declared capabilities are current at that cut. A handle carrying
runtime.live-projection additionally requires an explicit projection cut.

PID liveness, a responsive socket, a fresh route heartbeat, an installed user
service, and a visible GUI are diagnostics. They may explain why readiness is
missing, but none can establish it.

The cut reuses the existing
kungfu::runtime::durability::stream_position shape: stream_id,
container_epoch, sequence, and frame_uid. This ADR does not create another
durability position, receipt, projection truth, or fact ledger.

### 4. Generation fences every authority-bearing object

One runtime identity has at most one authority-bearing generation. Starting,
recovering, ready, draining, and restarting handles carry that generation.
Leases, activation receipts, and later capability operations bind it.

Recovery or restart creates a new generation before new authority is granted.
Objects from an older generation fail with stale_generation; they are not
silently rebound by PID reuse, socket reuse, or a process reconnect.

The canonical lifecycle is:

    absent -> starting -> recovering -> ready -> draining -> stopped
                 |            |          |
                 v            v          v
               failed <--- restarting <---

The machine contract carries the complete allowed transition list. Failed may
restart or stop. Stopped may start a new generation. No direct starting-to-ready
transition skips recovery and cut establishment.

### 5. Leases express continued demand, not readiness or fact ownership

A lease binds a holder, runtime identity, generation, capability subset, issue
time, expiry, and state. An active lease may keep the host from idle draining.
It cannot broaden the handle's capabilities or authority, and its liveness does
not make the handle ready.

The current supervisor route TTL is an adapter implementation pattern, not the
public lease contract. Process liveness may help reclaim a same-host holder,
but a PID is not lease identity. Network leases, distributed consensus, and
high availability remain outside v1.

### 6. Runtime activation does not acquire existing authorities

The runtime broker may grant only:

- runtime.coordinate;
- runtime.capability-use; and
- runtime.lease.

Durable facts remain owned by yijinjing journals and Episodes. Durability and
projection cuts remain owned by the ADR-0068 services and receipts. KFD
contract-world, fact admission, Profile lifecycle, actions, and assessment
truth retain their existing owners.

A runtime request cannot gain fact-admission, Profile, assessment, or storage
authority merely because a host was activated. Granting anything not requested
is an authority_conflict.

### 7. V1 freezes semantic ports, not an external executor ABI

The minimal ports are:

- RuntimeHost: activate, inspect, and drain a requirement/handle;
- RuntimeTransport: probe, route, and subscribe to notices;
- RuntimeClockExecutor: now, schedule, and request stop;
- DurableEngine: recover and report durable/projection cuts; and
- CoordinatorEngine: register peers, report capabilities, and route control.

These are semantic boundaries. They do not yet promise C++ virtual class
layouts, a C ABI, thread affinity, re-entrancy, or an external executor
interface. RuntimeClockExecutor remains internal and provisional until a second
host requires a qualified implementation.

The current supervisor/coordinator process topology is now behind the Python
ProcessRuntimeHost placement adapter. CoordinatorEngine provides the directly
callable, no-fork request seam while process placement, PIDs, signals, spawning,
and OS service diagnostics stay in the adapter. RuntimeCapabilityBroker now
plans and atomically admits operations from the contract-owned operation
registry. Storage-only callbacks run without constructing a host; live-required
callbacks run only after a matching semantic ready receipt. The current process
bridge now serializes first activation per workspace, fences process generations,
and admits an explicitly configured native readiness authority only at or beyond
the required durable cut. It still fails closed when that authority is absent.
EmbeddedRuntimeHost is a reserved non-claim: v1 deliberately contains no
production implementation, thread model, or qualification claim for it. A
future host must implement the same requirement, handle, readiness, generation,
lease, receipt, and error semantics rather than introduce an embedded-only
public path.

## Current capability vocabulary

The first contract freezes only capabilities already demanded by existing
runtime consumers:

- runtime.peer-registry;
- runtime.channel-routing;
- runtime.live-projection;
- runtime.assessment-scheduling; and
- runtime.coordination.

Adding a capability requires an owner port, readiness rule, negative fixture,
and a caller that needs it. Product nouns, provider names, Mission/Go semantics,
tmux, and GUI presentation do not belong in Core capability ids.

## Error vocabulary

V1 defines stable names for invalid requirements, unsupported capabilities,
runtime unavailability, missing readiness/cuts, activation failure, unknown
outcomes, stale generations, expired leases, authority conflicts, and
operation cancellation.

Host adapters preserve the original cause and translate it at their stable
boundary as proposed by ADR-0064. A library does not synthesize a process signal
to report one of these errors.

## Compatibility and migration

| Current surface | Migration role | Compatibility rule |
| --- | --- | --- |
| kungfu.runtime.status/v2 and kungfu.runtime.routes/v2 | process diagnostics | retain; running/healthy never imply semantic readiness |
| Python runtime_service.ensure_coordinator | compatibility entrypoint | delegates to ProcessRuntimeHost.activate; do not expose it as the new public requirement |
| kungfu runtime ensure/start/status/stop/restart | operator commands | retain command compatibility while projecting requirement, receipt, handle, and advanced diagnostics |
| C++ runtime::live::coordinator | coordinator engine | keep domain-neutral terminology and historic wire identity adapter from ADR-0057 |
| GUI tray/status bar | request and presentation | consume the shared handle/readiness projection; no GUI-only activation authority |
| Python/Node/libkungfu/KFX | language and extension consumers | expose the same schemas and error names; do not reproduce lifecycle rules |

The historic master/master wire identity and legacy state directory remain
compatibility adapter details. This contract does not rename persisted
journals, delete runtime state, or require one destructive migration.

## Executable negative boundary

The source gate validates positive fixtures and rejects:

1. a PID presented as readiness;
2. two authority-bearing generations for one runtime identity;
3. ready without a durable cut;
4. an activation receipt that broadens authority;
5. GUI presented as the activation authority; and
6. a live-required request silently downgraded.

The contract and fixtures are checked by ./shifu check:source; packaged
products copy the exact contract through the existing KFD-1 contract registry.

## Consequences

- Daemonless Episode/storage work remains a first-class fast path.
- Process health remains useful without being overclaimed as workspace
  readiness.
- Recovery, generation fencing, leases, and capability activation have one
  language- and topology-neutral vocabulary.
- A future embedded host can be evaluated against a stable semantic boundary,
  while no speculative production implementation is promised now.
- The broker, schemas, adapters, and product projections add implementation
  work, but later stages no longer need to rediscover their core semantics.

## Rejected alternatives

- **Make supervisor/coordinator existence the public API.** Rejected because it
  cannot prove recovery, cuts, or capability readiness and freezes process
  placement into every caller.
- **Make GUI startup the activation authority.** Rejected because headless CLI,
  agents, KFX, and future hosts need the same behavior and receipt.
- **Always start the runtime for storage operations.** Rejected because it
  destroys the daemonless fast path and adds avoidable failure modes.
- **Let live-required degrade when startup is inconvenient.** Rejected because
  callers would act under capabilities they do not have.
- **Design a production embedded executor now.** Rejected because no second
  implementation exists to falsify the abstraction or qualify its concurrency
  semantics.
- **Create a second cut, lease, or fact authority for activation.** Rejected
  because ADR-0068, Episode, KFD, and Profile lifecycle already own those facts.

## Delivery stages

1. Land this ADR, the KFD-1 contract, fixtures, and source gate.
2. Put the current supervisor/coordinator path behind ProcessRuntimeHost. **Complete:** CoordinatorEngine supplies the no-fork request seam; ProcessRuntimeHost owns process placement. The full semantic RuntimeHost adapter remains stages 3-4 work.
3. Add the Core capability broker and generation-fenced handles. **Complete:** the operation registry, atomic daemonless/live admission seam, and generation-fenced process handles are implemented.
4. Bind recovery and projection readiness to an exact durable cut. **Core seam complete:** one per-workspace activation owner serializes first calls, persists the accepted generation, fences replaced process diagnostics, and admits native durability/projection evidence only at or beyond the requested cut. The process adapter remains fail closed when no `DurableEngine` readiness authority is supplied; product evidence discovery is stage 6 work.
5. Add leases, idle draining, adoption, and restart recovery.
6. Project the same contract through CLI, GUI, Python, Node, libkungfu, and KFX.
7. Qualify daemonless/no-fork behavior, process crash recovery, product
   artifacts, and supported claims.

Stages 2-7 may refine internal classes, but changing the public requirement,
readiness, generation, lease, receipt, or error semantics requires an explicit
contract/ADR update and new negative evidence.
