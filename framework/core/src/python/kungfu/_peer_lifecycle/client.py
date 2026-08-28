# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Mapping

from kungfu.coordination import locks as coordination_locks

from kungfu._peer_lifecycle.state import (
    _peer_facade_value,
    _peer_facade_seam,
    STATE_SCHEMA,
    READY_SCHEMA,
    PeerLifecycleError,
    _now,
    _read_json,
    _write_json,
    _await_process_identity,
    _terminate_matching,
    peer_dir,
    state_path,
    spec_path,
    log_path,
    _lock_root,
    validate_spec,
    plan,
    _status_from_state,
    status,
)


def _bound_peer_identity_from_environment(pid: int) -> str | None:
    target = _peer_facade_value("_bound_peer_identity_from_environment", None)
    if target is None:
        raise PeerLifecycleError(
            "handshake-unavailable", "Peer host identity owner is unavailable"
        )
    return target(pid)


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


def _wait_for_ensure_status(
    runtime: str,
    peer_id: str,
    timeout: float,
    *,
    host_process: subprocess.Popen[Any] | None = None,
) -> dict[str, Any]:
    """Wait for a live host to finish its asynchronous readiness transition."""

    deadline = time.monotonic() + timeout
    while True:
        current = status(runtime, peer_id)
        if current["healthy"] or current["lifecycleState"] in {
            "crash-loop",
            "ended",
            "lost-control",
            "ownership-unknown",
        }:
            return current
        if host_process is not None and host_process.poll() is not None:
            return current
        if time.monotonic() >= deadline:
            return current
        time.sleep(0.1)


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
    return {
        **_wait_for_ensure_status(runtime, peer_id, readiness_wait, host_process=child),
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


for _peer_name in (
    "_host_command",
    "_product_entry_command",
    "_wait_for_ensure_status",
    "ensure",
    "stop",
    "restart",
    "declare_ready_from_environment",
):
    globals()[_peer_name] = _peer_facade_seam(_peer_name)(globals()[_peer_name])
del _peer_name
