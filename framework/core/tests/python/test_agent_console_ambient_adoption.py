# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from click.testing import CliRunner

from kungfu.agent import run_agent, session_contract, session_surface
from kungfu.cli.commands import kfc


ROOT_HASH = "sha256:" + "a" * 64
THREAD_ID = "019ff927-f9a4-7502-999a-6bc5a69bb702"


def process_identity():
    return {
        "schema": "kungfu.native-process-identity/v1",
        "provider": "codex",
        "providerSessionId": THREAD_ID,
        "providerProcessId": 40,
        "providerProcessStartedAt": "Thu Aug 13 10:59:00 2026",
    }


def console_envelope():
    body = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": "project:exact",
        "consoleId": "assistant:project:exact",
        "attemptId": "native:codex:ambient:exact",
        "runtimeProfileId": "kungfu.agent-runtime.codex.ambient",
        "provider": "codex",
        "activeProfiles": [],
        "workRef": None,
        "entrypoints": {
            "context": ["/exact/kungfu", "agent", "context", "--json"],
            "capabilities": ["/exact/kungfu", "agent", "capabilities", "--json"],
            "profiles": ["/exact/kungfu", "profile", "manager", "--json"],
            "bindWork": ["/exact/kungfu", "agent", "console", "bind-work"],
        },
        "knownLimits": ["Console observation does not grant Work authority"],
    }
    return {**body, "envelopeRoot": session_contract.semantic_root(body)}


def test_ambient_codex_identity_uses_exact_thread_and_process_ancestor(monkeypatch):
    monkeypatch.setattr(session_surface.os, "getppid", lambda: 50)
    rows = {
        50: (40, "Thu Aug 13 11:00:00 2026", "/bin/zsh"),
        40: (1, "Thu Aug 13 10:59:00 2026", "/usr/local/bin/codex"),
    }

    identity = session_surface.ambient_codex_process_identity(
        environ={"CODEX_THREAD_ID": THREAD_ID}, row_reader=rows.get
    )

    assert identity == process_identity()


def test_current_native_console_adopts_exact_ambient_process(monkeypatch, tmp_path):
    project = tmp_path / "project"
    runtime = project / ".kungfu" / "runtime"
    runtime.mkdir(parents=True)
    target = SimpleNamespace(
        identity=SimpleNamespace(
            workspace_kind="project",
            identity_state="qualified",
            workspace_root=str(project),
            workspace_id="project:exact",
        ),
        runtime_dir=str(runtime),
    )
    monkeypatch.setattr(
        session_surface, "resolve_workspace_target", lambda *_a, **_k: target
    )
    identity = process_identity()
    identity_root = session_contract.semantic_root(identity)
    requests = []
    started = False

    def invoke(request):
        nonlocal started
        requests.append(request)
        operation = request["operation"]
        if operation == "show" and not started:
            raise ValueError("session_not_found: unavailable")
        if operation == "plan-native-start":
            return {
                "operation": "native-start",
                "root": ROOT_HASH,
                **request["input"],
            }
        if operation == "start-native":
            started = True
            return {"status": "started"}
        if operation == "heartbeat-native":
            return {"state": "fresh"}
        if operation == "show":
            return {
                "lifecycleState": "running",
                "binding": {"kind": "workspace-assistant", "workRef": None},
                "attempt": {
                    "provider": "codex",
                    "observer": {"processIdentityRoot": identity_root},
                    "bootstrap": {
                        "state": "pending",
                        "mutationsAllowed": False,
                    },
                },
            }
        raise AssertionError(operation)

    current = session_surface.current_native_console(
        str(runtime),
        adopt=True,
        cwd=str(project),
        environ={"KUNGFU_CLI_BIN": "/exact/kungfu"},
        process_identity=identity,
        session_invoker=invoke,
    )

    assert [request["operation"] for request in requests] == [
        "show",
        "plan-native-start",
        "start-native",
        "heartbeat-native",
        "show",
    ]
    assert current["source"] == "ambient-provider-session"
    assert current["processIdentityRoot"] == identity_root
    assert current["envelope"]["workspaceId"] == "project:exact"
    assert "bootstrap" not in current["envelope"]
    session_contract.validate_agent_console_envelope(current["envelope"])


def test_public_bind_work_cli_adopts_current_codex_process(monkeypatch, tmp_path):
    envelope = console_envelope()
    calls = []
    monkeypatch.delenv("KUNGFU_AGENT_CONSOLE_ENVELOPE", raising=False)
    monkeypatch.setattr(
        session_surface,
        "current_native_console",
        lambda *_args, **kwargs: (
            calls.append(("current", kwargs)),
            {
                "source": "ambient-provider-session",
                "envelope": envelope,
                "workspaceRoot": str(tmp_path),
                "status": {},
            },
        )[1],
    )

    def bind(*args, **kwargs):
        calls.append(("bind", args, kwargs))
        return {
            "workRef": {"entityId": "assignment:test"},
            "session": {
                "workConsoleId": envelope["consoleId"],
                "sessionAttemptId": envelope["attemptId"],
            },
            "receipt": {"status": "bound"},
        }

    monkeypatch.setattr(run_agent, "bind_current_native_work", bind)
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "agent",
            "console",
            "bind-work",
            "--initiative-id",
            "initiative:test",
            "--assignment-id",
            "assignment:test",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert calls[0][1]["adopt"] is True
    assert calls[1][2]["envelope_override"] == envelope
    assert calls[1][2]["console_workspace_root"] == str(tmp_path)
