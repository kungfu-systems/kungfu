# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os
import platform
import signal
import subprocess
import time
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as xml_escape

import kungfu
from kungfu import host
from kungfu.storage import service as storage_service

lf = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime


SCHEMA_STATUS = "kungfu.runtime.status/v2"
SCHEMA_PLAN = "kungfu.runtime.service-plan/v2"
SCHEMA_RESULT = "kungfu.runtime.service-result/v2"
SCHEMA_ROUTES = "kungfu.runtime.routes/v2"
SCHEMA_ASSESSMENT_SUBSCRIPTION = "kungfu.runtime.assessment-subscription/v2"
LEGACY_SCHEMA_ROUTES = "kungfu.master-service.routes/v1"
# Stable wire-v1 identity. New code calls this process the coordinator, while
# existing journals and RocksDB records continue to resolve the historic UID.
COORDINATOR_WIRE_NAMESPACE = "master"
COORDINATOR_WIRE_NAME = "master"
LEGACY_STATE_DIR_NAME = "master"
SERVICE_ID = "tech.kungfu.supervisor"
SERVICE_NAME = "Kungfu Supervisor"
ROUTE_LEASE_TTL_SECONDS = 30.0


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


def _pid_state(pid: int | None) -> str:
    if not pid or pid <= 0:
        return "missing"
    return "running" if _is_pid_running(pid) else "dead"


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


def _canonical_path(value: str) -> str:
    return str(Path(value).expanduser().resolve())


def resolve_config_home(config_home: str | None = None) -> str:
    return _canonical_path(
        config_home or os.environ.get("KF_CONFIG_HOME") or "~/.kungfu-config"
    )


def resolve_runtime_home(home: str) -> str:
    return _canonical_path(home)


def resolve_runtime_dir(home: str, runtime_dir: str | None = None) -> str:
    return _canonical_path(runtime_dir or str(Path(home).expanduser() / "runtime"))


def route_id(home: str, runtime_dir: str) -> str:
    digest = sha256(
        f"{resolve_runtime_home(home)}\0{resolve_runtime_dir(home, runtime_dir)}".encode(
            "utf-8"
        )
    ).hexdigest()
    return digest[:16]


def route_record(home: str, runtime_dir: str) -> dict[str, Any]:
    home = resolve_runtime_home(home)
    runtime_dir = resolve_runtime_dir(home, runtime_dir)
    now = _now()
    return {
        "routeId": route_id(home, runtime_dir),
        "dataRoot": home,
        "home": home,
        "runtimeDir": runtime_dir,
        "desired": True,
        "leaseTtlSeconds": ROUTE_LEASE_TTL_SECONDS,
        "leaseUpdatedAt": now,
        "heartbeatAt": None,
        "supervisorPid": None,
        "coordinatorPid": None,
        "createdAt": now,
        "updatedAt": now,
    }


def supervisor_state_dir(config_home: str | None = None) -> Path:
    return Path(resolve_config_home(config_home)) / "runtime" / "supervisor"


def state_dir(runtime_dir: str) -> Path:
    return Path(runtime_dir).expanduser().resolve() / "coordinator"


def legacy_state_dir(runtime_dir: str) -> Path:
    return Path(runtime_dir).expanduser().resolve() / LEGACY_STATE_DIR_NAME


