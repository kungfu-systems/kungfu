# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
import platform
import signal
import subprocess
import time
from typing import Any, Mapping

from kungfu import runtime_service_config, runtime_state
from kungfu.execution_surface import authority as runtime_surface_authority

from kungfu._runtime_service.common import (
    SCHEMA_STATUS,
    RESTART_WINDOW_SECONDS,
    ServicePlan,
    supervisor_state_dir,
    supervisor_log_path,
    command_env_for_owner as command_env,
    coordinator_run_command,
    supervisor_command,
    CoordinatorProcess,
    _terminate_and_reap_child,
    _now,
    _json_write,
    _json_read,
    _is_pid_running,
    _process_start_identity,
    _process_matches,
    _terminate_process_if_matches,
    _terminate_process_tree_if_matches,
    resolve_config_home,
    resolve_runtime_home,
    resolve_runtime_dir,
    _runtime_facade_seam,
)
from kungfu._runtime_service.state import (
    route_record,
    supervisor_lifecycle_guard,
    state_dir,
    supervisor_pid_path,
    coordinator_pid_path,
    state_path,
    allocate_coordinator_authority,
    legacy_state_path,
    supervisor_state_path,
    routes_path,
    coordinator_log_path,
    read_pid,
    read_coordinator_pid,
    unlink_coordinator_pid_files,
    write_pid,
    read_routes,
    upsert_route,
    _upsert_route_unlocked,
    set_route_desired,
    _restart_permitted,
    _runtime_idle_grace_ns,
    _runtime_demand_status,
    _complete_runtime_drain,
    _fence_runtime_restart,
    _set_route_restart_status,
    _fenced_adopted_coordinator,
    touch_route_heartbeat,
    _retire_idle_routes,
    _finalize_supervisor_state,
    _route_freshness,
    _lifecycle_status,
    repair_route_state,
)
from kungfu._runtime_service.engine import (
    CoordinatorEngine as CoordinatorEngine_fallback,
    ProcessAssessmentExecutor,
)


CoordinatorEngine = _runtime_facade_seam("CoordinatorEngine")(
    CoordinatorEngine_fallback
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


@_runtime_facade_seam("run_coordinator")
def run_coordinator(home: str, runtime_dir: str, low_latency: bool = False) -> int:
    return ProcessRuntimeHost().run_foreground(home, runtime_dir, low_latency)


@_runtime_facade_seam("status")
def status(home: str, runtime_dir: str) -> dict[str, Any]:
    return route_status(home, runtime_dir)


@_runtime_facade_seam("route_status")
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


@_runtime_facade_seam("run_supervisor")
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


@_runtime_facade_seam("ensure_coordinator")
def ensure_coordinator(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    return ProcessRuntimeHost(log_level, config_home).activate(home, runtime_dir)


@_runtime_facade_seam("_wait_for_coordinator")
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


@_runtime_facade_seam("stop_supervisor")
def stop_supervisor(
    config_home: str | None = None, timeout: float = 10.0
) -> dict[str, Any]:
    return ProcessRuntimeHost(config_home=config_home).stop_supervisor(timeout)


@_runtime_facade_seam("supervisor_status")
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


@_runtime_facade_seam("service_plan")
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


@_runtime_facade_seam("install_service")
def install_service(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    return runtime_service_config.install_service(
        service_plan(home, runtime_dir, log_level, config_home)
    )


@_runtime_facade_seam("uninstall_service")
def uninstall_service(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    return runtime_service_config.uninstall_service(
        service_plan(home, runtime_dir, log_level, config_home)
    )


@_runtime_facade_seam("service_status")
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
