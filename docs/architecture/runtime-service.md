# Kungfu Runtime Service

Status: draft implementation slice.

Kungfu can keep live runtime coordination alive independently from the GUI.
Closing the GUI window should not imply that the runtime stops; stopping it is
an explicit operator action.

The canonical terminology is defined by
[ADR-0057](../adr/ADR-0057-domain-neutral-live-runtime-terminology.md);
[ADR-0036](../adr/ADR-0036-supervisor-and-workspace-master-topology.md)
records the original topology decision.
It defines two live process roles:

- `supervisor` is one per OS user/session. It owns no workspace facts. It
  starts, discovers, health-checks, and stops workspace coordinators.
- `coordinator` is one per resolved Kungfu data root: workspace `.kungfu/` or the
  machine fallback selected by `KF_HOME`. It owns live location/channel
  registry, active actor supervision, subscriptions, and live projections for
  that fact ledger.

Durable facts are not daemon-owned. The source of truth remains the data-root
storage: yijinjing journals, Episode manifest journal, payload store, and
rebuildable projections. Local append/seal/fsck/export operations may run
without a live coordinator when they do not need live discovery or routing.

The target workspace coordinator also coordinates KFD-2 assessment jobs for its data
root. It discovers load-bearing claims, deduplicates and invalidates assessment
requests, supervises assessor executors, and publishes TrustReport lifecycle
updates. It does not become fact authority or embed every domain assessor. See
[KFD-2 trust assessment in a live workspace](../qualification/kfd2-trust-assessment.md) and
[ADR-0052](../adr/ADR-0052-kfd2-assessment-lifecycle-and-executors.md).

## Current CLI Surface

The current implementation slice exposes the process manager through
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
```

`install` and `uninstall` are dry-run by default. They write or remove the
user-level service file only when `--execute` is supplied.

## Target Topology

The target live command path is:

```text
CLI / GUI / TUI
  -> resolve Kungfu data root
  -> contact per-user supervisor
  -> supervisor ensure_coordinator(data_root)
  -> command talks to that data-root coordinator
```

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

The `status --json` command reads process-control state and verifies whether
the recorded PIDs are still alive. Runtime-state files are not durable facts and
must not be treated as the source of truth.

The route registry also carries a narrow v1 lifecycle lease for each workspace
coordinator route:

- `leaseTtlSeconds` is the freshness window for the route heartbeat.
- `leaseUpdatedAt` is refreshed when a route is registered or re-registered.
- `heartbeatAt`, `supervisorPid`, and `coordinatorPid` are refreshed by the live
  supervisor loop while it actively owns that route.
- `status --json` reports `lifecycle.state`, `lifecycle.healthy`,
  `lifecycle.warnings`, `route.freshness`, `route.stale`, and
  `routes.staleCount`.

The lifecycle state is deterministic from the route lease and pid probes:

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

## Lifecycle Semantics

- Closing or hiding the GUI releases the GUI lease. It should not stop the
  supervisor or a still-active workspace coordinator.
- Quitting the GUI should exit Electron. If the service is installed and
  running, active workspace coordinators may remain alive.
- `kungfu runtime ensure` registers the current data root in the supervisor
  route registry and starts or reuses the corresponding workspace coordinator.
- Before starting or reusing a coordinator, `kungfu runtime ensure` performs a narrow
  repair pass: dead pid files are removed, stale routes are refreshed, and an
  orphan workspace coordinator is terminated before the supervisor is started so the
  supervisor does not duplicate it. The JSON result includes a `repairs` array
  when this pass changed or attempted to repair local process-control state.
- `kungfu runtime stop` stops the per-user supervisor and its supervised
  workspace coordinators.
- `kungfu runtime service uninstall --execute` removes the user service file; it
  does not delete runtime journals or other user data.
- When a workspace coordinator has no active leases and the idle grace period has
  elapsed, the supervisor may ask it to shut down gracefully.
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
