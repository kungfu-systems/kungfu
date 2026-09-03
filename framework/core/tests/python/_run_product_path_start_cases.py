# SPDX-License-Identifier: Apache-2.0
"""Assignment identity, Work start, and onboarding cases."""
# ruff: noqa: F401,F403

from _run_product_path_support import *
from _run_product_path_support import _capture


@pytest.mark.parametrize("command", ["claim", "status", "gate"])
def test_assignment_identity_options_are_reusable_across_commands(command):
    result = CliRunner().invoke(kfc, ["work", command, "--help"])

    assert result.exit_code == 0, result.output
    assert "--workspace" in result.output
    assert "--initiative-id" in result.output
    assert "--assignment-id" in result.output


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


def test_deterministic_mock_session_invoker_has_no_clock_cutoff():
    calls = []

    class Surface:
        @staticmethod
        def ensure(runtime_dir, *, timeout):
            calls.append(("ensure", runtime_dir, timeout))
            return "/tmp/agent-session.sock"

        @staticmethod
        def invoke(request, *, endpoint, timeout):
            calls.append((request["operation"], endpoint, timeout))
            return {"operation": request["operation"]}

    invoke = assignment_lifecycle.session_invoker(
        Surface, "/tmp/runtime", event_driven=True
    )
    assert invoke({"operation": "status"}) == {"operation": "status"}
    assert invoke({"operation": "start"}) == {"operation": "start"}
    assert invoke({"operation": "wait-status-change"}) == {
        "operation": "wait-status-change"
    }

    assert calls == [
        ("ensure", "/tmp/runtime", None),
        ("status", "/tmp/agent-session.sock", None),
        ("start", "/tmp/agent-session.sock", None),
        ("wait-status-change", "/tmp/agent-session.sock", None),
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
        lambda *_args, **_kwargs: "session-endpoint",
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
