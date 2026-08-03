# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace

from click.testing import CliRunner
import pytest

from kungfu.agent import native_launch
from kungfu.agent import run_agent
from kungfu.agent import runtime_profiles
from kungfu.cli.commands import agent as agent_commands, kfc


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
