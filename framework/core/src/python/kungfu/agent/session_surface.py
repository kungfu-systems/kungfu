# SPDX-License-Identifier: Apache-2.0

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import socket
import sys
import time
from typing import Protocol

from kungfu.agent.session_contract import semantic_root
from kungfu.workspace import WorkspaceTargetRequired, resolve_workspace_target


MAX_MESSAGE_BYTES = 1024 * 1024
_READ_CHUNK_BYTES = 65536


def _deadline(timeout):
    if timeout <= 0:
        raise ValueError("Agent Session timeout must be positive")
    return time.monotonic() + timeout


def _remaining_milliseconds(deadline, operation):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError(f"Agent Session {operation} timed out")
    return max(1, math.ceil(remaining * 1000))


def _encode_request(request):
    payload = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(payload) > MAX_MESSAGE_BYTES:
        raise ValueError("Agent Session request exceeds 1 MiB")
    return payload


def _decode_response(response):
    decoded = json.loads(bytes(response).split(b"\n", 1)[0])
    if not isinstance(decoded, dict):
        raise ValueError("Agent Session response must be a JSON object")
    return decoded


def _append_response(response, chunk):
    if not chunk:
        raise ValueError("Agent Session surface closed without a response")
    response.extend(chunk)
    if len(response) > MAX_MESSAGE_BYTES:
        raise ValueError("Agent Session response exceeds 1 MiB")


def _invoke_unix_socket(target, payload, timeout):
    if not hasattr(socket, "AF_UNIX"):
        raise ValueError("Agent Session Unix socket transport is unavailable")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(target)
        client.sendall(payload)
        response = bytearray()
        while b"\n" not in response:
            _append_response(response, client.recv(_READ_CHUNK_BYTES))
    return response


def _open_named_pipe(target, deadline, api):
    retryable = {api.ERROR_PIPE_BUSY, api.ERROR_SEM_TIMEOUT}
    while True:
        wait_ms = _remaining_milliseconds(deadline, "named-pipe connect")
        try:
            api.WaitNamedPipe(target, wait_ms)
            return api.CreateFile(
                target,
                api.GENERIC_READ | api.GENERIC_WRITE,
                0,
                api.NULL,
                api.OPEN_EXISTING,
                api.FILE_FLAG_OVERLAPPED,
                api.NULL,
            )
        except OSError as error:
            if getattr(error, "winerror", None) not in retryable:
                raise
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    "Agent Session named-pipe connect timed out"
                ) from error


def _complete_overlapped(api, overlapped, error, deadline, operation):
    if error == api.ERROR_IO_PENDING:
        wait_ms = _remaining_milliseconds(deadline, operation)
        wait_result = api.WaitForMultipleObjects([overlapped.event], False, wait_ms)
        if wait_result == api.WAIT_TIMEOUT:
            overlapped.cancel()
            try:
                overlapped.GetOverlappedResult(True)
            except OSError:
                pass
            raise TimeoutError(f"Agent Session {operation} timed out")
        if wait_result != api.WAIT_OBJECT_0:
            overlapped.cancel()
            raise OSError(
                f"Agent Session {operation} wait failed with status {wait_result}"
            )
    transferred, completion_error = overlapped.GetOverlappedResult(True)
    return transferred, completion_error


def _write_named_pipe(api, handle, payload, deadline):
    overlapped, error = api.WriteFile(handle, payload, overlapped=True)
    transferred, completion_error = _complete_overlapped(
        api, overlapped, error, deadline, "named-pipe write"
    )
    if completion_error:
        message = (
            "Agent Session named-pipe write failed with Windows error "
            f"{completion_error}"
        )
        raise OSError(completion_error, message)
    if transferred != len(payload):
        raise OSError("Agent Session named-pipe write was incomplete")


def _read_named_pipe(api, handle, deadline):
    response = bytearray()
    while b"\n" not in response:
        try:
            overlapped, error = api.ReadFile(handle, _READ_CHUNK_BYTES, overlapped=True)
            transferred, completion_error = _complete_overlapped(
                api, overlapped, error, deadline, "named-pipe read"
            )
        except OSError as raised:
            if getattr(raised, "winerror", None) == api.ERROR_BROKEN_PIPE:
                raise ValueError(
                    "Agent Session surface closed without a response"
                ) from raised
            raise
        if completion_error not in (0, api.ERROR_MORE_DATA):
            if completion_error == api.ERROR_BROKEN_PIPE:
                raise ValueError("Agent Session surface closed without a response")
            raise OSError(
                completion_error,
                "Agent Session named-pipe read failed with Windows error "
                f"{completion_error}",
            )
        _append_response(response, bytes(overlapped.getbuffer())[:transferred])
    return response


def _invoke_windows_named_pipe(target, payload, timeout):
    import _winapi as api

    deadline = _deadline(timeout)
    handle = _open_named_pipe(target, deadline, api)
    try:
        _write_named_pipe(api, handle, payload, deadline)
        return _read_named_pipe(api, handle, deadline)
    finally:
        getattr(api, "CloseHandle")(handle)


def _invoke_transport(request, endpoint, timeout):
    payload = _encode_request(request)
    if sys.platform == "win32":
        response = _invoke_windows_named_pipe(endpoint, payload, timeout)
    else:
        response = _invoke_unix_socket(endpoint, payload, timeout)
    return _decode_response(response)


