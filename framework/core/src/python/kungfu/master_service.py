# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os
import platform
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as xml_escape

import kungfu

lf = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime


SCHEMA_STATUS = "kungfu.master-service.status/v1"
SCHEMA_PLAN = "kungfu.master-service.plan/v1"
SCHEMA_RESULT = "kungfu.master-service.result/v1"
SERVICE_ID = "tech.kungfu.master"
SERVICE_NAME = "Kungfu Master"


def _now() -> float:
    return time.time()


def _json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", "utf-8")
    os.replace(tmp, path)


def _json_read(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _is_pid_running(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _signal_pid(pid: int, sig: int) -> None:
    os.kill(pid, sig)


def _terminate_pid(pid: int) -> None:
    if platform.system() == "Windows":
        _signal_pid(pid, signal.SIGTERM)
        return
    _signal_pid(pid, signal.SIGTERM)


def _shell_join(argv: list[str]) -> str:
    return (
        subprocess.list2cmdline(argv)
        if platform.system() == "Windows"
        else " ".join(shlex_quote(arg) for arg in argv)
    )


def shlex_quote(value: str) -> str:
    if not value:
        return "''"
    safe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@%+=:,./-"
    if all(ch in safe for ch in value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _systemd_env_line(key: str, value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'Environment="{key}={escaped}"'


def state_dir(runtime_dir: str) -> Path:
    return Path(runtime_dir).expanduser().resolve() / "service" / "master"


def supervisor_pid_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "supervisor.pid"


def master_pid_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "master.pid"


def state_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "state.json"


def supervisor_log_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "supervisor.log"


def master_log_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "master.log"


def read_pid(path: Path) -> int | None:
    try:
        return int(path.read_text("utf-8").strip())
    except (OSError, ValueError):
        return None


def write_pid(path: Path, pid: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{pid}\n", "utf-8")


def unlink_if_exists(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def entry_command() -> list[str]:
    argv0 = Path(sys.argv[0])
    if argv0.exists() and argv0.name not in {"python", "python3"}:
        return [str(argv0.resolve())]
    return [sys.executable, "-m", "kungfu"]


def command_env(home: str, runtime_dir: str, log_level: str) -> dict[str, str]:
    env = dict(os.environ)
    env["KF_HOME"] = home
    env["KF_RUNTIME_DIR"] = runtime_dir
    env["KF_LOG_LEVEL"] = log_level
    return env


def master_run_command(home: str, runtime_dir: str, log_level: str) -> list[str]:
    return [
        *entry_command(),
        "--log_level",
        log_level,
        "master",
        "run",
        "--runtime-dir",
        runtime_dir,
        "--home",
        home,
    ]


def supervisor_command(
    home: str, runtime_dir: str, log_level: str, *, foreground: bool = True
) -> list[str]:
    command = [
        *entry_command(),
        "--log_level",
        log_level,
        "master",
        "supervise",
        "--runtime-dir",
        runtime_dir,
        "--home",
        home,
    ]
    if foreground:
        command.append("--foreground")
    return command


class Master(yjj.master):
    def __init__(self, home: str, runtime_dir: str, low_latency: bool = False) -> None:
        locator = yjj.locator(runtime_dir)
        location = yjj.location(
            lf.enums.mode.LIVE,
            lf.enums.location_role.SYSTEM,
            "master",
            "master",
            locator,
        )
        super().__init__(location, low_latency)
        self.home_dir = home
        self.runtime_dir = runtime_dir

    def on_register(self, gen_time: int, register_data: Any) -> None:
        return None

    def check_register(self, gen_time: int, register_data: Any) -> bool:
        return True

    def on_interval_check(self, nanotime: int) -> None:
        return None


def run_master(home: str, runtime_dir: str, low_latency: bool = False) -> int:
    service_state_dir = state_dir(runtime_dir)
    service_state_dir.mkdir(parents=True, exist_ok=True)
    write_pid(master_pid_path(runtime_dir), os.getpid())
    _json_write(
        state_path(runtime_dir),
        {
            "schema": SCHEMA_STATUS,
            "status": "master-running",
            "home": home,
            "runtimeDir": runtime_dir,
            "masterPid": os.getpid(),
            "updatedAt": _now(),
        },
    )
    try:
        master = Master(home, runtime_dir, low_latency=low_latency)
        master.run()
        return 0
    finally:
        unlink_if_exists(master_pid_path(runtime_dir))


def status(home: str, runtime_dir: str) -> dict[str, Any]:
    supervisor_pid = read_pid(supervisor_pid_path(runtime_dir))
    master_pid = read_pid(master_pid_path(runtime_dir))
    state = _json_read(state_path(runtime_dir))
    supervisor_running = _is_pid_running(supervisor_pid)
    master_running = _is_pid_running(master_pid)
    status_name = "running" if supervisor_running else "stopped"
    if master_running and not supervisor_running:
        status_name = "orphan-master"
    return {
        "schema": SCHEMA_STATUS,
        "status": status_name,
        "home": home,
        "runtimeDir": runtime_dir,
        "stateDir": str(state_dir(runtime_dir)),
        "supervisor": {
            "pid": supervisor_pid,
            "running": supervisor_running,
            "pidFile": str(supervisor_pid_path(runtime_dir)),
            "log": str(supervisor_log_path(runtime_dir)),
        },
        "master": {
            "pid": master_pid,
            "running": master_running,
            "pidFile": str(master_pid_path(runtime_dir)),
            "log": str(master_log_path(runtime_dir)),
        },
        "lastState": state,
    }


def run_supervisor(
    home: str,
    runtime_dir: str,
    log_level: str,
    *,
    restart_delay: float = 2.0,
) -> int:
    service_state_dir = state_dir(runtime_dir)
    service_state_dir.mkdir(parents=True, exist_ok=True)
    write_pid(supervisor_pid_path(runtime_dir), os.getpid())
    stopping = False
    child: subprocess.Popen[Any] | None = None

    def request_stop(signum: int, frame: Any) -> None:
        nonlocal stopping
        stopping = True
        if child and child.poll() is None:
            child.terminate()

    signal.signal(signal.SIGTERM, request_stop)
    if platform.system() != "Windows":
        signal.signal(signal.SIGINT, request_stop)

    try:
        while not stopping:
            command = master_run_command(home, runtime_dir, log_level)
            with master_log_path(runtime_dir).open("ab") as log:
                child = subprocess.Popen(
                    command,
                    env=command_env(home, runtime_dir, log_level),
                    stdout=log,
                    stderr=log,
                )
            write_pid(master_pid_path(runtime_dir), child.pid)
            _json_write(
                state_path(runtime_dir),
                {
                    "schema": SCHEMA_STATUS,
                    "status": "running",
                    "home": home,
                    "runtimeDir": runtime_dir,
                    "supervisorPid": os.getpid(),
                    "masterPid": child.pid,
                    "masterCommand": command,
                    "updatedAt": _now(),
                },
            )
            while not stopping and child.poll() is None:
                time.sleep(0.5)
            return_code = child.poll()
            unlink_if_exists(master_pid_path(runtime_dir))
            _json_write(
                state_path(runtime_dir),
                {
                    "schema": SCHEMA_STATUS,
                    "status": "stopping" if stopping else "restarting",
                    "home": home,
                    "runtimeDir": runtime_dir,
                    "supervisorPid": os.getpid(),
                    "lastMasterReturnCode": return_code,
                    "updatedAt": _now(),
                },
            )
            if not stopping:
                time.sleep(restart_delay)
        return 0
    finally:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        unlink_if_exists(supervisor_pid_path(runtime_dir))
        unlink_if_exists(master_pid_path(runtime_dir))
        _json_write(
            state_path(runtime_dir),
            {
                "schema": SCHEMA_STATUS,
                "status": "stopped",
                "home": home,
                "runtimeDir": runtime_dir,
                "updatedAt": _now(),
            },
        )


def start_supervisor(home: str, runtime_dir: str, log_level: str) -> dict[str, Any]:
    current = status(home, runtime_dir)
    if current["supervisor"]["running"]:
        return {**current, "changed": False}
    state_dir(runtime_dir).mkdir(parents=True, exist_ok=True)
    command = supervisor_command(home, runtime_dir, log_level, foreground=True)
    with supervisor_log_path(runtime_dir).open("ab") as log:
        kwargs: dict[str, Any] = {
            "env": command_env(home, runtime_dir, log_level),
            "stdout": log,
            "stderr": log,
        }
        if platform.system() == "Windows":
            detached_process = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            new_process_group = getattr(
                subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200
            )
            kwargs["creationflags"] = detached_process | new_process_group
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(command, **kwargs)
    deadline = time.time() + 5
    while time.time() < deadline:
        current = status(home, runtime_dir)
        if current["supervisor"]["running"]:
            return {**current, "changed": True, "command": command}
        time.sleep(0.2)
    return {**status(home, runtime_dir), "changed": False, "command": command}


def stop_supervisor(
    home: str, runtime_dir: str, timeout: float = 10.0
) -> dict[str, Any]:
    current = status(home, runtime_dir)
    pid = current["supervisor"]["pid"]
    if not current["supervisor"]["running"] or not pid:
        return {**current, "changed": False}
    _terminate_pid(pid)
    deadline = time.time() + timeout
    while time.time() < deadline:
        current = status(home, runtime_dir)
        if not current["supervisor"]["running"]:
            return {**current, "changed": True}
        time.sleep(0.2)
    return {**status(home, runtime_dir), "changed": False, "error": "timeout"}


@dataclass(frozen=True)
class ServicePlan:
    platform: str
    path: Path
    content: str
    install_note: str
    uninstall_note: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA_PLAN,
            "platform": self.platform,
            "path": str(self.path),
            "content": self.content,
            "installNote": self.install_note,
            "uninstallNote": self.uninstall_note,
        }


def service_plan(home: str, runtime_dir: str, log_level: str) -> ServicePlan:
    system = platform.system()
    command = supervisor_command(home, runtime_dir, log_level, foreground=True)
    env = command_env(home, runtime_dir, log_level)
    if system == "Darwin":
        path = Path.home() / "Library" / "LaunchAgents" / f"{SERVICE_ID}.plist"
        args = "\n".join(f"    <string>{xml_escape(arg)}</string>" for arg in command)
        content = f"""<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>{xml_escape(SERVICE_ID)}</string>
  <key>ProgramArguments</key>
  <array>
{args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KF_HOME</key>
    <string>{xml_escape(home)}</string>
    <key>KF_RUNTIME_DIR</key>
    <string>{xml_escape(runtime_dir)}</string>
    <key>KF_LOG_LEVEL</key>
    <string>{xml_escape(log_level)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{xml_escape(str(supervisor_log_path(runtime_dir)))}</string>
  <key>StandardErrorPath</key>
  <string>{xml_escape(str(supervisor_log_path(runtime_dir)))}</string>
</dict>
</plist>
"""
        return ServicePlan(
            system,
            path,
            content,
            f"write {path}; then run: launchctl bootstrap gui/$(id -u) {shlex_quote(str(path))}",
            f"run: launchctl bootout gui/$(id -u) {shlex_quote(str(path))}; then remove {path}",
        )
    if system == "Linux":
        path = Path.home() / ".config" / "systemd" / "user" / "kungfu-master.service"
        content = f"""[Unit]
Description={SERVICE_NAME}
After=default.target

[Service]
Type=simple
{_systemd_env_line("KF_HOME", home)}
{_systemd_env_line("KF_RUNTIME_DIR", runtime_dir)}
{_systemd_env_line("KF_LOG_LEVEL", log_level)}
ExecStart={_shell_join(command)}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
"""
        return ServicePlan(
            system,
            path,
            content,
            "write the unit; then run: systemctl --user daemon-reload && systemctl --user enable --now kungfu-master.service",
            "run: systemctl --user disable --now kungfu-master.service; then remove the unit",
        )
    startup = (
        Path(os.environ.get("APPDATA", str(Path.home())))
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Startup"
        / "kungfu-master.cmd"
    )
    lines = [
        "@echo off",
        f'set "KF_HOME={env["KF_HOME"]}"',
        f'set "KF_RUNTIME_DIR={env["KF_RUNTIME_DIR"]}"',
        f'set "KF_LOG_LEVEL={env["KF_LOG_LEVEL"]}"',
        _shell_join(command),
        "",
    ]
    return ServicePlan(
        system,
        startup,
        "\r\n".join(lines),
        f"write {startup}; it will start at the next user logon",
        f"remove {startup}",
    )


def install_service(home: str, runtime_dir: str, log_level: str) -> dict[str, Any]:
    plan = service_plan(home, runtime_dir, log_level)
    plan.path.parent.mkdir(parents=True, exist_ok=True)
    plan.path.write_text(plan.content, "utf-8")
    return {
        "schema": SCHEMA_RESULT,
        "action": "install",
        "changed": True,
        "plan": plan.as_dict(),
    }


def uninstall_service(home: str, runtime_dir: str, log_level: str) -> dict[str, Any]:
    plan = service_plan(home, runtime_dir, log_level)
    existed = plan.path.exists()
    if existed:
        plan.path.unlink()
    return {
        "schema": SCHEMA_RESULT,
        "action": "uninstall",
        "changed": existed,
        "plan": plan.as_dict(),
    }


def service_status(home: str, runtime_dir: str, log_level: str) -> dict[str, Any]:
    plan = service_plan(home, runtime_dir, log_level)
    installed = plan.path.exists()
    actual = ""
    if installed:
        try:
            actual = plan.path.read_text("utf-8")
        except OSError:
            actual = ""
    return {
        "schema": SCHEMA_STATUS,
        "home": home,
        "runtimeDir": runtime_dir,
        "service": {
            "id": SERVICE_ID,
            "platform": plan.platform,
            "path": str(plan.path),
            "installed": installed,
            "matchesPlan": installed and actual == plan.content,
        },
        "supervisor": status(home, runtime_dir),
    }
