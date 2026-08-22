# SPDX-License-Identifier: Apache-2.0

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
from typing import Any, Mapping, Protocol
import uuid

from kungfu.agent import session_contract
from kungfu.agent.session_contract import semantic_root
from kungfu.workspace import WorkspaceTargetRequired, resolve_workspace_target


MAX_MESSAGE_BYTES = 1024 * 1024
_READ_CHUNK_BYTES = 65536
_SURFACE_CAPABILITIES_SCHEMA = "kungfu.agent-session.surface-capabilities/v1"
_REQUIRED_NATIVE_OPERATIONS = frozenset(
    {
        "capabilities",
        "show",
        "plan-native-start",
        "start-native",
        "heartbeat-native",
        "project-native-work",
        "end-native",
    }
)


def _deadline(timeout):
    if timeout is None:
        return None
    if timeout <= 0:
        raise ValueError("Agent Session timeout must be positive")
    return time.monotonic() + timeout


def _remaining_milliseconds(deadline, operation):
    if deadline is None:
        return 0xFFFFFFFF
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
            if deadline is not None and time.monotonic() >= deadline:
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


def _validate_surface_capabilities(capabilities, *, endpoint):
    schema = capabilities.get("schema") if isinstance(capabilities, dict) else None
    actions = capabilities.get("actions") if isinstance(capabilities, dict) else None
    supported = (
        {str(action) for action in actions if isinstance(action, str)}
        if isinstance(actions, list)
        else set()
    )
    missing = sorted(_REQUIRED_NATIVE_OPERATIONS - supported)
    if schema == _SURFACE_CAPABILITIES_SCHEMA and not missing:
        return capabilities
    details = []
    if schema != _SURFACE_CAPABILITIES_SCHEMA:
        details.append(
            f"schema is {schema or 'missing'}; expected {_SURFACE_CAPABILITIES_SCHEMA}"
        )
    if missing:
        details.append("missing operations: " + ", ".join(missing))
    raise ValueError(
        f"Agent Session protocol mismatch at {endpoint}: {'; '.join(details)}. "
        "Close running Kungfu processes for this Project and retry. Project data "
        "does not need to be deleted."
    )


def _run_worker_preserving_standard_streams(runner, *argv):
    """Start the detached worker without changing caller stdio inheritance."""

    inheritance = []
    for descriptor in (0, 1, 2):
        try:
            inheritance.append((descriptor, os.get_inheritable(descriptor)))
        except OSError:
            pass
    try:
        return runner(*argv)
    finally:
        for descriptor, inheritable in inheritance:
            os.set_inheritable(descriptor, inheritable)


def _spawn_detached_worker(*argv: str):
    environment = os.environ.copy()
    environment["ELECTRON_RUN_AS_NODE"] = "1"
    environment["KUNGFU_AS_VARIANT"] = "node"
    # The parent TUI pins its own embedded-Node entry. The Agent Session
    # bootstrap supplies a different reviewed argv and must not re-enter TUI.
    environment.pop("KUNGFU_NODE_VARIANT_ENTRY", None)
    creationflags = 0
    if sys.platform == "win32":
        creationflags = getattr(subprocess, "DETACHED_PROCESS", 0x00000008) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200
        )
    process = subprocess.Popen(
        list(argv),
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=creationflags,
        start_new_session=sys.platform != "win32",
    )
    try:
        _, stderr = process.communicate(timeout=20)
    except subprocess.TimeoutExpired as error:
        process.kill()
        process.communicate()
        raise TimeoutError(
            "native Agent Session bootstrap did not finish within 20 seconds"
        ) from error
    if process.returncode != 0:
        diagnostic = (stderr or "").strip()[-4096:]
        raise ValueError(
            diagnostic
            or f"native Agent Session bootstrap exited with status {process.returncode}"
        )
    return 0


def _await_surface_capabilities(endpoint, timeout=5.0):
    deadline = _deadline(timeout)
    if deadline is None:
        return invoke({"operation": "capabilities"}, endpoint=endpoint, timeout=None)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"Agent Session worker did not become ready at {endpoint}"
            )
        try:
            return invoke(
                {"operation": "capabilities"},
                endpoint=endpoint,
                timeout=min(0.25, remaining),
            )
        except (OSError, socket.timeout):
            time.sleep(min(0.05, remaining))


