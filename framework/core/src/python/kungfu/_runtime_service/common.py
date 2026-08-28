# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import functools
import json
import os
import platform
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import kungfu
import psutil
from kungfu import runtime_paths, runtime_service_config
from kungfu import runtime_processes as _runtime_processes


def _runtime_facade_value(name: str, fallback: Any) -> Any:
    facade = sys.modules.get("kungfu.runtime_service")
    return getattr(facade, name, fallback) if facade is not None else fallback


def _runtime_facade_call(name: str, fallback: Any, *args: Any, **kwargs: Any) -> Any:
    return _runtime_facade_value(name, fallback)(*args, **kwargs)


def _runtime_facade_seam(name: str):
    def runtime_decorate(fallback):
        @functools.wraps(fallback)
        def runtime_dispatch(*args: Any, **kwargs: Any) -> Any:
            candidate = _runtime_facade_value(name, runtime_dispatch)
            target = fallback if candidate is runtime_dispatch else candidate
            return target(*args, **kwargs)

        return runtime_dispatch

    return runtime_decorate


lf = kungfu.__binding__.yijinjing
yjj: Any = kungfu.__binding__.runtime

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
command_env_for_owner = _runtime_facade_seam("command_env")(command_env)
coordinator_run_command = runtime_service_config.coordinator_run_command
assessment_worker_command = runtime_service_config.assessment_worker_command
assessment_worker_command_for_owner = _runtime_facade_seam("assessment_worker_command")(
    assessment_worker_command
)
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


class CoordinatorProcess(Protocol):
    pid: int

    def poll(self) -> int | None: ...

    def terminate(self) -> None: ...

    def wait(self, timeout: float | None = None) -> int: ...

    def kill(self) -> None: ...


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


@_runtime_facade_seam("_terminate_and_reap_child")
def _terminate_and_reap_child(
    process_host: "ProcessRuntimeHost",  # type: ignore[name-defined]  # noqa: F821
    child: CoordinatorProcess,
    timeout: float = 5.0,
) -> None:
    """Stop a coordinator tree and wait until its OS resources are released."""

    descendants: list[psutil.Process] = []
    try:
        descendants = psutil.Process(child.pid).children(recursive=True)
    except (psutil.Error, OSError, ValueError, AttributeError):
        pass

    for process in reversed(descendants):
        try:
            process.terminate()
        except (psutil.Error, OSError, ValueError):
            pass

    process_host.terminate_child(child)
    try:
        child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=timeout)

    if descendants:
        _, alive = psutil.wait_procs(descendants, timeout=timeout)
        for process in alive:
            try:
                process.kill()
            except (psutil.Error, OSError, ValueError):
                pass
        if alive:
            psutil.wait_procs(alive, timeout=timeout)


_now = functools.partial(_runtime_facade_call, "_now", time.time)


@_runtime_facade_seam("_json_write")
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


@_runtime_facade_seam("_json_read")
def _json_read(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


@_runtime_facade_seam("_is_pid_running")
def _is_pid_running(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        return psutil.pid_exists(pid)
    except (psutil.Error, OSError, ValueError):
        return False


@_runtime_facade_seam("_process_start_identity")
def _process_start_identity(pid: int | None) -> str | None:
    """Return a portable PID-reuse fence, or None when identity is unknowable."""

    if not pid or pid <= 0:
        return None
    try:
        return format(psutil.Process(pid).create_time(), ".6f")
    except (psutil.Error, OSError, ValueError):
        return None


@_runtime_facade_seam("_process_matches")
def _process_matches(pid: int | None, start_identity: Any) -> bool:
    if not isinstance(start_identity, str) or not start_identity:
        return False
    return _is_pid_running(pid) and _process_start_identity(pid) == start_identity


_terminate_process_if_matches = _runtime_facade_seam("_terminate_process_if_matches")(
    _runtime_processes._terminate_process_if_matches
)
_terminate_process_tree_if_matches = _runtime_facade_seam(
    "_terminate_process_tree_if_matches"
)(_runtime_processes._terminate_process_tree_if_matches)


@_runtime_facade_seam("_pid_state")
def _pid_state(pid: int | None) -> str:
    if not pid or pid <= 0:
        return "missing"
    return "running" if _is_pid_running(pid) else "dead"


_canonical_path = runtime_paths.canonical_path
resolve_config_home = runtime_paths.resolve_config_home
resolve_runtime_home = runtime_paths.resolve_runtime_home
resolve_runtime_dir = runtime_paths.resolve_runtime_dir
