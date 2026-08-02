# SPDX-License-Identifier: Apache-2.0

import json
import hashlib
import os
from pathlib import Path
import shutil
import socket
import sys
from typing import Protocol

from kungfu.agent.session_contract import semantic_root


MAX_RESPONSE_BYTES = 1024 * 1024


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
    if not hasattr(socket, "AF_UNIX"):
        raise ValueError(
            "Agent Session local actions are currently supported on macOS/Linux"
        )
    payload = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(payload) > MAX_RESPONSE_BYTES:
        raise ValueError("Agent Session request exceeds 1 MiB")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(target)
        client.sendall(payload)
        response = bytearray()
        while b"\n" not in response:
            chunk = client.recv(65536)
            if not chunk:
                raise ValueError("Agent Session surface closed without a response")
            response.extend(chunk)
            if len(response) > MAX_RESPONSE_BYTES:
                raise ValueError("Agent Session response exceeds 1 MiB")
    decoded = json.loads(bytes(response).split(b"\n", 1)[0])
    if not decoded.get("ok"):
        error = decoded.get("error") or {}
        raise ValueError(
            f"{error.get('code', 'agent_session_error')}: "
            f"{error.get('message', 'Agent Session action failed')}"
        )
    return decoded["value"]
