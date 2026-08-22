# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace

from click.testing import CliRunner

from kungfu.agent import run_agent, session_contract, session_surface
from kungfu.cli.commands import kfc
from kungfu.workspace import resolve_workspace_target
from agent_bootstrap_fixtures import verified_bootstrap_receipt


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


def test_process_identity_row_uses_stable_locale(monkeypatch):
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        return SimpleNamespace(
            returncode=0,
            stdout=("40 Thu Aug 13 10:59:00 2026 /Users/example/.local/bin/codex\n"),
        )

    monkeypatch.setattr(session_surface.subprocess, "run", run)

    assert session_surface._process_identity_row(50) == (
        40,
        "Thu Aug 13 10:59:00 2026",
        "/Users/example/.local/bin/codex",
    )
    assert calls[0][1]["env"]["LC_ALL"] == "C"
    assert calls[0][1]["env"]["LANG"] == "C"


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


def test_public_bind_work_cli_selects_explicit_external_project(monkeypatch, tmp_path):
    requests = []
    observed_runtime_dirs = []
    console_project = tmp_path / "console-project"
    console_runtime = console_project / ".kungfu" / "runtime"
    console_runtime.mkdir(parents=True)
    console_target = resolve_workspace_target(
        "read-only", str(console_project), cwd=str(console_project)
    )
    work_project = tmp_path / "work-project"
    work_runtime = work_project / ".kungfu" / "runtime"
    work_runtime.mkdir(parents=True)
    work_target = resolve_workspace_target(
        "read-only", str(work_project), cwd=str(work_project)
    )
    body = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": console_target.identity.workspace_id,
        "consoleId": f"assistant:{console_target.identity.workspace_id}:native:one",
        "attemptId": "native:one",
        "runtimeProfileId": "kungfu.agent-runtime.codex.test",
        "provider": "codex",
        "activeProfiles": [],
        "workRef": None,
        "entrypoints": {
            "context": ["/exact/kungfu", "agent", "context", "--json"],
            "capabilities": [
                "/exact/kungfu",
                "agent",
                "capabilities",
                "--json",
            ],
            "profiles": ["/exact/kungfu", "profile", "manager", "--json"],
            "bindWork": ["/exact/kungfu", "agent", "console", "bind-work"],
        },
        "knownLimits": [],
    }
    envelope = {**body, "envelopeRoot": run_agent.canonical_root(body)}
    monkeypatch.setenv("KUNGFU_AGENT_CONSOLE_ENVELOPE", json.dumps(envelope))
    monkeypatch.setenv(
        "KUNGFU_AGENT_BOOTSTRAP_RECEIPT",
        json.dumps(verified_bootstrap_receipt()),
    )
    monkeypatch.setenv("KUNGFU_AGENT_ATTEMPT_ID", "native:one")
    monkeypatch.setenv("KUNGFU_WORKSPACE_ROOT", str(console_project))
    monkeypatch.setenv("KUNGFU_AGENT_RUNTIME_DIR", str(console_runtime))

    def status(runtime_dir, *_args):
        observed_runtime_dirs.append(runtime_dir)
        return {
            "assignment": {"assignment_id": "assignment:external"},
            "query_proof_root": ROOT_HASH,
        }

    monkeypatch.setattr("kungfu.cli.commands.assignment._status", status)
    monkeypatch.setattr(
        "kungfu.cli.commands.assignment.profile_source", lambda: tmp_path
    )

    def validate_source(_source, runtime_dir):
        observed_runtime_dirs.append(runtime_dir)
        return {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": ROOT_HASH,
            }
        }

    monkeypatch.setattr("kungfu.profile_sdk.validate_source", validate_source)

    def invoke(request, **_kwargs):
        requests.append(request)
        if request["operation"] == "plan-native-bind-work":
            return {
                "operation": "native-bind-work",
                "root": ROOT_HASH,
                **request["input"]["session"],
                "workRef": request["input"]["workRef"],
            }
        return {"status": "bound", "receiptRoot": ROOT_HASH}

    monkeypatch.setattr(run_agent.session_surface, "invoke", invoke)
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "kungfu-home"),
            "agent",
            "console",
            "bind-work",
            "--initiative-id",
            "initiative:external",
            "--assignment-id",
            "assignment:external",
            "--workspace",
            str(work_project),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == "bound"
    assert payload["workRef"]["workspaceId"] == work_target.identity.workspace_id
    assert payload["session"]["workConsoleId"] == envelope["consoleId"]
    assert observed_runtime_dirs == [str(work_runtime), str(work_runtime)]
    assert requests[0]["input"]["bindingScope"] == "explicit-external-project"
    assert requests[0]["input"]["sourceWorkspaceId"] == envelope["workspaceId"]
    assert [request["operation"] for request in requests] == [
        "plan-native-bind-work",
        "bind-native-work",
    ]
