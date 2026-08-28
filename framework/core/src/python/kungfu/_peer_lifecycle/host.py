# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import hashlib
import math
import os
import platform
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Mapping

import psutil
from kungfu.coordination import locks as coordination_locks

from kungfu._peer_lifecycle.state import (
    _peer_facade_value,
    _peer_facade_seam,
    READY_SCHEMA,
    IDENTITY_REQUEST_SCHEMA,
    PROCESS_IDENTITY_TIMEOUT_SECONDS,
    PeerLifecycleError,
    _now,
    _read_json,
    _write_json,
    _process_identity,
    _process_matches,
    _terminate_matching,
    peer_dir,
    state_path,
    spec_path,
    ready_path,
    identity_request_path,
    log_path,
    _lock_root,
    load_spec,
    plan,
)


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

    key = "PROCESS_IDENTITY_TIMEOUT_SECONDS"
    minimum = float(_peer_facade_value(key, PROCESS_IDENTITY_TIMEOUT_SECONDS))
    value = os.environ.get("KF_PEER_READY_TIMEOUT_SECONDS")
    try:
        timeout = float(value) if value is not None else 0.0
    except ValueError:
        timeout = 0.0
    if not math.isfinite(timeout) or timeout <= 0:
        timeout = minimum
    return max(minimum, timeout)


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


@_peer_facade_seam("_is_process_or_descendant")
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


for _peer_name in (
    "_bound_peer_identity_from_environment",
    "_peer_identity_binding_timeout",
    "_ready_mismatch_fields",
    "_ready_matches",
    "_host_write_state",
    "_host_bind_state",
    "_spawn_peer",
    "_await_peer_identity_request",
    "_managed_peer_alive",
    "run_host",
    "_main",
):
    globals()[_peer_name] = _peer_facade_seam(_peer_name)(globals()[_peer_name])
del _peer_name
