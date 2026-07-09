# Kungfu Master Service

Status: draft implementation slice.

Kungfu can keep the runtime master alive independently from the GUI. Closing the
GUI window should not imply that the master stops; stopping the master is an
explicit operator action.

The service layer has two parts:

- `kungfu master supervise` is the foreground supervisor loop used by a user
  service manager.
- `kungfu master run` is the foreground master runtime process supervised by
  that loop.

Users normally do not call those two commands directly. The public operator
surface is:

```sh
kungfu master status --json
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

## Runtime State

The supervisor writes runtime state under:

```text
<KF_RUNTIME_DIR>/service/master/
```

Files in that directory include:

- `supervisor.pid`
- `master.pid`
- `state.json`
- `supervisor.log`
- `master.log`

The `status --json` command reads those files and verifies whether the recorded
PIDs are still alive.

## Service Plans

`kungfu master service plan --json` prints the platform-specific file that
would be installed:

- macOS: `~/Library/LaunchAgents/tech.kungfu.master.plist`
- Linux: `~/.config/systemd/user/kungfu-master.service`
- Windows: the current user's Startup folder command file

The generated service starts the supervisor loop and lets the supervisor keep
the master alive. Loading/enabling the service manager is intentionally left as
an explicit user operation after the file is installed.

## Lifecycle Semantics

- Closing or hiding the GUI should not stop the master.
- Quitting the GUI should exit Electron. If the service is installed and
  running, the master remains alive.
- `kungfu master stop` stops the supervisor and its child master.
- `kungfu master service uninstall --execute` removes the user service file; it
  does not delete runtime journals or other user data.

## GUI Tray / Menu-Bar Controls

The reference GUI keeps a resident tray surface after the main window is closed.
On macOS this appears in the menu bar; on Windows and Linux it appears in the
system tray when the desktop environment supports Electron tray icons.

The tray menu exposes explicit lifecycle choices:

- `Show Kungfu` / `Hide Window` changes only the GUI window visibility.
- `Master Status`, `Start Master`, and `Stop Master` call the same
  `kungfu master ... --json` CLI surface listed above.
- `Quit GUI` exits Electron without treating window close as intent to stop the
  resident master.
- `Stop Master and Quit` first runs `kungfu master stop --json`, then exits the
  GUI if the stop succeeds.