def ensure(runtime_dir, *, runner=None, timeout=5.0):
    """Ensure and return the runtime-scoped detached Agent Session endpoint."""

    explicit_endpoint = os.environ.get("KUNGFU_AGENT_SESSION_ENDPOINT")
    endpoint = explicit_endpoint or endpoint_for_runtime(runtime_dir)
    if explicit_endpoint is None:
        os.environ["KUNGFU_AGENT_SESSION_ENDPOINT"] = endpoint
    try:
        capabilities = invoke(
            {"operation": "capabilities"},
            endpoint=endpoint,
            timeout=None if timeout is None else min(0.25, timeout),
        )
        _validate_surface_capabilities(capabilities, endpoint=endpoint)
        return endpoint
    except (OSError, socket.timeout):
        if explicit_endpoint is not None:
            raise

    entry = _resolve_native_entry()
    if entry is None:
        raise ValueError(
            "native Agent Session bridge is unavailable; build the Kungfu TUI "
            "bundle or set KUNGFU_NATIVE_AGENT_SESSION_ENTRY"
        )
    os.environ["KF_RUNTIME_DIR"] = str(Path(runtime_dir).expanduser().resolve())
    worker_executable = _resolve_worker_executable()
    os.environ["KUNGFU_AGENT_SESSION_EXECUTABLE"] = worker_executable
    if runner is None:
        runner = _spawn_detached_worker
    # The embedded Node bootstrap marks inherited descriptors close-on-exec on
    # some platforms. Restore the exact caller flags before a provider-native
    # child is launched; otherwise the first provider process starts without a
    # terminal while later attempts (which reuse the worker) happen to work.
    exit_code = _run_worker_preserving_standard_streams(
        runner, worker_executable, entry
    )
    if exit_code not in (None, 0):
        raise ValueError(
            f"native Agent Session bridge exited with status {int(exit_code)}"
        )
    capabilities = _await_surface_capabilities(endpoint, timeout=timeout)
    _validate_surface_capabilities(capabilities, endpoint=endpoint)
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


