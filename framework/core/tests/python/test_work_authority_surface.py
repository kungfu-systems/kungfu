# SPDX-License-Identifier: Apache-2.0

from datetime import UTC, datetime
import importlib
import json
from types import SimpleNamespace

from click.testing import CliRunner

from kungfu import assignment_close, assignment_evidence, assignment_review_lifecycle
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import assignment_review
from kungfu.cli.commands import kfc
from kungfu.agent import run_agent, session_contract


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
        "finalize-agent-session",
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


def test_session_finalization_retains_a_new_exact_root_without_rewriting_source(
    tmp_path,
):
    runtime_dir = tmp_path / "runtime"
    workspace = tmp_path / "project"
    workspace.mkdir()
    source_path = runtime_dir / "agent-runs" / "agent-1" / "bundle" / "report.json"
    source_path.parent.mkdir(parents=True)
    work_ref = {
        "workspaceId": "project:test",
        "profileId": "kungfu.work-control",
        "profileRoot": f"sha256:{'1' * 64}",
        "entityType": "assignment",
        "entityId": "assignment-1",
        "initiativeId": "initiative-1",
        "entityRoot": f"sha256:{'2' * 64}",
        "purpose": "complete-project-assignment",
        "systemTimeCut": f"sha256:{'3' * 64}",
    }
    source_body = {
        "schema": run_agent.REPORT_SCHEMA,
        "runId": "agent-1",
        "attemptId": "agent-1",
        "runtimeProfile": {
            "id": "kungfu.mock-agent.multi-step",
            "root": f"sha256:{'4' * 64}",
        },
        "launch": {"exitCode": 0},
        "providerObservation": {"text": "MOCK NEEDS ANSWER"},
        "session": {
            "workConsoleId": "work:assignment-1",
            "sessionAttemptId": "agent-1",
            "live": True,
        },
        "work": {"workRef": work_ref},
        "episode": {
            "episodeId": "42",
            "responsePath": str(source_path.parent / "response.json"),
            "manifestPath": str(source_path.parent / "manifest.json"),
            "reportPath": str(source_path),
        },
    }
    source = {
        **source_body,
        "reportRoot": run_agent.canonical_root(source_body),
    }
    source_bytes = (json.dumps(source, indent=2) + "\n").encode()
    source_path.write_bytes(source_bytes)
    requests = []

    def invoke(request):
        requests.append(request["operation"])
        if request["operation"] == "status":
            return {
                "workConsoleId": "work:assignment-1",
                "sessionAttemptId": "agent-1",
                "live": False,
                "lifecycleState": "ended",
                "workAgent": {
                    "attention": {"kind": "ready-for-review"},
                },
            }
        return {
            "terminal": {
                "earliestSequence": 0,
                "nextSequence": 3,
                "vt": {
                    "lines": [
                        "MOCK ANSWER RECEIVED: alpha",
                        "y",
                        "MOCK VALIDATION: passed",
                    ]
                },
            }
        }

    final_path, final = assignment_evidence.finalize_session_agent_report(
        source_path,
        runtime_dir,
        "initiative-1",
        "assignment-1",
        workspace_root=workspace,
        session_invoke=invoke,
    )

    assert requests == ["status", "snapshot"]
    assert source_path.read_bytes() == source_bytes
    assert final_path != source_path
    assert final["reportRoot"] != source["reportRoot"]
    assert final["session"]["live"] is False
    assert "MOCK ANSWER RECEIVED: alpha" in final["providerObservation"]["text"]
    assert final["sessionFinalization"]["sourceReportRoot"] == source["reportRoot"]
    assert final_path.is_file()
    assert (final_path.parent / "manifest.json").is_file()


def test_session_finalization_accepts_retained_structured_agent_output():
    assert (
        assignment_evidence._final_observation_text(
            {
                "schema": "kungfu.agent-session.structured-snapshot/v1",
                "agentText": "  structured Codex result  ",
                "retainedAgentResponse": True,
                "retainedTranscript": False,
            }
        )
        == "structured Codex result"
    )


def test_session_finalization_rejects_unretained_structured_agent_output():
    assert (
        assignment_evidence._final_observation_text(
            {
                "schema": "kungfu.agent-session.structured-snapshot/v1",
                "agentText": "not retained",
                "retainedAgentResponse": False,
                "retainedTranscript": False,
            }
        )
        == ""
    )


def test_atlas_primitive_has_no_work_mutation_commands():
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


