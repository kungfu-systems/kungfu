# Kungfu Runtime Service

Status: draft implementation slice.

Kungfu can keep live runtime coordination alive independently from the GUI.
Closing the GUI window should not imply that the runtime stops; stopping it is
an explicit operator action.

The topology-neutral activation and readiness contract is defined by
[KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c](../adr/KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c.md).
The canonical process-adapter terminology is defined by
[KF-ADR-019f86da-4f90-7394-9953-5dbb467859fa](../adr/KF-ADR-019f86da-4f90-7394-9953-5dbb467859fa.md);
[KF-ADR-019f86da-4f90-730a-a068-06e8758324e1](../adr/KF-ADR-019f86da-4f90-730a-a068-06e8758324e1.md)
records the original topology decision. The current process-control topology is
implemented by `ProcessRuntimeHost` over a directly callable
`CoordinatorEngine` and has two global live process roles:

- `supervisor` is one per OS user/session. It owns no workspace facts. It
  starts, discovers, health-checks, and stops workspace coordinators.
- `coordinator` is one per resolved Kungfu data root: workspace `.kungfu/` or the
  machine fallback selected by `KF_HOME`. It owns live location/channel
  registry, active actor supervision, subscriptions, and live projections for
  that fact ledger.

Declared application Peers may additionally use one independent, per-Peer
process host. That host owns only placement and recovery for its declared argv;
it is not a global service and never acquires Coordinator authority. See
[KF-ADR-019f86da-4f90-78ca-b356-4d5d425263a8](../adr/KF-ADR-019f86da-4f90-78ca-b356-4d5d425263a8.md).

Durable facts are not daemon-owned. The source of truth remains the data-root
storage: yijinjing journals, Episode manifest journal, payload store, and
rebuildable projections. Local append/seal/fsck/export operations may run
without a live coordinator when they do not need live discovery or routing.

The target workspace coordinator also coordinates KFD-2 assessment jobs for its data
root. It discovers load-bearing claims, deduplicates and invalidates assessment
requests, supervises assessor executors, and publishes TrustReport lifecycle
updates. It does not become fact authority or embed every domain assessor. See
[KFD-2 trust assessment in a live workspace](../qualification/kfd2-trust-assessment.md) and
[KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302](../adr/KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302.md).

## Current CLI Surface

The current implementation slice exposes this process adapter through
`kungfu runtime ...` commands:

- `kungfu runtime supervise` is the foreground supervisor loop used by a user
  service manager.
- `kungfu runtime run` is the foreground coordinator runtime process supervised by
  that loop.

Users normally do not call those two commands directly. The public operator
surface is:

```sh
kungfu runtime status --json
kungfu runtime ensure --json
kungfu runtime start --json
kungfu runtime stop --json
kungfu runtime restart --json
kungfu runtime service status --json
kungfu runtime service plan --json
kungfu runtime service install --json
kungfu runtime service install --execute --json
kungfu runtime service uninstall --json
kungfu runtime service uninstall --execute --json
kungfu runtime peer contract --json
kungfu runtime peer plan PEER_SPEC.json --json
kungfu runtime peer start PEER_SPEC.json --json
kungfu runtime peer ensure PEER_SPEC.json --json
kungfu runtime peer status [PEER_ID] --json
kungfu runtime peer health PEER_ID --json
kungfu runtime peer stop PEER_ID --json
kungfu runtime peer restart PEER_SPEC.json --json
kungfu health --json
kungfu health --deep --json
```

`kungfu health` is the user-level read-only projection over runtime, Peer,
storage, and Episode facts. An inactive daemonless workspace is healthy; a PID
is never promoted to readiness without its process-start identity and the
underlying runtime contract. Health never calls `ensure`, repairs a route, or
signals a process. See [Check Kungfu health](../guides/health.md).

`install` and `uninstall` are dry-run by default. They write or remove the
user-level service file only when `--execute` is supplied.

The v2 status and route payloads are compatibility diagnostics. A reported
`running` process lifecycle does not establish the KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c runtime `ready`
state, capability set, generation, or durable cut.

## Current ProcessRuntimeHost Topology

The target live command path is:

```text
CLI / GUI / TUI
  -> resolve Kungfu data root
  -> contact per-user supervisor
  -> supervisor ensure_coordinator(data_root)
  -> command talks to that data-root coordinator
```

