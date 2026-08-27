# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from typing import Any

from kungfu import runtime_leases, runtime_state
from kungfu.coordination import locks as coordination_locks
from kungfu.storage import service as storage_service

from kungfu._runtime_service.common import (
    SCHEMA_STATUS,
    SCHEMA_ROUTES,
    SCHEMA_ASSESSMENT_SUBSCRIPTION,
    SCHEMA_COORDINATOR_CONTINUITY,
    LEGACY_SCHEMA_ROUTES,
    LEGACY_STATE_DIR_NAME,
    ROUTE_LEASE_TTL_SECONDS,
    RESTART_WINDOW_SECONDS,
    RESTART_MAX_ATTEMPTS,
    RUNTIME_IDLE_GRACE_SECONDS,
    SUPERVISOR_LIFECYCLE_LOCK,
    _SUPERVISOR_LIFECYCLE_THREAD_LOCK,
    SUPERVISOR_ALWAYS_ON_ENV,
    _positive_generation,
    supervisor_state_dir,
    AdoptedCoordinatorProcess,
    _now,
    _json_write,
    _json_read,
    _is_pid_running,
    _process_start_identity,
    _process_matches,
    _pid_state,
    resolve_config_home,
    resolve_runtime_home,
    resolve_runtime_dir,
    _runtime_facade_value,
    _runtime_facade_seam,
)


def route_status(*args: Any, **kwargs: Any) -> dict[str, Any]:
    target = _runtime_facade_value("route_status", None)
    if target is None:
        raise RuntimeError("runtime supervisor owner is unavailable")
    return target(*args, **kwargs)


@_runtime_facade_seam("route_id")
def route_id(home: str, runtime_dir: str) -> str:
    digest = sha256(
        f"{resolve_runtime_home(home)}\0{resolve_runtime_dir(home, runtime_dir)}".encode(
            "utf-8"
        )
    ).hexdigest()
    return digest[:16]


@_runtime_facade_seam("route_record")
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