def _process_identity_row(pid: int) -> tuple[int, str, str] | None:
    """Read bounded public process coordinates for one POSIX process."""

    if os.name != "posix" or pid <= 1:
        return None
    completed = subprocess.run(
        ["ps", "-o", "ppid=", "-o", "lstart=", "-o", "comm=", "-p", str(pid)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
        timeout=1,
        env={**os.environ, "LC_ALL": "C", "LANG": "C"},
    )
    if completed.returncode != 0:
        return None
    fields = completed.stdout.strip().split(None, 6)
    if len(fields) != 7:
        return None
    try:
        parent_pid = int(fields[0])
    except ValueError:
        return None
    return parent_pid, " ".join(fields[1:6]), fields[6]


def ambient_codex_process_identity(
    *,
    environ: Mapping[str, str] | None = None,
    row_reader=None,
) -> dict[str, Any] | None:
    """Resolve the exact public Codex thread and owning process coordinates."""

    current = os.environ if environ is None else environ
    thread_id = str(current.get("CODEX_THREAD_ID") or "").strip()
    if not thread_id:
        return None
    try:
        canonical_thread_id = str(uuid.UUID(thread_id))
    except ValueError as error:
        raise ValueError(
            "CODEX_THREAD_ID is not an exact provider thread id"
        ) from error
    read_row = _process_identity_row if row_reader is None else row_reader
    pid = os.getppid()
    seen: set[int] = set()
    for _ in range(32):
        if pid <= 1 or pid in seen:
            break
        seen.add(pid)
        row = read_row(pid)
        if row is None:
            break
        parent_pid, started_at, executable = row
        if Path(executable).name == "codex":
            return {
                "schema": "kungfu.native-process-identity/v1",
                "provider": "codex",
                "providerSessionId": canonical_thread_id,
                "providerProcessId": pid,
                "providerProcessStartedAt": started_at,
            }
        pid = parent_pid
    raise ValueError(
        "CODEX_THREAD_ID is present but no exact live Codex process ancestor was found"
    )


def current_native_console(
    runtime_dir: str,
    *,
    adopt: bool = False,
    cwd: str | None = None,
    environ: Mapping[str, str] | None = None,
    process_identity: Mapping[str, Any] | None = None,
    session_invoker=None,
) -> dict[str, Any] | None:
    """Resolve or adopt the current provider-native Console without PTY ownership."""

    current = os.environ if environ is None else environ
    raw = str(current.get("KUNGFU_AGENT_CONSOLE_ENVELOPE") or "").strip()
    if raw:
        envelope = session_contract.validate_agent_console_envelope(json.loads(raw))
        return {
            "source": "injected-native-console",
            "envelope": envelope,
            "workspaceRoot": str(current.get("KUNGFU_WORKSPACE_ROOT") or ""),
            "status": None,
        }

    identity = (
        dict(process_identity)
        if process_identity is not None
        else ambient_codex_process_identity(environ=current)
    )
    if identity is None:
        return None
    provider = str(identity.get("provider") or "")
    if provider != "codex" or not identity.get("providerSessionId"):
        raise ValueError(
            "ambient Console adoption requires exact Codex process identity"
        )

    selected_cwd = str(Path(cwd or os.getcwd()).expanduser().resolve())
    target = resolve_workspace_target("read-only", cwd=selected_cwd)
    if (
        target.identity.workspace_kind != "project"
        or target.identity.identity_state != "qualified"
        or not target.identity.workspace_root
    ):
        raise ValueError(
            "ambient Console adoption requires one qualified Kungfu Project workspace"
        )
    workspace_root = target.identity.workspace_root
    workspace_id = target.identity.workspace_id
    process_identity_root = semantic_root(identity)
    attempt_suffix = process_identity_root.removeprefix("sha256:")[:24]
    session = {
        "workConsoleId": f"assistant:{workspace_id}",
        "sessionAttemptId": f"native:codex:ambient:{attempt_suffix}",
    }
    actor_id = f"native:codex:{attempt_suffix}"

    def invoke_session(request):
        if session_invoker is not None:
            return session_invoker(request)
        return invoke_for_project(
            request,
            fallback_runtime_dir=target.runtime_dir or runtime_dir,
            cwd=workspace_root,
        )

    status = None
    try:
        status = invoke_session({"operation": "show", "session": session})
    except ValueError as error:
        if "session_not_found" not in str(error):
            raise
    if status is not None:
        attempt = status.get("attempt") or {}
        observer = attempt.get("observer") or {}
        if (
            attempt.get("provider") != "codex"
            or observer.get("processIdentityRoot") != process_identity_root
        ):
            raise ValueError(
                "registered ambient Console does not match the current Codex process"
            )
    if status is None and not adopt:
        return None

    lifecycle_state = str((status or {}).get("lifecycleState") or "")
    if status is None or lifecycle_state in {"ended", "unavailable"}:
        profile = {
            "id": "kungfu.agent-runtime.codex.ambient",
            "provider": "codex",
            "source": "current-public-process-environment",
        }
        plan = invoke_session(
            {
                "operation": "plan-native-start",
                "client": "kfd3-agent",
                "actorId": actor_id,
                "input": {
                    "workspaceId": workspace_id,
                    **session,
                    "provider": "codex",
                    "providerVersion": "current-process",
                    "profileRoot": semantic_root(profile),
                    "runtimeProfileId": profile["id"],
                    "binding": {"kind": "workspace-assistant", "workRef": None},
                },
            }
        )
        invoke_session(
            {
                "operation": "start-native",
                "client": "kfd3-agent",
                "actorId": actor_id,
                "plan": plan,
                "expectedPlanRoot": plan["root"],
                "processIdentity": identity,
            }
        )

    if adopt:
        active_binding = (status or {}).get("binding") or {}
        active_work_ref = (
            active_binding.get("workRef")
            if active_binding.get("kind") == "work"
            else None
        )
        invoke_session(
            {
                "operation": "heartbeat-native",
                "client": "kfd3-agent",
                "actorId": actor_id,
                "session": session,
                "processIdentity": identity,
                "observation": {
                    "schema": "kungfu.attempt-heartbeat/v1",
                    "state": "fresh",
                    "staleAfterMs": 10000,
                    "workRefRoot": (
                        semantic_root(active_work_ref)
                        if active_work_ref is not None
                        else None
                    ),
                    "diagnostic": "current-public-codex-process",
                },
            }
        )
    status = invoke_session({"operation": "show", "session": session})
    binding = status.get("binding") or {}
    work_ref = binding.get("workRef") if binding.get("kind") == "work" else None
    cli_bin = str(
        current.get("KUNGFU_CLI_BIN") or shutil.which("kungfu") or sys.argv[0]
    )
    body = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": workspace_id,
        "consoleId": session["workConsoleId"],
        "attemptId": session["sessionAttemptId"],
        "runtimeProfileId": "kungfu.agent-runtime.codex.ambient",
        "provider": "codex",
        "activeProfiles": [],
        "workRef": work_ref,
        "entrypoints": {
            "context": [cli_bin, "agent", "context", "--json"],
            "capabilities": [cli_bin, "agent", "capabilities", "--json"],
            "profiles": [cli_bin, "profile", "manager", "--json"],
            "bindWork": [cli_bin, "agent", "console", "bind-work"],
        },
        "knownLimits": [
            "current provider process was adopted without terminal ownership",
            "native provider terminal bytes are not captured by Kungfu",
            "Console observation does not grant Work authority",
        ],
    }
    envelope = {**body, "envelopeRoot": semantic_root(body)}
    session_contract.validate_agent_console_envelope(envelope)
    return {
        "source": "ambient-provider-session",
        "envelope": envelope,
        "workspaceRoot": workspace_root,
        "status": status,
        "processIdentityRoot": process_identity_root,
    }
