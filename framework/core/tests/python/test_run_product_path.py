# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from click.testing import CliRunner

from kungfu import assignment_lifecycle
from kungfu import assignment_orchestration as orchestration
from kungfu.agent import first_value as onboarding
from kungfu.agent import managed_run
from kungfu.agent import native_launch
from kungfu.agent import run_agent
from kungfu.cli.commands import assignment, assignment_review, kfc, run
from kungfu.workspace import (
    inspect_workspace,
    resolve_workspace_target,
    select_workspace,
)


@pytest.mark.parametrize("command", ["claim", "status", "gate"])
def test_assignment_identity_options_are_reusable_across_commands(command):
    result = CliRunner().invoke(kfc, ["work", command, "--help"])

    assert result.exit_code == 0, result.output
    assert "--workspace" in result.output
    assert "--initiative-id" in result.output
    assert "--assignment-id" in result.output


def _capture(project: Path, assignment_id: str):
    target = resolve_workspace_target("capture-only", str(project), cwd=str(project))
    request = {
        "schema": "kungfu.assignment-request/v1",
        "source": {"kind": "test"},
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {
            "assignment_id": assignment_id,
            "initiative_id": "project-work",
            "title": assignment_id,
            "objective": f"Complete {assignment_id}",
            "acceptance_criteria": ["Result exists"],
        },
    }
    return orchestration.capture_assignment_request(request, target)


def test_agent_activity_history_projection_keeps_process_success_outside_work():
    work = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "project:history-fixture",
        "profileId": "work-control",
        "profileRoot": "sha256:" + "a" * 64,
        "entityType": "assignment",
        "entityId": "history-fixture",
        "entityRoot": "sha256:" + "b" * 64,
        "purpose": "qualify exact history continuity",
        "systemTimeCut": "2026-08-01T00:00:00Z",
    }

    projection = run_agent.agent_activity_history_projection(
        work, entrypoint="native-agent-ui"
    )

    assert projection["schema"] == "kungfu.work-agent-history.projection/v1"
    assert projection["state"] == "session-activity-only"
    assert projection["entrypoint"] == "native-agent-ui"
    assert projection["workRefRoot"] == run_agent.canonical_root(work)
    assert projection["semanticAdmissionReceiptRoot"] is None
    assert projection["processExitSettlesWork"] is False
    assert projection["selfReportSettlesWork"] is False
    assert projection["nextAction"] == "independent-assessment-required"


def test_assignment_session_invoker_bounds_provider_writes_beyond_read_probes():
    calls = []

    class Surface:
        @staticmethod
        def ensure(runtime_dir):
            assert runtime_dir == "/tmp/runtime"
            return "/tmp/agent-session.sock"

        @staticmethod
        def invoke(request, *, endpoint, timeout):
            calls.append((request["operation"], endpoint, timeout))
            return {"operation": request["operation"]}

    invoke = assignment_lifecycle.session_invoker(Surface, "/tmp/runtime")
    assert invoke({"operation": "status"}) == {"operation": "status"}
    assert invoke({"operation": "instruct"}) == {"operation": "instruct"}

    assert calls == [
        ("status", "/tmp/agent-session.sock", 5.0),
        ("instruct", "/tmp/agent-session.sock", 30.0),
    ]