`kungfu.runtime_service.ensure_coordinator` is a compatibility function that
delegates activation to `ProcessRuntimeHost`. The adapter owns PID files,
signals, child spawning, detached supervisor startup, and process diagnostics.
`CoordinatorEngine` owns the directly callable coordinator request seam and
accepts an injected assessment executor; its no-fork fixture uses no PID,
signal, argv, environment, or subprocess authority. This seam is qualification
evidence, not a production EmbeddedRuntimeHost.

## Capability-driven Invocation

The runtime contract owns the machine-readable operation inventory; Profile
actions reference it through `runtimeOperation` instead of defining a second
action registry. `RuntimeCapabilityBroker` turns one operation id into the same
requirement and activation receipt vocabulary for every future product surface.

Storage-only invocation is deliberately lazy: it returns a daemonless
activation receipt and executes the durable callback without constructing a
host. Live-required invocation constructs the configured activation client only
at invoke time and executes the callback only when the returned handle is ready
at a durable cut with exactly the requested capabilities and authorities.

The current `ProcessRuntimeActivationClient` requests the existing process host
through one cross-process activation owner per canonical workspace. Concurrent
first calls wait behind the same owner, reuse one accepted generation, and
advance the generation when the recorded process diagnostics are replaced.
The accepted snapshot is written atomically only after semantic readiness.

`NativeReadinessAuthority` invokes and projects the existing typed
`kungfu.durability.reconciliation/v1` and
`kungfu.projection-candidate-status/v1` outputs into the runtime readiness
contract. A cut behind the requirement, a foreign projection authority, or a
missing hydrated projection fails before callback admission. PID and health
diagnostics remain insufficient: without an explicitly supplied DurableEngine
readiness authority the process adapter returns `readiness_not_established`.
Profile/KFX product actions now discover a workspace-bound
`kungfu.runtime.native-readiness-evidence/v1` descriptor under
`KF_CONFIG_HOME/runtime/readiness/`. The descriptor is only a set of exact
coordinates: workspace and data roots, minimum cut, durability request, profile,
writer identity, and optional projection identity. It is not readiness proof.
`NativeReadinessAuthority` still calls the existing typed authorities and the
broker still rejects any evidence that does not establish the requested cut.

The first stage 6 projection slice adds one
`kungfu.runtime.product-status/v1` value beside the retained process
diagnostics. `kungfu runtime status` leads with workspace availability,
generation, semantic readiness, exact cuts, effective leases, and typed failure;
supervisor/coordinator facts remain in an explicitly labelled advanced section.
`kungfu runtime operations --json` exposes the contract-owned operation catalog,
and `kungfu runtime plan OPERATION --json` produces the same topology-neutral
requirement used by the broker without activating a host.

The GUI consumes that product projection and no longer starts or stops the
runtime on application startup, ordinary quit, or tray actions. Node, KFX, and
the libkungfu-facing TypeScript declaration surface share the exact status,
handle, readiness, lease, error, and operation vocabulary. These projections
do not create another lifecycle implementation or external executor ABI.

Profile/KFX action planning binds the declared `runtimeOperation` to that same
runtime invocation plan. Storage-only action invocation returns a daemonless
activation receipt and runs no host factory. Live-required planning fails when
the descriptor is absent or invalid; invocation refreshes the descriptor and
the complete action plan, constructs the existing `NativeReadinessAuthority`,
and runs the domain callback only when the broker returns an admitted receipt.
A process that merely started cannot satisfy this boundary. Stage 7 must still
qualify the producer of these coordinates and cold product activation before a
release may claim that behavior.

## Semantic Leases and Recovery

`RuntimeLeaseManager` persists KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c leases in the same per-workspace
activation snapshot and serializes acquire, renew, release, expiry, and drain
transitions through the activation owner lock. A caller may lease only a
capability subset from the exact active ready generation and must hold the
`runtime.lease` authority. Holder ids are semantic identities; PIDs do not
become lease holders.

When no active semantic lease remains, the runtime enters an idle grace period.
At the deadline, the manager atomically moves the handle to `draining` before
the process adapter marks the route undesired. This prevents a late lease or a
same-generation activation from racing shutdown. Completion records `stopped`
or `failed`; a later activation must establish a new generation.

