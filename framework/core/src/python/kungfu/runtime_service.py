# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os
import platform
import signal
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Mapping, Protocol

import kungfu
from kungfu import (
    runtime_leases,
    runtime_paths,
    runtime_processes as _runtime_processes,
    runtime_service_config,
    runtime_state,
)
from kungfu.action_envelope import CARRIER_ACTION_ENVELOPE
from kungfu.coordination import locks as coordination_locks
from kungfu.coordination.arbiter import (
    ACTION_GRANT,
    ACTION_RELEASE,
    ACTION_REQUEST,
    LockTable,
    grant_payload,
    parse_name,
)
from kungfu.execution_surface import authority as runtime_surface_authority
from kungfu.storage import service as storage_service
from kungfu.action_wire import unwrap_event, wrap_event
from pykungfu.runtime import coordinator as NativeCoordinator

lf = kungfu.__binding__.yijinjing
yjj: Any = kungfu.__binding__.runtime
# Preserve the historical module attribute used by process-control tests and
# downstream diagnostics while the implementation owner lives in one module.
psutil = _runtime_processes.psutil

SCHEMA_STATUS = "kungfu.runtime.status/v2"
SCHEMA_ROUTES = "kungfu.runtime.routes/v2"
SCHEMA_ASSESSMENT_SUBSCRIPTION = "kungfu.runtime.assessment-subscription/v2"
SCHEMA_COORDINATOR_CONTINUITY = "kungfu.runtime.coordinator-continuity/v1"
LEGACY_SCHEMA_ROUTES = "kungfu.master-service.routes/v1"
# Stable wire-v1 identity. New code calls this process the coordinator, while
# existing journals and RocksDB records continue to resolve the historic UID.
COORDINATOR_WIRE_NAMESPACE = "master"
COORDINATOR_WIRE_NAME = "master"
LEGACY_STATE_DIR_NAME = "master"
ROUTE_LEASE_TTL_SECONDS = 30.0
RESTART_WINDOW_SECONDS = 60.0
RESTART_MAX_ATTEMPTS = 5
RUNTIME_IDLE_GRACE_SECONDS = 30.0
SUPERVISOR_LIFECYCLE_LOCK = "supervisor-lifecycle"
_SUPERVISOR_LIFECYCLE_THREAD_LOCK = threading.RLock()


SCHEMA_PLAN = runtime_service_config.SCHEMA_PLAN
SCHEMA_RESULT = runtime_service_config.SCHEMA_RESULT
SERVICE_ID = runtime_service_config.SERVICE_ID
SERVICE_NAME = runtime_service_config.SERVICE_NAME
SUPERVISOR_ALWAYS_ON_ENV = runtime_service_config.SUPERVISOR_ALWAYS_ON_ENV
ServicePlan = runtime_service_config.ServicePlan
_shell_join = runtime_service_config._shell_join
shlex_quote = runtime_service_config.shlex_quote
_systemd_env_line = runtime_service_config._systemd_env_line
_positive_generation = runtime_service_config._positive_generation
supervisor_state_dir = runtime_service_config.supervisor_state_dir
supervisor_log_path = runtime_service_config.supervisor_log_path
entry_command = runtime_service_config.entry_command
command_env = runtime_service_config.command_env
coordinator_run_command = runtime_service_config.coordinator_run_command
assessment_worker_command = runtime_service_config.assessment_worker_command
run_assessment_worker = runtime_service_config.run_assessment_worker
supervisor_command = runtime_service_config.supervisor_command


@dataclass(frozen=True)
class RuntimeEngineRequest:
    operation: str


@dataclass(frozen=True)
class RuntimeEngineReceipt:
    operation: str
    accepted: bool
    state: str
    capabilities: tuple[str, ...]
    error: str | None = None


class AssessmentExecutor(Protocol):
    def ready(self, nanotime: int) -> bool: ...

    def start(self, assessment_key: str, nanotime: int) -> None: ...

    def close(self) -> None: ...


CoordinatorProcess = _runtime_processes.CoordinatorProcess


class AdoptedCoordinatorProcess:
    """Process-shaped adapter for a fenced coordinator not spawned by this loop."""

    def __init__(self, pid: int, start_identity: str) -> None:
        self.pid = pid
        self.start_identity = start_identity

    def poll(self) -> int | None:
        return None if _process_matches(self.pid, self.start_identity) else 0

    def terminate(self) -> None:
        _terminate_process_if_matches(self.pid, self.start_identity)

    def wait(self, timeout: float | None = None) -> int:
        deadline = time.time() + (timeout or 0.0)
        while _process_matches(self.pid, self.start_identity):
            if timeout is not None and time.time() >= deadline:
                raise subprocess.TimeoutExpired(["adopted-coordinator"], timeout)
            time.sleep(0.05)
        return 0

    def kill(self) -> None:
        _terminate_process_if_matches(self.pid, self.start_identity, force=True)


_terminate_and_reap_child = (
    _runtime_processes.RuntimeProcessControl.terminate_and_reap_child
)


def _now() -> float:
    return time.time()


