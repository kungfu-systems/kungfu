---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0081
decision_status: accepted
implementation_status: partial
implementation_commits: [80593936763261a38eb1fb696a254390c2decd67, 8b02979d68751924810d1dc25424dd7289f5d3e6, f3743218981bee7b1ffbe4fc14511845b8ac0b53]
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/834, https://github.com/kungfu-systems/kungfu/pull/837, https://github.com/kungfu-systems/kungfu/pull/840, https://github.com/kungfu-systems/kungfu/pull/885]
qualification_refs: [scripts/check-agent-session-contract.test.mjs, scripts/run-zero-burden-product-qualification.mjs, tests/fixtures/agent-session-capsule-contract, framework/agent-session/tests/capsule-host.test.mjs, framework/agent-session/tests/capsule-worker.test.mjs, framework/agent-session/tests/peer-transport.test.mjs, framework/agent-session/tests/runtime-port.test.mjs, framework/agent-session/tests/runtime-port.native.test.mjs, framework/agent-session/tests/provider-adapters.test.mjs, framework/agent-session/tests/interaction-port.test.mjs, framework/agent-session/tests/provider-version.native.test.mjs, framework/agent-session/tests/product-surface.test.mjs, framework/agent-session/tests/product-detached-host.test.mjs, framework/agent-session/tests/product-recovery-qualification.test.mjs, framework/core/tests/python/test_agent_console_contract.py, docs/qualification/zero-burden-desktop-runtime.md, docs/qualification/evidence/agent-session/stage6-macos-source-v1.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-14
theme: durable-agent-session-capsule-control-plane
confidence: high
evidence_grade: B
last_reviewed: 2026-07-14
---

# ADR-0081: one fenced AgentSessionCapsule owns each live agent PTY

- Status: accepted; implementation partial
- Date: 2026-07-14
- Category: product runtime / agent interaction / process ownership / recovery
- Related: [ADR-0016](ADR-0016-managed-session-host-placement.md),
  [ADR-0064](ADR-0064-runtime-error-propagation-and-stop-ownership.md),
  [ADR-0068](ADR-0068-tiered-durability-and-crash-recovery.md),
  [ADR-0070](ADR-0070-peer-communication-primitives-layering.md),
  [ADR-0077](ADR-0077-agent-coordination-on-live-runtime.md),
  [ADR-0079](ADR-0079-native-work-agent-console-loop.md), and
  [ADR-0080](ADR-0080-topology-neutral-capability-driven-runtime-activation.md)
- Contract:
  [kungfu-agent-session.contract.json](../../framework/agent-session/kungfu-agent-session.contract.json)
- Fixtures:
  [agent-session-capsule-contract](../../tests/fixtures/agent-session-capsule-contract)

## Context

Kungfu's current desktop terminal host owns `node-pty` in Electron main and can
optionally place the provider under tmux. That makes a window-independent tmux
process possible, but it still leaves process ownership, attachment,
controller authority, input deduplication, output replay, and recovery split
across presentation code and provider-specific terminal behavior. CLI and
agents cannot use the same write contract without going through a GUI-only
surface.

ADR-0079 already separates the stable `WorkConsole` from a physical
`SessionAttempt`. ADR-0080 already provides topology-neutral runtime
activation, generation fencing, capability leases, and readiness. Neither ADR
assigns PTY-master ownership or defines what a terminal delivery receipt can
prove. Repeating those semantics in GUI, CLI, and KFX adapters would create
multiple authorities and make restart behavior dependent on which client is
open.

The tempting opposite is to persist every terminal byte as a portable Episode
fact. Raw provider streams are sensitive, high-volume, and lossy by nature;
they are not authoritative work state. Treating them as such would weaken both
privacy and KFD evidence semantics.

## Decision

### 1. Identity and PTY ownership form one explicit chain

The authority chain is:

```text
WorkRef
└── WorkConsole
    └── SessionAttempt
        └── AgentSessionCapsule
            └── ProviderChild
```

`WorkConsole` remains the stable user-facing identity and `SessionAttempt`
remains one physical provider execution. Exactly one authority-bearing
`AgentSessionCapsule` owns the PTY master for a live attempt. Attachments are
readers; only the current controller lease may submit input. Runtime generation
fencing rejects a second owner or a stale lease.

The Capsule is a discoverable runtime Peer, not an Electron renderer or a
Coordinator subroutine. The Coordinator registers routes, generations, and
leases. It does not proxy every input or output byte and is not a continuous
liveness dependency for the provider.

### 2. Coordinator and stream epochs are independent

`coordinatorEpoch` advances when Coordinator authority restarts.
`sessionStreamEpoch` advances only when the authoritative Capsule is replaced.
A GUI or Coordinator restart may detach and reattach readers without resetting
the live stream. Every action and receipt binds the current Capsule generation
and session stream epoch so a recovered controller cannot write through a stale
view.

### 3. Four frame classes preserve authority boundaries

| Class | Examples | Authority and retention |
| --- | --- | --- |
| volatile terminal transport | input/output bytes, resize, VT snapshot, gap | bounded and runtime-local; sensitive by default; never portable fact authority |
| auditable control | attach, controller lease, interrupt, terminate, recovery | actor, plan root, attempt, preconditions, receipt, and denial reason |
| durable lifecycle | started, ready, exit, crash, orphaned, adopted, superseded | records what happened; does not infer task success |
| work facts | progress, cost, evidence, closeout, assessment | owned by Profile actions, Episodes, and KFD |

Output carries monotonic sequence numbers. A slow reader cannot backpressure
the provider. If bounded retention drops the requested range, the reader gets
an explicit gap plus a current VT snapshot; loss is never silently presented as
a contiguous transcript.

### 4. One provider-neutral interaction port serves every client

CLI, GUI, and KFX/Agent clients use the same plan/action/status/receipt schemas.
The public operation family is `start`, `attach`, `detach`, `end`,
`acquire-control`, `release-control`, `status`, `snapshot`, `instruct`,
`send-key`, and `interrupt`. Presentation code does not gain a private write
path.

Provider adapters expose interaction state as `ready`, `busy`,
`approval-needed`, `ended`, or `unknown`. Automatic semantic instruction is
held in `approval-needed` and `unknown`; an adapter never guesses by sending
Enter. Input uses an idempotent `inputId`. A timeout is resolved by querying the
receipt rather than blindly resending bytes.

A delivery receipt proves only that validated input was admitted and written to
the PTY at a named offset. Semantic outcome must come from a provider structured
event or a subsequent Profile/KFD action. PTY liveness, transcript text, and a
delivery receipt do not prove work progress, completion, evidence quality, or
reality fitness.

### 5. Provider execution has no shell fallthrough

The Capsule directly spawns a validated executable plus argv. It does not first
start a persistent interactive shell. Foreground identity binds provider,
Profile root, executable, argv, process start identity, attempt, and generation.
When the provider exits, input admission closes before any later text can be
accepted.

An opaque custom shell wrapper is an explicit compatibility mode. It must
declare its adapter and previewable executable/argv, and automatic semantic
instruction is disabled by default.

### 6. Recovery never invents a recoverable PTY

- GUI restart reattaches to the same Capsule with output sequence and VT
  snapshot recovery.
- Coordinator restart lets the Capsule re-register the same stream epoch.
- Supervisor restart may adopt a detached Capsule only when runtime identity,
  generation, process-start identity, and peer handshake are proven.
- Capsule crash ends the old attempt as lost control. A provider-supported
  resume identifier may seed a new attempt, but a surviving child PID is not a
  recoverable PTY claim.
- Machine reboot creates a new attempt and may use provider-supported semantic
  resume; it is not OS-process continuation.

tmux remains an explicit compatibility backend and direct mode remains an
explicit ephemeral backend during migration. Moving an existing GUI-owned PTY
to Capsule ownership requires a new attempt; there is no dual-owner transition.

## Contract and compatibility

The KFD-1 surface `agent-session-control-plane-contract` is rooted at
`framework/agent-session/kungfu-agent-session.contract.json`. It depends on the
registered runtime contract rather than copying runtime generation or lease
definitions. The value schema bundle freezes public plan, action, topology,
status, delivery, input-ledger, and output-read receipts.

Version 1 is pre-release. Optional operations, capabilities, states, and typed
errors may be added. Changes to identity, authority, epoch meaning, receipt
proof, or required fields require a new schema major and an explicit migration.
Provider or product implementation does not qualify the contract merely by
compiling; it must pass the same negative fixtures.

## Rejected alternatives

### Keep Electron main as the durable owner

Rejected because GUI lifetime would remain the process authority and CLI/Agent
control would require a private proxy surface.

### Make tmux the canonical control plane

Rejected because tmux provides process and terminal persistence but does not
own Kungfu identity, generation fencing, controller lease, plan roots, typed
receipts, or work-fact separation. It remains a compatibility backend.

### Route every byte through Coordinator

Rejected because it lengthens the data path and turns Coordinator restart into
a live-session dependency. Coordinator owns discovery and authority, not byte
forwarding.

### Treat transcripts as durable work facts

Rejected because terminal bytes are sensitive observations, not declared facts
or semantic outcomes. Explicitly admitted excerpts may later be attached as
evidence input under Profile/KFD authority.

## Consequences

- Electron main reaches Agent Session Capsules through a private detached worker
  and stable runtime-scoped endpoint. Worker loss ends its provider children and
  creates a new empty runtime rather than claiming PTY continuity.
- Provider adapters must fail visibly on unknown/modal state and version drift.
- Runtime and product implementations need bounded byte/VT retention, explicit
  gaps, controller lease receipts, and exact-generation process signaling.
- Privacy configuration governs raw prompt/output retention; secrets and
  environment values are not part of lifecycle or control facts.
- Synthetic provider qualification can prove host/transport invariants, but
  product promotion also requires packaged real Codex and Claude interactive
  smoke.

## Implementation and qualification stages

1. This slice registers the canonical contract, schemas, and negative fixtures.
2. A Capsule host owns a synthetic provider PTY and proves exit/input fencing.
3. Peer transport, controller lease, re-registration, bounded replay, and
   adoption are qualified under restart/fault cases.
4. Codex and Claude adapters prove semantic instruction and receipt separation.
5. CLI, GUI, KFX/Agent, WorkConsole, Profile, and KFD-3 share the same port.
6. Fault, privacy, performance, Mac product, and promoted real-provider evidence
   close the decision.

The contract slice, Stage 2 independent synthetic Capsule PTY host, Stage 3
journal/notice transport authority, Stage 4 provider-neutral interaction port,
and Stage 5 shared product action surface are implemented, so the
implementation status remains partial. Deterministic transport fixtures prove
multi-reader cursors, one-controller arbitration, input dedup, bounded gaps,
Coordinator re-registration, Supervisor adoption fencing and writer-path
fanout bounds.
The production adapter binds that seam to native Watcher Peers without a
Coordinator byte proxy. Versioned, redacted Codex and Claude Code fixtures now
prove ready/busy/approval/unknown admission policy, atomic paste, bounded queue,
manual-only keys, interrupt fencing, exit closure and visible adapter drift.
Local `--version` probes match Codex `0.144.3` and Claude Code `2.1.209` without
reading private state; they do not qualify authenticated TUI behavior. Stage 5
binds GUI, CLI, KFX/Agent, WorkConsole and KFD-3 to one action/plan/status/receipt
port and proves the product runtime plus local RPC with synthetic providers.
The Stage 6 implementation slice moves Capsule ownership into a detached local
worker, serializes first-worker startup across clients, reconnects a restarted
Electron main through one stable private endpoint, bounds RPC and VT state, and
terminates provider PTYs when worker authority ends. Synthetic Mac source
qualification covers restart reattachment, worker loss, provider exit, bounded
overflow, receipt privacy, and local RPC latency. Authenticated Codex `0.144.3`
passes instruction/output, approval denial, interrupt, main restart, and exit
closure. Authenticated Claude Code `2.1.209` now passes the same loop under an
explicit `Bash` ask rule: current VT-grid state overrides an erased volatile
busy signature, the real approval modal is detected, Escape is delivered, and
the disposable probe remains absent. The packaged Mac build
`20260714T150829Z-237b7662f` passes Codex PTY, Codex structured, and Claude PTY
loops through the packaged worker, retains no raw terminal or private
environment values, and is promoted at `/Applications/Kungfu Episodes.app`.
Machine restart and Linux/Windows qualification remain open, so the
implementation status remains partial even though Mac `promotionEligible` is
true and the qualified build is current.

The shared surface also projects each live or retained attempt into the same
product states for GUI, CLI, and Agent clients: `available`, `starting`,
`working`, `recovering`, `action-required`, or `ended`. A lost worker never
turns an unrecoverable attempt into an empty successful Hub: it retains the
attempt as `action-required` with the single safe recommendation to start a new
attempt or use provider-supported resume. Normal presentation does not expose
Capsule, worker, PID, Supervisor, or Coordinator terminology.
