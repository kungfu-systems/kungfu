# SPDX-License-Identifier: Apache-2.0

"""Fenced, per-Peer process lifecycle control.

The coordinator owns runtime semantics.  This module only owns process
placement for explicitly declared Peers; it is deliberately not a third
global daemon.  One small host process supervises one Peer declaration.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Mapping

import psutil

from kungfu.coordination import locks as coordination_locks


SPEC_SCHEMA = "kungfu.runtime.peer-lifecycle-spec/v1"
STATE_SCHEMA = "kungfu.runtime.peer-lifecycle-state/v1"
STATUS_SCHEMA = "kungfu.runtime.peer-lifecycle-status/v1"
PLAN_SCHEMA = "kungfu.runtime.peer-lifecycle-plan/v1"
READY_SCHEMA = "kungfu.runtime.peer-ready/v1"
IDENTITY_REQUEST_SCHEMA = "kungfu.runtime.peer-identity-request/v1"
RECOVERY_SCHEMA = "kungfu.runtime.peer-recovery/v1"
PEER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
HEARTBEAT_TTL_SECONDS = 5.0
DEFAULT_READY_TIMEOUT_SECONDS = 20.0
DEFAULT_RESTART_WINDOW_SECONDS = 60.0
DEFAULT_RESTART_MAX_ATTEMPTS = 5
PROCESS_IDENTITY_TIMEOUT_SECONDS = 2.0


class PeerLifecycleError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _now() -> float:
    return time.time()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", "utf-8")
    os.replace(temporary, path)


def _canonical_digest(value: Mapping[str, Any]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _process_identity(pid: int | None) -> str | None:
    if not isinstance(pid, int) or pid <= 0:
        return None
    if platform.system() == "Windows":
        return _windows_process_identity(pid)
    try:
        return format(psutil.Process(pid).create_time(), ".6f")
    except (psutil.Error, OSError, ValueError):
        return None


def _windows_process_identity(pid: int) -> str | None:
    """Read the exact kernel creation FILETIME instead of a derived timestamp."""

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    ]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        creation = wintypes.FILETIME()
        exit_time = wintypes.FILETIME()
        kernel_time = wintypes.FILETIME()
        user_time = wintypes.FILETIME()
        if not kernel32.GetProcessTimes(
            handle,
            ctypes.byref(creation),
            ctypes.byref(exit_time),
            ctypes.byref(kernel_time),
            ctypes.byref(user_time),
        ):
            return None
        exit_value = (exit_time.dwHighDateTime << 32) | exit_time.dwLowDateTime
        if exit_value != 0:
            return None
        value = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
        return f"filetime:{value}"
    finally:
        kernel32.CloseHandle(handle)


def _process_matches(pid: int | None, identity: Any) -> bool:
    return (
        isinstance(identity, str)
        and bool(identity)
        and _process_identity(pid) == identity
    )


def _await_process_identity(
    pid: int, timeout: float = PROCESS_IDENTITY_TIMEOUT_SECONDS
) -> str | None:
    """Wait for the OS process table to expose a newly spawned identity."""

    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        identity = _process_identity(pid)
        if identity is not None:
            return identity
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.02)


def _terminate_matching(pid: int | None, identity: Any, *, force: bool = False) -> bool:
    if pid is None or not _process_matches(pid, identity):
        return False
    try:
        process = psutil.Process(int(pid))
        process.kill() if force else process.terminate()
        return True
    except (psutil.Error, OSError, ValueError):
        return False


def peer_root(runtime_dir: str | os.PathLike[str]) -> Path:
    return Path(runtime_dir).expanduser().resolve() / "peers"


def peer_dir(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    if not isinstance(peer_id, str) or not PEER_ID.fullmatch(peer_id):
        raise PeerLifecycleError("invalid-peer-id", "peerId has an invalid format")
    return peer_root(runtime_dir) / peer_id


def state_path(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "state.json"


def spec_path(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "launch.json"


def ready_path(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "ready.json"


def identity_request_path(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "identity-request.json"


def log_path(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "peer.log"


def _lock_root(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "locks"


def validate_spec(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema") != SPEC_SCHEMA:
        raise PeerLifecycleError("invalid-spec", f"spec schema must be {SPEC_SCHEMA}")
    allowed = {"schema", "peerId", "command", "readiness", "recovery", "metadata"}
    unknown = set(value) - allowed
    if unknown:
        raise PeerLifecycleError(
            "invalid-spec",
            f"spec contains unknown fields: {', '.join(sorted(unknown))}",
        )
    peer_id = value.get("peerId")
    if not isinstance(peer_id, str) or not PEER_ID.fullmatch(peer_id):
        raise PeerLifecycleError("invalid-peer-id", "peerId has an invalid format")
    command = value.get("command")
    if not isinstance(command, dict) or set(command) - {"argv", "cwd"}:
        raise PeerLifecycleError("invalid-command", "command accepts only argv and cwd")
    argv = command.get("argv")
    if (
        not isinstance(argv, list)
        or not argv
        or not all(isinstance(item, str) and item for item in argv)
    ):
        raise PeerLifecycleError(
            "invalid-command", "command.argv must be non-empty strings"
        )
    cwd = command.get("cwd")
    if cwd is not None and (not isinstance(cwd, str) or not cwd):
        raise PeerLifecycleError(
            "invalid-command", "command.cwd must be a non-empty string"
        )
    readiness = value.get("readiness") or {}
    if not isinstance(readiness, dict) or set(readiness) - {"kind", "timeoutSeconds"}:
        raise PeerLifecycleError(
            "invalid-readiness", "readiness declaration is invalid"
        )
    if readiness.get("kind", "file-handshake") != "file-handshake":
        raise PeerLifecycleError(
            "invalid-readiness", "only file-handshake readiness is supported"
        )
    timeout = readiness.get("timeoutSeconds", DEFAULT_READY_TIMEOUT_SECONDS)
    if (
        not isinstance(timeout, (int, float))
        or isinstance(timeout, bool)
        or timeout <= 0
    ):
        raise PeerLifecycleError(
            "invalid-readiness", "readiness timeout must be positive"
        )
    recovery = value.get("recovery")
    if not isinstance(recovery, dict):
        raise PeerLifecycleError("invalid-recovery", "recovery declaration is required")
    recovery_allowed = {
        "schema",
        "processExit",
        "durableState",
        "maxRestarts",
        "windowSeconds",
        "guidance",
    }
    if set(recovery) - recovery_allowed or recovery.get("schema") != RECOVERY_SCHEMA:
        raise PeerLifecycleError("invalid-recovery", "recovery declaration is invalid")
    process_exit = recovery.get("processExit")
    if process_exit not in {"restart", "lost-control"}:
        raise PeerLifecycleError(
            "invalid-recovery", "recovery.processExit must be restart or lost-control"
        )
    durable_state = recovery.get("durableState")
    if durable_state not in {"declared", "none"}:
        raise PeerLifecycleError(
            "invalid-recovery", "recovery.durableState must be declared or none"
        )
    if process_exit == "restart" and durable_state != "declared":
        raise PeerLifecycleError(
            "unsafe-restart",
            "restart is forbidden without a declared durable recovery boundary",
        )
    max_restarts = recovery.get("maxRestarts", DEFAULT_RESTART_MAX_ATTEMPTS)
    window = recovery.get("windowSeconds", DEFAULT_RESTART_WINDOW_SECONDS)
    if (
        not isinstance(max_restarts, int)
        or isinstance(max_restarts, bool)
        or max_restarts < 0
    ):
        raise PeerLifecycleError(
            "invalid-recovery", "maxRestarts must be a non-negative integer"
        )
    if not isinstance(window, (int, float)) or isinstance(window, bool) or window <= 0:
        raise PeerLifecycleError("invalid-recovery", "windowSeconds must be positive")
    guidance = recovery.get("guidance")
    if not isinstance(guidance, str) or not guidance.strip():
        raise PeerLifecycleError("invalid-recovery", "recovery guidance is required")
    metadata = value.get("metadata") or {}
    if not isinstance(metadata, dict):
        raise PeerLifecycleError("invalid-spec", "metadata must be an object")
    return {
        "schema": SPEC_SCHEMA,
        "peerId": peer_id,
        "command": {"argv": list(argv), "cwd": cwd},
        "readiness": {"kind": "file-handshake", "timeoutSeconds": float(timeout)},
        "recovery": {
            "schema": RECOVERY_SCHEMA,
            "processExit": process_exit,
            "durableState": durable_state,
            "maxRestarts": max_restarts,
            "windowSeconds": float(window),
            "guidance": guidance.strip(),
        },
        "metadata": metadata,
    }


def load_spec(path: str | os.PathLike[str]) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PeerLifecycleError(
            "invalid-spec", f"cannot read Peer spec: {error}"
        ) from error
    return validate_spec(value)


def plan(
    spec: Mapping[str, Any], runtime_dir: str | os.PathLike[str]
) -> dict[str, Any]:
    normalized = validate_spec(dict(spec))
    plan_id = _canonical_digest(normalized)
    return {
        "schema": PLAN_SCHEMA,
        "planId": plan_id,
        "peerId": normalized["peerId"],
        "runtimeDir": str(Path(runtime_dir).expanduser().resolve()),
        "command": normalized["command"],
        "recovery": normalized["recovery"],
        "readiness": normalized["readiness"],
        "shell": False,
    }


def _status_from_state(
    runtime_dir: str, peer_id: str, state: dict[str, Any]
) -> dict[str, Any]:
    host_pid = state.get("hostPid")
    peer_pid = state.get("peerPid")
    host_alive = _process_identity(host_pid) is not None
    peer_alive = _process_identity(peer_pid) is not None
    host_verified = _process_matches(host_pid, state.get("hostStartIdentity"))
    peer_verified = _process_matches(peer_pid, state.get("peerStartIdentity"))
    heartbeat = state.get("heartbeatAt")
    heartbeat_fresh = (
        isinstance(heartbeat, (int, float))
        and _now() - heartbeat <= HEARTBEAT_TTL_SECONDS
    )
    lifecycle = str(state.get("lifecycleState") or "stopped")
    adoptable = False
    ownership_unknown = False
    if host_alive and not host_verified:
        lifecycle = "ownership-unknown"
        ownership_unknown = True
    elif not host_alive and peer_alive and peer_verified:
        lifecycle = "orphaned"
        adoptable = state.get("readinessState") == "ready"
    elif peer_alive and not peer_verified:
        lifecycle = "ownership-unknown"
        ownership_unknown = True
    elif host_verified and lifecycle == "ready" and not heartbeat_fresh:
        lifecycle = "degraded"
    healthy = (
        lifecycle == "ready"
        and host_verified
        and peer_verified
        and heartbeat_fresh
        and state.get("readinessState") == "ready"
    )
    return {
        "schema": STATUS_SCHEMA,
        "peerId": peer_id,
        "runtimeDir": str(Path(runtime_dir).expanduser().resolve()),
        "lifecycleState": lifecycle,
        "healthy": healthy,
        "registered": state.get("readinessState") == "ready",
        "ready": state.get("readinessState") == "ready" and peer_verified,
        "degraded": lifecycle == "degraded",
        "orphaned": lifecycle == "orphaned",
        "adoptable": adoptable,
        "ownershipUnknown": ownership_unknown,
        "crashLoop": lifecycle == "crash-loop",
        "ended": lifecycle == "ended",
        "lostControl": lifecycle == "lost-control",
        "desiredState": state.get("desiredState", "stopped"),
        "host": {
            "generation": state.get("hostGeneration"),
            "pid": host_pid,
            "startIdentity": state.get("hostStartIdentity"),
            "alive": host_alive,
            "identityVerified": host_verified,
            "heartbeatFresh": heartbeat_fresh,
        },
        "peer": {
            "generation": state.get("peerGeneration"),
            "ownerHostGeneration": state.get("peerOwnerHostGeneration"),
            "pid": peer_pid,
            "startIdentity": state.get("peerStartIdentity"),
            "alive": peer_alive,
            "identityVerified": peer_verified,
        },
        "recovery": state.get("recovery"),
        "restartAttempts": len(state.get("restartAttempts") or []),
        "lastExit": state.get("lastExit"),
        "error": state.get("error"),
        "readinessMismatches": state.get("readinessMismatches") or [],
        "statePath": str(state_path(runtime_dir, peer_id)),
        "logPath": str(log_path(runtime_dir, peer_id)),
    }


def status(runtime_dir: str | os.PathLike[str], peer_id: str) -> dict[str, Any]:
    runtime = str(Path(runtime_dir).expanduser().resolve())
    return _status_from_state(
        runtime, peer_id, _read_json(state_path(runtime, peer_id))
    )


def list_status(runtime_dir: str | os.PathLike[str]) -> dict[str, Any]:
    root = peer_root(runtime_dir)
    items = []
    if root.is_dir():
        for item in sorted(root.iterdir()):
            if item.is_dir() and PEER_ID.fullmatch(item.name):
                items.append(status(runtime_dir, item.name))
    return {"schema": "kungfu.runtime.peer-lifecycle-list/v1", "items": items}


def _host_command(
    runtime_dir: str, peer_id: str, generation: int, plan_id: str
) -> list[str]:
    from kungfu import host

    entry = (
        [sys.executable, "-m", "kungfu.peer_lifecycle"]
        if host.host_form() == host.FORM_SOURCE
        else _product_entry_command()
    )
    return [
        *entry,
        "host",
        "--runtime-dir",
        runtime_dir,
        "--peer-id",
        peer_id,
        "--host-generation",
        str(generation),
        "--expected-plan-id",
        plan_id,
    ]


def _product_entry_command() -> list[str]:
    from kungfu import runtime_service

    return [
        *runtime_service.entry_command(),
        "runtime",
        "peer-host",
    ]


def ensure(
    spec: Mapping[str, Any],
    runtime_dir: str | os.PathLike[str],
    *,
    expected_plan_id: str | None = None,
    wait_seconds: float | None = None,
) -> dict[str, Any]:
    runtime = str(Path(runtime_dir).expanduser().resolve())
    normalized = validate_spec(dict(spec))
    readiness_wait = (
        float(normalized["readiness"]["timeoutSeconds"])
        if wait_seconds is None
        else max(0.0, wait_seconds)
    )
    peer_id = normalized["peerId"]
    peer_plan = plan(normalized, runtime)
    if expected_plan_id is not None and expected_plan_id != peer_plan["planId"]:
        raise PeerLifecycleError(
            "plan-mismatch", "expected plan id does not match the spec"
        )
    directory = peer_dir(runtime, peer_id)
    directory.mkdir(parents=True, exist_ok=True)
    command: list[str] | None = None
    with coordination_locks.held(
        _lock_root(runtime, peer_id), "mutation", label="peer-ensure"
    ):
        current = _read_json(state_path(runtime, peer_id))
        current_status = _status_from_state(runtime, peer_id, current)
        if current_status["host"]["alive"]:
            if not current_status["host"]["identityVerified"]:
                raise PeerLifecycleError(
                    "ownership-unknown",
                    "recorded Peer host PID belongs to another process",
                )
            if current.get("planId") != peer_plan["planId"]:
                raise PeerLifecycleError(
                    "spec-conflict",
                    "running Peer host uses a different launch declaration",
                )
            return {**current_status, "changed": False, "adopted": False}
        if (
            current_status["peer"]["alive"]
            and not current_status["peer"]["identityVerified"]
        ):
            raise PeerLifecycleError(
                "ownership-unknown", "recorded Peer PID belongs to another process"
            )
        generation = int(current.get("hostGeneration") or 0) + 1
        _write_json(spec_path(runtime, peer_id), normalized)
        state = {
            **current,
            "schema": STATE_SCHEMA,
            "peerId": peer_id,
            "runtimeDir": runtime,
            "planId": peer_plan["planId"],
            "desiredState": "running",
            "lifecycleState": "starting",
            "hostGeneration": generation,
            "hostPid": None,
            "hostStartIdentity": None,
            "recovery": normalized["recovery"],
            "restartAttempts": current.get("restartAttempts") or [],
            "updatedAt": _now(),
            "error": None,
        }
        _write_json(state_path(runtime, peer_id), state)
        command = _host_command(runtime, peer_id, generation, peer_plan["planId"])
        with log_path(runtime, peer_id).open("ab") as log:
            kwargs: dict[str, Any] = {
                "stdin": subprocess.DEVNULL,
                "stdout": log,
                "stderr": log,
            }
            if platform.system() == "Windows":
                kwargs["creationflags"] = getattr(
                    subprocess, "DETACHED_PROCESS", 0x8
                ) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)
            else:
                kwargs["start_new_session"] = True
            child = subprocess.Popen(command, **kwargs)
        host_identity = _await_process_identity(child.pid)
        if host_identity is None:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            state.update(
                {
                    "lifecycleState": "ended",
                    "error": "Peer host process start identity was unavailable",
                    "updatedAt": _now(),
                }
            )
            _write_json(state_path(runtime, peer_id), state)
            raise PeerLifecycleError(
                "process-identity-unavailable",
                "Peer host process start identity was unavailable",
            )
    deadline = time.monotonic() + readiness_wait
    while time.monotonic() < deadline:
        current_status = status(runtime, peer_id)
        if current_status["healthy"] or current_status["lifecycleState"] in {
            "crash-loop",
            "lost-control",
            "ownership-unknown",
        }:
            break
        time.sleep(0.1)
    return {
        **status(runtime, peer_id),
        "changed": True,
        "adopted": False,
        "command": command,
    }


def stop(
    runtime_dir: str | os.PathLike[str],
    peer_id: str,
    *,
    expected_host_generation: int | None = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    runtime = str(Path(runtime_dir).expanduser().resolve())
    with coordination_locks.held(
        _lock_root(runtime, peer_id), "mutation", label="peer-stop"
    ):
        state = _read_json(state_path(runtime, peer_id))
        current = _status_from_state(runtime, peer_id, state)
        if (
            expected_host_generation is not None
            and state.get("hostGeneration") != expected_host_generation
        ):
            raise PeerLifecycleError(
                "stale-host-generation", "Peer host generation has advanced"
            )
        if current["ownershipUnknown"]:
            raise PeerLifecycleError(
                "ownership-unknown", "Peer ownership cannot be fenced"
            )
        state["desiredState"] = "stopped"
        state["updatedAt"] = _now()
        _write_json(state_path(runtime, peer_id), state)
        changed = False
        if current["host"]["identityVerified"]:
            # Desired state is the portable stop channel.  Windows process
            # termination has no catchable SIGTERM equivalent and would strand
            # the child Peer, so the host observes this state and performs the
            # fenced child shutdown itself on every platform.
            changed = True
        elif current["peer"]["identityVerified"]:
            changed = _terminate_matching(
                current["peer"]["pid"], current["peer"]["startIdentity"]
            )
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = status(runtime, peer_id)
        if not current["host"]["alive"] and not current["peer"]["alive"]:
            break
        time.sleep(0.1)
    return {**status(runtime, peer_id), "changed": changed}


def restart(
    spec: Mapping[str, Any],
    runtime_dir: str | os.PathLike[str],
    *,
    expected_host_generation: int | None = None,
) -> dict[str, Any]:
    normalized = validate_spec(dict(spec))
    stopped = stop(
        runtime_dir,
        normalized["peerId"],
        expected_host_generation=expected_host_generation,
    )
    started = ensure(normalized, runtime_dir)
    return {
        "schema": "kungfu.runtime.peer-lifecycle-restart/v1",
        "stop": stopped,
        "start": started,
    }


def declare_ready_from_environment(
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    path = os.environ.get("KF_PEER_READY_FILE")
    if not path:
        raise PeerLifecycleError(
            "handshake-unavailable", "KF_PEER_READY_FILE is not set"
        )
    pid = os.getpid()
    payload = {
        "schema": READY_SCHEMA,
        "peerId": os.environ.get("KF_PEER_ID"),
        "hostGeneration": int(os.environ["KF_PEER_HOST_GENERATION"]),
        "peerGeneration": int(os.environ["KF_PEER_GENERATION"]),
        "readyToken": os.environ.get("KF_PEER_READY_TOKEN"),
        "pid": pid,
        "processStartIdentity": _bound_peer_identity_from_environment(pid),
        "declaredAt": _now(),
        **dict(extra or {}),
    }
    _write_json(Path(path), payload)
    return payload


def _bound_peer_identity_from_environment(pid: int) -> str | None:
    """Use the host-issued kernel identity when a managed state is available."""

    state_dir = os.environ.get("KF_PEER_STATE_DIR")
    if not state_dir:
        return _process_identity(pid)
    expected = {
        "peerId": os.environ.get("KF_PEER_ID"),
        "peerOwnerHostGeneration": int(os.environ["KF_PEER_HOST_GENERATION"]),
        "peerGeneration": int(os.environ["KF_PEER_GENERATION"]),
        "readyToken": os.environ.get("KF_PEER_READY_TOKEN"),
        "peerPid": pid,
    }
    _write_json(
        Path(state_dir) / "identity-request.json",
        {
            "schema": IDENTITY_REQUEST_SCHEMA,
            "peerId": expected["peerId"],
            "hostGeneration": expected["peerOwnerHostGeneration"],
            "peerGeneration": expected["peerGeneration"],
            "readyToken": expected["readyToken"],
            "pid": pid,
            "requestedAt": _now(),
        },
    )
    deadline = time.monotonic() + _peer_identity_binding_timeout()
    managed_state = Path(state_dir) / "state.json"
    while True:
        state = _read_json(managed_state)
        if all(state.get(key) == value for key, value in expected.items()):
            identity = state.get("peerStartIdentity")
            if isinstance(identity, str) and identity:
                return identity
        if time.monotonic() >= deadline:
            raise PeerLifecycleError(
                "handshake-unavailable",
                "Peer host process identity binding was unavailable",
            )
        time.sleep(0.02)


def _peer_identity_binding_timeout() -> float:
    """Keep the host/Peer rendezvous inside the declared readiness window."""

    value = os.environ.get("KF_PEER_READY_TIMEOUT_SECONDS")
    try:
        timeout = float(value) if value is not None else 0.0
    except ValueError:
        timeout = 0.0
    if not math.isfinite(timeout) or timeout <= 0:
        timeout = PROCESS_IDENTITY_TIMEOUT_SECONDS
    return max(PROCESS_IDENTITY_TIMEOUT_SECONDS, timeout)


def _ready_mismatch_fields(
    state: Mapping[str, Any], ready: Mapping[str, Any]
) -> list[str]:
    bindings = {
        "schema": (READY_SCHEMA, ready.get("schema")),
        "peerId": (state.get("peerId"), ready.get("peerId")),
        "hostGeneration": (
            state.get("peerOwnerHostGeneration"),
            ready.get("hostGeneration"),
        ),
        "peerGeneration": (state.get("peerGeneration"), ready.get("peerGeneration")),
        "readyToken": (state.get("readyToken"), ready.get("readyToken")),
        "pid": (state.get("peerPid"), ready.get("pid")),
        "processStartIdentity": (
            state.get("peerStartIdentity"),
            ready.get("processStartIdentity"),
        ),
    }
    return [name for name, (expected, actual) in bindings.items() if expected != actual]


def _ready_matches(state: Mapping[str, Any], ready: Mapping[str, Any]) -> bool:
    return not _ready_mismatch_fields(state, ready)


def _host_write_state(
    runtime: str, peer_id: str, host_generation: int, state: dict[str, Any]
) -> bool:
    """Merge a host observation without overwriting a concurrent stop request."""

    with coordination_locks.held(
        _lock_root(runtime, peer_id), "mutation", label="peer-host-state"
    ):
        latest = _read_json(state_path(runtime, peer_id))
        if (
            latest.get("hostGeneration") != host_generation
            or latest.get("hostPid") != os.getpid()
        ):
            return False
        desired = latest.get("desiredState", "stopped")
        merged = {**latest, **state, "desiredState": desired}
        _write_json(state_path(runtime, peer_id), merged)
        state.clear()
        state.update(merged)
        return desired == "running"


def _host_bind_state(
    runtime: str, peer_id: str, host_generation: int, expected_plan_id: str
) -> dict[str, Any]:
    """Atomically bind an unclaimed host generation to the current process."""

    identity = _process_identity(os.getpid())
    if identity is None:
        return {}
    with coordination_locks.held(
        _lock_root(runtime, peer_id), "mutation", label="peer-host-bind"
    ):
        state = _read_json(state_path(runtime, peer_id))
        if (
            state.get("hostGeneration") != host_generation
            or state.get("planId") != expected_plan_id
            or state.get("desiredState") != "running"
        ):
            return {}
        recorded_pid = state.get("hostPid")
        recorded_identity = state.get("hostStartIdentity")
        if recorded_pid is not None or recorded_identity is not None:
            if recorded_pid != os.getpid() or recorded_identity != identity:
                return {}
        state.update(
            {
                "hostPid": os.getpid(),
                "hostStartIdentity": identity,
                "heartbeatAt": _now(),
                "updatedAt": _now(),
            }
        )
        _write_json(state_path(runtime, peer_id), state)
        return state


def _spawn_peer(
    spec: Mapping[str, Any], state: dict[str, Any]
) -> tuple[psutil.Process | subprocess.Popen[Any], float]:
    peer_id = str(state["peerId"])
    runtime = str(state["runtimeDir"])
    generation = int(state.get("peerGeneration") or 0) + 1
    token = hashlib.sha256(os.urandom(32)).hexdigest()
    readiness_deadline = time.monotonic() + float(spec["readiness"]["timeoutSeconds"])
    environment = {
        **os.environ,
        "KF_RUNTIME_DIR": runtime,
        "KF_PEER_ID": peer_id,
        "KF_PEER_HOST_GENERATION": str(state["hostGeneration"]),
        "KF_PEER_GENERATION": str(generation),
        "KF_PEER_READY_FILE": str(ready_path(runtime, peer_id)),
        "KF_PEER_READY_TOKEN": token,
        "KF_PEER_STATE_DIR": str(peer_dir(runtime, peer_id)),
        "KF_PEER_READY_TIMEOUT_SECONDS": str(spec["readiness"]["timeoutSeconds"]),
    }
    try:
        ready_path(runtime, peer_id).unlink()
    except FileNotFoundError:
        pass
    try:
        identity_request_path(runtime, peer_id).unlink()
    except FileNotFoundError:
        pass
    with log_path(runtime, peer_id).open("ab") as log:
        child = subprocess.Popen(
            list(spec["command"]["argv"]),
            cwd=spec["command"].get("cwd") or None,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            shell=False,
        )
    bound = _await_peer_identity_request(
        child,
        runtime,
        peer_id,
        int(state["hostGeneration"]),
        generation,
        token,
        max(0.0, readiness_deadline - time.monotonic()),
    )
    if bound is None:
        request = _read_json(identity_request_path(runtime, peer_id))
        requested_pid = request.get("pid")
        requested_identity = (
            _process_identity(requested_pid)
            if isinstance(requested_pid, int)
            and _is_process_or_descendant(child.pid, requested_pid)
            else None
        )
        if requested_identity is not None and isinstance(requested_pid, int):
            _terminate_matching(requested_pid, requested_identity, force=True)
        if child.poll() is None:
            child.kill()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        raise PeerLifecycleError(
            "process-identity-unavailable",
            "Peer did not present a host-verifiable process identity",
        )
    peer_pid, peer_identity = bound
    state.update(
        {
            "peerGeneration": generation,
            "peerOwnerHostGeneration": state["hostGeneration"],
            "peerPid": peer_pid,
            "peerStartIdentity": peer_identity,
            "readyToken": token,
            "readinessState": "registering",
            "lifecycleState": "registering",
            "readinessMismatches": [],
            "updatedAt": _now(),
        }
    )
    _host_write_state(runtime, peer_id, int(state["hostGeneration"]), state)
    peer = child if peer_pid == child.pid else psutil.Process(peer_pid)
    return peer, readiness_deadline


def _await_peer_identity_request(
    child: subprocess.Popen[Any],
    runtime_dir: str,
    peer_id: str,
    host_generation: int,
    peer_generation: int,
    ready_token: str,
    timeout: float,
) -> tuple[int, str] | None:
    """Bind the kernel identity of the actual launched process.

    Windows virtual-environment launchers may wait on a child interpreter, so
    ``Popen.pid`` is not always the PID seen by Python inside the Peer.  The
    request is fenced by the launch token and must name the launched process or
    one of its descendants before the host signs its kernel start identity.
    """

    deadline = time.monotonic() + max(0.0, timeout)
    expected = {
        "schema": IDENTITY_REQUEST_SCHEMA,
        "peerId": peer_id,
        "hostGeneration": host_generation,
        "peerGeneration": peer_generation,
        "readyToken": ready_token,
    }
    request_file = identity_request_path(runtime_dir, peer_id)
    while True:
        request = _read_json(request_file)
        requested_pid = request.get("pid")
        if (
            all(request.get(key) == value for key, value in expected.items())
            and isinstance(requested_pid, int)
            and requested_pid > 0
            and _is_process_or_descendant(child.pid, requested_pid)
        ):
            identity = _process_identity(requested_pid)
            if identity is not None:
                return requested_pid, identity
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.02)


def _is_process_or_descendant(parent_pid: int, candidate_pid: int) -> bool:
    if candidate_pid == parent_pid:
        return True
    try:
        process = psutil.Process(candidate_pid)
        for _ in range(64):
            process = process.parent()
            if process is None:
                return False
            if process.pid == parent_pid:
                return True
    except (psutil.Error, OSError, ValueError):
        return False
    return False


def _managed_peer_alive(
    peer: psutil.Process | subprocess.Popen[Any] | None,
    state: Mapping[str, Any],
) -> bool:
    if peer is None:
        return False
    if isinstance(peer, subprocess.Popen) and peer.poll() is not None:
        return False
    if isinstance(peer, psutil.Process):
        try:
            if not peer.is_running() or peer.status() == psutil.STATUS_ZOMBIE:
                return False
        except (psutil.Error, OSError):
            return False
    return _process_matches(state.get("peerPid"), state.get("peerStartIdentity"))


def run_host(
    runtime_dir: str, peer_id: str, host_generation: int, expected_plan_id: str
) -> int:
    runtime = str(Path(runtime_dir).expanduser().resolve())
    state_file = state_path(runtime, peer_id)
    spec = load_spec(spec_path(runtime, peer_id))
    stopping = False

    def request_stop(_signum: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    if platform.system() != "Windows":
        signal.signal(signal.SIGINT, request_stop)

    if plan(spec, runtime)["planId"] != expected_plan_id:
        return 2
    state = _host_bind_state(runtime, peer_id, host_generation, expected_plan_id)
    if not state:
        return 2

    peer: psutil.Process | subprocess.Popen[Any] | None = None
    adopted = False
    ready = _read_json(ready_path(runtime, peer_id))
    if _process_matches(state.get("peerPid"), state.get("peerStartIdentity")):
        if not _ready_matches(state, ready):
            state.update(
                {
                    "lifecycleState": "ownership-unknown",
                    "error": "live Peer lacks a matching readiness fence",
                    "updatedAt": _now(),
                }
            )
            _host_write_state(runtime, peer_id, host_generation, state)
            return 3
        peer = psutil.Process(int(state["peerPid"]))
        adopted = True
        state.update(
            {
                "lifecycleState": "ready",
                "readinessState": "ready",
                "adoptedAt": _now(),
                "adoptedByHostGeneration": host_generation,
                "error": None,
            }
        )

    while not stopping:
        state = _read_json(state_file)
        if (
            state.get("hostGeneration") != host_generation
            or state.get("hostPid") != os.getpid()
            or state.get("desiredState") != "running"
        ):
            stopping = True
            break
        peer_alive = _managed_peer_alive(peer, state)
        if peer is None or not peer_alive:
            if peer is not None:
                exit_code = peer.poll() if isinstance(peer, subprocess.Popen) else None
                state["lastExit"] = {"code": exit_code, "observedAt": _now()}
                recovery = spec["recovery"]
                if recovery["processExit"] == "lost-control":
                    state.update(
                        {
                            "lifecycleState": "lost-control",
                            "readinessState": "ended",
                            "error": recovery["guidance"],
                            "updatedAt": _now(),
                        }
                    )
                    if not _host_write_state(runtime, peer_id, host_generation, state):
                        stopping = True
                    while not stopping:
                        latest = _read_json(state_file)
                        if (
                            latest.get("hostGeneration") != host_generation
                            or latest.get("hostPid") != os.getpid()
                            or latest.get("desiredState") != "running"
                        ):
                            stopping = True
                            break
                        time.sleep(0.2)
                    break
                cutoff = _now() - float(recovery["windowSeconds"])
                attempts = [
                    float(item)
                    for item in state.get("restartAttempts") or []
                    if float(item) >= cutoff
                ]
                attempts.append(_now())
                state["restartAttempts"] = attempts
                if len(attempts) > int(recovery["maxRestarts"]):
                    state.update(
                        {
                            "lifecycleState": "crash-loop",
                            "readinessState": "ended",
                            "error": "bounded Peer restart budget exhausted",
                            "updatedAt": _now(),
                        }
                    )
                    if not _host_write_state(runtime, peer_id, host_generation, state):
                        stopping = True
                    while not stopping:
                        latest = _read_json(state_file)
                        if (
                            latest.get("hostGeneration") != host_generation
                            or latest.get("hostPid") != os.getpid()
                            or latest.get("desiredState") != "running"
                        ):
                            stopping = True
                            break
                        time.sleep(0.2)
                    break
            peer, deadline = _spawn_peer(spec, state)
            adopted = False
            while time.monotonic() < deadline and not stopping:
                state = _read_json(state_file)
                if state.get("desiredState") != "running":
                    stopping = True
                    break
                if not _process_matches(
                    state.get("peerPid"), state.get("peerStartIdentity")
                ):
                    break
                ready = _read_json(ready_path(runtime, peer_id))
                if _ready_matches(state, ready):
                    state.update(
                        {
                            "lifecycleState": "ready",
                            "readinessState": "ready",
                            "readyAt": _now(),
                            "error": None,
                            "readinessMismatches": [],
                        }
                    )
                    break
                time.sleep(0.1)
            else:
                if not stopping:
                    _terminate_matching(
                        state.get("peerPid"), state.get("peerStartIdentity")
                    )
                    mismatch_fields = _ready_mismatch_fields(state, ready)
                    mismatches = ", ".join(mismatch_fields)
                    state["readinessMismatches"] = mismatch_fields
                    state["error"] = "Peer readiness handshake timed out"
                    if mismatches:
                        state["error"] += f"; mismatched bindings: {mismatches}"
            if not _host_write_state(runtime, peer_id, host_generation, state):
                stopping = True
                break
        state["heartbeatAt"] = _now()
        state["lifecycleState"] = (
            "ready"
            if state.get("readinessState") == "ready"
            else state.get("lifecycleState", "degraded")
        )
        state["adopted"] = adopted
        state["updatedAt"] = _now()
        if not _host_write_state(runtime, peer_id, host_generation, state):
            stopping = True
            break
        time.sleep(0.2)

    state = _read_json(state_file)
    if (
        state.get("hostGeneration") == host_generation
        and state.get("hostPid") == os.getpid()
    ):
        _terminate_matching(state.get("peerPid"), state.get("peerStartIdentity"))
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and _process_matches(
            state.get("peerPid"), state.get("peerStartIdentity")
        ):
            time.sleep(0.05)
        if _process_matches(state.get("peerPid"), state.get("peerStartIdentity")):
            _terminate_matching(
                state.get("peerPid"), state.get("peerStartIdentity"), force=True
            )
        state.update(
            {
                "lifecycleState": "ended",
                "readinessState": "ended",
                "hostPid": None,
                "hostStartIdentity": None,
                "peerPid": None,
                "peerStartIdentity": None,
                "endedAt": _now(),
                "updatedAt": _now(),
            }
        )
        _host_write_state(runtime, peer_id, host_generation, state)
    return 0


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    host_parser = subparsers.add_parser("host")
    host_parser.add_argument("--runtime-dir", required=True)
    host_parser.add_argument("--peer-id", required=True)
    host_parser.add_argument("--host-generation", type=int, required=True)
    host_parser.add_argument("--expected-plan-id", required=True)
    args = parser.parse_args(argv)
    return run_host(
        args.runtime_dir,
        args.peer_id,
        args.host_generation,
        args.expected_plan_id,
    )


if __name__ == "__main__":
    raise SystemExit(_main())