@_runtime_facade_seam("supervisor_lifecycle_lock_dir")
def supervisor_lifecycle_lock_dir(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "lifecycle-locks"


@_runtime_facade_seam("supervisor_lifecycle_guard")
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


@_runtime_facade_seam("state_dir")
def state_dir(runtime_dir: str) -> Path:
    return Path(runtime_dir).expanduser().resolve() / "coordinator"


@_runtime_facade_seam("legacy_state_dir")
def legacy_state_dir(runtime_dir: str) -> Path:
    return Path(runtime_dir).expanduser().resolve() / LEGACY_STATE_DIR_NAME


@_runtime_facade_seam("supervisor_pid_path")
def supervisor_pid_path(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "supervisor.pid"


@_runtime_facade_seam("coordinator_pid_path")
def coordinator_pid_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "coordinator.pid"


@_runtime_facade_seam("legacy_coordinator_pid_path")
def legacy_coordinator_pid_path(runtime_dir: str) -> Path:
    return legacy_state_dir(runtime_dir) / "master.pid"


@_runtime_facade_seam("state_path")
def state_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "state.json"


@_runtime_facade_seam("coordinator_continuity_path")
def coordinator_continuity_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "runtime-continuity.json"


@_runtime_facade_seam("allocate_coordinator_authority")
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


@_runtime_facade_seam("legacy_state_path")
def legacy_state_path(runtime_dir: str) -> Path:
    return legacy_state_dir(runtime_dir) / "state.json"


@_runtime_facade_seam("supervisor_state_path")
def supervisor_state_path(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "state.json"


@_runtime_facade_seam("routes_path")
def routes_path(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "routes.json"


@_runtime_facade_seam("coordinator_log_path")
def coordinator_log_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "coordinator.log"


@_runtime_facade_seam("assessment_subscription_path")
def assessment_subscription_path(runtime_dir: str) -> Path:
    return state_dir(runtime_dir) / "assessments.json"


@_runtime_facade_seam("read_pid")
def read_pid(path: Path) -> int | None:
    try:
        return int(path.read_text("utf-8").strip())
    except (OSError, ValueError):
        return None


@_runtime_facade_seam("read_coordinator_pid")
def read_coordinator_pid(runtime_dir: str) -> int | None:
    return read_pid(coordinator_pid_path(runtime_dir)) or read_pid(
        legacy_coordinator_pid_path(runtime_dir)
    )


@_runtime_facade_seam("unlink_coordinator_pid_files")
def unlink_coordinator_pid_files(runtime_dir: str) -> None:
    unlink_if_exists(coordinator_pid_path(runtime_dir))
    unlink_if_exists(legacy_coordinator_pid_path(runtime_dir))


@_runtime_facade_seam("write_pid")
def write_pid(path: Path, pid: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{pid}\n", "utf-8")


@_runtime_facade_seam("unlink_if_exists")
def unlink_if_exists(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


@_runtime_facade_seam("assessment_snapshot")
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


@_runtime_facade_seam("publish_assessment_snapshot")
def publish_assessment_snapshot(runtime_dir: str) -> dict[str, Any]:
    snapshot = assessment_snapshot(runtime_dir)
    _json_write(assessment_subscription_path(runtime_dir), snapshot)
    return snapshot


@_runtime_facade_seam("read_routes")
def read_routes(config_home: str | None = None) -> dict[str, Any]:
    payload = _json_read(routes_path(config_home))
    if not isinstance(payload.get("routes"), dict):
        return {"schema": SCHEMA_ROUTES, "routes": {}}
    schema = payload.get("schema")
    if schema == SCHEMA_ROUTES:
        return payload
    if schema != LEGACY_SCHEMA_ROUTES:
        return {"schema": SCHEMA_ROUTES, "routes": {}}
    for route in payload["routes"].values():
        if isinstance(route, dict) and "coordinatorPid" not in route:
            route["coordinatorPid"] = route.pop("masterPid", None)
    payload["schema"] = SCHEMA_ROUTES
    return payload


@_runtime_facade_seam("write_routes")
def write_routes(config_home: str | None, payload: dict[str, Any]) -> None:
    payload.setdefault("schema", SCHEMA_ROUTES)
    payload.setdefault("routes", {})
    payload["updatedAt"] = _now()
    _json_write(routes_path(config_home), payload)


@_runtime_facade_seam("_upsert_route_unlocked")
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


@_runtime_facade_seam("upsert_route")
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


@_runtime_facade_seam("_set_route_desired_unlocked")
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


@_runtime_facade_seam("set_route_desired")
def set_route_desired(
    config_home: str | None,
    home: str,
    runtime_dir: str,
    desired: bool,
) -> dict[str, Any]:
    with supervisor_lifecycle_guard(config_home, "route-desired"):
        return _set_route_desired_unlocked(config_home, home, runtime_dir, desired)


@_runtime_facade_seam("_restart_permitted")
def _restart_permitted(
    attempts: list[float],
    now: float,
    *,
    window_seconds: float = RESTART_WINDOW_SECONDS,
    max_attempts: int = RESTART_MAX_ATTEMPTS,
) -> bool:
    attempts[:] = [value for value in attempts if now - value < window_seconds]
    return len(attempts) < max_attempts


@_runtime_facade_seam("_runtime_idle_grace_ns")
def _runtime_idle_grace_ns() -> int:
    raw = os.environ.get(
        "KF_RUNTIME_IDLE_GRACE_SECONDS", str(RUNTIME_IDLE_GRACE_SECONDS)
    )
    try:
        seconds = max(float(raw), 0.0)
    except ValueError:
        seconds = RUNTIME_IDLE_GRACE_SECONDS
    return int(seconds * 1_000_000_000)


@_runtime_facade_seam("_runtime_demand_status")
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


@_runtime_facade_seam("_complete_runtime_drain")
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


@_runtime_facade_seam("_fence_runtime_restart")
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


@_runtime_facade_seam("_set_route_restart_status_unlocked")
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


@_runtime_facade_seam("_set_route_restart_status")
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


@_runtime_facade_seam("_fenced_adopted_coordinator")
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


@_runtime_facade_seam("_touch_route_heartbeat_unlocked")
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


@_runtime_facade_seam("touch_route_heartbeat")
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


@_runtime_facade_seam("_retire_idle_routes")
def _retire_idle_routes(
    config_home: str,
    *,
    has_children: bool,
    supervisor_pid: int,
    supervisor_start_identity: str | None,
) -> bool:
    """Atomically retire inactive routes when an on-demand supervisor can exit."""

    if has_children or os.environ.get(SUPERVISOR_ALWAYS_ON_ENV, "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
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


@_runtime_facade_seam("_finalize_supervisor_state")
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


@_runtime_facade_seam("_route_freshness")
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


@_runtime_facade_seam("_lifecycle_status")
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


@_runtime_facade_seam("repair_route_state")
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
