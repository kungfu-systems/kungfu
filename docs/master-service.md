# Kungfu Supervisor and Master Service

Status: draft implementation slice.

Kungfu can keep live runtime coordination alive independently from the GUI.
Closing the GUI window should not imply that the runtime stops; stopping it is
an explicit operator action.

The architecture decision is
[ADR-0036](../framework/core/docs/adr/ADR-0036-supervisor-and-workspace-master-topology.md).
It defines two live process roles:

- `supervisor` is one per OS user/session. It owns no workspace facts. It
  starts, discovers, health-checks, and stops workspace masters.
- `master` is one per resolved Kungfu data root: workspace `.kungfu/` or the
  machine fallback selected by `KF_HOME`. It owns live location/channel
  registry, active actor supervision, subscriptions, and live projections for
  that fact ledger.

Durable facts are not daemon-owned. The source of truth remains the data-root
storage: yijinjing journals, Episode manifest journal, payload store, and
rebuildable projections. Local append/seal/fsck/export operations may run
without a live master when they do not need live discovery or routing.

## Current CLI Surface

The current implementation slice exposes the process manager through
`kungfu master ...` commands:

- `kungfu master supervise` is the foreground supervisor loop used by a user
  service manager.
- `kungfu master run` is the foreground master runtime process supervised by
  that loop.

Users normally do not call those two commands directly. The public operator
surface is:

```sh
kungfu master status --json
kungfu master ensure --json
kungfu master start --json
kungfu master stop --json
kungfu master restart --json
kungfu master service status --json
kungfu master service plan --json
kungfu master service install --json
kungfu master service install --execute --json
kungfu master service uninstall --json
kungfu master service uninstall --execute --json
```

`install` and `uninstall` are dry-run by default. They write or remove the
user-level service file only when `--execute` is supplied.

## Target Topology

The target live command path is:

```text
CLI / GUI / TUI
  -> resolve Kungfu data root
  -> contact per-user supervisor
  -> supervisor ensure_master(data_root)
  -> command talks to that data-root master
```

If the supervisor is not running, a product entrypoint may start it. If a
command only needs closed-data storage access, it may bypass the live master and
operate directly on the resolved data-root storage.

The supervisor tracks masters by canonical data-root identity, not by the raw
current-working-directory string. This prevents a symlinked workspace or nested
path from accidentally starting duplicate masters for the same `.kungfu/` home.

## Runtime State

The target supervisor writes user-level runtime state under the user
config/runtime area:

```text
<KF_CONFIG_HOME>/runtime/supervisor/
```

The target workspace master writes process-control state under the resolved
data root:

```text
<kungfu-data-root>/runtime/master/
```

Files in these runtime-state directories include:

- `supervisor.pid`
- `master.pid`
- `state.json`
- `supervisor.log`
- `master.log`

The `status --json` command reads process-control state and verifies whether
the recorded PIDs are still alive. Runtime-state files are not durable facts and
must not be treated as the source of truth.

The route registry also carries a narrow v1 lifecycle lease for each workspace
master route:

- `leaseTtlSeconds` is the freshness window for the route heartbeat.
- `leaseUpdatedAt` is refreshed when a route is registered or re-registered.
- `heartbeatAt`, `supervisorPid`, and `masterPid` are refreshed by the live
  supervisor loop while it actively owns that route.
- `status --json` reports `lifecycle.state`, `lifecycle.healthy`,
  `lifecycle.warnings`, `route.freshness`, `route.stale`, and
  `routes.staleCount`.

The lifecycle state is deterministic from the route lease and pid probes:

- `running`: supervisor and workspace master are both live and the route is
  fresh.
- `degraded`: the supervisor is live but the workspace master is not yet live.
- `stale-route`: the route heartbeat is older than its lease TTL.
- `orphan-master`: the workspace master is live without a live supervisor.
- `dead`: at least one recorded pid file points to a dead process.
- `registered`: the route is registered but not currently live.
- `stopped`: no live supervisor or master is recorded.

## Service Plans

`kungfu master service plan --json` prints the platform-specific file that
would be installed:

- macOS: `~/Library/LaunchAgents/tech.kungfu.supervisor.plist`
- Linux: `~/.config/systemd/user/kungfu-supervisor.service`
- Windows: the current user's Startup folder `kungfu-supervisor.cmd` command
  file

The generated service starts the supervisor loop and lets the supervisor keep
workspace masters alive as needed. Loading/enabling the service manager is
intentionally left as an explicit user operation after the file is installed.

## Lifecycle Semantics

- Closing or hiding the GUI releases the GUI lease. It should not stop the
  supervisor or a still-active workspace master.
- Quitting the GUI should exit Electron. If the service is installed and
  running, active workspace masters may remain alive.
- `kungfu master ensure` registers the current data root in the supervisor
  route registry and starts or reuses the corresponding workspace master.
- Before starting or reusing a master, `kungfu master ensure` performs a narrow
  repair pass: dead pid files are removed, stale routes are refreshed, and an
  orphan workspace master is terminated before the supervisor is started so the
  supervisor does not duplicate it. The JSON result includes a `repairs` array
  when this pass changed or attempted to repair local process-control state.
- `kungfu master stop` stops the per-user supervisor and its supervised
  workspace masters.
- `kungfu master service uninstall --execute` removes the user service file; it
  does not delete runtime journals or other user data.
- When a workspace master has no active leases and the idle grace period has
  elapsed, the supervisor may ask it to shut down gracefully.
- A graceful shutdown should flush live projections, seal or record the master
  lifecycle Episode where applicable, close sockets, release locks, and leave
  journals, manifests, payloads, and projections intact.

## GUI Tray / Menu-Bar Controls

The reference GUI keeps a resident tray surface after the main window is closed.
On macOS this appears in the menu bar; on Windows and Linux it appears in the
system tray when the desktop environment supports Electron tray icons.

The tray menu exposes explicit lifecycle choices:

- GUI startup runs `kungfu master ensure --json` against the resolved
  `KF_HOME` / `KF_RUNTIME_DIR` / `KF_CONFIG_HOME`, so product GUI sessions
  register the current data root with the per-user supervisor automatically.
- `Show Kungfu Episodes` / `Hide Window` changes only the GUI window visibility.
- The tray menu includes a read-only supervisor/master summary and the current
  data root before the lifecycle actions.
- `Master Status`, `Start Master`, and `Stop Master` call the same
  `kungfu master ... --json` CLI surface listed above.
- `Quit GUI` exits Electron without treating window close as intent to stop the
  resident master.
- `Stop Master and Quit` first runs `kungfu master stop --json`, then exits the
  GUI if the stop succeeds.

The shell bottom status bar and the System Status view read the same
`kungfu master status --json` payload through the Electron main process. They
surface supervisor liveness, workspace master liveness, config home, data root,
runtime directory, and route registration without introducing a second process
control path. Lifecycle health comes from the core status payload, not from GUI
pid or route reimplementation, so stale and degraded states stay consistent
between CLI, tray, status bar, and the System Status view.
