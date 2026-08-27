# SPDX-License-Identifier: Apache-2.0

"""Fenced, per-Peer process lifecycle control.

The coordinator owns runtime semantics.  This module only owns process
placement for explicitly declared Peers; it is deliberately not a third
global daemon.  One small host process supervises one Peer declaration.
"""

from __future__ import annotations

import functools
import hashlib
import json
import os
import platform
import re
import sys
import time
from pathlib import Path
from typing import Any, Mapping

import psutil

from kungfu.coordination import locks as coordination_locks


def _peer_facade_value(name: str, fallback: Any) -> Any:
    facade = sys.modules.get("kungfu.peer_lifecycle")
    return getattr(facade, name, fallback) if facade is not None else fallback


def _peer_facade_call(name: str, fallback: Any, *args: Any, **kwargs: Any) -> Any:
    return _peer_facade_value(name, fallback)(*args, **kwargs)


def _peer_facade_seam(name: str):
    def peer_decorate(fallback):
        @functools.wraps(fallback)
        def peer_dispatch(*args: Any, **kwargs: Any) -> Any:
            candidate = _peer_facade_value(name, peer_dispatch)
            target = fallback if candidate is peer_dispatch else candidate
            return target(*args, **kwargs)

        return peer_dispatch

    return peer_decorate


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


_now = functools.partial(_peer_facade_call, "_now", time.time)


@_peer_facade_seam("_read_json")
def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


@_peer_facade_seam("_write_json")
def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    coordination_locks.write_json(path, value)


@_peer_facade_seam("_canonical_digest")
def _canonical_digest(value: Mapping[str, Any]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(payload).hexdigest()


@_peer_facade_seam("_process_identity")
def _process_identity(pid: int | None) -> str | None:
    if not isinstance(pid, int) or pid <= 0:
        return None
    if platform.system() == "Windows":
        return _windows_process_identity(pid)
    try:
        return format(psutil.Process(pid).create_time(), ".6f")
    except (psutil.Error, OSError, ValueError):
        return None


@_peer_facade_seam("_windows_process_identity")
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


@_peer_facade_seam("_process_matches")
def _process_matches(pid: int | None, identity: Any) -> bool:
    return (
        isinstance(identity, str)
        and bool(identity)
        and _process_identity(pid) == identity
    )


@_peer_facade_seam("_await_process_identity")
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


@_peer_facade_seam("_terminate_matching")
def _terminate_matching(pid: int | None, identity: Any, *, force: bool = False) -> bool:
    if pid is None or not _process_matches(pid, identity):
        return False
    try:
        process = psutil.Process(int(pid))
        process.kill() if force else process.terminate()
        return True
    except (psutil.Error, OSError, ValueError):
        return False


@_peer_facade_seam("peer_root")
def peer_root(runtime_dir: str | os.PathLike[str]) -> Path:
    return Path(runtime_dir).expanduser().resolve() / "peers"


@_peer_facade_seam("peer_dir")
def peer_dir(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    if not isinstance(peer_id, str) or not PEER_ID.fullmatch(peer_id):
        raise PeerLifecycleError("invalid-peer-id", "peerId has an invalid format")
    return peer_root(runtime_dir) / peer_id


@_peer_facade_seam("state_path")
def state_path(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "state.json"


@_peer_facade_seam("spec_path")
def spec_path(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "launch.json"


@_peer_facade_seam("ready_path")
def ready_path(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "ready.json"


@_peer_facade_seam("identity_request_path")
def identity_request_path(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "identity-request.json"


@_peer_facade_seam("log_path")
def log_path(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "peer.log"


@_peer_facade_seam("_lock_root")
def _lock_root(runtime_dir: str | os.PathLike[str], peer_id: str) -> Path:
    return peer_dir(runtime_dir, peer_id) / "locks"


@_peer_facade_seam("validate_spec")
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


@_peer_facade_seam("load_spec")
def load_spec(path: str | os.PathLike[str]) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PeerLifecycleError(
            "invalid-spec", f"cannot read Peer spec: {error}"
        ) from error
    return validate_spec(value)


@_peer_facade_seam("plan")
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


@_peer_facade_seam("_status_from_state")
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


@_peer_facade_seam("status")
def status(runtime_dir: str | os.PathLike[str], peer_id: str) -> dict[str, Any]:
    runtime = str(Path(runtime_dir).expanduser().resolve())
    return _status_from_state(
        runtime, peer_id, _read_json(state_path(runtime, peer_id))
    )


@_peer_facade_seam("list_status")
def list_status(runtime_dir: str | os.PathLike[str]) -> dict[str, Any]:
    root = peer_root(runtime_dir)
    items = []
    if root.is_dir():
        for item in sorted(root.iterdir()):
            if item.is_dir() and PEER_ID.fullmatch(item.name):
                items.append(status(runtime_dir, item.name))
    return {"schema": "kungfu.runtime.peer-lifecycle-list/v1", "items": items}
