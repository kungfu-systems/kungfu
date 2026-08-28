# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

from kungfu import config
from kungfu import workspace_guidance
from kungfu.agent import run_agent
from kungfu.agent import runtime_profiles
from kungfu.agent.managed_run import ManagedRunCoordinator
from kungfu.agent.native_launch import NativeLaunchCoordinator
from kungfu.agent.provider_bootstrap import ProviderBootstrapAdapter
from kungfu.agent.run_intent import RunIntentDispatcher
from kungfu.agent.runtime_profile_catalog import RuntimeProfileCatalog
from kungfu.agent.runtime_profile_store import RuntimeProfileStore
from kungfu.agent.verification_probe import VerificationProbe
from kungfu.rewind.cost import discovery as provider_discovery


ROOT = Path(__file__).resolve().parents[2]


def _invalid_utf8_version_command():
    return [
        "-c",
        "import sys; sys.stdout.buffer.write(b'provider \\xff 1.2.3\\n')",
    ]


def test_verification_probe_replaces_invalid_utf8_from_provider():
    probe = VerificationProbe(schema="test")

    assert probe.raw_version(sys.executable, _invalid_utf8_version_command()) == (
        "provider � 1.2.3"
    )


def test_mock_runtime_verification_has_no_time_based_admission(monkeypatch):
    observed = {}

    def probe(*args, **kwargs):
        observed["timeout"] = kwargs["timeout"]
        return SimpleNamespace(returncode=0, stdout="1.1.0\n", stderr="")

    monkeypatch.setattr(runtime_profiles.subprocess, "run", probe)
    result = runtime_profiles.verify_profile(
        {
            "id": "kungfu.mock-agent.complete",
            "provider": "synthetic",
            "launch": {"executable": sys.executable},
        }
    )

    assert result["ok"] is True
    assert observed["timeout"] is None


def test_codex_direct_process_uses_stdin_without_version_assumptions():
    prompt = "bounded task " + ("evidence " * 10_000)
    argv = ["/usr/bin/codex", "exec", "--json", prompt]

    process_argv, stdin_text = run_agent._direct_process_transport("codex", argv)

    assert process_argv == ["/usr/bin/codex", "exec", "--json", "-"]
    assert stdin_text == prompt
    assert prompt not in process_argv
    assert run_agent._direct_process_transport("claude", argv) == (argv, None)


def test_deterministic_mock_direct_process_keeps_large_prompt_out_of_argv():
    prompt = "bounded review\n" + ("evidence\n" * 10_000)
    argv = [
        "/opt/kungfu/runtime/kungfu",
        "/opt/kungfu/tui/mock-agent.mjs",
        "--scenario",
        "review-fit",
        prompt,
    ]

    process_argv, stdin_text = run_agent._direct_process_transport("synthetic", argv)

    assert process_argv == argv[:-1]
    assert prompt not in process_argv
    assert stdin_text == f"\x1b[200~{prompt}\x1b[201~\r"


def test_deterministic_mock_waits_for_session_events_without_a_deadline(monkeypatch):
    ref = {
        "workConsoleId": "work:mock",
        "sessionAttemptId": "attempt:mock:1",
    }
    requests = []

    def invoke(request):
        requests.append(request)
        if request["operation"] == "status":
            return {**ref, "changeSequence": 7, "interactionState": "busy"}
        if request["operation"] == "wait-status-change":
            assert request["afterChangeSequence"] == 7
            return {**ref, "changeSequence": 8, "interactionState": "ended"}
        raise AssertionError(request)

    monkeypatch.setattr(
        run_agent.time,
        "monotonic",
        lambda: (_ for _ in ()).throw(AssertionError("deadline is forbidden")),
    )
    monkeypatch.setattr(
        run_agent.time,
        "sleep",
        lambda _seconds: (_ for _ in ()).throw(AssertionError("polling is forbidden")),
    )

    result = run_agent._wait_for_session(
        invoke,
        ref,
        lambda status: status["interactionState"] == "ended",
        timeout_seconds=None,
        event_driven=True,
    )

    assert result["changeSequence"] == 8
    assert [request["operation"] for request in requests] == [
        "status",
        "wait-status-change",
    ]


def test_verification_probe_keeps_version_after_invalid_utf8():
    probe = VerificationProbe(schema="test")
    result = probe.verify(
        {
            "id": "test.invalid-utf8",
            "provider": "test",
            "launch": {
                "executable": sys.executable,
                "versionArgv": _invalid_utf8_version_command(),
            },
        }
    )

    assert result["ok"] is True
    assert result["version"] == "1.2.3"