def supervisor_pid_path(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "supervisor.pid"


def coordinator_pid_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "coordinator.pid"


def legacy_coordinator_pid_path(runtime_dir: str) -> Path:
    return legacy_state_dir(runtime_dir) / "master.pid"


def state_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "state.json"


def legacy_state_path(runtime_dir: str) -> Path:
    return legacy_state_dir(runtime_dir) / "state.json"


def supervisor_state_path(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "state.json"


def routes_path(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "routes.json"


def supervisor_log_path(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "supervisor.log"


def coordinator_log_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "coordinator.log"


def assessment_subscription_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "assessments.json"


def read_pid(path: Path) -> int | None:
    try:
        return int(path.read_text("utf-8").strip())
    except (OSError, ValueError):
        return None


def read_coordinator_pid(runtime_dir: str) -> int | None:
    return read_pid(coordinator_pid_path(runtime_dir)) or read_pid(
        legacy_coordinator_pid_path(runtime_dir)
    )


def unlink_coordinator_pid_files(runtime_dir: str) -> None:
    unlink_if_exists(coordinator_pid_path(runtime_dir))
    unlink_if_exists(legacy_coordinator_pid_path(runtime_dir))


def write_pid(path: Path, pid: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{pid}\n", "utf-8")


def unlink_if_exists(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def entry_command() -> list[str]:
    return host.entry_command()


def command_env(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, str]:
    env = dict(os.environ)
    env["KF_HOME"] = home
    env["KF_RUNTIME_DIR"] = runtime_dir
    env["KF_CONFIG_HOME"] = resolve_config_home(config_home)
    env["KF_LOG_LEVEL"] = log_level
    return env


def coordinator_run_command(home: str, runtime_dir: str, log_level: str) -> list[str]:
    return [
        *entry_command(),
        "--log_level",
        log_level,
        "runtime",
        "run",
        "--runtime-dir",
        runtime_dir,
        "--home",
        home,
    ]


def assessment_worker_command(runtime_dir: str, assessment_key: str) -> list[str]:
    return [
        *entry_command(),
        "runtime",
        "assess-worker",
        "--runtime-dir",
        resolve_runtime_dir("", runtime_dir),
        "--assessment-key",
        assessment_key,
    ]


def assessment_snapshot(runtime_dir: str) -> dict[str, Any]:
    lifecycle = storage_service.assessment_list(runtime_dir)
    counts: dict[str, int] = {}
    for assessment in lifecycle["assessments"]:
        state = str(assessment["state"])
        counts[state] = counts.get(state, 0) + 1
    return {
        **lifecycle,
        "schema": SCHEMA_ASSESSMENT_SUBSCRIPTION,
        "runtimeDir": resolve_runtime_dir("", runtime_dir),
        "updatedAt": _now(),
        "counts": counts,
    }


def publish_assessment_snapshot(runtime_dir: str) -> dict[str, Any]:
    snapshot = assessment_snapshot(runtime_dir)
    _json_write(assessment_subscription_path(runtime_dir), snapshot)
    return snapshot


def run_assessment_worker(runtime_dir: str, assessment_key: str) -> dict[str, Any]:
    return storage_service.assessment_execute(
        runtime_dir,
        assessment_key,
        executor_profile="process",
    )


def supervisor_command(
    config_home: str | None,
    log_level: str,
    *,
    home: str | None = None,
    runtime_dir: str | None = None,
    foreground: bool = True,
) -> list[str]:
    command = [
        *entry_command(),
        "--log_level",
        log_level,
        "runtime",
        "supervise",
        "--config-home",
        resolve_config_home(config_home),
    ]
    if home:
        command.extend(["--home", resolve_runtime_home(home)])
    if runtime_dir:
        command.extend(["--runtime-dir", resolve_runtime_dir(home or "", runtime_dir)])
    if foreground:
        command.append("--foreground")
    return command


def _empty_routes() -> dict[str, Any]:
    return {"schema": SCHEMA_ROUTES, "routes": {}}


def read_routes(config_home: str | None = None) -> dict[str, Any]:
    payload = _json_read(routes_path(config_home))
    if not isinstance(payload.get("routes"), dict):
        return _empty_routes()
    if payload.get("schema") == LEGACY_SCHEMA_ROUTES:
        for route in payload["routes"].values():
            if isinstance(route, dict) and "coordinatorPid" not in route:
                route["coordinatorPid"] = route.pop("masterPid", None)
        payload["schema"] = SCHEMA_ROUTES
    elif payload.get("schema") != SCHEMA_ROUTES:
        return _empty_routes()
    return payload


def write_routes(config_home: str | None, payload: dict[str, Any]) -> None:
    payload.setdefault("schema", SCHEMA_ROUTES)
    payload.setdefault("routes", {})
    payload["updatedAt"] = _now()
    _json_write(routes_path(config_home), payload)


def upsert_route(
    config_home: str | None, home: str, runtime_dir: str
) -> dict[str, Any]:
    route = route_record(home, runtime_dir)
    payload = read_routes(config_home)
    previous = payload["routes"].get(route["routeId"])
    if isinstance(previous, dict):
        route["createdAt"] = previous.get("createdAt", route["createdAt"])
    payload["routes"][route["routeId"]] = route
    write_routes(config_home, payload)
    return route


def touch_route_heartbeat(
    config_home: str | None,
    route_id_: str,
    *,
    supervisor_pid: int | None,
    coordinator_pid: int | None,
) -> dict[str, Any] | None:
    payload = read_routes(config_home)
    route = payload["routes"].get(route_id_)
    if not isinstance(route, dict):
        return None
    now = _now()
    route["heartbeatAt"] = now
    route["leaseTtlSeconds"] = route.get("leaseTtlSeconds", ROUTE_LEASE_TTL_SECONDS)
    route["supervisorPid"] = supervisor_pid
    route["coordinatorPid"] = coordinator_pid
    route["updatedAt"] = now
    payload["routes"][route_id_] = route
    write_routes(config_home, payload)
    return route


def _route_freshness(
    route: dict[str, Any] | None,
    *,
    registered: bool,
    now: float,
) -> dict[str, Any]:
    if not registered or not isinstance(route, dict):
        return {
            "state": "unregistered",
            "stale": False,
            "ageSeconds": None,
            "expiresAt": None,
            "ttlSeconds": ROUTE_LEASE_TTL_SECONDS,
        }
    ttl = float(route.get("leaseTtlSeconds") or ROUTE_LEASE_TTL_SECONDS)
    heartbeat = route.get("heartbeatAt")
    lease_updated = route.get("leaseUpdatedAt")
    anchor = heartbeat if isinstance(heartbeat, (int, float)) else lease_updated
    if not isinstance(anchor, (int, float)):
        return {
            "state": "pending",
            "stale": False,
            "ageSeconds": None,
            "expiresAt": None,
            "ttlSeconds": ttl,
        }
    age = max(0.0, now - float(anchor))
    stale = age > ttl
    return {
        "state": "stale" if stale else "fresh",
        "stale": stale,
        "ageSeconds": age,
        "expiresAt": float(anchor) + ttl,
        "ttlSeconds": ttl,
    }


def _lifecycle_status(
    *,
    registered: bool,
    route_freshness: dict[str, Any],
    supervisor_pid: int | None,
    supervisor_running: bool,
    coordinator_pid: int | None,
    coordinator_running: bool,
) -> dict[str, Any]:
    warnings: list[str] = []
    supervisor_state = _pid_state(supervisor_pid)
    coordinator_state = _pid_state(coordinator_pid)
    route_stale = bool(route_freshness.get("stale"))
    if route_stale:
        warnings.append("route-stale")
    if supervisor_state == "dead":
        warnings.append("supervisor-dead-pid")
    if coordinator_state == "dead":
        warnings.append("coordinator-dead-pid")

    state = "stopped"
    if route_stale:
        state = "stale-route"
    elif coordinator_running and not supervisor_running:
        state = "orphan-coordinator"
        warnings.append("orphan-coordinator")
    elif supervisor_running and coordinator_running:
        state = "running"
    elif supervisor_running and not coordinator_running:
        state = "degraded"
        warnings.append("coordinator-not-running")
    elif supervisor_state == "dead" or coordinator_state == "dead":
        state = "dead"
    elif registered:
        state = "registered"

    healthy = state == "running"
    return {
        "state": state,
        "healthy": healthy,
        "warnings": warnings,
        "supervisorProcess": supervisor_state,
        "coordinatorProcess": coordinator_state,
        "routeFreshness": route_freshness,
    }


def _terminate_and_wait(pid: int, timeout: float = 2.0) -> bool:
    _terminate_pid(pid)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _is_pid_running(pid):
            return True
        time.sleep(0.1)
    return not _is_pid_running(pid)


def repair_route_state(
    home: str,
    runtime_dir: str,
    config_home: str | None = None,
) -> list[str]:
    current = route_status(home, runtime_dir, config_home)
    repairs: list[str] = []
    coordinator_pid = current["coordinator"]["pid"]
    if current["lifecycle"]["supervisorProcess"] == "dead":
        unlink_if_exists(supervisor_pid_path(config_home))
        repairs.append("removed-dead-supervisor-pid")
    if current["lifecycle"]["coordinatorProcess"] == "dead":
        unlink_coordinator_pid_files(runtime_dir)
        repairs.append("removed-dead-coordinator-pid")
    if current["lifecycle"]["state"] == "orphan-coordinator" and coordinator_pid:
        if _terminate_and_wait(coordinator_pid):
            unlink_coordinator_pid_files(runtime_dir)
            repairs.append("terminated-orphan-coordinator")
        else:
            repairs.append("orphan-coordinator-still-running")
    if current["route"].get("freshness", {}).get("stale"):
        repairs.append("refreshed-stale-route")
    return repairs


class Coordinator(yjj.coordinator):
    def __init__(self, home: str, runtime_dir: str, low_latency: bool = False) -> None:
        locator = yjj.locator(runtime_dir)
        location = yjj.location(
            lf.enums.mode.LIVE,
            lf.enums.location_role.SYSTEM,
            COORDINATOR_WIRE_NAMESPACE,
            COORDINATOR_WIRE_NAME,
            locator,
        )
        super().__init__(location, low_latency)
        self.home_dir = home
        self.runtime_dir = runtime_dir
        self._assessment_worker: tuple[str, subprocess.Popen[Any], int] | None = None
        self._assessment_last_check = 0

    @staticmethod
    def _assessment_worker_timeout_ns() -> int:
        raw = os.environ.get("KF_ASSESSMENT_WORKER_TIMEOUT_SECONDS", "30")
        try:
            seconds = max(float(raw), 0.1)
        except ValueError:
            seconds = 30.0
        return int(seconds * 1_000_000_000)

    def on_register(self, gen_time: int, register_data: Any) -> None:
        return None

    def check_register(self, gen_time: int, register_data: Any) -> bool:
        return True

    def on_interval_check(self, nanotime: int) -> None:
        if nanotime - self._assessment_last_check < 500_000_000:
            return
        self._assessment_last_check = nanotime
        if self._assessment_worker is not None:
            _, child, started_at = self._assessment_worker
            if child.poll() is None:
                if nanotime - started_at < self._assessment_worker_timeout_ns():
                    return
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            self._assessment_worker = None

        snapshot = publish_assessment_snapshot(self.runtime_dir)
        pending = [
            assessment
            for assessment in snapshot["assessments"]
            if assessment["state"] == "pending"
        ]
        if not pending:
            return
        assessment_key = str(pending[0]["assessment_key"])
        command = assessment_worker_command(self.runtime_dir, assessment_key)
        coordinator_log_path(self.runtime_dir).parent.mkdir(parents=True, exist_ok=True)
        with coordinator_log_path(self.runtime_dir).open("ab") as log:
            child = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=command_env(
                    self.home_dir,
                    self.runtime_dir,
                    os.environ.get("KF_LOG_LEVEL", "warning"),
                ),
            )
        self._assessment_worker = (assessment_key, child, nanotime)


def run_coordinator(home: str, runtime_dir: str, low_latency: bool = False) -> int:
    home = resolve_runtime_home(home)
    runtime_dir = resolve_runtime_dir(home, runtime_dir)
    service_state_dir = state_dir(runtime_dir)
    service_state_dir.mkdir(parents=True, exist_ok=True)
    write_pid(coordinator_pid_path(runtime_dir), os.getpid())
    _json_write(
        state_path(runtime_dir),
        {
            "schema": SCHEMA_STATUS,
            "status": "coordinator-running",
            "home": home,
            "runtimeDir": runtime_dir,
            "coordinatorPid": os.getpid(),
            "updatedAt": _now(),
        },
    )
    try:
        coordinator = Coordinator(home, runtime_dir, low_latency=low_latency)
        coordinator.run()
        return 0
    finally:
        unlink_coordinator_pid_files(runtime_dir)


def status(home: str, runtime_dir: str) -> dict[str, Any]:
    return route_status(home, runtime_dir)


def route_status(
    home: str,
    runtime_dir: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    config_home = resolve_config_home(config_home)
    home = resolve_runtime_home(home)
    runtime_dir = resolve_runtime_dir(home, runtime_dir)
    route = route_record(home, runtime_dir)
    supervisor_pid = read_pid(supervisor_pid_path(config_home))
    coordinator_pid = read_coordinator_pid(runtime_dir)
    state = _json_read(state_path(runtime_dir)) or _json_read(
        legacy_state_path(runtime_dir)
    )
    supervisor_state = _json_read(supervisor_state_path(config_home))
    routes = read_routes(config_home)
    registered_route = routes["routes"].get(route["routeId"])
    registered = isinstance(registered_route, dict)
    supervisor_running = _is_pid_running(supervisor_pid)
    coordinator_running = _is_pid_running(coordinator_pid)
    now = _now()
    route_freshness = _route_freshness(
        registered_route if registered else None,
        registered=registered,
        now=now,
    )
    lifecycle = _lifecycle_status(
        registered=registered,
        route_freshness=route_freshness,
        supervisor_pid=supervisor_pid,
        supervisor_running=supervisor_running,
        coordinator_pid=coordinator_pid,
        coordinator_running=coordinator_running,
    )
    route_payload = registered_route if registered else route
    return {
        "schema": SCHEMA_STATUS,
        "status": lifecycle["state"],
        "configHome": config_home,
        "dataRoot": home,
        "home": home,
        "runtimeDir": runtime_dir,
        "supervisorStateDir": str(supervisor_state_dir(config_home)),
        "stateDir": str(state_dir(runtime_dir)),
        "route": {
            **route_payload,
            "registered": registered,
            "freshness": route_freshness,
            "stale": route_freshness["stale"],
        },
        "lifecycle": lifecycle,
        "supervisor": {
            "pid": supervisor_pid,
            "running": supervisor_running,
            "processState": lifecycle["supervisorProcess"],
            "pidFile": str(supervisor_pid_path(config_home)),
            "log": str(supervisor_log_path(config_home)),
        },
        "coordinator": {
            "pid": coordinator_pid,
            "running": coordinator_running,
            "processState": lifecycle["coordinatorProcess"],
            "pidFile": str(coordinator_pid_path(runtime_dir)),
            "log": str(coordinator_log_path(runtime_dir)),
        },
        "routes": {
            "path": str(routes_path(config_home)),
            "count": len(routes["routes"]),
            "staleCount": sum(
                1
                for item in routes["routes"].values()
                if _route_freshness(
                    item if isinstance(item, dict) else None,
                    registered=isinstance(item, dict),
                    now=now,
                )["stale"]
            ),
        },
        "lastSupervisorState": supervisor_state,
        "lastState": state,
    }


def run_supervisor(
    log_level: str,
    *,
    config_home: str | None = None,
    home: str | None = None,
    runtime_dir: str | None = None,
    restart_delay: float = 2.0,
) -> int:
    config_home = resolve_config_home(config_home)
    service_state_dir = supervisor_state_dir(config_home)
    service_state_dir.mkdir(parents=True, exist_ok=True)
    write_pid(supervisor_pid_path(config_home), os.getpid())
    if home and runtime_dir:
        upsert_route(config_home, home, runtime_dir)
    stopping = False
    children: dict[str, subprocess.Popen[Any]] = {}

    def request_stop(signum: int, frame: Any) -> None:
        nonlocal stopping
        stopping = True
        for child in children.values():
            if child.poll() is None:
                child.terminate()

    signal.signal(signal.SIGTERM, request_stop)
    if platform.system() != "Windows":
        signal.signal(signal.SIGINT, request_stop)

    try:
        while not stopping:
            routes = read_routes(config_home)
            desired_routes = {
                route_id_: route
                for route_id_, route in routes["routes"].items()
                if isinstance(route, dict) and route.get("desired") is True
            }
            for route_id_, child in list(children.items()):
                if child.poll() is not None or route_id_ not in desired_routes:
                    route = desired_routes.get(route_id_)
                    if route:
                        unlink_coordinator_pid_files(str(route["runtimeDir"]))
                    if route_id_ not in desired_routes and child.poll() is None:
                        child.terminate()
                    children.pop(route_id_, None)
            for route_id_, route in desired_routes.items():
                running_child = children.get(route_id_)
                if running_child and running_child.poll() is None:
                    touch_route_heartbeat(
                        config_home,
                        route_id_,
                        supervisor_pid=os.getpid(),
                        coordinator_pid=running_child.pid,
                    )
                    continue
                route_home = str(route["home"])
                route_runtime_dir = str(route["runtimeDir"])
                command = coordinator_run_command(
                    route_home, route_runtime_dir, log_level
                )
                coordinator_log_path(route_runtime_dir).parent.mkdir(
                    parents=True, exist_ok=True
                )
                with coordinator_log_path(route_runtime_dir).open("ab") as log:
                    child = subprocess.Popen(
                        command,
                        env=command_env(
                            route_home,
                            route_runtime_dir,
                            log_level,
                            config_home,
                        ),
                        stdout=log,
                        stderr=log,
                    )
                children[route_id_] = child
                write_pid(coordinator_pid_path(route_runtime_dir), child.pid)
                touch_route_heartbeat(
                    config_home,
                    route_id_,
                    supervisor_pid=os.getpid(),
                    coordinator_pid=child.pid,
                )
            _json_write(
                supervisor_state_path(config_home),
                {
                    "schema": SCHEMA_STATUS,
                    "status": "running",
                    "configHome": config_home,
                    "supervisorPid": os.getpid(),
                    "routes": {
                        route_id_: {
                            "home": route["home"],
                            "runtimeDir": route["runtimeDir"],
                            "coordinatorPid": children[route_id_].pid
                            if route_id_ in children
                            else None,
                        }
                        for route_id_, route in desired_routes.items()
                    },
                    "updatedAt": _now(),
                },
            )
            time.sleep(restart_delay)
        return 0
    finally:
        for route_id_, child in list(children.items()):
            if child.poll() is None:
                child.terminate()
        for route_id_, child in list(children.items()):
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        for route in read_routes(config_home)["routes"].values():
            if isinstance(route, dict) and route.get("runtimeDir"):
                unlink_coordinator_pid_files(str(route["runtimeDir"]))
        unlink_if_exists(supervisor_pid_path(config_home))
        _json_write(
            supervisor_state_path(config_home),
            {
                "schema": SCHEMA_STATUS,
                "status": "stopped",
                "configHome": config_home,
                "updatedAt": _now(),
            },
        )


def ensure_coordinator(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    config_home = resolve_config_home(config_home)
    home = resolve_runtime_home(home)
    runtime_dir = resolve_runtime_dir(home, runtime_dir)
    repairs = repair_route_state(home, runtime_dir, config_home)
    route = upsert_route(config_home, home, runtime_dir)
    current = route_status(home, runtime_dir, config_home)
    if current["supervisor"]["running"]:
        return _wait_for_coordinator(
            home, runtime_dir, config_home, changed=False, route=route, repairs=repairs
        )
    supervisor_state_dir(config_home).mkdir(parents=True, exist_ok=True)
    command = supervisor_command(
        config_home,
        log_level,
        home=home,
        runtime_dir=runtime_dir,
        foreground=True,
    )
    with supervisor_log_path(config_home).open("ab") as log:
        kwargs: dict[str, Any] = {
            "env": command_env(home, runtime_dir, log_level, config_home),
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
    return _wait_for_coordinator(
        home,
        runtime_dir,
        config_home,
        changed=True,
        command=command,
        route=route,
        repairs=repairs,
    )


def _wait_for_coordinator(
    home: str,
    runtime_dir: str,
    config_home: str,
    *,
    changed: bool,
    route: dict[str, Any],
    repairs: list[str] | None = None,
    command: list[str] | None = None,
) -> dict[str, Any]:
    deadline = time.time() + 5
    while time.time() < deadline:
        current = route_status(home, runtime_dir, config_home)
        if current["supervisor"]["running"] and current["coordinator"]["running"]:
            payload = {
                **current,
                "changed": changed,
                "route": {**route, **current.get("route", {})},
            }
            if repairs is not None:
                payload["repairs"] = repairs
            if command:
                payload["command"] = command
            return payload
        time.sleep(0.2)
    payload = {
        **route_status(home, runtime_dir, config_home),
        "changed": changed,
    }
    payload["route"] = {**route, **payload.get("route", {})}
    if repairs is not None:
        payload["repairs"] = repairs
    if command:
        payload["command"] = command
    return payload


def stop_supervisor(
    config_home: str | None = None, timeout: float = 10.0
) -> dict[str, Any]:
    config_home = resolve_config_home(config_home)
    current = supervisor_status(config_home)
    pid = current["supervisor"]["pid"]
    if not current["supervisor"]["running"] or not pid:
        return {**current, "changed": False}
    _terminate_pid(pid)
    deadline = time.time() + timeout
    while time.time() < deadline:
        current = supervisor_status(config_home)
        if not current["supervisor"]["running"]:
            return {**current, "changed": True}
        time.sleep(0.2)
    return {**supervisor_status(config_home), "changed": False, "error": "timeout"}


def supervisor_status(config_home: str | None = None) -> dict[str, Any]:
    config_home = resolve_config_home(config_home)
    supervisor_pid = read_pid(supervisor_pid_path(config_home))
    routes = read_routes(config_home)
    return {
        "schema": SCHEMA_STATUS,
        "status": "running" if _is_pid_running(supervisor_pid) else "stopped",
        "configHome": config_home,
        "supervisorStateDir": str(supervisor_state_dir(config_home)),
        "supervisor": {
            "pid": supervisor_pid,
            "running": _is_pid_running(supervisor_pid),
            "pidFile": str(supervisor_pid_path(config_home)),
            "log": str(supervisor_log_path(config_home)),
        },
        "routes": {
            "path": str(routes_path(config_home)),
            "count": len(routes["routes"]),
            "items": list(routes["routes"].values()),
        },
        "lastSupervisorState": _json_read(supervisor_state_path(config_home)),
    }


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


def service_plan(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> ServicePlan:
    config_home = resolve_config_home(config_home)
    home = resolve_runtime_home(home)
    runtime_dir = resolve_runtime_dir(home, runtime_dir)
    system = platform.system()
    command = supervisor_command(
        config_home,
        log_level,
        home=home,
        runtime_dir=runtime_dir,
        foreground=True,
    )
    env = command_env(home, runtime_dir, log_level, config_home)
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
    <key>KF_CONFIG_HOME</key>
    <string>{xml_escape(config_home)}</string>
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
  <string>{xml_escape(str(supervisor_log_path(config_home)))}</string>
  <key>StandardErrorPath</key>
  <string>{xml_escape(str(supervisor_log_path(config_home)))}</string>
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
        path = (
            Path.home() / ".config" / "systemd" / "user" / "kungfu-supervisor.service"
        )
        content = f"""[Unit]
Description={SERVICE_NAME}
After=default.target

[Service]
Type=simple
{_systemd_env_line("KF_HOME", home)}
{_systemd_env_line("KF_CONFIG_HOME", config_home)}
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
            "write the unit; then run: systemctl --user daemon-reload && systemctl --user enable --now kungfu-supervisor.service",
            "run: systemctl --user disable --now kungfu-supervisor.service; then remove the unit",
        )
    startup = (
        Path(os.environ.get("APPDATA", str(Path.home())))
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Startup"
        / "kungfu-supervisor.cmd"
    )
    lines = [
        "@echo off",
        f'set "KF_HOME={env["KF_HOME"]}"',
        f'set "KF_CONFIG_HOME={env["KF_CONFIG_HOME"]}"',
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


def install_service(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    plan = service_plan(home, runtime_dir, log_level, config_home)
    plan.path.parent.mkdir(parents=True, exist_ok=True)
    plan.path.write_text(plan.content, "utf-8")
    return {
        "schema": SCHEMA_RESULT,
        "action": "install",
        "changed": True,
        "plan": plan.as_dict(),
    }


def uninstall_service(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    plan = service_plan(home, runtime_dir, log_level, config_home)
    existed = plan.path.exists()
    if existed:
        plan.path.unlink()
    return {
        "schema": SCHEMA_RESULT,
        "action": "uninstall",
        "changed": existed,
        "plan": plan.as_dict(),
    }


def service_status(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    config_home = resolve_config_home(config_home)
    home = resolve_runtime_home(home)
    runtime_dir = resolve_runtime_dir(home, runtime_dir)
    plan = service_plan(home, runtime_dir, log_level, config_home)
    installed = plan.path.exists()
    actual = ""
    if installed:
        try:
            actual = plan.path.read_text("utf-8")
        except OSError:
            actual = ""
    return {
        "schema": SCHEMA_STATUS,
        "configHome": config_home,
        "home": home,
        "runtimeDir": runtime_dir,
        "service": {
            "id": SERVICE_ID,
            "platform": plan.platform,
            "path": str(plan.path),
            "installed": installed,
            "matchesPlan": installed and actual == plan.content,
        },
        "supervisor": route_status(home, runtime_dir, config_home),
    }
