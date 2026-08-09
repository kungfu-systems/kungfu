# SPDX-License-Identifier: Apache-2.0

import json
import sys
from types import SimpleNamespace

from click.testing import CliRunner
import pytest

from kungfu.agent import native_launch
from kungfu.agent import run_agent
from kungfu.agent import runtime_profiles
from kungfu.agent import session_surface
from kungfu.cli.commands import agent as agent_commands, kfc


NATIVE_SURFACE_CAPABILITIES = {
    "schema": "kungfu.agent-session.surface-capabilities/v1",
    "actions": [
        "capabilities",
        "show",
        "plan-native-start",
        "start-native",
        "heartbeat-native",
        "project-native-work",
        "end-native",
    ],
}


def test_agent_session_resolves_the_current_project_runtime(monkeypatch, tmp_path):
    runtime_dir = tmp_path / "project" / ".kungfu" / "runtime"
    calls = []
    monkeypatch.delenv("KUNGFU_AGENT_SESSION_ENDPOINT", raising=False)
    monkeypatch.setattr(
        agent_commands.session_surface,
        "resolve_workspace_target",
        lambda *_args, **_kwargs: SimpleNamespace(runtime_dir=str(runtime_dir)),
    )

    def invoke(request, *, endpoint=None, **_kwargs):
        calls.append((request, endpoint))
        return {"schema": "kungfu.agent-session-list/v1", "sessions": []}

    monkeypatch.setattr(agent_commands.session_surface, "invoke", invoke)

    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "agent",
            "session",
            "list",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert calls[0][1] == agent_commands.session_surface.endpoint_for_runtime(
        runtime_dir
    )


def test_agent_session_restarts_the_runtime_scoped_surface_for_postmortem(
    monkeypatch, tmp_path
):
    runtime_dir = tmp_path / "project" / ".kungfu" / "runtime"
    derived_endpoint = agent_commands.session_surface.endpoint_for_runtime(runtime_dir)
    calls = []
    ensured = []
    monkeypatch.delenv("KUNGFU_AGENT_SESSION_ENDPOINT", raising=False)
    monkeypatch.setattr(
        agent_commands.session_surface,
        "resolve_workspace_target",
        lambda *_args, **_kwargs: SimpleNamespace(runtime_dir=str(runtime_dir)),
    )

    def invoke(request, *, endpoint=None, **_kwargs):
        calls.append((request, endpoint))
        if len(calls) == 1:
            raise FileNotFoundError(endpoint)
        return {"schema": "kungfu.agent-session-list/v1", "sessions": []}

    monkeypatch.setattr(agent_commands.session_surface, "invoke", invoke)
    monkeypatch.setattr(
        agent_commands.session_surface,
        "ensure",
        lambda value: ensured.append(value) or "/tmp/restarted-agent-session.sock",
    )

    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "agent",
            "session",
            "list",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert calls[0][1] == derived_endpoint
    assert calls[1][1] == "/tmp/restarted-agent-session.sock"
    assert ensured == [str(runtime_dir)]


def test_agent_session_does_not_replace_an_explicit_environment_endpoint(
    monkeypatch, tmp_path
):
    monkeypatch.setenv(
        "KUNGFU_AGENT_SESSION_ENDPOINT", "/tmp/explicit-agent-session.sock"
    )
    ensured = []
    monkeypatch.setattr(
        agent_commands.session_surface,
        "invoke",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            FileNotFoundError("explicit endpoint unavailable")
        ),
    )
    monkeypatch.setattr(
        agent_commands.session_surface,
        "ensure",
        lambda value: ensured.append(value) or "/tmp/restarted-agent-session.sock",
    )

    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "agent",
            "session",
            "list",
            "--json",
        ],
    )

    assert result.exit_code == 1
    assert "explicit endpoint unavailable" in result.output
    assert ensured == []


def test_agent_session_rejects_a_live_worker_with_stale_native_operations(
    monkeypatch, tmp_path
):
    monkeypatch.delenv("KUNGFU_AGENT_SESSION_ENDPOINT", raising=False)
    monkeypatch.setattr(
        session_surface,
        "invoke",
        lambda *_args, **_kwargs: {
            "schema": "kungfu.agent-session.surface-capabilities/v1",
            "actions": ["capabilities", "show"],
        },
    )
    runners = []

    with pytest.raises(ValueError) as raised:
        session_surface.ensure(
            tmp_path / "runtime", runner=lambda *_args: runners.append(True)
        )

    assert "Agent Session protocol mismatch" in str(raised.value)
    assert "plan-native-start" in str(raised.value)
    assert "Project data does not need to be deleted" in str(raised.value)
    assert runners == []