def test_reviewer_prompt_requires_exact_structured_criterion_coverage():
    checks = ["Names the product", "Reports evidence and unresolved risks"]
    profile_root = f"sha256:{'1' * 64}"
    assignment_root = f"sha256:{'2' * 64}"
    query_proof_root = f"sha256:{'3' * 64}"
    report_root = f"sha256:{'5' * 64}"
    deliverable_root = f"sha256:{'4' * 64}"
    plan = {
        "workspace": {"id": "project:starter"},
        "work": {
            "initiativeId": "starter",
            "assignmentId": "write-brief",
            "assignmentRoot": assignment_root,
            "queryProofRoot": query_proof_root,
            "acceptanceChecks": checks,
        },
        "execution": {
            "reportRoot": report_root,
            "workRef": {"profileRoot": profile_root},
        },
        "deliverable": {"path": "README.md", "root": deliverable_root},
        "inputs": [],
    }
    prompt = assignment_review.review_agent_prompt(plan)
    continuation = assignment_review.review_continuation(plan)

    assert "criteria array must contain exactly 2 objects" in prompt
    assert '1. criterion must equal "Names the product"' in prompt
    assert '2. criterion must equal "Reports evidence and unresolved risks"' in prompt
    assert "A statement in summary does not count as criterion coverage" in prompt
    assert '"schema": "kungfu.review-context/v1"' in prompt
    assert '"schema": "kungfu.work-ref/v1"' in prompt
    assert '"entityId": "write-brief"' in prompt
    assert '"initiativeId": "starter"' in prompt
    assert f'"profileRoot": "{profile_root}"' in prompt
    assert f'"systemTimeCut": "{query_proof_root}"' in prompt
    assert '"mode": "fresh-independent-review"' in prompt
    assert f'"priorClaimRoot": "{report_root}"' in prompt
    assert '"schema": "kungfu.agent-continuation-envelope/v1"' in prompt
    assert '"schema": "kungfu.review-intake-assessment/v1"' in prompt
    assert "assess that admitted content directly" in prompt
    assert "only for evidence rows that do not contain content" in prompt
    assert run_agent.validate_continuation(continuation) == continuation
    assert session_contract.validate_work_ref(
        assignment_review.review_work_ref(plan)
    ) == assignment_review.review_work_ref(plan)


def test_fresh_reviewer_receives_the_exact_work_continuation_envelope(
    tmp_path, monkeypatch
):
    def root(marker):
        return f"sha256:{marker * 64}"

    plan = {
        "planRoot": root("9"),
        "workspace": {"id": "project:starter"},
        "work": {
            "initiativeId": "starter",
            "assignmentId": "write-brief",
            "assignmentRoot": root("1"),
            "queryProofRoot": root("2"),
            "acceptanceChecks": ["Names the product"],
            "phase": "executing",
        },
        "execution": {
            "reportRoot": root("3"),
            "workRef": {"profileRoot": root("4")},
        },
        "deliverable": {"path": "README.md", "root": root("5")},
        "inputs": [],
        "reviewer": {"id": "codex.path", "label": "Codex · PATH CLI"},
        "reviewExecution": {"mode": "fresh-process"},
        "executable": True,
    }
    observed = {}

    def execute_agent(**kwargs):
        observed.update(kwargs)
        return {
            "launch": {"exitCode": 1},
            "reportRoot": root("6"),
        }

    monkeypatch.setattr(assignment_review_lifecycle.run_agent, "execute", execute_agent)
    services = assignment_review_lifecycle.ReviewServices(
        plan=lambda **_kwargs: plan,
        receipt=lambda value: value,
        runtime=lambda *_args: SimpleNamespace(
            identity=SimpleNamespace(workspace_root=str(tmp_path)),
            runtime_dir=str(tmp_path / "runtime"),
        ),
        retained_evidence=lambda *_args: None,
        agent_report_summary=lambda report: report,
        status=lambda *_args: {},
        mint_lease=lambda *_args: {},
        advance=lambda *_args: {},
        completion_claim_values=lambda *_args: {},
        profile_action=lambda *_args: {},
        completion_review_values=lambda *_args: {},
    )
    request = assignment_review_lifecycle.ReviewRequest(
        config_home=tmp_path / "config",
        runtime_home=tmp_path / "home",
        agent_report_file=tmp_path / "execution-report.json",
        workspace_root=str(tmp_path),
        home=False,
        initiative_id="starter",
        assignment_id="write-brief",
        reviewer_profile_id="codex.path",
        expected_plan_root=plan["planRoot"],
        execute=True,
        allow_foreign_binding=False,
    )

    receipt = assignment_review_lifecycle.execute(
        request, services, lambda *_args: None, lambda: 0
    )

    expected_work_ref = assignment_review.review_work_ref(plan)
    expected_continuation = assignment_review.review_continuation(plan)
    assert receipt["status"] == "reviewer-failed"
    assert observed["work_ref"] == expected_work_ref
    assert observed["continuation"] == expected_continuation
    assert observed["permission_mode"] == "read-only"
    assert (
        run_agent.validate_continuation(observed["continuation"])
        == expected_continuation
    )
    assert json.dumps(expected_continuation, sort_keys=True) in observed["prompt"]


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
            "queryProofRoot": f"sha256:{'7' * 64}",
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
            "reportRoot": f"sha256:{'8' * 64}",
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
                "initiativeId": plan["work"]["initiativeId"],
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