def test_next_work_selects_the_only_captured_assignment(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")

    selected = run._choose_work(str(project))

    assert selected["assignmentId"] == "first"
    assert selected["phase"] == "captured"


def test_next_work_requires_explicit_selection_when_ambiguous(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    _capture(project, "second")

    with pytest.raises(ValueError, match="multiple Work items"):
        run._choose_work(str(project))

    assert (
        run._choose_work(str(project), work_selector="second")["assignmentId"]
        == "second"
    )


def test_explicit_work_selector_can_start_a_fresh_attempt_while_work_executes(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    monkeypatch.setattr(run, "_work_phase", lambda *_args: "executing")

    selected = run._choose_work(str(project), work_selector="first")

    assert selected["assignmentId"] == "first"
    assert selected["phase"] == "executing"
    with pytest.raises(ValueError, match="no Work can start"):
        run._choose_work(str(project))


def test_explicit_settled_work_reaches_the_fail_closed_start_plan(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    monkeypatch.setattr(run, "_work_phase", lambda *_args: "continuation-decided")

    selected = run._choose_work(str(project), work_selector="first")

    assert selected["assignmentId"] == "first"
    assert selected["phase"] == "continuation-decided"
    with pytest.raises(ValueError, match="no Work can start"):
        run._choose_work(str(project))


@pytest.mark.parametrize(
    ("phase", "mode", "stages"),
    [
        ("captured", "first-attempt", ["admit", "claim", "kickoff", "run", "retain"]),
        ("admitted", "existing-admitted-work", ["claim", "kickoff", "run", "retain"]),
        ("claimed", "existing-claimed-work", ["kickoff", "run", "retain"]),
        ("executing", "existing-executing-work", ["run", "retain"]),
    ],
)
def test_work_start_phase_plan_only_uses_legal_forward_transitions(phase, mode, stages):
    actual_mode, effects, blocked_reason = assignment._work_start_phase_plan(phase)

    assert actual_mode == mode
    assert [effect["stage"] for effect in effects] == stages
    assert blocked_reason is None


@pytest.mark.parametrize(
    "phase",
    [
        "stage-ready",
        "completion-claimed",
        "independently-reviewed",
        "continuation-decided",
    ],
)
def test_work_start_phase_plan_rejects_settled_or_review_work(phase):
    mode, effects, blocked_reason = assignment._work_start_phase_plan(phase)

    assert mode is None
    assert effects == []
    assert phase in blocked_reason


def test_codex_work_start_plan_discloses_exact_invocation_project_trust(tmp_path):
    effects = [{"stage": "run", "label": "Launch Codex"}]
    grant = assignment_review.provider_project_trust("codex", str(tmp_path))

    assert grant == {
        "schema": "kungfu.agent-project-trust/v1",
        "provider": "codex",
        "workspaceRoot": str(tmp_path),
        "scope": "single-invocation",
        "allows": [
            "project-local-config",
            "project-local-hooks",
            "project-local-exec-policies",
        ],
        "persistent": False,
    }
    planned = assignment_review.effects_with_project_trust(effects, grant)
    assert [effect["stage"] for effect in planned] == ["project-trust", "run"]
    assert str(tmp_path) in planned[0]["label"]
    assert "project-local config, hooks, and exec policies" in planned[0]["label"]
    assert assignment_review.provider_project_trust("claude", str(tmp_path)) is None


def test_codex_project_trust_is_exact_explicit_and_invocation_scoped(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    grant = assignment_review.provider_project_trust("codex", str(project))

    assert managed_run._session_argv("codex", {}, str(project), None) == []
    assert managed_run._session_argv("codex", {}, str(project), grant) == [
        "-c",
        f'projects={{{json.dumps(str(project.resolve()))}={{trust_level="trusted"}}}}',
    ]
    with pytest.raises(ValueError, match="does not match the exact workspace"):
        managed_run._session_argv("codex", {}, str(tmp_path), grant)


def test_managed_work_start_builds_a_strict_assignment_work_ref():
    plan = {
        "work": {
            "initiativeId": "project-work",
            "assignmentId": "first",
        },
        "workControl": {
            "profileId": "kungfu.work-control",
            "profileRoot": "sha256:" + "2" * 64,
        },
    }
    admission = {"workspace": {"workspace_id": "workspace:test"}}
    status = {
        "assignment": {"assignment_id": "first"},
        "query_proof_root": "sha256:" + "3" * 64,
    }

    work_ref = assignment_lifecycle.work_ref(admission, plan, status)

    assert work_ref["initiativeId"] == "project-work"
    assert run_agent.validate_work_ref(work_ref) == work_ref


def test_resumed_authority_writes_remain_visible_when_run_gate_fails(
    tmp_path, monkeypatch
):
    request = tmp_path / "request.json"
    request.write_text("{}\n", encoding="utf-8")
    plan = {
        "planRoot": "sha256:" + "1" * 64,
        "executable": True,
        "blockedReason": None,
        "continuationMode": "existing-admitted-work",
        "workspace": {"id": "workspace:test", "root": str(tmp_path)},
        "work": {
            "initiativeId": "project-work",
            "assignmentId": "first",
            "phase": "admitted",
            "objective": "Verify bound-session ordering",
            "acceptanceChecks": ["Run gate is checked before instruction"],
        },
        "agent": {
            "id": "kungfu.mock-agent",
            "label": "Mock Agent",
            "provider": "synthetic",
        },
        "workControl": {
            "profileId": "kungfu.work-control",
            "profileRoot": "sha256:" + "2" * 64,
        },
    }
    statuses = iter(
        [
            {"phase": "admitted", "query_proof_root": "sha256:" + "3" * 64},
            {
                "phase": "claimed",
                "query_proof_root": "sha256:" + "4" * 64,
                "assignment": {"assignment_id": "first"},
            },
        ]
    )
    monkeypatch.setattr(assignment, "_work_start_plan", lambda **_kwargs: plan)
    monkeypatch.setattr(
        assignment,
        "resolve_workspace_target",
        lambda *_args, **_kwargs: SimpleNamespace(runtime_dir=tmp_path / "runtime"),
    )
    monkeypatch.setattr(assignment, "_status", lambda *_args: next(statuses))
    monkeypatch.setattr(
        assignment,
        "_profile_action",
        lambda *_args, **_kwargs: {
            "claim": {
                "claim_id": "claim-1",
                "lease_id": "lease-1",
                "lease_expires_at": "2026-08-01T02:00:00Z",
                "agent": "kungfu.mock-agent",
            },
            "receipt": {"payload_hash": "sha256:" + "5" * 64},
        },
    )
    monkeypatch.setattr(
        assignment,
        "_advance",
        lambda *_args, **_kwargs: {
            "transition": {
                "claim_id": "transition-1",
                "lease_id": "lease-1",
                "from_phase": "claimed",
                "to_phase": "executing",
            },
            "status": {
                "phase": "executing",
                "query_proof_root": "sha256:" + "6" * 64,
            },
            "receipt": {"payload_hash": "sha256:" + "7" * 64},
        },
    )
    monkeypatch.setattr(
        assignment.orchestration,
        "gate",
        lambda *_args: {"ok": False, "reason": "test run gate failure"},
    )
    monkeypatch.setattr(
        assignment.run_agent.session_surface,
        "ensure",
        lambda *_args: "session-endpoint",
    )

    def start_bound_session(**kwargs):
        assert kwargs["work_ref"]["initiativeId"] == "project-work"
        run_agent.session_contract.validate_work_ref(kwargs["work_ref"])
        kwargs["session_started_callback"](
            {
                "workConsoleId": "work:kungfu.work-control:assignment:first",
                "sessionAttemptId": "agent-test",
            },
            {"status": "started"},
        )
        raise AssertionError("run gate should fail before the first instruction")

    monkeypatch.setattr(assignment.run_agent, "execute", start_bound_session)

    result = assignment.start_work.callback.__wrapped__(
        SimpleNamespace(config_home=str(tmp_path), home=str(tmp_path)),
        request,
        str(tmp_path),
        False,
        "project-work",
        "first",
        "kungfu.mock-agent",
        "local-user",
        plan["planRoot"],
        True,
        False,
        False,
        False,
    )

    assert result["ok"] is False
    assert result["failedAt"] == "kickoff"
    assert result["workPhase"] == "executing"
    assert result["writeOccurred"] is True
    assert set(result["authorityReceipts"]) == {"claim", "kickoff"}


def test_task_capture_creates_a_bounded_assignment_not_runtime(tmp_path):
    project = tmp_path / "project"
    project.mkdir()

    selected = run._capture_task(str(project), "Write a concise launch note")

    assert selected["phase"] == "captured"
    assert selected["initiativeId"] == "project-work"
    assert Path(selected["requestPath"]).is_file()
    assert not (project / ".kungfu" / "runtime").exists()


def test_agent_route_completion_persists_shared_onboarding_state(tmp_path):
    config_home = tmp_path / "config"
    runtime_home = tmp_path / "runtime"
    onboarding.kungfu_config.set_user_config_value(
        "ui.onboarding",
        {
            "version": 1,
            "status": "started",
            "route": "tour",
            "labCompleted": True,
            "tourCompleted": False,
            "completedAt": "",
        },
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )

    receipt = onboarding.complete_agent_route(
        config_home=str(config_home), runtime_home=str(runtime_home)
    )

    assert receipt["state"]["status"] == "completed"
    assert receipt["state"]["route"] == "agent"
    assert receipt["state"]["labCompleted"] is True
    assert receipt["state"]["tourCompleted"] is False
    assert receipt["state"]["completedAt"].endswith("Z")
    saved = onboarding.kungfu_config.resolve_config(
        config_home=str(config_home), runtime_home=str(runtime_home)
    )["config"]["ui"]["onboarding"]
    assert saved == receipt["state"]


def test_run_from_a_fresh_directory_converges_on_agent_first_onboarding(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    for name in (
        "KF_HOME",
        "KF_RUNTIME_DIR",
        "KF_WORKSPACE_ROOT",
        "KUNGFU_WORKSPACE_ROOT",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("KF_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setattr(
        run,
        "_provider_profile",
        lambda *_args, **_kwargs: {
            "id": "codex.test",
            "provider": "codex",
        },
    )
    monkeypatch.setattr(run.run_agent.session_surface, "ensure", lambda *_args: "sock")
    launches = []
    monkeypatch.setattr(
        run.run_agent,
        "run_native_interactive",
        lambda *_args, **kwargs: launches.append(kwargs) or 0,
    )

    result = CliRunner().invoke(kfc, ["--home", str(tmp_path / "home"), "run", "codex"])

    assert result.exit_code == 0, result.output
    assert launches[0]["workspace_root"] == str(tmp_path)
    assert launches[0]["work_ref"] is None
    assert launches[0]["work_selection"]["state"] == "none"
    assert (
        "starting codex in this directory without durable Work binding" in result.output
    )
    assert "Codex may ask whether to trust" in result.output


def test_native_launch_uses_the_selected_current_project_outside_it(
    tmp_path, monkeypatch
):
    source = tmp_path / "outside"
    project = tmp_path / "selected"
    source.mkdir()
    project.mkdir()
    target = SimpleNamespace(
        identity=SimpleNamespace(
            workspace_kind="project",
            workspace_root=str(project),
            workspace_id="project:selected",
        ),
        runtime_dir=project / ".kungfu" / "runtime",
    )
    for name in (
        "KF_HOME",
        "KF_RUNTIME_DIR",
        "KF_WORKSPACE_ROOT",
        "KUNGFU_WORKSPACE_ROOT",
    ):
        monkeypatch.delenv(name, raising=False)

    def resolve(_operation, workspace_root=None, **_kwargs):
        if workspace_root == str(project):
            return target
        raise native_launch.WorkspaceTargetRequired("read-only", str(source))

    monkeypatch.setattr(native_launch, "resolve_workspace_target", resolve)
    monkeypatch.setattr(
        native_launch,
        "load_workspace_registry",
        lambda **_kwargs: {
            "last_workspace_id": "project:selected",
            "recent": [
                {
                    "workspace_id": "project:selected",
                    "workspace_kind": "project",
                    "workspace_root": str(project),
                }
            ],
        },
    )

    resolved, launch_root, reason = native_launch.resolve_native_launch_target(
        SimpleNamespace(
            config_home=str(tmp_path / "config"), home=str(tmp_path / "home")
        ),
        cwd=str(source),
    )

    assert resolved is target
    assert launch_root == str(project)
    assert reason == "selected-project"


def test_native_launch_prefers_the_working_directory_project_to_global_current(
    tmp_path, monkeypatch
):
    source = tmp_path / "project"
    source.mkdir()
    target = SimpleNamespace(
        identity=SimpleNamespace(
            workspace_kind="project",
            workspace_root=str(source),
            workspace_id="project:cwd",
        ),
        runtime_dir=source / ".kungfu" / "runtime",
    )
    for name in (
        "KF_HOME",
        "KF_RUNTIME_DIR",
        "KF_WORKSPACE_ROOT",
        "KUNGFU_WORKSPACE_ROOT",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(
        native_launch,
        "resolve_workspace_target",
        lambda *_args, **_kwargs: target,
    )
    monkeypatch.setattr(
        native_launch,
        "load_workspace_registry",
        lambda **_kwargs: pytest.fail("global current Project should not be read"),
    )

    resolved, launch_root, reason = native_launch.resolve_native_launch_target(
        SimpleNamespace(
            config_home=str(tmp_path / "config"), home=str(tmp_path / "home")
        ),
        cwd=str(source),
    )

    assert resolved is target
    assert launch_root == str(source)
    assert reason == "working-directory-project"


def test_successful_managed_work_start_completes_agent_onboarding(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    request = project / "request.json"
    request.write_text("{}\n", encoding="utf-8")
    target = SimpleNamespace(
        identity=SimpleNamespace(
            workspace_kind="project",
            workspace_root=str(project),
        )
    )
    monkeypatch.setattr(
        native_launch,
        "resolve_native_launch_target",
        lambda *_args, **_kwargs: (target, str(project), "explicit-project"),
    )
    monkeypatch.setattr(
        run,
        "_capture_task",
        lambda *_args: {
            "requestPath": str(request),
            "initiativeId": "project-work",
            "assignmentId": "first",
            "title": "First Work",
        },
    )
    monkeypatch.setattr(
        run,
        "_provider_profile",
        lambda *_args, **_kwargs: {"id": "kungfu.mock", "provider": "synthetic"},
    )
    monkeypatch.setattr(
        assignment,
        "_work_start_plan",
        lambda **_kwargs: {
            "planRoot": "sha256:" + "1" * 64,
            "workspace": {"root": str(project)},
            "work": {"assignmentId": "first", "title": "First Work"},
            "agent": {
                "label": "Mock Agent",
                "verification": {"version": "1.0.0"},
            },
            "effects": [],
        },
    )
    monkeypatch.setattr(
        assignment.start_work.callback,
        "__wrapped__",
        lambda *_args, **_kwargs: {"ok": True, "workPhase": "executing"},
    )
    completed = []
    monkeypatch.setattr(
        onboarding,
        "complete_agent_route",
        lambda **kwargs: completed.append(kwargs) or {"state": {"status": "completed"}},
    )

    result = run._run_provider(
        SimpleNamespace(
            config_home=str(tmp_path / "config"), home=str(tmp_path / "home")
        ),
        "synthetic",
        "First Work",
        None,
        str(project),
        False,
        True,
        False,
        None,
        False,
    )

    assert result["ok"] is True
    assert completed == [
        {
            "config_home": str(tmp_path / "config"),
            "runtime_home": str(tmp_path / "home"),
        }
    ]


def test_managed_provider_plan_uses_selected_current_project_outside_it(
    tmp_path, monkeypatch
):
    source = tmp_path / "outside"
    project = tmp_path / "selected"
    source.mkdir()
    project.mkdir()
    request = project / "request.json"
    request.write_text("{}\n", encoding="utf-8")
    config_home = tmp_path / "config"
    runtime_home = tmp_path / "home"
    environment = {
        "HOME": str(tmp_path / "user"),
        "KF_CONFIG_HOME": str(config_home),
        "KF_HOME": str(runtime_home),
    }
    identity = inspect_workspace(str(project), env=environment)
    assert identity is not None
    select_workspace(identity, config_home=str(config_home), env=environment)
    monkeypatch.chdir(source)
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    for name in ("KF_WORKSPACE_ROOT", "KF_RUNTIME_DIR", "KUNGFU_WORKSPACE_ROOT"):
        monkeypatch.delenv(name, raising=False)

    selected_roots = []
    monkeypatch.setattr(
        run,
        "_choose_work",
        lambda root, **_kwargs: (
            selected_roots.append(root)
            or {
                "requestPath": str(request),
                "initiativeId": "project-work",
                "assignmentId": "first",
            }
        ),
    )
    monkeypatch.setattr(
        run,
        "_provider_profile",
        lambda *_args, **_kwargs: {"id": "codex.test", "provider": "codex"},
    )
    monkeypatch.setattr(
        assignment,
        "_work_start_plan",
        lambda **_kwargs: {
            "planRoot": "sha256:" + "1" * 64,
            "workspace": {"root": str(project)},
            "work": {"assignmentId": "first", "title": "First Work"},
            "agent": {
                "label": "Codex",
                "verification": {"version": "1.0.0"},
            },
            "effects": [],
        },
    )

    run._run_provider(
        SimpleNamespace(config_home=str(config_home), home=str(runtime_home)),
        "codex",
        None,
        None,
        None,
        True,
        True,
        False,
        None,
        False,
    )

    assert selected_roots == [str(project)]


def test_only_bare_provider_invocation_selects_native_interactive_mode():
    defaults = {
        "task": None,
        "work_selector": None,
        "workspace_root": None,
        "plan_only": False,
        "as_json": False,
        "events_json": False,
        "expected_plan_root": None,
        "allow_foreign_binding": False,
    }
    assert run._native_provider_request(**defaults) is True
    for field, value in (
        ("task", "bounded task"),
        ("work_selector", "work-1"),
        ("workspace_root", "/project"),
        ("plan_only", True),
        ("as_json", True),
        ("events_json", True),
        ("expected_plan_root", "sha256:" + "a" * 64),
        ("allow_foreign_binding", True),
    ):
        request = {**defaults, field: value}
        assert run._native_provider_request(**request) is False, field


@pytest.mark.parametrize("provider", ["codex", "claude", "amp", "opencode"])
def test_bare_provider_cli_dispatches_native_without_managed_work(
    tmp_path, monkeypatch, provider
):
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        run,
        "_run_native_provider",
        lambda ctx, **kwargs: calls.append((ctx, kwargs)),
    )
    monkeypatch.setattr(
        run,
        "_run_provider",
        lambda *_args, **_kwargs: pytest.fail("managed Work path was selected"),
    )

    result = CliRunner().invoke(
        kfc, ["--home", str(tmp_path / "home"), "run", provider]
    )

    assert result.exit_code == 0, result.output
    assert calls[0][1] == {"provider": provider}


def test_native_provider_failure_leaves_actionable_terminal_error(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.chdir(project)
    target = SimpleNamespace(
        identity=SimpleNamespace(
            workspace_kind="project",
            workspace_root=str(project),
            workspace_id="workspace:test",
        ),
        runtime_dir=project / ".kungfu" / "runtime",
    )
    monkeypatch.setattr(
        run, "resolve_workspace_target", lambda *_args, **_kwargs: target
    )
    monkeypatch.setattr(
        run,
        "_provider_profile",
        lambda *_args, **_kwargs: {"provider": "codex"},
    )
    monkeypatch.setattr(
        run,
        "_native_work_binding",
        lambda *_args, **_kwargs: (
            None,
            {
                "schema": "kungfu.native-work-selection/v1",
                "workspaceId": "workspace:test",
                "state": "none",
            },
        ),
    )
    monkeypatch.setattr(run.run_agent.session_surface, "ensure", lambda *_args: "sock")
    completed = []
    monkeypatch.setattr(
        onboarding,
        "complete_agent_route",
        lambda **kwargs: completed.append(kwargs) or {"state": {"status": "completed"}},
    )
    monkeypatch.setattr(
        run,
        "_native_work_observer",
        lambda *_args: {"state": "active"},
    )

    def fail_after_binding(*_args, **kwargs):
        bound_work_ref = {
            "initiativeId": "project-work",
            "entityId": "assignment:first",
        }
        kwargs["work_observer"](bound_work_ref)
        kwargs["work_observer"](bound_work_ref)
        return 7

    monkeypatch.setattr(
        run.run_agent,
        "run_native_interactive",
        fail_after_binding,
    )

    result = CliRunner().invoke(kfc, ["--home", str(tmp_path / "home"), "run", "codex"])

    assert result.exit_code == 7
    assert "Error: provider-native UI 'codex' exited with status 7." in result.output
    assert "did not change Work completion" in result.output
    assert "kungfu agent session list --json" in result.output
    assert len(completed) == 1
    assert completed[0]["runtime_home"] == str(tmp_path / "home")


@pytest.mark.parametrize("provider", ["codex", "claude", "amp", "opencode"])
def test_parameterized_provider_cli_preserves_managed_path(
    tmp_path, monkeypatch, provider
):
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        run,
        "_run_native_provider",
        lambda *_args, **_kwargs: pytest.fail("native UI path was selected"),
    )
    monkeypatch.setattr(
        run,
        "_run_provider",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    result = CliRunner().invoke(
        kfc,
        ["--home", str(tmp_path / "home"), "run", provider, "bounded task"],
    )

    assert result.exit_code == 0, result.output
    assert calls[0][0][1:3] == (provider, "bounded task")


@pytest.mark.parametrize(
    ("option", "value"),
    [
        ("--work", "assignment:alpha"),
        ("--workspace", "{project}"),
        ("--plan", None),
        ("--json", None),
        ("--events-json", None),
        ("--expected-plan-root", "sha256:" + "1" * 64),
    ],
)
def test_every_provider_control_option_preserves_managed_dispatch(
    tmp_path, monkeypatch, option, value
):
    project = tmp_path / "project"
    project.mkdir()
    calls = []
    monkeypatch.chdir(project)
    monkeypatch.setattr(
        run,
        "_run_native_provider",
        lambda *_args, **_kwargs: pytest.fail("native UI path was selected"),
    )
    monkeypatch.setattr(
        run,
        "_run_provider",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )
    argument = str(project) if value == "{project}" else value
    argv = ["--home", str(tmp_path / "home"), "run", "codex", option]
    if argument is not None:
        argv.append(argument)

    result = CliRunner().invoke(kfc, argv)

    assert result.exit_code == 0, result.output
    assert len(calls) == 1


def test_bare_run_agent_dispatches_native_default(tmp_path, monkeypatch):
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        run,
        "_run_native_provider",
        lambda ctx, **kwargs: calls.append((ctx, kwargs)),
    )

    result = CliRunner().invoke(kfc, ["--home", str(tmp_path / "home"), "run", "agent"])

    assert result.exit_code == 0, result.output
    assert calls[0][1] == {"profile_id": None, "workspace_root": None}


def test_bare_run_agent_dispatches_registered_third_party_profile(
    tmp_path, monkeypatch
):
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        run,
        "_run_native_provider",
        lambda ctx, **kwargs: calls.append((ctx, kwargs)),
    )

    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "run",
            "agent",
            "--agent",
            "termagent.path.local",
        ],
    )

    assert result.exit_code == 0, result.output
    assert calls[0][1] == {
        "profile_id": "termagent.path.local",
        "workspace_root": None,
    }


def test_run_agent_managed_controls_still_require_prompt(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(
        kfc,
        ["--home", str(tmp_path / "home"), "run", "agent", "--json"],
    )

    assert result.exit_code == 2
    assert "--work-ref, --continuation, --timeout, and --json require --prompt" in (
        result.output
    )


def test_run_agent_prompt_and_explicit_profile_preserve_managed_execution(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    calls = []
    monkeypatch.chdir(project)

    def execute(**kwargs):
        calls.append(kwargs)
        return {
            "runId": "run:test",
            "runtimeProfile": {"provider": "codex"},
            "launch": {"exitCode": 0},
            "episode": {"manifestPath": str(tmp_path / "episode.json")},
        }

    monkeypatch.setattr(run.run_agent, "execute", execute)
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "run",
            "agent",
            "--prompt",
            "bounded task",
            "--agent",
            "codex-explicit",
            "--workspace",
            str(project),
        ],
    )

    assert result.exit_code == 0, result.output
    assert len(calls) == 1
    assert calls[0]["prompt"] == "bounded task"
    assert calls[0]["profile_id"] == "codex-explicit"
    assert calls[0]["workspace_root"] == str(project)
    assert calls[0]["work_ref"] is None
    assert calls[0]["continuation"] is None
    assert calls[0]["timeout_seconds"] == 900.0


def test_native_work_binding_never_guesses_between_assignments(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    _capture(project, "second")
    monkeypatch.setattr(run, "_work_phase", lambda *_args: "executing")

    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert work_ref is None
    assert selection["state"] == "ambiguous"
    assert selection["candidateAssignmentIds"] == ["first", "second"]


def test_native_work_binding_with_no_work_is_read_only(tmp_path):
    project = tmp_path / "project"
    project.mkdir()

    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert work_ref is None
    assert selection["state"] == "none"
    assert not (project / ".kungfu").exists()


@pytest.mark.parametrize("phase", [*orchestration.PHASES, "ready", "planned"])
def test_native_work_binding_discovers_but_does_not_claim_the_only_current_work(
    tmp_path, monkeypatch, phase
):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    monkeypatch.setattr(run, "_work_phase", lambda *_args: phase)
    monkeypatch.setattr(
        orchestration,
        "list_sealed_assignment_states",
        lambda *_args: {
            "states": [],
            "unqualified_states": [],
            "issues": [],
        },
    )
    monkeypatch.setattr(
        "kungfu.cli.commands.assignment._status",
        lambda *_args: {
            "assignment": {"assignment_id": "first", "phase": phase},
            "query_proof_root": "sha256:" + "1" * 64,
        },
    )
    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert selection["state"] == "single"
    assert work_ref is None
    assert selection["assignmentId"] == "first"
    assert selection["phase"] == phase


def test_native_work_binding_reports_one_captured_request_without_admitting(
    tmp_path,
):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")

    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert work_ref is None
    assert selection["state"] == "single"
    assert selection["candidateAssignmentIds"] == ["first"]
    assert selection["assignmentId"] == "first"
    assert selection["phase"] == "captured"
    assert not (project / ".kungfu" / "runtime").exists()


def test_native_work_binding_excludes_portably_settled_work(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    monkeypatch.setattr(run, "_work_phase", lambda *_args: "continuation-decided")
    monkeypatch.setattr(
        orchestration,
        "list_sealed_assignment_states",
        lambda *_args: {
            "states": [
                {
                    "assignment_subject": "kungfu:first",
                    "settled": True,
                }
            ],
            "unqualified_states": [],
            "issues": [],
        },
    )

    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert work_ref is None
    assert selection["state"] == "none"
    assert selection["candidateAssignmentIds"] == []
    assert selection["settledAssignmentIds"] == ["first"]


def test_native_work_binding_degrades_when_settlement_is_ambiguous(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    monkeypatch.setattr(run, "_work_phase", lambda *_args: "continuation-decided")
    monkeypatch.setattr(
        orchestration,
        "list_sealed_assignment_states",
        lambda *_args: {
            "states": [],
            "unqualified_states": [],
            "issues": [{"code": "sealed-assignment-state-invalid"}],
        },
    )

    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert work_ref is None
    assert selection["state"] == "degraded"
    assert selection["candidateAssignmentIds"] == ["first"]
    assert "cannot prove" in selection["diagnostic"]


def test_native_work_observer_reads_fresh_core_state_without_mutation(
    tmp_path, monkeypatch
):
    root = "sha256:" + "1" * 64
    monkeypatch.setattr(
        "kungfu.cli.commands.assignment._status",
        lambda *_args: {
            "assignment": {
                "title": "Native continuity",
                "objective": "Keep Work visible across native UIs",
                "work_definition": {
                    "acceptance_criteria": ["Rediscover the same Work"]
                },
                "evidenceEpisodeRoots": [root],
            },
            "phase": "executing",
            "query_proof_root": root,
            "next_actions": [
                {
                    "action": "stage",
                    "description": "Record the stage-ready boundary",
                }
            ],
        },
    )

    observed = run._native_work_observer(
        tmp_path,
        {
            "state": "bound",
            "initiativeId": "initiative:alpha",
            "assignmentId": "assignment:alpha",
            "phase": "executing",
        },
    )

    assert observed["state"] == "fresh"
    assert observed["work"] == {
        "schema": "kungfu.native-work-observation/v1",
        "state": "available",
        "initiativeId": "initiative:alpha",
        "assignmentId": "assignment:alpha",
        "title": "Native continuity",
        "objective": "Keep Work visible across native UIs",
        "acceptanceChecks": ["Rediscover the same Work"],
        "phase": "executing",
        "queryProofRoot": root,
        "nextActions": ["stage: Record the stage-ready boundary"],
        "evidenceEpisodeRoots": [root],
        "continuation": {
            "completionClaimCount": 0,
            "independentReviewCount": 0,
            "continuationDecisionCount": 0,
        },
        "remainingObligation": None,
        "nextAction": "stage: Record the stage-ready boundary",
    }


def test_native_work_observer_exposes_none_ambiguous_and_degraded(tmp_path):
    none = run._native_work_observer(tmp_path, {"state": "none"})
    ambiguous = run._native_work_observer(tmp_path, {"state": "ambiguous"})
    degraded = run._native_work_observer(
        tmp_path,
        {"state": "single-unbound", "diagnostic": "proof unavailable"},
    )

    assert none["work"]["state"] == "none"
    assert ambiguous["work"]["state"] == "ambiguous"
    assert degraded["state"] == "degraded"
    assert degraded["work"]["state"] == "degraded"
    assert degraded["diagnostic"] == "proof unavailable"


def test_unbound_native_work_observer_does_not_load_work_authority(
    monkeypatch, tmp_path
):
    import builtins

    original_import = builtins.__import__

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "kungfu.cli.commands" and "assignment" in fromlist:
            raise AssertionError("unbound observer loaded Work authority")
        return original_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", guarded_import)

    for state in ("none", "ambiguous", "single", "single-unbound"):
        observed = run._native_work_observer(
            tmp_path,
            {"state": state, "diagnostic": "proof unavailable"},
        )
        assert observed["work"]["state"] in {
            "none",
            "ambiguous",
            "available",
            "degraded",
        }


def test_project_work_session_yields_at_deterministic_attention(tmp_path):
    calls = []
    started_callbacks = []
    statuses = [
        {
            "live": True,
            "lifecycleState": "starting",
            "interactionState": "unknown",
            "output": {"nextSequence": 0},
        },
        {
            "live": True,
            "lifecycleState": "ready",
            "interactionState": "ready",
            "output": {"nextSequence": 10},
        },
        {
            "live": True,
            "lifecycleState": "ready",
            "interactionState": "ready",
            "output": {"nextSequence": 20},
            "controller": {"holderId": "kungfu-project-work"},
        },
        {
            "live": True,
            "lifecycleState": "running",
            "interactionState": "busy",
            "output": {"nextSequence": 30},
            "controller": {"holderId": "kungfu-project-work"},
        },
        {
            "live": True,
            "lifecycleState": "ready",
            "interactionState": "ready",
            "output": {"nextSequence": 42},
            "workAgent": {
                "attempt": "waiting",
                "attention": {
                    "kind": "needs-answer",
                    "nextActions": ["reply", "review-changes", "end-attempt"],
                },
            },
            "product": {"state": "available"},
            "controller": {"holderId": "kungfu-project-work"},
        },
    ]

    def invoke(request):
        calls.append(request)
        operation = request["operation"]
        if operation == "plan-start":
            return {"root": "sha256:" + "1" * 64}
        if operation == "start":
            return {"status": "started"}
        if operation == "status":
            return statuses.pop(0) if len(statuses) > 1 else statuses[0]
        if operation == "plan-control":
            return {"root": "sha256:" + "2" * 64}
        if operation == "acquire-control":
            return {"status": "granted"}
        if operation == "instruct":
            return {"status": "written"}
        if operation == "snapshot":
            return {
                "terminal": {
                    "vt": {
                        "lines": [
                            "MOCK WORKING: inspect project",
                            "MOCK NEEDS ANSWER: choose alpha or beta.",
                            "mock› ",
                        ]
                    }
                }
            }
        raise AssertionError(operation)

    work = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "workspace:test",
        "profileId": "kungfu.work-control",
        "profileRoot": "sha256:" + "3" * 64,
        "entityType": "assignment",
        "entityId": "first",
        "entityRoot": "sha256:" + "4" * 64,
        "purpose": "complete-project-assignment",
        "systemTimeCut": "sha256:" + "5" * 64,
    }
    selected = {
        "id": "kungfu.mock-agent.multi-step",
        "provider": "synthetic",
        "launch": {
            "executable": "/usr/bin/node",
            "argv": ["/mock-provider.mjs", "--scenario", "multi-step"],
        },
    }

    result, session = run_agent.run_session_attempt(
        invoke=invoke,
        run_id="agent-test",
        selected=selected,
        verification={"version": "1.0.0"},
        work=work,
        cwd=str(tmp_path),
        env={"PATH": "/usr/bin"},
        prompt="bounded Work",
        timeout_seconds=1,
        session_started_callback=lambda ref, started: started_callbacks.append(
            (dict(ref), dict(started))
        ),
    )

    assert result.exit_code == 0
    assert "MOCK NEEDS ANSWER" in result.stdout
    assert session["live"] is True
    assert session["workAgent"]["attention"]["kind"] == "needs-answer"
    assert started_callbacks == [
        (
            {
                "workConsoleId": "work:kungfu.work-control:assignment:first",
                "sessionAttemptId": "agent-test",
            },
            {"status": "started"},
        )
    ]
    assert (
        calls.index(next(call for call in calls if call["operation"] == "start"))
        < calls.index(
            next(call for call in calls if call["operation"] == "acquire-control")
        )
        < calls.index(next(call for call in calls if call["operation"] == "instruct"))
    )
    start_input = next(
        call["input"] for call in calls if call["operation"] == "plan-start"
    )
    assert start_input["binding"] == {"kind": "work", "workRef": work}
    assert start_input["workConsoleId"] == ("work:kungfu.work-control:assignment:first")


def test_structured_session_retains_its_bounded_agent_answer(tmp_path):
    statuses = iter(
        [
            {
                "live": True,
                "interactionState": "ready",
                "output": {"nextSequence": 1},
                "controller": {"holderId": "kungfu-project-work"},
            },
            {
                "live": True,
                "interactionState": "busy",
                "output": {"nextSequence": 2},
            },
            {
                "live": True,
                "interactionState": "ready",
                "output": {"nextSequence": 3},
            },
        ]
    )

    def invoke(request):
        operation = request["operation"]
        if operation == "plan-start":
            return {"root": "sha256:" + "1" * 64}
        if operation == "start":
            return {"status": "started"}
        if operation == "status":
            return next(statuses)
        if operation == "plan-control":
            return {"root": "sha256:" + "2" * 64}
        if operation == "instruct":
            return {"status": "delivered"}
        if operation == "snapshot":
            return {
                "agentText": "README.md contains exactly one heading.",
                "retainedAgentResponse": True,
                "retainedTranscript": False,
            }
        raise AssertionError(operation)

    work = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "workspace:test",
        "profileId": "kungfu.work-control",
        "profileRoot": "sha256:" + "3" * 64,
        "entityType": "assignment",
        "entityId": "first",
        "entityRoot": "sha256:" + "4" * 64,
        "purpose": "complete-project-assignment",
        "systemTimeCut": "sha256:" + "5" * 64,
    }
    result, _session = run_agent.run_session_attempt(
        invoke=invoke,
        run_id="agent-codex-structured",
        selected={
            "id": "codex.path.test",
            "provider": "codex",
            "launch": {"executable": "/usr/bin/codex", "argv": []},
        },
        verification={"version": "opaque-future-build"},
        work=work,
        cwd=str(tmp_path),
        env={"PATH": "/usr/bin"},
        prompt="inspect README",
        timeout_seconds=1,
    )

    assert result.stdout == "README.md contains exactly one heading."


def test_codex_project_work_session_carries_confirmed_workspace_write_policy(tmp_path):
    calls = []
    observations = iter(
        [
            {
                "live": True,
                "interactionState": "ready",
                "output": {"nextSequence": 1},
                "controller": {"holderId": "kungfu-project-work"},
            },
            {
                "live": True,
                "interactionState": "approval-needed",
                "output": {"nextSequence": 2},
            },
        ]
    )

    def invoke(request):
        calls.append(request)
        operation = request["operation"]
        if operation == "plan-start":
            return {"root": "sha256:" + "1" * 64}
        if operation == "start":
            return {"status": "started"}
        if operation == "status":
            return next(observations)
        if operation == "plan-control":
            return {"root": "sha256:" + "2" * 64}
        if operation == "instruct":
            return {"status": "delivered"}
        if operation == "snapshot":
            return {"terminal": {"vt": {"lines": []}}}
        raise AssertionError(operation)

    work = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "workspace:test",
        "profileId": "kungfu.work-control",
        "profileRoot": "sha256:" + "3" * 64,
        "entityType": "assignment",
        "entityId": "first",
        "entityRoot": "sha256:" + "4" * 64,
        "purpose": "complete-project-assignment",
        "systemTimeCut": "sha256:" + "5" * 64,
    }
    run_agent.run_session_attempt(
        invoke=invoke,
        run_id="agent-codex",
        selected={
            "id": "codex.path.test",
            "provider": "codex",
            "launch": {"executable": "/usr/bin/codex", "argv": []},
        },
        verification={"version": "0.146.0"},
        work=work,
        cwd=str(tmp_path),
        env={"PATH": "/usr/bin"},
        prompt="perform the confirmed Work",
        timeout_seconds=1,
        permission_mode="workspace-write",
    )

    start_input = next(
        call["input"] for call in calls if call["operation"] == "plan-start"
    )
    assert start_input["structured"] == {
        "threadStartParams": {
            "cwd": str(tmp_path),
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
            "sandbox": "workspace-write",
        }
    }


def test_terminal_mock_scenarios_ignore_ready_echo_until_the_process_ends():
    recovery = {
        "provider": "synthetic",
        "launch": {"argv": ["/mock-provider.mjs", "--scenario", "recovery-story"]},
    }
    interactive = {
        "provider": "synthetic",
        "launch": {"argv": ["/mock-provider.mjs", "--scenario", "multi-step"]},
    }
    ready_after_echo = {
        "live": True,
        "interactionState": "ready",
        "output": {"nextSequence": 42},
    }
    ended = {
        "live": False,
        "interactionState": "ended",
        "output": {"nextSequence": 43},
    }

    assert managed_run._terminal_mock_scenario(recovery) is True
    assert managed_run._terminal_mock_scenario(interactive) is False
    assert (
        managed_run._session_boundary_reached(
            ready_after_echo,
            before_sequence=10,
            terminal_mock=True,
        )
        is False
    )
    assert (
        managed_run._session_boundary_reached(
            ready_after_echo,
            before_sequence=10,
            terminal_mock=False,
        )
        is False
    )
    assert (
        managed_run._session_boundary_reached(
            ready_after_echo,
            before_sequence=10,
            terminal_mock=False,
            observed_busy=True,
        )
        is True
    )
    assert (
        managed_run._session_boundary_reached(
            ended,
            before_sequence=10,
            terminal_mock=True,
        )
        is True
    )


def test_initial_session_wait_ignores_only_the_transient_missing_signature():
    assert (
        managed_run._initial_session_boundary_reached(
            {
                "interactionState": "unknown",
                "providerAdapter": {
                    "compatible": True,
                    "reason": "no-supported-state-signature",
                },
            }
        )
        is False
    )
    assert (
        managed_run._initial_session_boundary_reached(
            {
                "interactionState": "unknown",
                "providerAdapter": {
                    "compatible": False,
                    "reason": "foreground-provider-mismatch",
                },
            }
        )
        is True
    )
    assert (
        managed_run._initial_session_boundary_reached(
            {
                "interactionState": "unknown",
                "providerAdapter": {
                    "compatible": True,
                    "reason": "provider-reported-blocked",
                },
            }
        )
        is True
    )
    assert (
        managed_run._initial_session_boundary_reached({"interactionState": "ready"})
        is True
    )


def test_mock_profile_probes_the_deterministic_provider_version():
    profile = run_agent.runtime_profiles.deterministic_mock_profile("approval")
    verification = run_agent.runtime_profiles.verify_profile(profile)

    assert verification["ok"] is True
    assert verification["version"] == "1.1.0"
    assert verification["argv"][-3:] == ["--scenario", "approval", "--version"]


def test_synthetic_provider_retains_its_explicit_qualification_result():
    output = (
        'MOCK WORKING: read retained evidence\nKUNGFU_REVIEW_RESULT {"verdict":"fit"}\n'
    )

    parsed = run_agent.parse_provider_output("synthetic", output)

    assert parsed["text"] == output.strip()


def test_managed_session_retains_its_visible_terminal_answer(tmp_path, monkeypatch):
    retained = "Independent assessment: README has exactly one heading."
    monkeypatch.setattr(
        run_agent,
        "run_session_attempt",
        lambda **_kwargs: (
            run_agent.ProcessResult(0, retained, "", False, False),
            {"schema": "kungfu.agent-run-session/v1"},
        ),
    )
    monkeypatch.setattr(
        run_agent,
        "select_profile",
        lambda *_args, **_kwargs: (
            {
                "id": "codex.test",
                "provider": "codex",
                "cwdPolicy": "workspace-root",
                "launch": {"executable": "/usr/bin/codex", "argv": []},
            },
            {},
        ),
    )
    monkeypatch.setattr(
        run_agent.runtime_profiles,
        "verify_profile",
        lambda _profile: {"ok": True, "version": "0.147.0"},
    )

    result = run_agent.execute(
        prompt="inspect README",
        runtime_dir=str(tmp_path / "runtime"),
        workspace_root=str(tmp_path),
        work_ref={
            "schema": "kungfu.work-ref/v1",
            "workspaceId": "workspace:test",
            "profileId": "kungfu.work-control",
            "profileRoot": "sha256:" + "1" * 64,
            "entityType": "assignment",
            "entityId": "first",
            "initiativeId": "project-work",
            "entityRoot": "sha256:" + "2" * 64,
            "purpose": "complete-project-assignment",
            "systemTimeCut": "sha256:" + "3" * 64,
        },
        session_invoker=lambda _request: {},
        use_session=True,
    )

    response = json.loads(Path(result["episode"]["responsePath"]).read_text())
    assert response["parsed"]["text"] == retained


def test_direct_provider_starts_native_work_before_process_launch(
    tmp_path, monkeypatch
):
    order = []
    work_ref = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "workspace:test",
        "profileId": "kungfu.work-control",
        "profileRoot": "sha256:" + "1" * 64,
        "entityType": "assignment",
        "entityId": "first",
        "initiativeId": "project-work",
        "entityRoot": "sha256:" + "2" * 64,
        "purpose": "complete-project-assignment",
        "systemTimeCut": "sha256:" + "3" * 64,
    }
    monkeypatch.setattr(
        run_agent,
        "select_profile",
        lambda *_args, **_kwargs: (
            {
                "id": "opencode.test",
                "provider": "opencode",
                "cwdPolicy": "workspace-root",
                "launch": {"executable": "/usr/bin/opencode", "argv": []},
            },
            {},
        ),
    )
    monkeypatch.setattr(
        run_agent.runtime_profiles,
        "verify_profile",
        lambda _profile: {"ok": True, "version": "arbitrary-version"},
    )

    def start_work(ref, started):
        order.append(("start", dict(ref), dict(started)))

    def run_process(*_args, **_kwargs):
        order.append(("process", dict(_kwargs["env"])))
        return run_agent.ProcessResult(0, '{"type":"text"}\n', "", False, False)

    result = run_agent.execute(
        prompt="inspect README",
        runtime_dir=str(tmp_path / "runtime"),
        workspace_root=str(tmp_path),
        work_ref=work_ref,
        process_runner=run_process,
        session_invoker=lambda _request: {},
        use_session=True,
        session_started_callback=start_work,
    )

    assert result["launch"]["exitCode"] == 0
    assert order[0][0] == "start"
    assert order[0][1]["workConsoleId"] == (
        "work:kungfu.work-control:assignment:project-work:first"
    )
    assert order[0][2] == {"status": "started", "transport": "direct-process"}
    assert order[1][0] == "process"
    managed_env = order[1][1]
    envelope = json.loads(managed_env["KUNGFU_AGENT_CONSOLE_ENVELOPE"])
    assert envelope["attemptId"] == managed_env["KUNGFU_SKILL_RUN_ID"]
    assert envelope["workRef"] == work_ref
    assert envelope["skillRuntimeAudit"]["workRefRoot"] == run_agent.canonical_root(
        work_ref
    )
    assert managed_env["KUNGFU_SKILL_AUDIT_FILE"].endswith("-events.jsonl")
    assert Path(managed_env["KUNGFU_SKILL_RUNTIME_AUDIT_FILE"]).is_file()
    assert Path(managed_env["KUNGFU_SKILL_RUNTIME_AUDIT_FINAL_FILE"]).is_file()