def test_agent_session_accepts_the_versioned_native_operation_vocabulary(
    monkeypatch, tmp_path
):
    monkeypatch.delenv("KUNGFU_AGENT_SESSION_ENDPOINT", raising=False)
    monkeypatch.setattr(
        session_surface,
        "invoke",
        lambda *_args, **_kwargs: NATIVE_SURFACE_CAPABILITIES,
    )
    runners = []

    endpoint = session_surface.ensure(
        tmp_path / "runtime", runner=lambda *_args: runners.append(True)
    )

    assert endpoint == session_surface.endpoint_for_runtime(tmp_path / "runtime")
    assert runners == []


def test_agent_session_ensure_reuses_an_explicit_product_endpoint(
    monkeypatch, tmp_path
):
    explicit = "/tmp/product-agent-session.sock"
    monkeypatch.setenv("KUNGFU_AGENT_SESSION_ENDPOINT", explicit)
    calls = []
    monkeypatch.setattr(
        session_surface,
        "invoke",
        lambda request, **kwargs: (
            calls.append((request, kwargs)) or NATIVE_SURFACE_CAPABILITIES
        ),
    )
    runners = []

    endpoint = session_surface.ensure(
        tmp_path / "different-project-runtime",
        runner=lambda *_args: runners.append(True),
    )

    assert endpoint == explicit
    assert calls[0][1]["endpoint"] == explicit
    assert runners == []


def test_native_interactive_uses_controlling_terminal_before_registering_attempt(
    monkeypatch, tmp_path
):
    stdin_path = tmp_path / "stdin"
    stdout_path = tmp_path / "stdout"
    stderr_path = tmp_path / "stderr"
    stdin_path.write_bytes(b"")
    profile = {
        "provider": "amp",
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": "/usr/bin/amp",
            "interactiveArgv": [],
            "shellMode": False,
        },
    }
    monkeypatch.setattr(
        runtime_profiles,
        "verify_profile",
        lambda selected: {"ok": True, "error": None, "version": "1.2.3"},
    )
    monkeypatch.setattr(
        native_launch,
        "_native_terminal_route",
        lambda _provider: native_launch.NativeTerminalRoute(
            str(stdin_path), str(stdout_path), str(stderr_path)
        ),
    )
    calls = []

    class ProviderProcess:
        def __init__(self, argv, **kwargs):
            calls.append((argv, kwargs))

        def wait(self):
            return 0

    monkeypatch.setattr(native_launch.subprocess, "Popen", ProviderProcess)

    assert (
        run_agent.run_native_interactive(
            profile,
            runtime_dir=str(tmp_path / "runtime"),
            config_home=str(tmp_path / "config"),
            runtime_home=str(tmp_path / "home"),
            workspace_root=str(tmp_path),
            work_ref=None,
            work_selection={
                "schema": "kungfu.native-work-selection/v1",
                "state": "none",
            },
        )
        == 0
    )

    assert set(calls[0][1]) == {"cwd", "env", "stdin", "stdout", "stderr"}
    assert all(calls[0][1][name].closed for name in ("stdin", "stdout", "stderr"))
    context = json.loads(calls[0][1]["env"]["KUNGFU_AGENT_CONTEXT"])
    assert context["terminal"]["stdioAttached"] is True


def test_native_interactive_rejects_missing_terminal_before_session_attempt(
    monkeypatch, tmp_path
):
    profile = {
        "provider": "codex",
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": "/usr/bin/codex",
            "interactiveArgv": [],
            "shellMode": False,
        },
    }
    monkeypatch.setattr(
        runtime_profiles,
        "verify_profile",
        lambda selected: {"ok": True, "error": None, "version": "1.2.3"},
    )
    monkeypatch.setattr(
        native_launch,
        "_native_terminal_route",
        lambda _provider: (_ for _ in ()).throw(
            ValueError(
                "provider-native UI 'codex' requires an interactive terminal; "
                "non-terminal descriptors: stdin"
            )
        ),
    )
    requests = []

    with pytest.raises(ValueError, match="non-terminal descriptors: stdin"):
        run_agent.run_native_interactive(
            profile,
            runtime_dir=str(tmp_path / "runtime"),
            config_home=str(tmp_path / "config"),
            runtime_home=str(tmp_path / "home"),
            workspace_root=str(tmp_path),
            work_ref=None,
            work_selection={
                "schema": "kungfu.native-work-selection/v1",
                "state": "none",
            },
            session_invoker=lambda request: requests.append(request),
        )

    assert requests == []


