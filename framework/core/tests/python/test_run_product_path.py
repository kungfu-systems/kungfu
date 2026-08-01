# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
from types import SimpleNamespace

import pytest

from kungfu import assignment_orchestration as orchestration
from kungfu.agent import run_agent
from kungfu.cli.commands import assignment, run
from kungfu.workspace import resolve_workspace_target


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
            "goal_id": assignment_id,
            "mission_id": "project-work",
            "title": assignment_id,
            "objective": f"Complete {assignment_id}",
            "acceptance_criteria": ["Result exists"],
        },
    }
    return orchestration.capture_assignment_request(request, target)


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
            {"phase": "claimed", "query_proof_root": "sha256:" + "4" * 64},
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
        lambda *_args: {
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
        lambda *_args: {
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


def test_project_work_session_yields_at_deterministic_attention(tmp_path):
    calls = []
    statuses = [
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
    )

    assert result.exit_code == 0
    assert "MOCK NEEDS ANSWER" in result.stdout
    assert session["live"] is True
    assert session["workAgent"]["attention"]["kind"] == "needs-answer"
    start_input = next(
        call["input"] for call in calls if call["operation"] == "plan-start"
    )
    assert start_input["binding"] == {"kind": "work", "workRef": work}
    assert start_input["workConsoleId"] == ("work:kungfu.work-control:assignment:first")


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
