# SPDX-License-Identifier: Apache-2.0

from datetime import UTC, datetime
import importlib
import json

from click.testing import CliRunner

from kungfu import assignment_close, assignment_evidence
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import assignment_review
from kungfu.cli.commands import kfc
from kungfu.agent import run_agent


def test_click_tree_exposes_one_work_family_and_no_assignment_alias():
    assert "work" in kfc.commands
    assert "assignment" not in kfc.commands
    assert kfc.commands["work"].name == "work"


def test_work_help_accepts_hidden_commands_added_without_a_priority():
    result = CliRunner().invoke(kfc, ["work", "--help"])

    assert result.exit_code == 0, result.output
    assert "runtime-host" not in result.output


def test_work_family_contains_only_profile_backed_orchestration_commands():
    commands = set(kfc.commands["work"].commands)
    assert commands == {
        "admit",
        "bind",
        "binding-create",
        "capture",
        "claim",
        "claim-completion",
        "close",
        "close-plan",
        "close-resume",
        "decide",
        "family-contract",
        "family-contract-v2",
        "family-create",
        "family-transition",
        "family-transition-v2",
        "family-upgrade-v2",
        "family-verify",
        "family-verify-v2",
        "gate",
        "kickoff",
        "relation-event",
        "review",
        "review-agent-plan",
        "review-agent-run",
        "resume-prepare",
        "runtime-host",
        "seal",
        "stage",
        "start",
        "start-plan",
        "start-resume",
        "status",
        "verify-binding",
        "verify-seal",
    }
    assert commands.isdisjoint(
        {
            "artifact",
            "block",
            "checkpoint",
            "complete",
            "create",
            "done",
            "export",
            "import",
            "link-run",
            "next",
            "pause",
            "ready",
            "recover",
            "resume",
            "settle",
            "validate",
        }
    )


def test_reused_work_identity_decorator_preserves_every_command_signature():
    identity_options = {
        "--workspace",
        "--home",
        "--initiative-id",
        "--assignment-id",
    }
    for name in {
        "bind",
        "claim",
        "close",
        "close-plan",
        "close-resume",
        "gate",
        "kickoff",
        "seal",
        "stage",
        "status",
    }:
        command = kfc.commands["work"].commands[name]
        flags = {
            flag
            for parameter in command.params
            for flag in getattr(parameter, "opts", ())
        }
        assert identity_options <= flags, name


def test_start_resume_accepts_the_generic_project_work_purpose(tmp_path, monkeypatch):
    report_path = tmp_path / "agent-runs" / "run-1" / "bundle" / "report.json"
    report_path.parent.mkdir(parents=True)
    report_path.write_text("{}", encoding="utf-8")
    report = {
        "work": {
            "workRef": {
                "entityType": "assignment",
                "entityId": "create-launch-brief",
                "purpose": "complete-project-assignment",
            }
        }
    }
    monkeypatch.setattr(
        assignment_evidence,
        "load_execution_agent_report",
        lambda *_args, **_kwargs: (report_path, report),
    )

    assert (
        assignment_evidence.latest_starter_agent_report(
            tmp_path,
            "agent-work-starter",
            "create-launch-brief",
        )
        == report
    )


def test_atlas_bridge_has_no_work_mutation_aliases():
    atlas_commands = set(kfc.commands["atlas"].commands)
    assert atlas_commands.isdisjoint(
        {
            "claim-completion",
            "create-go",
            "create-mission",
            "decide-continuation",
            "review-completion",
        }
    )


def test_reviewer_result_requires_exact_criterion_coverage():
    checks = ["Names the product", "Uses retained evidence"]
    report = {
        "providerObservation": {
            "text": (
                "Review complete.\n"
                "KUNGFU_REVIEW_RESULT "
                '{"verdict":"fit","summary":"Both checks pass.",'
                '"criteria":['
                '{"criterion":"Names the product","passed":true,'
                '"evidence":"deliverable line 1"},'
                '{"criterion":"Uses retained evidence","passed":true,'
                '"evidence":"inputs and benefit section"}],'
                '"evidenceRequests":[]}'
            )
        }
    }
    result = assignment_review.parse_reviewer_result(report, checks)
    assert result["verdict"] == "fit"
    assert all(row["passed"] for row in result["criteria"])