A replacement supervisor may adopt a still-running coordinator only when the
activation snapshot validates and names that exact coordinator PID in the
active generation and the recorded process-start identity still matches. The
supervisor PID may change without changing coordinator authority. A live
coordinator without that complete ownership fence is preserved but never
adopted, signalled, or replaced; the route reports `ownership-unknown` and
fails closed for operator repair. Unexpected coordinator exits use a bounded five-attempt,
60-second restart window and expose `crash-loop` plus the next retry time in
route diagnostics rather than retrying forever.

These are single-host process-adapter semantics. They do not provide a network
lease, distributed election, cross-machine adoption, or high availability.

## Independent Peer Lifecycle Hosts

The registered `peer-lifecycle` contract defines one declaration and one host
per Peer. Runtime-local state lives at:

```text
<kungfu-data-root>/runtime/peers/<peer-id>/
```

`state.json` records desired and observed lifecycle, host and Peer generations,
both process-start identities, readiness, bounded restart attempts, and the
recovery declaration. `launch.json` is the normalized argv-only declaration;
`ready.json` is the process-authored handshake; `peer.log` is diagnostic output.

The status model distinguishes `stopped`, `starting`, `registering`, `ready`,
`degraded`, `orphaned`, `ownership-unknown`, `crash-loop`, `ended`, and
`lost-control`. A live PID does not imply `ready`. Host-loss adoption requires
the exact surviving Peer generation, PID/start identity, and readiness token.
Peer loss restarts only declarations that name a durable recovery boundary;
otherwise it becomes `lost-control`.

AgentSession uses the same recovery vocabulary and declares Capsule process
loss as `lost-control`. This preserves the existing rule that a lost PTY master
cannot be reconstructed from a child PID or terminal text.

If the supervisor is not running, a product entrypoint may start it. If a
command only needs closed-data storage access, it may bypass the live coordinator and
operate directly on the resolved data-root storage.

The supervisor tracks workspace coordinators by canonical data-root identity, not by the raw
current-working-directory string. This prevents a symlinked workspace or nested
path from accidentally starting duplicate coordinators for the same `.kungfu/` home.

## Runtime State

The target supervisor writes user-level runtime state under the user
config/runtime area:

```text
<KF_CONFIG_HOME>/runtime/supervisor/
```

The target workspace coordinator writes process-control state under the resolved
data root:

```text
<kungfu-data-root>/runtime/coordinator/
```

Files in these runtime-state directories include:

- `supervisor.pid`
- `coordinator.pid`
- `state.json`
- `supervisor.log`
- `coordinator.log`

Supervisor and coordinator state also records the portable process creation
time returned by the runtime's process library. PID liveness remains a
diagnostic; adoption and signalling require the PID and that start identity to
match the recorded runtime generation. This prevents PID reuse from turning a
stale runtime record into authority over an unrelated process.

The `status --json` command reads process-control state and verifies whether
the recorded PIDs are still alive. Runtime-state files are not durable facts and
must not be treated as the source of truth. PID, route, socket, service-install,
and GUI facts may explain an unavailable runtime, but they cannot issue an
KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c readiness handle or activation receipt.

The route registry also carries a narrow diagnostic freshness TTL for each
workspace coordinator route. It is historically represented by lease-named
fields, but it is not an KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c semantic runtime lease:

- `leaseTtlSeconds` is the freshness window for the route heartbeat.
- `leaseUpdatedAt` is refreshed when a route is registered or re-registered.
- `heartbeatAt`, `supervisorPid`, and `coordinatorPid` are refreshed by the live
  supervisor loop while it actively owns that route.
- `status --json` reports `lifecycle.state`, `lifecycle.healthy`,
  `lifecycle.warnings`, `route.freshness`, `route.stale`, and
  `routes.staleCount`.

The diagnostic lifecycle state is deterministic from the route lease and pid
probes:

- `running`: supervisor and workspace coordinator are both live and the route is
  fresh.
- `degraded`: the supervisor is live but the workspace coordinator is not yet live.
- `stale-route`: the route heartbeat is older than its lease TTL.
- `orphan-coordinator`: the workspace coordinator is live without a live supervisor.
- `dead`: at least one recorded pid file points to a dead process.
- `registered`: the route is registered but not currently live.
- `stopped`: no live supervisor or coordinator is recorded.

## Service Plans