def _json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as output:
            temporary = Path(output.name)
            output.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
        replace_attempts = 20 if platform.system() == "Windows" else 1
        for attempt in range(replace_attempts):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == replace_attempts - 1:
                    raise
                time.sleep(0.05)
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _json_read(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


_is_pid_running = _runtime_processes.RuntimeProcessControl.is_pid_running
_process_start_identity = _runtime_processes.RuntimeProcessControl.start_identity


def _process_matches(pid: int | None, start_identity: Any) -> bool:
    if not isinstance(start_identity, str) or not start_identity:
        return False
    return _is_pid_running(pid) and _process_start_identity(pid) == start_identity


_terminate_process_if_matches = (
    _runtime_processes.RuntimeProcessControl.terminate_if_matches
)
_terminate_process_tree_if_matches = (
    _runtime_processes.RuntimeProcessControl.terminate_tree_if_matches
)


def _pid_state(pid: int | None) -> str:
    if not pid or pid <= 0:
        return "missing"
    return "running" if _is_pid_running(pid) else "dead"


_canonical_path = runtime_paths.canonical_path
resolve_config_home = runtime_paths.resolve_config_home
resolve_runtime_home = runtime_paths.resolve_runtime_home
resolve_runtime_dir = runtime_paths.resolve_runtime_dir


def route_id(home: str, runtime_dir: str) -> str:
    digest = sha256(
        f"{resolve_runtime_home(home)}\0{resolve_runtime_dir(home, runtime_dir)}".encode(
            "utf-8"
        )
    ).hexdigest()
    return digest[:16]


def route_record(
    home: str, runtime_dir: str, runtime_generation: str | int = "1"
) -> dict[str, Any]:
    home = resolve_runtime_home(home)
    runtime_dir = resolve_runtime_dir(home, runtime_dir)
    now = _now()
    return {
        "routeId": route_id(home, runtime_dir),
        "dataRoot": home,
        "home": home,
        "runtimeDir": runtime_dir,
        "runtimeGeneration": _positive_generation(
            runtime_generation, "runtime generation"
        ),
        "desired": True,
        "leaseTtlSeconds": ROUTE_LEASE_TTL_SECONDS,
        "leaseUpdatedAt": now,
        "heartbeatAt": None,
        "supervisorPid": None,
        "supervisorStartIdentity": None,
        "coordinatorPid": None,
        "coordinatorStartIdentity": None,
        "createdAt": now,
        "updatedAt": now,
    }


def supervisor_lifecycle_lock_dir(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "lifecycle-locks"


@contextmanager
def supervisor_lifecycle_guard(config_home: str | None, label: str):
    """Serialize route mutation and on-demand supervisor start/exit decisions."""

    with _SUPERVISOR_LIFECYCLE_THREAD_LOCK:
        with coordination_locks.held(
            supervisor_lifecycle_lock_dir(config_home),
            SUPERVISOR_LIFECYCLE_LOCK,
            label=label,
        ):
            yield


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


def coordinator_continuity_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "runtime-continuity.json"


def allocate_coordinator_authority(
    runtime_dir: str, runtime_generation: str | int
) -> dict[str, str]:
    """Allocate one monotonic coordinator epoch for a fenced runtime generation."""

    generation = _positive_generation(runtime_generation, "runtime generation")
    path = coordinator_continuity_path(runtime_dir)
    lock_root = path.parent / "continuity-locks"
    with coordination_locks.held(
        lock_root,
        "coordinator-authority",
        label=f"coordinator-authority:generation-{generation}",
    ):
        previous_generation = 0
        previous_epoch = 0
        if path.exists():
            try:
                previous = json.loads(path.read_text("utf-8"))
                if previous.get("schema") != SCHEMA_COORDINATOR_CONTINUITY:
                    raise ValueError("coordinator continuity schema mismatch")
                previous_generation = int(
                    _positive_generation(
                        previous.get("runtimeGeneration", ""),
                        "recorded runtime generation",
                    )
                )
                previous_epoch = int(
                    _positive_generation(
                        previous.get("coordinatorEpoch", ""),
                        "recorded coordinator epoch",
                    )
                )
            except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
                raise RuntimeError(
                    f"invalid coordinator continuity state at {path}: {error}"
                ) from error
        generation_value = int(generation)
        if generation_value < previous_generation:
            raise RuntimeError(
                "runtime generation is older than the persisted coordinator authority"
            )
        epoch = previous_epoch + 1
        if epoch > (2**64 - 1):
            raise RuntimeError("coordinator epoch exhausted uint64 range")
        authority = {
            "runtimeGeneration": generation,
            "coordinatorEpoch": str(epoch),
        }
        _json_write(
            path,
            {
                "schema": SCHEMA_COORDINATOR_CONTINUITY,
                **authority,
                "updatedAt": _now(),
            },
        )
        return authority


def legacy_state_path(runtime_dir: str) -> Path:
    return legacy_state_dir(runtime_dir) / "state.json"


def supervisor_state_path(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "state.json"


def routes_path(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "routes.json"


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


def _upsert_route_unlocked(
    config_home: str | None,
    home: str,
    runtime_dir: str,
    runtime_generation: str | int | None = None,
) -> dict[str, Any]:
    route = route_record(home, runtime_dir, runtime_generation or "1")
    payload = read_routes(config_home)
    previous = payload["routes"].get(route["routeId"])
    if isinstance(previous, dict):
        route["createdAt"] = previous.get("createdAt", route["createdAt"])
        if runtime_generation is None:
            route["runtimeGeneration"] = previous.get("runtimeGeneration", "1")
    payload["routes"][route["routeId"]] = route
    write_routes(config_home, payload)
    return route


def upsert_route(
    config_home: str | None,
    home: str,
    runtime_dir: str,
    runtime_generation: str | int | None = None,
) -> dict[str, Any]:
    with supervisor_lifecycle_guard(config_home, "route-upsert"):
        return _upsert_route_unlocked(
            config_home, home, runtime_dir, runtime_generation
        )


def _set_route_desired_unlocked(
    config_home: str | None,
    home: str,
    runtime_dir: str,
    desired: bool,
) -> dict[str, Any]:
    route = route_record(home, runtime_dir)
    payload = read_routes(config_home)
    previous = payload["routes"].get(route["routeId"])
    if isinstance(previous, dict):
        route = {
            **route,
            **previous,
            "dataRoot": route["dataRoot"],
            "home": route["home"],
            "runtimeDir": route["runtimeDir"],
            "createdAt": previous.get("createdAt", route["createdAt"]),
        }
    now = _now()
    route["desired"] = desired
    route["leaseUpdatedAt"] = now
    route["updatedAt"] = now
    payload["routes"][route["routeId"]] = route
    write_routes(config_home, payload)
    return route


def set_route_desired(
    config_home: str | None,
    home: str,
    runtime_dir: str,
    desired: bool,
) -> dict[str, Any]:
    with supervisor_lifecycle_guard(config_home, "route-desired"):
        return _set_route_desired_unlocked(config_home, home, runtime_dir, desired)


def _restart_permitted(
    attempts: list[float],
    now: float,
    *,
    window_seconds: float = RESTART_WINDOW_SECONDS,
    max_attempts: int = RESTART_MAX_ATTEMPTS,
) -> bool:
    attempts[:] = [value for value in attempts if now - value < window_seconds]
    return len(attempts) < max_attempts


def _runtime_idle_grace_ns() -> int:
    raw = os.environ.get(
        "KF_RUNTIME_IDLE_GRACE_SECONDS", str(RUNTIME_IDLE_GRACE_SECONDS)
    )
    try:
        seconds = max(float(raw), 0.0)
    except ValueError:
        seconds = RUNTIME_IDLE_GRACE_SECONDS
    return int(seconds * 1_000_000_000)


def _runtime_demand_status(
    config_home: str,
    runtime_dir: str,
    *,
    grace_ns: int,
    clock: Any = None,
) -> dict[str, Any] | None:
    manager = runtime_leases.RuntimeLeaseManager(
        config_home,
        runtime_state.workspace_id(runtime_dir),
        clock=clock,
    )
    try:
        return manager.begin_idle_drain(grace_ns)
    except runtime_leases.RuntimeLifecycleError:
        return None


def _complete_runtime_drain(
    config_home: str,
    runtime_dir: str,
    generation: str,
    *,
    stopped: bool,
) -> bool:
    manager = runtime_leases.RuntimeLeaseManager(
        config_home,
        runtime_state.workspace_id(runtime_dir),
    )
    try:
        manager.complete_drain(generation, stopped=stopped)
    except runtime_leases.RuntimeLifecycleError:
        return False
    return True


def _fence_runtime_restart(
    config_home: str,
    runtime_dir: str,
    coordinator_pid: int,
) -> bool:
    manager = runtime_leases.RuntimeLeaseManager(
        config_home,
        runtime_state.workspace_id(runtime_dir),
    )
    try:
        manager.begin_restart(coordinator_pid)
    except runtime_leases.RuntimeLifecycleError:
        return False
    return True


def _set_route_restart_status_unlocked(
    config_home: str,
    route_id_: str,
    *,
    state: str,
    attempts: int,
    retry_at: float | None,
) -> None:
    payload = read_routes(config_home)
    route = payload["routes"].get(route_id_)
    if not isinstance(route, dict):
        return
    route["restartState"] = state
    route["restartAttempts"] = attempts
    route["restartNotBefore"] = retry_at
    route["updatedAt"] = _now()
    write_routes(config_home, payload)


def _set_route_restart_status(
    config_home: str,
    route_id_: str,
    *,
    state: str,
    attempts: int,
    retry_at: float | None,
) -> None:
    with supervisor_lifecycle_guard(config_home, "route-restart-status"):
        _set_route_restart_status_unlocked(
            config_home,
            route_id_,
            state=state,
            attempts=attempts,
            retry_at=retry_at,
        )


def _fenced_adopted_coordinator(
    config_home: str,
    runtime_dir: str,
    runtime_generation: str | int | None = None,
) -> AdoptedCoordinatorProcess | None:
    pid = read_coordinator_pid(runtime_dir)
    if not pid or not _is_pid_running(pid):
        return None
    state = _json_read(state_path(runtime_dir))
    start_identity = state.get("coordinatorStartIdentity")
    if state.get("coordinatorPid") != pid or not _process_matches(pid, start_identity):
        return None
    generation = runtime_state.fenced_coordinator_generation(
        config_home,
        runtime_dir,
        pid,
    )
    if generation is None or str(state.get("runtimeGeneration")) != str(generation):
        return None
    if runtime_generation is not None and str(generation) != str(runtime_generation):
        return None
    return AdoptedCoordinatorProcess(pid, str(start_identity))


def _touch_route_heartbeat_unlocked(
    config_home: str | None,
    route_id_: str,
    *,
    supervisor_pid: int | None,
    coordinator_pid: int | None,
    supervisor_start_identity: str | None = None,
    coordinator_start_identity: str | None = None,
) -> dict[str, Any] | None:
    payload = read_routes(config_home)
    route = payload["routes"].get(route_id_)
    if not isinstance(route, dict):
        return None
    now = _now()
    route["heartbeatAt"] = now
    route["leaseTtlSeconds"] = route.get("leaseTtlSeconds", ROUTE_LEASE_TTL_SECONDS)
    route["supervisorPid"] = supervisor_pid
    route["supervisorStartIdentity"] = (
        supervisor_start_identity or _process_start_identity(supervisor_pid)
    )
    route["coordinatorPid"] = coordinator_pid
    route["coordinatorStartIdentity"] = (
        coordinator_start_identity or _process_start_identity(coordinator_pid)
    )
    route["restartState"] = "running"
    route["restartNotBefore"] = None
    route["updatedAt"] = now
    payload["routes"][route_id_] = route
    write_routes(config_home, payload)
    return route


def touch_route_heartbeat(
    config_home: str | None,
    route_id_: str,
    *,
    supervisor_pid: int | None,
    coordinator_pid: int | None,
    supervisor_start_identity: str | None = None,
    coordinator_start_identity: str | None = None,
) -> dict[str, Any] | None:
    with supervisor_lifecycle_guard(config_home, "route-heartbeat"):
        return _touch_route_heartbeat_unlocked(
            config_home,
            route_id_,
            supervisor_pid=supervisor_pid,
            coordinator_pid=coordinator_pid,
            supervisor_start_identity=supervisor_start_identity,
            coordinator_start_identity=coordinator_start_identity,
        )


def _supervisor_always_on() -> bool:
    return os.environ.get(SUPERVISOR_ALWAYS_ON_ENV, "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _retire_idle_routes(
    config_home: str,
    *,
    has_children: bool,
    supervisor_pid: int,
    supervisor_start_identity: str | None,
) -> bool:
    """Atomically retire inactive routes when an on-demand supervisor can exit."""

    if has_children or _supervisor_always_on():
        return False
    with supervisor_lifecycle_guard(config_home, "supervisor-idle-exit"):
        payload = read_routes(config_home)
        if any(
            isinstance(route, dict) and route.get("desired") is True
            for route in payload["routes"].values()
        ):
            return False
        payload["routes"] = {}
        write_routes(config_home, payload)
        _json_write(
            supervisor_state_path(config_home),
            {
                "schema": SCHEMA_STATUS,
                "status": "idle-exiting",
                "configHome": config_home,
                "supervisorPid": supervisor_pid,
                "supervisorStartIdentity": supervisor_start_identity,
                "updatedAt": _now(),
            },
        )
        if read_pid(supervisor_pid_path(config_home)) == supervisor_pid:
            unlink_if_exists(supervisor_pid_path(config_home))
        return True


def _finalize_supervisor_state(
    config_home: str,
    *,
    supervisor_pid: int,
    supervisor_start_identity: str | None,
    stop_reason: str,
) -> None:
    """Clear only this supervisor's state; never overwrite a replacement."""

    with supervisor_lifecycle_guard(config_home, "supervisor-finalize"):
        current_pid = read_pid(supervisor_pid_path(config_home))
        current_state = _json_read(supervisor_state_path(config_home))
        owns_state = (
            current_state.get("supervisorPid") == supervisor_pid
            and current_state.get("supervisorStartIdentity")
            == supervisor_start_identity
        )
        if current_pid == supervisor_pid:
            unlink_if_exists(supervisor_pid_path(config_home))
        elif current_pid is not None or not owns_state:
            return
        _json_write(
            supervisor_state_path(config_home),
            {
                "schema": SCHEMA_STATUS,
                "status": "stopped",
                "configHome": config_home,
                "stopReason": stop_reason,
                "supervisorPid": supervisor_pid,
                "supervisorStartIdentity": supervisor_start_identity,
                "updatedAt": _now(),
            },
        )


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
        registered_generation = (
            current["route"].get("runtimeGeneration")
            if current["route"].get("registered")
            else None
        )
        adopted = _fenced_adopted_coordinator(
            resolve_config_home(config_home),
            runtime_dir,
            registered_generation,
        )
        if adopted is not None:
            repairs.append("preserved-fenced-orphan-coordinator")
        else:
            repairs.append("preserved-unowned-orphan-coordinator")
    if current["route"].get("freshness", {}).get("stale"):
        repairs.append("refreshed-stale-route")
    return repairs


class ProcessAssessmentExecutor:
    def __init__(self, home: str, runtime_dir: str, log_level: str) -> None:
        self.home = home
        self.runtime_dir = runtime_dir
        self.log_level = log_level
        self.current: tuple[str, subprocess.Popen[Any], int] | None = None

    @staticmethod
    def _timeout_ns() -> int:
        raw = os.environ.get("KF_ASSESSMENT_WORKER_TIMEOUT_SECONDS", "30")
        try:
            seconds = max(float(raw), 0.1)
        except ValueError:
            seconds = 30.0
        return int(seconds * 1_000_000_000)

    def ready(self, nanotime: int) -> bool:
        if self.current is None:
            return True
        _, child, started_at = self.current
        if child.poll() is not None:
            self.current = None
            return True
        if nanotime - started_at < self._timeout_ns():
            return False
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        self.current = None
        return True

    def start(self, assessment_key: str, nanotime: int) -> None:
        command = assessment_worker_command(self.runtime_dir, assessment_key)
        coordinator_log_path(self.runtime_dir).parent.mkdir(parents=True, exist_ok=True)
        with coordinator_log_path(self.runtime_dir).open("ab") as log:
            child = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=command_env(
                    self.home,
                    self.runtime_dir,
                    self.log_level,
                ),
            )
        self.current = (assessment_key, child, nanotime)

    def close(self) -> None:
        if self.current is None:
            return
        _, child, _ = self.current
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        self.current = None


class CoordinatorEngine(NativeCoordinator):
    CAPABILITIES = (
        "runtime.peer-registry",
        "runtime.channel-routing",
        "runtime.assessment-scheduling",
    )

    def __init__(
        self,
        home: str,
        runtime_dir: str,
        low_latency: bool = False,
        *,
        assessment_executor: AssessmentExecutor | None = None,
        runtime_generation: str | int = "1",
        coordinator_epoch: str | int = "1",
    ) -> None:
        locator = yjj.locator(runtime_dir)
        location = yjj.location(
            lf.enums.mode.LIVE,
            lf.enums.location_role.SYSTEM,
            COORDINATOR_WIRE_NAMESPACE,
            COORDINATOR_WIRE_NAME,
            locator,
        )
        self.location = {
            "namespace": COORDINATOR_WIRE_NAMESPACE,
            "name": COORDINATOR_WIRE_NAME,
        }
        from kungfu import durability as durability_runtime

        self.durability_policy = durability_runtime.resolve_policy(
            runtime_home=home,
            config_home=os.environ.get("KF_CONFIG_HOME"),
            cwd=home,
        )
        super().__init__(
            location,
            low_latency,
            self.durability_policy["native"],
            int(_positive_generation(runtime_generation, "runtime generation")),
            int(_positive_generation(coordinator_epoch, "coordinator epoch")),
        )
        self.durability = durability_runtime.ConfiguredDurabilityRuntime(
            self, self.durability_policy, data_root=runtime_dir
        )
        self.home_dir = home
        self.runtime_dir = runtime_dir
        self._assessment_executor = assessment_executor
        self._assessment_last_check = 0
        # KF-ADR-019f86da-4f90-7332-a4cd-c9c9b549a5fb lock arbitration, merged into the per-workspace coordinator
        # (retiring the standalone Arbiter peer). The pure LockTable holds the
        # contention state; request/release frames arrive on the coordinator's
        # inbound stream (see on_react) and grants are written straight to the
        # holder's command journal. Liveness reclaim uses the registry pid the
        # coordinator already owns, so no request frame needs to carry a pid.
        self._lock_table = LockTable()

    # --- KF-ADR-019f86da-4f90-7332-a4cd-c9c9b549a5fb lock arbiter (merged into coordinator) ------------------
    def on_react(self) -> None:
        # Installed before coordinator::react() connects the event stream, so the
        # subscription is live from the first frame. Narrow surface: only the
        # coordination action envelope, so a lock bug can never disturb the
        # coordinator's native reactions.
        self.observe(CARRIER_ACTION_ENVELOPE, self._on_lock_action)

    def _on_lock_action(self, event: Any) -> None:
        # Error-isolated: lock arbitration must never crash the coordinator's
        # main react loop (the workspace lifeline). A bad frame is dropped.
        try:
            if event.carrier_type != CARRIER_ACTION_ENVELOPE:
                return
            decoded = unwrap_event(bytes(event.data_as_byte_array))
            if decoded is None:
                return
            action_type, payload = decoded
            name = parse_name(payload)
            if name is None:
                return
            source = int(event.source)
            if action_type == ACTION_REQUEST:
                grant = self._lock_table.request(name, source)
                if grant is not None:
                    self._emit_grant(name, grant)
            elif action_type == ACTION_RELEASE:
                nxt = self._lock_table.release(name, source)
                if nxt is not None:
                    self._emit_grant(name, nxt)
        except Exception:  # noqa: BLE001 - lock logic must never break serving
            pass

    def _emit_grant(self, name: str, holder: int) -> None:
        # Grant is addressed to the holder's command journal (the coordinator
        # already holds a writer to every registered peer). The holder observes
        # the action envelope on its own live stream — no public broadcast.
        if not self.has_writer(holder):
            return
        payload = grant_payload(name, holder)
        carrier, data = wrap_event(ACTION_GRANT, payload)
        self.get_writer(holder).write_bytes(self.now(), carrier, data)

    def _reap_dead_lock_holders(self) -> None:
        # Reclaim locks whose holder is gone. The holder's liveness comes from
        # the coordinator's registry pid (Register carries pid), not from a pid
        # smuggled in the lock request — this is the tax the standalone arbiter
        # paid for living outside the registry, removed by merging in.
        try:
            registry = self.get_registry()
        except Exception:  # noqa: BLE001
            return
        dead: list[int] = []
        seen: set[int] = set()
        for name in list(self._lock_table.snapshot()):
            holder = self._lock_table.holder(name)
            if holder is None or holder in seen:
                continue
            seen.add(holder)
            reg = registry.get(holder)
            pid = int(getattr(reg, "pid", 0)) if reg is not None else None
            if reg is None or not _is_pid_running(pid):
                dead.append(holder)
        for uid in dead:
            for name, nxt in self._lock_table.forget(uid):
                if nxt is not None:
                    self._emit_grant(name, nxt)

    def handle_request(self, request: RuntimeEngineRequest) -> RuntimeEngineReceipt:
        if request.operation == "inspect":
            return RuntimeEngineReceipt(
                operation=request.operation,
                accepted=True,
                state="constructed",
                capabilities=self.CAPABILITIES,
            )
        return RuntimeEngineReceipt(
            operation=request.operation,
            accepted=False,
            state="rejected",
            capabilities=(),
            error="unsupported-operation",
        )

    def on_register(self, gen_time: int, register_data: Any) -> None:
        return None

    def check_register(self, gen_time: int, register_data: Any) -> bool:
        return True

    def on_interval_check(self, nanotime: int) -> None:
        # Reclaim locks held by dead peers every interval, independent of the
        # assessment-worker throttle below.
        self._reap_dead_lock_holders()
        if nanotime - self._assessment_last_check < 500_000_000:
            return
        self._assessment_last_check = nanotime
        if (
            self._assessment_executor is not None
            and not self._assessment_executor.ready(nanotime)
        ):
            return

        snapshot = publish_assessment_snapshot(self.runtime_dir)
        pending = [
            assessment
            for assessment in snapshot["assessments"]
            if assessment["state"] == "pending"
        ]
        if not pending:
            return
        if self._assessment_executor is None:
            return
        assessment_key = str(pending[0]["assessment_key"])
        self._assessment_executor.start(assessment_key, nanotime)

    def close(self) -> None:
        self.durability.close()
        if self._assessment_executor is not None:
            self._assessment_executor.close()


class Coordinator(CoordinatorEngine):
    """Compatibility process coordinator; new no-fork code uses CoordinatorEngine."""

    def __init__(self, home: str, runtime_dir: str, low_latency: bool = False) -> None:
        super().__init__(
            home,
            runtime_dir,
            low_latency,
            assessment_executor=ProcessAssessmentExecutor(
                home,
                runtime_dir,
                os.environ.get("KF_LOG_LEVEL", "warning"),
            ),
        )


class ProcessRuntimeHost:
    """Owns process placement while CoordinatorEngine owns runtime semantics."""

    def __init__(
        self,
        log_level: str = "warning",
        config_home: str | None = None,
        runtime_image: Mapping[str, Any] | None = None,
    ) -> None:
        self.log_level = log_level
        self.config_home = resolve_config_home(config_home)
        if runtime_image is None:
            from kungfu import runtime_upgrade

            runtime_image = runtime_upgrade.image_from_environment()
        self.runtime_image = runtime_image

    def run_foreground(
        self,
        home: str,
        runtime_dir: str,
        low_latency: bool = False,
        runtime_generation: str | int | None = None,
    ) -> int:
        home = resolve_runtime_home(home)
        runtime_dir = resolve_runtime_dir(home, runtime_dir)
        authority = allocate_coordinator_authority(
            runtime_dir,
            runtime_generation or os.environ.get("KF_RUNTIME_GENERATION", "1"),
        )
        state_dir(runtime_dir).mkdir(parents=True, exist_ok=True)
        write_pid(coordinator_pid_path(runtime_dir), os.getpid())
        coordinator_start_identity = _process_start_identity(os.getpid())
        try:
            engine = CoordinatorEngine(
                home,
                runtime_dir,
                low_latency=low_latency,
                runtime_generation=authority["runtimeGeneration"],
                coordinator_epoch=authority["coordinatorEpoch"],
                assessment_executor=ProcessAssessmentExecutor(
                    home, runtime_dir, self.log_level
                ),
            )
            _json_write(
                state_path(runtime_dir),
                runtime_surface_authority.coordinator_running_state(
                    schema=SCHEMA_STATUS,
                    home=home,
                    runtime_dir=runtime_dir,
                    authority=authority,
                    pid=os.getpid(),
                    start_identity=coordinator_start_identity,
                    runtime_image=self.runtime_image,
                    updated_at=_now(),
                ),
            )
            try:
                engine.run()
                return 0
            finally:
                engine.close()
        finally:
            unlink_coordinator_pid_files(runtime_dir)

    def spawn_coordinator(
        self,
        home: str,
        runtime_dir: str,
        runtime_generation: str | int = "1",
    ) -> subprocess.Popen[Any]:
        home = resolve_runtime_home(home)
        runtime_dir = resolve_runtime_dir(home, runtime_dir)
        command = coordinator_run_command(
            home,
            runtime_dir,
            self.log_level,
            self.runtime_image,
        )
        coordinator_log_path(runtime_dir).parent.mkdir(parents=True, exist_ok=True)
        with coordinator_log_path(runtime_dir).open("ab") as log:
            return subprocess.Popen(
                command,
                env=command_env(
                    home,
                    runtime_dir,
                    self.log_level,
                    self.config_home,
                    runtime_generation=runtime_generation,
                    runtime_image=self.runtime_image,
                ),
                stdout=log,
                stderr=log,
            )

    def spawn_supervisor(
        self,
        home: str,
        runtime_dir: str,
        runtime_generation: str | int = "1",
    ) -> tuple[subprocess.Popen[Any], list[str]]:
        home = resolve_runtime_home(home)
        runtime_dir = resolve_runtime_dir(home, runtime_dir)
        supervisor_state_dir(self.config_home).mkdir(parents=True, exist_ok=True)
        command = supervisor_command(
            self.config_home,
            self.log_level,
            home=home,
            runtime_dir=runtime_dir,
            foreground=True,
            runtime_image=self.runtime_image,
        )
        with supervisor_log_path(self.config_home).open("ab") as log:
            kwargs: dict[str, Any] = {
                "env": command_env(
                    home,
                    runtime_dir,
                    self.log_level,
                    self.config_home,
                    runtime_generation=runtime_generation,
                    runtime_image=self.runtime_image,
                ),
                "stdout": log,
                "stderr": log,
            }
            if platform.system() == "Windows":
                detached_process = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
                new_process_group = getattr(
                    subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200
                )
                breakaway_from_job = getattr(
                    subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000
                )
                kwargs["creationflags"] = (
                    detached_process | new_process_group | breakaway_from_job
                )
            else:
                kwargs["start_new_session"] = True
            try:
                child = subprocess.Popen(command, **kwargs)
            except OSError as error:
                # Some Windows service managers place clients in a job that
                # explicitly forbids breakaway. Preserve the existing resident
                # process behavior there, while allowing CI and other
                # kill-on-close jobs to release the supervisor when permitted.
                if (
                    platform.system() != "Windows"
                    or getattr(error, "winerror", None) != 5
                ):
                    raise
                kwargs["creationflags"] = detached_process | new_process_group
                child = subprocess.Popen(command, **kwargs)
        write_pid(supervisor_pid_path(self.config_home), child.pid)
        _json_write(
            supervisor_state_path(self.config_home),
            {
                "schema": SCHEMA_STATUS,
                "status": "starting",
                "configHome": self.config_home,
                "supervisorPid": child.pid,
                "supervisorStartIdentity": _process_start_identity(child.pid),
                "updatedAt": _now(),
            },
        )
        return child, command

    def activate(self, home: str, runtime_dir: str) -> dict[str, Any]:
        return self.activate_with_generation(home, runtime_dir, "1")

    def activate_with_generation(
        self, home: str, runtime_dir: str, runtime_generation: str | int
    ) -> dict[str, Any]:
        home = resolve_runtime_home(home)
        runtime_dir = resolve_runtime_dir(home, runtime_dir)
        command = None
        with supervisor_lifecycle_guard(self.config_home, "runtime-activate"):
            repairs = repair_route_state(home, runtime_dir, self.config_home)
            route = _upsert_route_unlocked(
                self.config_home, home, runtime_dir, runtime_generation
            )
            current = route_status(home, runtime_dir, self.config_home)
            if (
                current["supervisor"]["running"]
                and not current["supervisor"]["identityVerified"]
            ):
                return {
                    **current,
                    "changed": False,
                    "route": {**route, **current.get("route", {})},
                    "repairs": repairs,
                    "error": "supervisor-identity-unverified",
                }
            changed = not current["supervisor"]["running"]
            if changed:
                _, command = self.spawn_supervisor(
                    home, runtime_dir, runtime_generation
                )
        return _wait_for_coordinator(
            home,
            runtime_dir,
            self.config_home,
            changed=changed,
            command=command,
            route=route,
            repairs=repairs,
        )

    def inspect(self, home: str, runtime_dir: str) -> dict[str, Any]:
        return route_status(home, runtime_dir, self.config_home)

    def drain(
        self,
        home: str,
        runtime_dir: str,
        timeout: float = 10.0,
    ) -> dict[str, Any]:
        home = resolve_runtime_home(home)
        runtime_dir = resolve_runtime_dir(home, runtime_dir)
        set_route_desired(self.config_home, home, runtime_dir, False)
        deadline = time.time() + timeout
        while time.time() < deadline:
            current = route_status(home, runtime_dir, self.config_home)
            if not current["coordinator"]["running"]:
                return {**current, "changed": True}
            time.sleep(0.2)
        return {
            **route_status(home, runtime_dir, self.config_home),
            "changed": False,
            "error": "timeout",
        }

    def install_stop_handlers(self, callback: Any) -> None:
        signal.signal(signal.SIGTERM, callback)
        if platform.system() != "Windows":
            signal.signal(signal.SIGINT, callback)

    @staticmethod
    def terminate_child(child: CoordinatorProcess) -> None:
        if child.poll() is None:
            child.terminate()

    def stop_supervisor(self, timeout: float = 10.0) -> dict[str, Any]:
        current = supervisor_status(self.config_home)
        pid = current["supervisor"]["pid"]
        if not current["supervisor"]["running"] or not pid:
            return {**current, "changed": False}
        if not current["supervisor"]["identityVerified"]:
            return {
                **current,
                "changed": False,
                "error": "supervisor-identity-unverified",
            }
        start_identity = str(current["supervisor"]["startIdentity"])
        terminated = (
            _terminate_process_tree_if_matches(pid, start_identity)
            if platform.system() == "Windows"
            else _terminate_process_if_matches(pid, start_identity)
        )
        if not terminated:
            return {
                **current,
                "changed": False,
                "error": "supervisor-identity-changed",
            }
        deadline = time.time() + timeout
        while time.time() < deadline:
            current = supervisor_status(self.config_home)
            if not current["supervisor"]["running"]:
                return {**current, "changed": True}
            time.sleep(0.2)
        return {
            **supervisor_status(self.config_home),
            "changed": False,
            "error": "timeout",
        }


def run_coordinator(home: str, runtime_dir: str, low_latency: bool = False) -> int:
    return ProcessRuntimeHost().run_foreground(home, runtime_dir, low_latency)


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
    supervisor_identity_verified = supervisor_state.get(
        "supervisorPid"
    ) == supervisor_pid and _process_matches(
        supervisor_pid, supervisor_state.get("supervisorStartIdentity")
    )
    coordinator_identity_verified = state.get(
        "coordinatorPid"
    ) == coordinator_pid and _process_matches(
        coordinator_pid, state.get("coordinatorStartIdentity")
    )
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
            "startIdentity": supervisor_state.get("supervisorStartIdentity"),
            "identityVerified": supervisor_identity_verified,
            "processState": lifecycle["supervisorProcess"],
            "pidFile": str(supervisor_pid_path(config_home)),
            "log": str(supervisor_log_path(config_home)),
        },
        "coordinator": {
            "pid": coordinator_pid,
            "running": coordinator_running,
            "startIdentity": state.get("coordinatorStartIdentity"),
            "identityVerified": coordinator_identity_verified,
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
        "product": runtime_state.product_status(config_home, runtime_dir),
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
    process_host = ProcessRuntimeHost(log_level, config_home)
    service_state_dir = supervisor_state_dir(config_home)
    service_state_dir.mkdir(parents=True, exist_ok=True)
    supervisor_start_identity = _process_start_identity(os.getpid())
    with supervisor_lifecycle_guard(config_home, "supervisor-start"):
        write_pid(supervisor_pid_path(config_home), os.getpid())
        _json_write(
            supervisor_state_path(config_home),
            {
                "schema": SCHEMA_STATUS,
                "status": "starting",
                "configHome": config_home,
                "supervisorPid": os.getpid(),
                "supervisorStartIdentity": supervisor_start_identity,
                "updatedAt": _now(),
            },
        )
    if home and runtime_dir:
        upsert_route(
            config_home,
            home,
            runtime_dir,
            os.environ.get("KF_RUNTIME_GENERATION"),
        )
    stopping = False
    children: dict[str, CoordinatorProcess] = {}
    restart_attempts: dict[str, list[float]] = {}
    draining_generations: dict[str, str] = {}
    idle_grace_ns = _runtime_idle_grace_ns()
    stop_reason = "signal"

    def request_stop(signum: int, frame: Any) -> None:
        nonlocal stopping
        stopping = True
        # Defer termination to the finally block so it can snapshot and reap
        # the coordinator's descendants before Windows severs the process tree.

    process_host.install_stop_handlers(request_stop)

    try:
        while not stopping:
            routes = read_routes(config_home)
            desired_routes: dict[str, dict[str, Any]] = {}
            for route_id_, route in routes["routes"].items():
                if not isinstance(route, dict) or route.get("desired") is not True:
                    continue
                demand = _runtime_demand_status(
                    config_home,
                    str(route["runtimeDir"]),
                    grace_ns=idle_grace_ns,
                )
                if demand is not None and demand.get("state") == "draining":
                    draining_generations[route_id_] = str(demand["generation"])
                    set_route_desired(
                        config_home,
                        str(route["home"]),
                        str(route["runtimeDir"]),
                        False,
                    )
                    if route_id_ not in children:
                        _complete_runtime_drain(
                            config_home,
                            str(route["runtimeDir"]),
                            draining_generations.pop(route_id_),
                            stopped=True,
                        )
                    continue
                desired_routes[route_id_] = route
            for route_id_, child in list(children.items()):
                exit_code = child.poll()
                route = routes["routes"].get(route_id_)
                if route_id_ not in desired_routes:
                    if exit_code is None:
                        process_host.terminate_child(child)
                        continue
                    if route:
                        runtime_dir_ = str(route["runtimeDir"])
                        unlink_coordinator_pid_files(runtime_dir_)
                        generation = draining_generations.pop(route_id_, None)
                        if generation is not None:
                            _complete_runtime_drain(
                                config_home,
                                runtime_dir_,
                                generation,
                                stopped=True,
                            )
                    children.pop(route_id_, None)
                    continue
                if exit_code is not None:
                    if route:
                        runtime_dir_ = str(route["runtimeDir"])
                        _fence_runtime_restart(
                            config_home,
                            runtime_dir_,
                            child.pid,
                        )
                        unlink_coordinator_pid_files(runtime_dir_)
                    restart_attempts.setdefault(route_id_, []).append(_now())
                    children.pop(route_id_, None)
            for route_id_, route in desired_routes.items():
                running_child = children.get(route_id_)
                if running_child and running_child.poll() is None:
                    touch_route_heartbeat(
                        config_home,
                        route_id_,
                        supervisor_pid=os.getpid(),
                        coordinator_pid=running_child.pid,
                        supervisor_start_identity=supervisor_start_identity,
                        coordinator_start_identity=getattr(
                            running_child,
                            "start_identity",
                            _process_start_identity(running_child.pid),
                        ),
                    )
                    continue
                adopted = _fenced_adopted_coordinator(
                    config_home,
                    str(route["runtimeDir"]),
                    route.get("runtimeGeneration"),
                )
                if adopted is not None:
                    children[route_id_] = adopted
                    touch_route_heartbeat(
                        config_home,
                        route_id_,
                        supervisor_pid=os.getpid(),
                        coordinator_pid=adopted.pid,
                        supervisor_start_identity=supervisor_start_identity,
                        coordinator_start_identity=adopted.start_identity,
                    )
                    continue
                existing_pid = read_coordinator_pid(str(route["runtimeDir"]))
                if existing_pid and _is_pid_running(existing_pid):
                    _set_route_restart_status(
                        config_home,
                        route_id_,
                        state="ownership-unknown",
                        attempts=len(restart_attempts.setdefault(route_id_, [])),
                        retry_at=None,
                    )
                    continue
                attempts = restart_attempts.setdefault(route_id_, [])
                now = _now()
                if not _restart_permitted(attempts, now):
                    retry_at = min(attempts) + RESTART_WINDOW_SECONDS
                    _set_route_restart_status(
                        config_home,
                        route_id_,
                        state="crash-loop",
                        attempts=len(attempts),
                        retry_at=retry_at,
                    )
                    continue
                route_home = str(route["home"])
                route_runtime_dir = str(route["runtimeDir"])
                child = process_host.spawn_coordinator(
                    route_home,
                    route_runtime_dir,
                    route.get("runtimeGeneration", "1"),
                )
                _set_route_restart_status(
                    config_home,
                    route_id_,
                    state="starting",
                    attempts=len(attempts),
                    retry_at=None,
                )
                children[route_id_] = child
                write_pid(coordinator_pid_path(route_runtime_dir), child.pid)
                touch_route_heartbeat(
                    config_home,
                    route_id_,
                    supervisor_pid=os.getpid(),
                    coordinator_pid=child.pid,
                    supervisor_start_identity=supervisor_start_identity,
                    coordinator_start_identity=_process_start_identity(child.pid),
                )
            if _retire_idle_routes(
                config_home,
                has_children=bool(children),
                supervisor_pid=os.getpid(),
                supervisor_start_identity=supervisor_start_identity,
            ):
                stop_reason = "idle"
                break
            _json_write(
                supervisor_state_path(config_home),
                {
                    "schema": SCHEMA_STATUS,
                    "status": "running",
                    "configHome": config_home,
                    "supervisorPid": os.getpid(),
                    "supervisorStartIdentity": supervisor_start_identity,
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
            _terminate_and_reap_child(process_host, child)
        for route in read_routes(config_home)["routes"].values():
            if isinstance(route, dict) and route.get("runtimeDir"):
                unlink_coordinator_pid_files(str(route["runtimeDir"]))
        _finalize_supervisor_state(
            config_home,
            supervisor_pid=os.getpid(),
            supervisor_start_identity=supervisor_start_identity,
            stop_reason=stop_reason,
        )


def ensure_coordinator(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    return ProcessRuntimeHost(log_level, config_home).activate(home, runtime_dir)


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
        if runtime_surface_authority.coordinator_ready(current):
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
    current_route = payload.get("route")
    payload["route"] = {
        **route,
        **(current_route if isinstance(current_route, dict) else {}),
    }
    if repairs is not None:
        payload["repairs"] = repairs
    if command:
        payload["command"] = command
    return payload


def stop_supervisor(
    config_home: str | None = None, timeout: float = 10.0
) -> dict[str, Any]:
    return ProcessRuntimeHost(config_home=config_home).stop_supervisor(timeout)


def supervisor_status(config_home: str | None = None) -> dict[str, Any]:
    config_home = resolve_config_home(config_home)
    supervisor_pid = read_pid(supervisor_pid_path(config_home))
    supervisor_state = _json_read(supervisor_state_path(config_home))
    supervisor_identity_verified = supervisor_state.get(
        "supervisorPid"
    ) == supervisor_pid and _process_matches(
        supervisor_pid, supervisor_state.get("supervisorStartIdentity")
    )
    routes = read_routes(config_home)
    return {
        "schema": SCHEMA_STATUS,
        "status": "running" if _is_pid_running(supervisor_pid) else "stopped",
        "configHome": config_home,
        "supervisorStateDir": str(supervisor_state_dir(config_home)),
        "supervisor": {
            "pid": supervisor_pid,
            "running": _is_pid_running(supervisor_pid),
            "startIdentity": supervisor_state.get("supervisorStartIdentity"),
            "identityVerified": supervisor_identity_verified,
            "pidFile": str(supervisor_pid_path(config_home)),
            "log": str(supervisor_log_path(config_home)),
        },
        "routes": {
            "path": str(routes_path(config_home)),
            "count": len(routes["routes"]),
            "items": list(routes["routes"].values()),
        },
        "lastSupervisorState": supervisor_state,
    }


def service_plan(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> ServicePlan:
    return runtime_service_config.service_plan(
        home,
        runtime_dir,
        log_level,
        config_home,
    )


def install_service(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    return runtime_service_config.install_service(
        service_plan(home, runtime_dir, log_level, config_home)
    )


def uninstall_service(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    return runtime_service_config.uninstall_service(
        service_plan(home, runtime_dir, log_level, config_home)
    )


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
    return runtime_service_config.service_status(
        config_home=config_home,
        home=home,
        runtime_dir=runtime_dir,
        plan=plan,
        supervisor=route_status(home, runtime_dir, config_home),
    )