def test_native_terminal_route_reports_the_non_terminal_descriptors(monkeypatch):
    monkeypatch.setattr(native_launch.os, "isatty", lambda descriptor: descriptor == 1)

    def unavailable(*_args, **_kwargs):
        raise OSError("no controlling terminal")

    monkeypatch.setattr(native_launch, "open", unavailable, raising=False)

    with pytest.raises(ValueError) as error:
        native_launch._native_terminal_route("codex")

    assert "non-terminal descriptors: stdin, stderr" in str(error.value)
    assert "terminal or PTY" in str(error.value)


def test_windows_native_terminal_route_reopens_console_even_when_crt_fds_are_ttys(
    monkeypatch,
):
    opened = []

    class ConsoleInput:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def fileno(self):
            return 0

    monkeypatch.setattr(native_launch.os, "name", "nt")
    monkeypatch.setattr(native_launch.os, "isatty", lambda _descriptor: True)
    monkeypatch.setattr(
        native_launch,
        "open",
        lambda path, *_args, **_kwargs: opened.append(path) or ConsoleInput(),
        raising=False,
    )

    route = native_launch._native_terminal_route("codex")

    assert route == native_launch.NativeTerminalRoute("CONIN$", "CONOUT$", "CONOUT$")
    assert opened == ["CONIN$"]


class WindowsError(OSError):
    def __init__(self, winerror, message="Windows named-pipe error"):
        super().__init__(winerror, message)
        self.winerror = winerror


class FakeOverlapped:
    def __init__(self, buffer, completion_error=0):
        self.event = object()
        self.buffer = buffer
        self.completion_error = completion_error
        self.cancelled = False

    def cancel(self):
        self.cancelled = True

    def GetOverlappedResult(self, _wait):
        if self.cancelled:
            raise WindowsError(995, "operation aborted")
        return len(self.buffer), self.completion_error

    def getbuffer(self):
        return self.buffer


class FakeWinApi:
    ERROR_BROKEN_PIPE = 109
    ERROR_IO_PENDING = 997
    ERROR_MORE_DATA = 234
    ERROR_PIPE_BUSY = 231
    ERROR_SEM_TIMEOUT = 121
    FILE_FLAG_OVERLAPPED = 0x40000000
    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    NULL = 0
    OPEN_EXISTING = 3
    WAIT_OBJECT_0 = 0
    WAIT_TIMEOUT = 258

    def __init__(
        self,
        response=b'{"ok":true,"value":{"answer":42}}\n',
        *,
        busy_count=0,
        unavailable=False,
        wait_results=None,
    ):
        self.read_buffer = bytearray(response)
        self.busy_count = busy_count
        self.unavailable = unavailable
        self.wait_results = list(wait_results or [])
        self.wait_named_pipe_calls = []
        self.writes = []
        self.overlapped = []
        self.closed = []

    def WaitNamedPipe(self, target, timeout):
        self.wait_named_pipe_calls.append((target, timeout))
        if self.unavailable:
            raise WindowsError(2, "pipe not found")
        if self.busy_count:
            self.busy_count -= 1
            raise WindowsError(self.ERROR_PIPE_BUSY, "pipe busy")

    def CreateFile(self, *_args):
        return 73

    def WriteFile(self, _handle, payload, *, overlapped):
        assert overlapped is True
        self.writes.append(payload)
        operation = FakeOverlapped(payload)
        self.overlapped.append(operation)
        return operation, self.ERROR_IO_PENDING

    def ReadFile(self, _handle, size, *, overlapped):
        assert overlapped is True
        if not self.read_buffer:
            raise WindowsError(self.ERROR_BROKEN_PIPE, "pipe closed")
        chunk = bytes(self.read_buffer[:size])
        del self.read_buffer[:size]
        operation = FakeOverlapped(chunk)
        self.overlapped.append(operation)
        return operation, self.ERROR_IO_PENDING

    def WaitForMultipleObjects(self, _events, _wait_all, _timeout):
        if self.wait_results:
            return self.wait_results.pop(0)
        return self.WAIT_OBJECT_0

    def CloseHandle(self, handle):
        self.closed.append(handle)