def test_exact_retained_passing_reviewer_evidence_is_reusable(tmp_path):
    command = importlib.import_module("kungfu.cli.commands.assignment")
    runtime = tmp_path / "runtime"
    workspace = tmp_path / "project"
    report_path = runtime / "agent-runs" / "review-run" / "bundle" / "report.json"
    report_path.parent.mkdir(parents=True)
    workspace.mkdir()
    checks = ["Names the product", "Uses retained evidence"]
    plan = {
        "workspace": {"id": "project:starter", "root": str(workspace)},
        "work": {
            "initiativeId": "starter",
            "assignmentId": "write-brief",
            "assignmentRoot": f"sha256:{'1' * 64}",
            "acceptanceChecks": checks,
        },
        "deliverable": {
            "path": "deliverables/launch-brief.md",
            "root": f"sha256:{'2' * 64}",
        },
        "inputs": [
            {
                "path": "inputs/product-notes.md",
                "root": f"sha256:{'3' * 64}",
            }
        ],
        "execution": {
            "workRef": {"profileRoot": f"sha256:{'4' * 64}"},
        },
        "reviewer": {
            "id": "codex.local",
            "profileRoot": f"sha256:{'5' * 64}",
        },
    }
    result_line = {
        "verdict": "fit",
        "summary": "Both checks pass.",
        "criteria": [
            {
                "criterion": "Names the product",
                "passed": True,
                "evidence": "deliverable line 1",
            },
            {
                "criterion": "Uses retained evidence",
                "passed": True,
                "evidence": "input line 2",
            },
        ],
        "evidenceRequests": [],
    }
    report_body = {
        "schema": run_agent.REPORT_SCHEMA,
        "runId": "review-run",
        "attemptId": "review-run",
        "runtimeProfile": {
            "id": "codex.local",
            "root": plan["reviewer"]["profileRoot"],
        },
        "launch": {
            "cwd": str(workspace),
            "argvWithoutPrompt": ["codex", "exec", "--sandbox", "read-only"],
            "promptRoot": run_agent.canonical_root(
                assignment_review.review_agent_prompt(plan)
            ),
            "exitCode": 0,
        },
        "providerObservation": {
            "text": "KUNGFU_REVIEW_RESULT "
            + json.dumps(result_line, separators=(",", ":"))
        },
        "work": {
            "workRef": {
                "workspaceId": plan["workspace"]["id"],
                "profileId": "kungfu.work-control",
                "profileRoot": plan["execution"]["workRef"]["profileRoot"],
                "entityType": "assignment",
                "entityId": plan["work"]["assignmentId"],
                "entityRoot": plan["work"]["assignmentRoot"],
                "purpose": "independent-completion-review",
                "systemTimeCut": f"sha256:{'6' * 64}",
            }
        },
        "privacy": {
            "priorTranscriptBytesGivenToAgent": 0,
            "privateProviderSessionStoreRead": False,
        },
        "episode": {"episodeId": "42"},
    }
    report = {
        **report_body,
        "reportRoot": run_agent.canonical_root(report_body),
    }
    report_path.write_text(json.dumps(report), encoding="utf-8")

    retained = command._find_retained_reviewer_evidence(runtime, plan)

    assert retained is not None
    assert retained["report"]["reportRoot"] == report["reportRoot"]
    assert retained["assessment"]["verdict"] == "fit"

    changed_plan = {
        **plan,
        "deliverable": {
            **plan["deliverable"],
            "root": f"sha256:{'7' * 64}",
        },
    }
    assert command._find_retained_reviewer_evidence(runtime, changed_plan) is None


