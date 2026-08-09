# Assignment Runtime R2 GUI Client

R2 moves the production Work Dashboard Assignment boundary to the versioned
`kungfu.assignment-runtime/v1` client. The Electron main process owns one
persistent Local Runtime writer for the selected logical workspace, while the
renderer and KFX view receive only the typed Runtime capability. No public
envelope exposes a physical Home path, Python type, or Electron channel.

This document describes the source candidate. It does not claim protected
delivery, deployed behavior, R3 CLI/Agent/KFX convergence, loopback transport,
or Cluster Runtime.

## Production path inventory

| GUI responsibility | R2 path | Exact boundary |
| --- | --- | --- |
| startup and authority identity | `createAssignmentRuntimeHost` starts the hidden `kungfu work runtime-host` command | readiness is published only after the R1 writer acquires its native authority; invalid identity, bind failure, process exit, malformed output, or handshake timeout fails closed |
| capability negotiation | `openAssignmentRuntime().discover()` | `capabilities.discover` with the exact R1 request and response schemas |
| snapshot, list, get, and query | typed `AssignmentRuntime` methods | `assignment.snapshot`, `assignment.list`, `assignment.get`, and `assignment.query` preserve realm generation and revision |
| resumable watch | `AssignmentRuntime.watch()` | `events.watch` carries the last rooted cursor; reconnect never silently substitutes a new-generation cursor |
| commands and receipts | `submit()` and `inspectCommand()` | `command.submit` and `command.get` preserve command identity, CAS revision, idempotency key, attempts, leases, Warrants, roots, and receipts |
| diagnostics and recovery | `diagnostics()`, `recoveryPlan()`, and `recoveryExecute()` | `diagnostics.get`, `recovery.plan`, and `recovery.execute`; Work Dashboard asks for diagnostics and a plan after snapshot failure and never falls back to a direct writer |
| renderer and KFX capability | Electron IPC carries only complete Runtime envelopes; `assignmentRuntime` is an explicit KFX capability | the transport is private and replaceable; the versioned Runtime protocol remains the client API |
| shutdown and reconnect | main process terminates the writer on quit; a later call starts a fresh host after failure | an uncertain command is replayed byte-for-byte with its original request identity, revision, and idempotency fences |

## Compatibility boundary

`work-control-profile.ts` remains an explicit read-only compatibility adapter
for retained projection reads. Its mutation methods always raise the stable
`authority-bypass` error and name `kungfu.assignment-runtime/v1`; they never
call Profile intent planning or authorization. Production Work Dashboard
startup, reads, watch, diagnostics, recovery, and command capability are bound
to `AssignmentRuntime`. Runtime unavailability has no Profile or storage
fallback and no dual write.

The All Work workspace-federation observer and Projects APIs remain separate
read-only product projections: they aggregate repository and workspace
availability across multiple workspaces and do not own Local Assignment
transitions. R2 does not relabel that global projection as the Local Runtime or
route Runtime commands through it. The Work Dashboard establishes the Local
Assignment snapshot/watch authority alongside that projection and exposes all
Assignment reads and commands only through `AssignmentRuntime`.

The public CLI remains an R3 client-migration residual. Its hidden
`runtime-host` subcommand is only the GUI's private transport into the already
qualified R1 writer and is not a claim that the public CLI is a Runtime client.

## Qualification and falsification

`./shifu test:assignment-runtime` is the repository-native R0-R2 suite. It
keeps the immutable R0 fixtures, R1 Local Profile tests, and disposable runtime
roots, and adds the following GUI evidence:

- every R1 GUI operation maps to the versioned envelope and negotiated
  capability;
- a lost response reconnects and replays the exact request without changing
  command identity, revision, or idempotency material;
- a generation change retains the old request and cursor so native fencing or
  resume-gap handling remains visible;
- main-process readiness waits for the Python writer handshake and rejects
  second-writer ambiguity, malformed output, process failure, and startup
  timeout;
- direct GUI Profile mutation fails with `authority-bypass` and performs no
  Profile authorization call; and
- the R1 disposable-Home suite continues to prove root parity, CAS,
  idempotency, concurrency, crash and interrupted-write recovery, reconnect,
  cursor gaps, stable errors, authority bypass, and second-writer rejection.

Qualification must not select or mutate the user's real `~/.kungfu`. A green
source candidate is not delivery evidence until the exact DCO commit is
independently approved, selected by a Delivery Warrant, merged through the
protected queue, and verified by exact ancestry and tree identity.