def install_windows_api(monkeypatch, api):
    monkeypatch.setattr(session_surface.sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "_winapi", api)


def test_windows_endpoint_uses_the_runtime_scoped_named_pipe(monkeypatch, tmp_path):
    monkeypatch.setattr(session_surface.sys, "platform", "win32")
    first = session_surface.endpoint_for_runtime(tmp_path / "runtime")
    second = session_surface.endpoint_for_runtime(tmp_path / "runtime")

    assert first == second
    assert first.startswith(r"\\.\pipe\kungfu-agent-session-")


def test_windows_named_pipe_preserves_json_line_framing(monkeypatch):
    api = FakeWinApi()
    install_windows_api(monkeypatch, api)

    result = session_surface._invoke_transport(
        {"operation": "capabilities"},
        r"\\.\pipe\kungfu-agent-session-test",
        timeout=1.0,
    )

    assert result == {"ok": True, "value": {"answer": 42}}
    assert api.writes == [b'{"operation":"capabilities"}\n']
    assert api.closed == [73]


def test_windows_named_pipe_retries_a_busy_instance(monkeypatch):
    api = FakeWinApi(busy_count=1)
    install_windows_api(monkeypatch, api)

    session_surface._invoke_transport(
        {"operation": "list"},
        r"\\.\pipe\kungfu-agent-session-test",
        timeout=1.0,
    )

    assert len(api.wait_named_pipe_calls) == 2
    assert api.closed == [73]


def test_windows_named_pipe_surfaces_an_unavailable_endpoint(monkeypatch):
    api = FakeWinApi(unavailable=True)
    install_windows_api(monkeypatch, api)

    with pytest.raises(OSError) as raised:
        session_surface._invoke_transport(
            {"operation": "list"},
            r"\\.\pipe\missing",
            timeout=1.0,
        )

    assert raised.value.winerror == 2
    assert api.closed == []


def test_windows_named_pipe_cancels_a_timed_out_read(monkeypatch):
    api = FakeWinApi(wait_results=[FakeWinApi.WAIT_OBJECT_0, FakeWinApi.WAIT_TIMEOUT])
    install_windows_api(monkeypatch, api)

    with pytest.raises(TimeoutError, match="named-pipe read timed out"):
        session_surface._invoke_transport(
            {"operation": "list"},
            r"\\.\pipe\kungfu-agent-session-test",
            timeout=1.0,
        )

    assert api.overlapped[-1].cancelled is True
    assert api.closed == [73]


def test_windows_named_pipe_rejects_a_malformed_response(monkeypatch):
    api = FakeWinApi(response=b"{not-json}\n")
    install_windows_api(monkeypatch, api)

    with pytest.raises(json.JSONDecodeError):
        session_surface._invoke_transport(
            {"operation": "list"},
            r"\\.\pipe\kungfu-agent-session-test",
            timeout=1.0,
        )


def test_windows_named_pipe_rejects_a_non_object_response(monkeypatch):
    api = FakeWinApi(response=b"[]\n")
    install_windows_api(monkeypatch, api)

    with pytest.raises(ValueError, match="response must be a JSON object"):
        session_surface._invoke_transport(
            {"operation": "list"},
            r"\\.\pipe\kungfu-agent-session-test",
            timeout=1.0,
        )


def test_windows_named_pipe_rejects_an_oversized_response(monkeypatch):
    api = FakeWinApi(response=b"x" * (session_surface.MAX_MESSAGE_BYTES + 1))
    install_windows_api(monkeypatch, api)

    with pytest.raises(ValueError, match="response exceeds 1 MiB"):
        session_surface._invoke_transport(
            {"operation": "list"},
            r"\\.\pipe\kungfu-agent-session-test",
            timeout=1.0,
        )


def test_transport_rejects_an_oversized_request_before_connect(monkeypatch):
    api = FakeWinApi()
    install_windows_api(monkeypatch, api)

    with pytest.raises(ValueError, match="request exceeds 1 MiB"):
        session_surface._invoke_transport(
            {"payload": "x" * session_surface.MAX_MESSAGE_BYTES},
            r"\\.\pipe\kungfu-agent-session-test",
            timeout=1.0,
        )

    assert api.wait_named_pipe_calls == []