def test_review_settlement_lease_renews_the_original_execution_agent(monkeypatch):
    command = importlib.import_module("kungfu.cli.commands.assignment")
    observed = {}

    def profile_action(runtime_dir, operation, values, actor):
        observed.update(
            {
                "runtime_dir": runtime_dir,
                "operation": operation,
                "values": values,
                "actor": actor,
            }
        )
        return {"claim": values}

    monkeypatch.setattr(command, "_profile_action", profile_action)
    before = datetime.now(UTC)
    receipt = command._mint_review_settlement_lease(
        "/runtime",
        {
            "work": {
                "initiativeId": "starter",
                "assignmentId": "write-brief",
            },
            "execution": {"agent": {"id": "codex.execution", "provider": "codex"}},
        },
        "local-user",
    )
    expiry = datetime.fromisoformat(
        observed["values"]["leaseExpiresAt"].replace("Z", "+00:00")
    )

    assert receipt["claim"]["agent"] == "codex.execution"
    assert observed["operation"] == "claim-assignment"
    assert observed["values"]["slot"] == "starter-codex"
    assert observed["values"]["grantScope"] == "assignment-execution"
    assert observed["values"]["leaseId"].startswith("work-review-")
    assert expiry > before


def test_starter_native_review_uses_the_bound_handoff_assessment_without_git():
    command = importlib.import_module("kungfu.cli.commands.assignment")
    values = command._native_completion_review_values(
        {
            "workspace": {"root": "/project-without-git"},
            "work": {
                "initiativeId": "starter",
                "assignmentId": "write-brief",
            },
            "reviewer": {"id": "codex.path.detected"},
        },
        {"runId": "review-run"},
    )

    assert values["purpose"] == "handoff"
    assert values["executorProfile"] == "thread"
    assert values["reviewer"] == "codex.path.detected"
    assert values["reviewerSource"] == "review-run"
    assert values["checkoutPath"] == ""


def test_starter_completion_claim_uses_native_episode_and_proof_authority():
    command = importlib.import_module("kungfu.cli.commands.assignment")
    values = command._native_completion_claim_values(
        {
            "work": {
                "initiativeId": "starter",
                "assignmentId": "write-brief",
                "workDefinitionRoot": f"sha256:{'1' * 64}",
                "acceptanceChecks": ["Names the product"],
            },
            "execution": {
                "episodeId": "41",
                "reportRoot": f"sha256:{'2' * 64}",
            },
            "deliverable": {"root": f"sha256:{'3' * 64}"},
        },
        {
            "runId": "review-run",
            "reportRoot": f"sha256:{'4' * 64}",
            "episode": {"episodeId": "42"},
        },
        {"summary": "The acceptance criterion passes."},
    )

    assert values["evidenceEpisodeIds"] == [41, 42]
    assert values["proofRoots"] == [
        f"sha256:{'2' * 64}",
        f"sha256:{'4' * 64}",
        f"sha256:{'3' * 64}",
    ]
    assert "resultAtlasRoot" not in values
    assert "inputAtlasRoot" not in values
    assert "projectCutRoot" not in values


def test_starter_close_plan_binds_one_fit_review_and_hides_technical_seal(
    monkeypatch,
):
    command = importlib.import_module("kungfu.cli.commands.assignment")
    review = {
        "review_id": "review-starter",
        "verdict": "fit",
        "continuation_plan": {
            "allowed_actions": ["approve", "close"],
        },
        "continuation_plan_root": f"sha256:{'1' * 64}",
    }
    identity = type(
        "Identity",
        (),
        {
            "workspace_id": "project:starter",
            "workspace_root": "/project",
            "data_home": "/project/.kungfu",
            "identity_root": f"sha256:{'2' * 64}",
        },
    )()
    monkeypatch.setattr(
        command,
        "_runtime",
        lambda *args: (identity, "/project/.kungfu/runtime", {}),
    )
    monkeypatch.setattr(
        command,
        "_status",
        lambda *args: {
            "phase": "independently-reviewed",
            "query_proof_root": f"sha256:{'3' * 64}",
            "assignment": {"assignment_id": "write-brief"},
            "independent_reviews": [review],
            "continuation_decisions": [],
        },
    )

    plan = assignment_close.build_plan(
        workspace_root="/project",
        home=False,
        initiative_id="starter",
        assignment_id="write-brief",
        services=command._close_services(),
    )

    assert plan["writeOccurred"] is False
    assert plan["confirmationRequired"] is True
    assert plan["executable"] is True
    assert plan["decision"]["mode"] == "required"
    assert [effect["stage"] for effect in plan["effects"]] == [
        "decide",
        "seal",
    ]
    assert plan["review"]["allowedActions"] == ["approve", "close"]