def test_terminal_mock_session_waits_for_process_exit_after_reviewable_output():
    observations = [
        [
            {
                "live": True,
                "lifecycleState": "ready",
                "interactionState": "ready",
                "output": {"nextSequence": 1},
                "controller": {"holderId": "kungfu-project-work"},
            }
        ],
        [
            {
                "live": True,
                "lifecycleState": "running",
                "interactionState": "unknown",
                "output": {"nextSequence": 2},
            },
            {
                "live": True,
                "lifecycleState": "ready",
                "interactionState": "ready",
                "output": {"nextSequence": 3},
            },
            {
                "live": True,
                "lifecycleState": "ended",
                "interactionState": "ended",
                "output": {"nextSequence": 3},
                "exit": {"exitCode": 0},
            },
            {
                "live": False,
                "lifecycleState": "ended",
                "interactionState": "ended",
                "output": {"nextSequence": 3},
                "exit": {"exitCode": 0},
            },
        ],
    ]
    inspected = []

    def wait_for_session(
        _invoke, _ref, predicate, *, timeout_seconds, event_driven=False
    ):
        assert timeout_seconds is None
        assert event_driven is True
        for status in observations.pop(0):
            inspected.append(status["interactionState"])
            if predicate(status):
                return status
        raise AssertionError("expected one observed status to satisfy the boundary")

    def invoke(request):
        if request["operation"] == "plan-start":
            return {"root": "sha256:" + "1" * 64}
        if request["operation"] == "start":
            return {}
        if request["operation"] == "snapshot":
            return {"terminal": {"vt": {"lines": ["reviewable output"]}}}
        raise AssertionError(request["operation"])

    def invoke_control(_invoke, _ref, operation, _payload):
        return {"status": "granted" if operation == "acquire-control" else "written"}

    coordinator = ManagedRunCoordinator(
        session_ref=lambda _work, run_id: {
            "workConsoleId": "console:test",
            "sessionAttemptId": run_id,
        },
        semantic_root=lambda _value: "sha256:" + "2" * 64,
        wait_for_session=wait_for_session,
        invoke_control=invoke_control,
        result_factory=lambda **kwargs: SimpleNamespace(**kwargs),
    )
    result, session = coordinator.run(
        invoke=invoke,
        run_id="attempt:test",
        selected={
            "id": "kungfu.mock-agent.recovery-delivery",
            "provider": "synthetic",
            "launch": {
                "executable": "/usr/bin/node",
                "argv": [
                    "/mock-provider.mjs",
                    "--scenario",
                    "recovery-delivery",
                ],
            },
        },
        verification={"version": "1.1.0"},
        work={"workspaceId": "workspace:test"},
        cwd="/tmp",
        env={},
        prompt="finish the retained Work",
        timeout_seconds=1,
    )

    assert inspected == ["ready", "unknown", "ready", "ended", "ended"]
    assert result.exit_code == 0
    assert session["live"] is False
    assert session["interactionState"] == "ended"


def test_provider_discovery_replaces_invalid_utf8_from_version_probe(monkeypatch):
    real_run = subprocess.run

    def invalid_version(_argv, **kwargs):
        return real_run(
            [sys.executable, *_invalid_utf8_version_command()],
            **kwargs,
        )

    monkeypatch.setattr(provider_discovery.subprocess, "run", invalid_version)

    assert provider_discovery._default_version_probe("provider") == ("provider � 1.2.3")


def _invalid_utf8_git_failure(real_run):
    def run(_argv, **kwargs):
        return real_run(
            [
                sys.executable,
                "-c",
                "import os; os.write(2, b'not a repo: \\xb2\\n'); raise SystemExit(1)",
            ],
            **kwargs,
        )

    return run


def test_runtime_home_git_probe_replaces_invalid_utf8(monkeypatch, tmp_path):
    real_run = subprocess.run
    monkeypatch.setattr(config.subprocess, "run", _invalid_utf8_git_failure(real_run))

    assert config._git_worktree_root(str(tmp_path)) is None


def test_workspace_guidance_git_probe_replaces_invalid_utf8(monkeypatch, tmp_path):
    real_run = subprocess.run
    monkeypatch.setattr(
        workspace_guidance.subprocess, "run", _invalid_utf8_git_failure(real_run)
    )

    assert workspace_guidance._git_root(str(tmp_path)) is None


def test_run_intent_dispatcher_keeps_native_and_managed_paths_explicit():
    dispatcher = RunIntentDispatcher()
    native = {
        "task": None,
        "work_selector": None,
        "workspace_root": None,
        "plan_only": False,
        "as_json": False,
        "events_json": False,
        "expected_plan_root": None,
        "allow_foreign_binding": False,
    }
    assert dispatcher.provider_mode(native) == "native"
    assert dispatcher.provider_mode({**native, "workspace_root": "/project"}) == (
        "managed"
    )
    assert (
        dispatcher.dispatch_provider(
            request=native, native=lambda: "native", managed=lambda: "managed"
        )
        == "native"
    )


def test_python_session_services_are_import_closed_and_bounded():
    assert all(
        value is not None
        for value in (
            NativeLaunchCoordinator,
            ManagedRunCoordinator,
            RuntimeProfileCatalog,
            ProviderBootstrapAdapter,
            VerificationProbe,
            RuntimeProfileStore,
        )
    )
    agent_root = ROOT / "src" / "python" / "kungfu" / "agent"
    budgets = {
        agent_root / "run_agent.py": 1450,
        agent_root / "runtime_profiles.py": 800,
        ROOT / "src" / "python" / "kungfu" / "cli" / "commands" / "run.py": 900,
    }
    for source, maximum in budgets.items():
        assert len(source.read_text(encoding="utf-8").splitlines()) <= maximum
    assert "kungfu.cli" not in (agent_root / "native_launch.py").read_text(
        encoding="utf-8"
    )
    assert "kungfu.cli" not in (agent_root / "managed_run.py").read_text(
        encoding="utf-8"
    )