def effective_work_ref(envelope):
    effective = envelope.get("workRef")
    try:
        status = invoke(
            {
                "operation": "show",
                "session": {
                    "workConsoleId": envelope["consoleId"],
                    "sessionAttemptId": envelope["attemptId"],
                },
            }
        )
        binding = status.get("binding") or {}
        if binding.get("kind") == "work":
            effective = binding.get("workRef")
    except (OSError, ValueError):
        pass
    return effective


class ReturnCodeResult(Protocol):
    returncode: int


def native_heartbeat_observation(binding, work_observer=None):
    """Return bounded attempt liveness without reading authoritative Work."""

    work_ref = binding.get("workRef") if binding.get("kind") == "work" else None
    return {
        "schema": "kungfu.attempt-heartbeat/v1",
        "state": "fresh",
        "workRefRoot": semantic_root(work_ref) if work_ref else None,
        "diagnostic": None,
    }


def endpoint_for_runtime(runtime_dir):
    """Return the endpoint used by the detached Agent Session host."""

    directory = str((Path(runtime_dir).expanduser().resolve() / "agent-session"))
    scope = hashlib.sha256(directory.encode("utf-8")).hexdigest()[:16]
    if sys.platform == "win32":
        return rf"\\.\pipe\kungfu-agent-session-{scope}"
    socket_root = Path("/tmp") / f"kungfu-agent-session-{os.getuid()}"
    return str(socket_root / f"{scope}.sock")


def invoke_for_project(request, *, fallback_runtime_dir, endpoint=None, cwd=None):
    """Invoke the project surface and revive its detached host when needed."""

    environment_endpoint = os.environ.get("KUNGFU_AGENT_SESSION_ENDPOINT")
    endpoint_is_explicit = endpoint is not None or environment_endpoint is not None
    resolved_endpoint = endpoint or environment_endpoint
    runtime_dir = None
    if not resolved_endpoint:
        try:
            runtime_dir = str(
                resolve_workspace_target(
                    "read-only", cwd=cwd or os.getcwd()
                ).runtime_dir
            )
        except WorkspaceTargetRequired:
            runtime_dir = str(fallback_runtime_dir)
        resolved_endpoint = endpoint_for_runtime(runtime_dir)
    try:
        return invoke(request, endpoint=resolved_endpoint)
    except OSError:
        if endpoint_is_explicit:
            raise
        resolved_endpoint = ensure(runtime_dir or str(fallback_runtime_dir))
        return invoke(request, endpoint=resolved_endpoint)


def _resolve_native_entry():
    override = os.environ.get("KUNGFU_NATIVE_AGENT_SESSION_ENTRY")
    if override and os.path.exists(override):
        return os.path.abspath(override)

    import kungfu

    binding_dir = Path(kungfu.__binding__.__file__).resolve().parent
    candidates = [
        binding_dir.parent / "tui" / "native-agent-session.mjs",
        binding_dir / "native-agent-session.mjs",
        Path(__file__).resolve().parents[5]
        / "agent-session"
        / "src"
        / "native-interactive-client.mjs",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())
    return None


def _resolve_worker_executable():
    override = os.environ.get("KUNGFU_AGENT_SESSION_EXECUTABLE")
    candidates = [override, sys.argv[0], shutil.which("kungfu")]
    for candidate in candidates:
        if not candidate:
            continue
        resolved = Path(candidate).expanduser().resolve()
        if resolved.is_file() and os.access(resolved, os.X_OK):
            return str(resolved)
    raise ValueError(
        "native Agent Session worker requires an executable Kungfu front door; "
        "set KUNGFU_AGENT_SESSION_EXECUTABLE"
    )


def ensure(runtime_dir, *, runner=None):
    """Ensure and return the runtime-scoped detached Agent Session endpoint."""

    endpoint = endpoint_for_runtime(runtime_dir)
    os.environ["KUNGFU_AGENT_SESSION_ENDPOINT"] = endpoint
    try:
        invoke({"operation": "capabilities"}, endpoint=endpoint, timeout=0.25)
        return endpoint
    except (OSError, ValueError, socket.timeout):
        pass

    entry = _resolve_native_entry()
    if entry is None:
        raise ValueError(
            "native Agent Session bridge is unavailable; build the Kungfu TUI "
            "bundle or set KUNGFU_NATIVE_AGENT_SESSION_ENTRY"
        )
    os.environ["KF_RUNTIME_DIR"] = str(Path(runtime_dir).expanduser().resolve())
    os.environ["KUNGFU_AGENT_SESSION_EXECUTABLE"] = _resolve_worker_executable()
    if runner is None:
        import kungfu

        runner = kungfu.__binding__.libnode.run
    exit_code = runner(sys.argv[0], entry)
    if exit_code not in (None, 0):
        raise ValueError(
            f"native Agent Session bridge exited with status {int(exit_code)}"
        )
    invoke({"operation": "capabilities"}, endpoint=endpoint, timeout=5.0)
    return endpoint


def invoke(request, endpoint=None, timeout=5.0):
    """Invoke the runtime-scoped Agent Session surface without a second API."""
    target = endpoint or os.environ.get("KUNGFU_AGENT_SESSION_ENDPOINT", "")
    if not target:
        raise ValueError(
            "Agent Session surface is unavailable; open the Kungfu product or "
            "run inside a Kungfu Agent Console"
        )
    decoded = _invoke_transport(request, target, timeout)
    if not decoded.get("ok"):
        error = decoded.get("error") or {}
        raise ValueError(
            f"{error.get('code', 'agent_session_error')}: "
            f"{error.get('message', 'Agent Session action failed')}"
        )
    return decoded["value"]
