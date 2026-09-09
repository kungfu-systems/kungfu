# SPDX-License-Identifier: Apache-2.0
"""Project Work and provider session lifecycle cases."""
# ruff: noqa: F401,F403

from _run_product_path_support import *
from _run_product_path_support import _capture


def test_project_work_session_yields_at_deterministic_attention(tmp_path):
    calls = []
    started_callbacks = []
    statuses = [
        {
            "changeSequence": 0,
            "live": True,
            "lifecycleState": "starting",
            "interactionState": "unknown",
            "output": {"nextSequence": 0},
        },
        {
            "changeSequence": 1,
            "live": True,
            "lifecycleState": "ready",
            "interactionState": "ready",
            "output": {"nextSequence": 10},
        },
        {
            "changeSequence": 2,
            "live": True,
            "lifecycleState": "ready",
            "interactionState": "ready",
            "output": {"nextSequence": 20},
            "controller": {"holderId": "kungfu-project-work"},
        },
        {
            "changeSequence": 3,
            "live": True,
            "lifecycleState": "running",
            "interactionState": "busy",
            "output": {"nextSequence": 30},
            "controller": {"holderId": "kungfu-project-work"},
        },
        {
            "changeSequence": 4,
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
        if operation in {"status", "wait-status-change"}:
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
    ready_after_fast_turn = {
        **ready_after_echo,
        "workAgent": {"attention": {"kind": "ready-for-review"}},
    }
    assert (
        managed_run._session_boundary_reached(
            ready_after_fast_turn,
            before_sequence=10,
            terminal_mock=False,
        )
        is True
    )
    needs_answer_after_fast_turn = {
        **ready_after_echo,
        "workAgent": {"attention": {"kind": "needs-answer"}},
    }
    assert (
        managed_run._session_boundary_reached(
            needs_answer_after_fast_turn,
            before_sequence=10,
            terminal_mock=False,
        )
        is True
    )
    assert (
        managed_run._session_boundary_reached(
            {
                **ready_after_echo,
                "workAgent": {"attention": {"kind": "needs-answer"}},
            },
            before_sequence=10,
            terminal_mock=False,
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

    reviewer = run_agent.runtime_profiles.deterministic_mock_profile("review-fit")

    assert profile["label"] == "Mock Agent · approval"
    assert reviewer["label"] == "Mock Reviewer · deterministic-fit"
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
    monkeypatch.setattr(
        "kungfu.assignment_runtime.profile_lifecycle.resolve_qualified_work_profile",
        lambda *_args, **_kwargs: {
            "id": "kungfu.work-control",
            "root": "sha256:" + "1" * 64,
            "source": str(tmp_path / "exact-work-control"),
        },
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
    monkeypatch.setattr(
        "kungfu.assignment_runtime.profile_lifecycle.resolve_qualified_work_profile",
        lambda *_args, **_kwargs: {
            "id": "kungfu.work-control",
            "root": work_ref["profileRoot"],
            "source": str(tmp_path / "exact-work-control"),
        },
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


def test_prompt_only_agent_console_uses_exact_project_workspace_identity(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    project_candidate = resolve_workspace_target(
        "capture-only", str(project), cwd=str(project)
    )
    ensure_workspace_data_home(project_candidate.identity, "workspace-identity-fixture")
    project_target = resolve_workspace_target(
        "read-only", str(project), cwd=str(project)
    )
    launched = []
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

    def run_process(*_args, **kwargs):
        launched.append(kwargs)
        return run_agent.ProcessResult(0, '{"type":"text"}\n', "", False, False)

    result = run_agent.execute(
        prompt="inspect project",
        runtime_dir=str(tmp_path / "runtime"),
        workspace_root=str(project),
        process_runner=run_process,
    )

    assert result["launch"]["exitCode"] == 0
    environment = launched[0]["env"]
    envelope = json.loads(environment["KUNGFU_AGENT_CONSOLE_ENVELOPE"])
    assert environment["KUNGFU_WORKSPACE_ROOT"] == str(project)
    # Prompt-only Consoles must share the qualified Project authority runtime.
    assert environment["KUNGFU_AGENT_RUNTIME_DIR"] == str(project_target.runtime_dir)
    assert envelope["workspaceId"] == project_target.identity.workspace_id
    assert envelope["consoleId"].startswith(
        f"assistant:{project_target.identity.workspace_id}:agent-"
    )
    assert envelope["workRef"] is None

    unqualified = tmp_path / "unqualified"
    unqualified.mkdir()
    monkeypatch.setattr(
        native_launch, "inspect_workspace", lambda *_args, **_kwargs: None
    )
    run_agent.execute(
        prompt="inspect unqualified directory",
        runtime_dir=str(tmp_path / "fallback-runtime"),
        workspace_root=str(unqualified),
        process_runner=run_process,
    )
    fallback_envelope = json.loads(launched[1]["env"]["KUNGFU_AGENT_CONSOLE_ENVELOPE"])
    assert launched[1]["env"]["KUNGFU_AGENT_RUNTIME_DIR"] == str(
        tmp_path / "fallback-runtime"
    )
    assert fallback_envelope["workspaceId"] == str(unqualified)
    assert fallback_envelope["consoleId"].startswith(f"assistant:{unqualified}:agent-")