`kungfu runtime service plan --json` prints the platform-specific file that
would be installed:

- macOS: `~/Library/LaunchAgents/tech.kungfu.supervisor.plist`
- Linux: `~/.config/systemd/user/kungfu-supervisor.service`
- Windows: the current user's Startup folder `kungfu-supervisor.cmd` command
  file

The generated service starts the supervisor loop and lets the supervisor keep
workspace coordinators alive as needed. Loading/enabling the service manager is
intentionally left as an explicit user operation after the file is installed.
Generated service plans set `KF_SUPERVISOR_ALWAYS_ON=1`, which is the explicit
boundary for a resident supervisor. A supervisor started on demand by
`runtime ensure` omits that setting and exits after its last undesired route and
child have drained.

## Lifecycle Semantics

- Closing or hiding the GUI releases the GUI lease. It should not stop the
  supervisor or a still-active workspace coordinator.
- Quitting the GUI should exit Electron. If the service is installed and
  running, active workspace coordinators may remain alive.
- `kungfu runtime ensure` registers the current data root in the supervisor
  route registry and starts or reuses the corresponding workspace coordinator.
- Before starting or reusing a coordinator, `kungfu runtime ensure` performs a
  narrow repair pass: dead pid files are removed, stale routes are refreshed,
  and an orphan workspace coordinator is preserved only when the activation
  snapshot fences that exact coordinator generation and process-start identity.
  An untracked orphan is preserved without signalling and blocks replacement as
  `ownership-unknown`. The JSON result includes a
  `repairs` array when this pass changed or attempted to repair local
  process-control state.
- `kungfu runtime stop` stops the per-user supervisor and its supervised
  workspace coordinators.
- `kungfu runtime service uninstall --execute` removes the user service file; it
  does not delete runtime journals or other user data.
- When a workspace coordinator has no active semantic leases and the idle grace
  period has elapsed, the supervisor fences the generation as `draining`, marks
  only that route undesired, and records completion after the coordinator exits.
  After all routes and children are gone, an on-demand supervisor atomically
  retires the inactive route registry and exits. The lifecycle lock shared with
  activation prevents a late ensure from racing that decision.
- A graceful shutdown should flush live projections, seal or record the coordinator
  lifecycle Episode where applicable, close sockets, release locks, and leave
  journals, manifests, payloads, and projections intact.
- Pending assessment requests are durable ledger work, not coordinator-memory-only
  tasks. A restarted coordinator can rediscover and retry them by assessment key.
- Closing an Episode does not wait for an unbounded KFD-2 evaluation by
  default. Explicit high-risk gates may wait for a fresh report while leaving
  the sealed Episode intact on timeout or insufficient trust.

## GUI Tray / Menu-Bar Controls

The reference GUI keeps a resident tray surface after the main window is closed.
On macOS this appears in the menu bar; on Windows and Linux it appears in the
system tray when the desktop environment supports Electron tray icons.

The tray menu exposes explicit lifecycle choices:

- GUI startup runs `kungfu runtime ensure --json` against the resolved
  `KF_HOME` / `KF_RUNTIME_DIR` / `KF_CONFIG_HOME`, so product GUI sessions
  register the current data root with the per-user supervisor automatically.
- `Show Kungfu Episodes` / `Hide Window` changes only the GUI window visibility.
- The tray menu includes a read-only supervisor/coordinator summary and the current
  data root before the lifecycle actions.
- `Runtime Status`, `Start Runtime`, and `Stop Runtime` call the same
  `kungfu runtime ... --json` CLI surface listed above.
- `Quit GUI` exits Electron without treating window close as intent to stop the
  resident coordinator.
- `Stop Runtime and Quit` first runs `kungfu runtime stop --json`, then exits the
  GUI if the stop succeeds.

The shell bottom status bar and the System Status view read the same
`kungfu runtime status --json` payload through the Electron main process. They
surface supervisor liveness, workspace coordinator liveness, config home, data root,
runtime directory, and route registration without introducing a second process
control path. Lifecycle health comes from the core status payload, not from GUI
pid or route reimplementation, so stale and degraded states stay consistent
between CLI, tray, status bar, and the System Status view.
The optional foreground continuity projection is a staged UI bridge; final
`Workspace ready` must project the shared KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c cut-bound readiness rather
than infer it from process health.
