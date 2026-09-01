# SPDX-License-Identifier: Apache-2.0

from datetime import UTC, datetime
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

from click.testing import CliRunner

from kungfu import (
    assignment_close,
    assignment_evidence,
    assignment_review_lifecycle,
    work_authority,
)
from kungfu.assignment_runtime import fresh_recovery as assignment_fresh_recovery
from kungfu.assignment_runtime import fresh_recovery_authority
from kungfu.assignment_runtime import profile_lifecycle
from kungfu.assignment_runtime.authority import LocalRuntimeError, WorkControlAuthority
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import assignment_review
from kungfu.cli.commands import kfc
from kungfu.agent import planned_work_binding, run_agent, session_contract

assignment_command = importlib.import_module("kungfu.cli.commands.assignment")


def test_qualified_work_profile_resolves_retained_exact_source(monkeypatch, tmp_path):
    source = tmp_path / "installed" / "work-control"
    source.mkdir(parents=True)
    (source / "profile.json").write_text("{}\n", encoding="utf-8")
    profile_root = f"sha256:{'a' * 64}"
    monkeypatch.setattr(
        profile_lifecycle.storage_service,
        "profile_lifecycle",
        lambda *_args, **_kwargs: {
            "profile_suite_root": profile_root,
            "qualified": True,
            "activated": True,
            "removed": False,
            "latest_event": {"closure": {"profile_path": str(source / "profile.json")}},
        },
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "validate_source",
        lambda observed_source, observed_runtime: (
            {
                "inspection": {
                    "profile": {"id": "kungfu.work-control"},
                    "profile_suite_root": profile_root,
                }
            }
            if observed_source == source.resolve() and observed_runtime == tmp_path
            else (_ for _ in ()).throw(AssertionError("source/runtime drift"))
        ),
    )

    assert profile_lifecycle.resolve_qualified_work_profile(tmp_path) == {
        "id": "kungfu.work-control",
        "root": profile_root,
        "source": str(source.resolve()),
    }


def test_qualified_work_profile_accepts_equivalent_explicit_bundled_source(
    monkeypatch, tmp_path
):
    retained = tmp_path / "rollback-image" / "work-control"
    bundled = tmp_path / "current-image" / "work-control"
    retained.mkdir(parents=True)
    bundled.mkdir(parents=True)
    (retained / "profile.json").write_text("{}\n", encoding="utf-8")
    profile_root = f"sha256:{'a' * 64}"
    monkeypatch.setattr(
        profile_lifecycle.storage_service,
        "profile_lifecycle",
        lambda *_args, **_kwargs: {
            "profile_suite_root": profile_root,
            "qualified": True,
            "activated": True,
            "removed": False,
            "latest_event": {
                "closure": {"profile_path": str(retained / "profile.json")}
            },
        },
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "validate_source",
        lambda observed_source, observed_runtime: (
            {
                "inspection": {
                    "profile": {"id": "kungfu.work-control"},
                    "profile_suite_root": profile_root,
                }
            }
            if observed_source in {retained.resolve(), bundled.resolve()}
            and observed_runtime == tmp_path
            else (_ for _ in ()).throw(AssertionError("source/runtime drift"))
        ),
    )

    assert profile_lifecycle.resolve_qualified_work_profile(
        tmp_path,
        source=bundled,
    ) == {
        "id": "kungfu.work-control",
        "root": profile_root,
        "source": str(bundled.resolve()),
    }


def test_qualified_work_profile_rejects_explicit_source_with_different_root(
    monkeypatch, tmp_path
):
    retained = tmp_path / "rollback-image" / "work-control"
    bundled = tmp_path / "current-image" / "work-control"
    retained.mkdir(parents=True)
    bundled.mkdir(parents=True)
    (retained / "profile.json").write_text("{}\n", encoding="utf-8")
    retained_root = f"sha256:{'a' * 64}"
    observed_root = f"sha256:{'b' * 64}"
    monkeypatch.setattr(
        profile_lifecycle.storage_service,
        "profile_lifecycle",
        lambda *_args, **_kwargs: {
            "profile_suite_root": retained_root,
            "qualified": True,
            "activated": True,
            "removed": False,
            "latest_event": {
                "closure": {"profile_path": str(retained / "profile.json")}
            },
        },
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "validate_source",
        lambda observed_source, _runtime: {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": (
                    retained_root
                    if observed_source == retained.resolve()
                    else observed_root
                ),
            }
        },
    )

    with __import__("pytest").raises(
        profile_lifecycle.profile_sdk.ProfileSdkError,
        match="does not match the qualified retained root",
    ) as error:
        profile_lifecycle.resolve_qualified_work_profile(
            tmp_path,
            source=bundled,
        )

    assert error.value.diagnosis["code"] == "work-control-profile-source-drift"
    assert error.value.diagnosis["retainedRoot"] == retained_root
    assert error.value.diagnosis["observedRoot"] == observed_root


def test_qualified_work_profile_relocates_missing_source_by_exact_root(
    monkeypatch, tmp_path
):
    missing = tmp_path / "removed-image" / "work-control" / "profile.json"
    bundled_root = tmp_path / "current-image" / "extensions"
    source = bundled_root / "work-control"
    source.mkdir(parents=True)
    profile_root = f"sha256:{'a' * 64}"
    monkeypatch.setenv("KF_BUNDLED_EXTENSION_ROOT", str(bundled_root))
    monkeypatch.setattr(
        profile_lifecycle.storage_service,
        "profile_lifecycle",
        lambda *_args, **_kwargs: {
            "profile_suite_root": profile_root,
            "qualified": True,
            "activated": True,
            "removed": False,
            "latest_event": {"closure": {"profile_path": str(missing)}},
        },
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "discover_source",
        lambda profile_id, runtime_dir, *, search_roots: (
            {
                "source": str(source),
                "profileSuiteRoot": profile_root,
            }
            if profile_id == "kungfu.work-control"
            and runtime_dir == tmp_path
            and search_roots == [str(bundled_root)]
            else (_ for _ in ()).throw(AssertionError("discovery boundary drift"))
        ),
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "validate_source",
        lambda observed_source, observed_runtime: (
            {
                "inspection": {
                    "profile": {"id": "kungfu.work-control"},
                    "profile_suite_root": profile_root,
                }
            }
            if observed_source == source.resolve() and observed_runtime == tmp_path
            else (_ for _ in ()).throw(AssertionError("source/runtime drift"))
        ),
    )

    assert profile_lifecycle.resolve_qualified_work_profile(tmp_path) == {
        "id": "kungfu.work-control",
        "root": profile_root,
        "source": str(source.resolve()),
    }


def test_qualified_work_profile_relocation_rejects_root_drift(monkeypatch, tmp_path):
    missing = tmp_path / "removed-image" / "work-control" / "profile.json"
    bundled_root = tmp_path / "current-image" / "extensions"
    source = bundled_root / "work-control"
    source.mkdir(parents=True)
    retained_root = f"sha256:{'a' * 64}"
    observed_root = f"sha256:{'b' * 64}"
    monkeypatch.setenv("KF_BUNDLED_EXTENSION_ROOT", str(bundled_root))
    monkeypatch.setattr(
        profile_lifecycle.storage_service,
        "profile_lifecycle",
        lambda *_args, **_kwargs: {
            "profile_suite_root": retained_root,
            "qualified": True,
            "activated": True,
            "removed": False,
            "latest_event": {"closure": {"profile_path": str(missing)}},
        },
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "discover_source",
        lambda *_args, **_kwargs: {"source": str(source)},
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "validate_source",
        lambda *_args, **_kwargs: {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": observed_root,
            }
        },
    )

    with __import__("pytest").raises(
        profile_lifecycle.profile_sdk.ProfileSdkError,
        match="retained source no longer matches its exact root",
    ) as error:
        profile_lifecycle.resolve_qualified_work_profile(tmp_path)

    assert error.value.diagnosis["code"] == "work-control-profile-source-root-drift"
    assert error.value.diagnosis["retainedRoot"] == retained_root
    assert error.value.diagnosis["observedRoot"] == observed_root


def test_missing_work_profile_has_specific_fail_closed_diagnosis(monkeypatch, tmp_path):
    def missing(*_args, **_kwargs):
        raise ValueError("Profile not found: kungfu.work-control")

    monkeypatch.setattr(profile_lifecycle.storage_service, "profile_lifecycle", missing)

    with __import__("pytest").raises(
        profile_lifecycle.profile_sdk.ProfileSdkError,
        match="Work Control Profile is not installed",
    ) as error:
        profile_lifecycle.resolve_qualified_work_profile(tmp_path)

    assert error.value.diagnosis["code"] == "work-control-profile-not-installed"

    with __import__("pytest").raises(
        LocalRuntimeError,
        match="Work Control Profile is not installed",
    ) as runtime_error:
        WorkControlAuthority(tmp_path).inspect()

    assert runtime_error.value.code == "backend-unavailable"
    assert runtime_error.value.diagnostics[0]["code"] == (
        "work-control-profile-not-installed"
    )


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
        "authorize-effect",
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
        "fresh-recover",
        "fresh-recovery-plan",
        "gate",
        "kickoff",
        "record-effect-attempt",
        "record-effect-outcome",
        "record-input",
        "record-run",
        "relation-event",
        "review",
        "review-agent-plan",
        "review-agent-run",
        "resume-prepare",
        "runtime-recovery-plan",
        "runtime-recovery-resolve",
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


def _fresh_recovery_fixture():
    def root(digit):
        return f"sha256:{digit * 64}"

    status = {
        "schema": "kungfu.assignment-orchestration.status/v1",
        "phase": "completion-claimed",
        "query_proof_root": root("5"),
        "completion_claim_count": 1,
        "completion_claims": [{"claim_id": "claim:one", "root": root("6")}],
        "independent_review_count": 0,
        "independent_reviews": [],
        "continuation_decision_count": 0,
        "continuation_decisions": [],
        "next_actions": [{"action": "review"}],
        "assignment": {
            "initiative_id": "initiative:test",
            "assignment_id": "assignment:test",
            "request_root": root("1"),
            "work_definition_root": root("2"),
            "evidence_episode_roots": [root("7")],
        },
    }
    work_ref = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "project:test",
        "profileId": "kungfu.work-control",
        "profileRoot": root("3"),
        "entityType": "assignment",
        "entityId": "assignment:test",
        "entityRoot": assignment_fresh_recovery._root(status["assignment"]),
        "purpose": "continue-project-assignment",
        "systemTimeCut": root("5"),
        "initiativeId": "initiative:test",
    }
    binding = {
        "workRef": work_ref,
        "session": {
            "workConsoleId": "assistant:project:test",
            "sessionAttemptId": "native:new",
        },
    }
    plan = assignment_fresh_recovery.build_plan(
        workspace={
            "id": "project:test",
            "root": "/project",
            "identityRoot": root("4"),
        },
        status=status,
        binding=binding,
        previous_attempt_id="native:old",
        expected_request_root=root("1"),
        expected_work_definition_root=root("2"),
        expected_profile_root=root("3"),
        recovery_profile={
            "profileId": "kungfu.work-control",
            "profileRoot": root("3"),
            "sourceContractRoot": root("6"),
            "sourceLocator": "/profile/work-control",
        },
        profile_active=False,
        now="2026-08-25T09:00:00Z",
    )
    return status, binding, plan


def test_retained_assignment_authority_ignores_arbitrary_reader_fields():
    status, _binding, _plan = _fresh_recovery_fixture()
    retained_root = work_authority.semantic_root(
        work_authority.retained_assignment_authority(status)
    )
    projected = json.loads(json.dumps(status))
    projected.update(
        query_proof_root=f"sha256:{'a' * 64}",
        active_lease={"lease_id": "reader-only"},
        work_semantics={"next_actions": [{"action": "authorize-effect"}]},
        next_actions=[{"action": "reader-projection"}],
        arbitrary_future_reader_field={"revision": 99},
    )

    assert (
        work_authority.semantic_root(
            work_authority.retained_assignment_authority(projected)
        )
        == retained_root
    )
    projected["completion_claim_count"] = 2
    assert (
        work_authority.semantic_root(
            work_authority.retained_assignment_authority(projected)
        )
        != retained_root
    )


def test_planned_native_binder_never_rediscovers_work_authority(monkeypatch):
    _status, binding, _plan = _fresh_recovery_fixture()
    requests = []
    endpoint = "/tmp/exact-agent-session.sock"
    monkeypatch.setattr(
        planned_work_binding.session_surface,
        "endpoint_for_runtime",
        lambda _runtime: endpoint,
    )

    def invoke(request, **options):
        requests.append((request, options))
        if request["operation"] == "plan-native-bind-work":
            return {"root": f"sha256:{'9' * 64}"}
        return {"status": "bound", "receiptRoot": f"sha256:{'8' * 64}"}

    monkeypatch.setattr(planned_work_binding.session_surface, "invoke", invoke)

    result = planned_work_binding.bind_planned_native_work(
        "/exact/console/runtime",
        work_ref=binding["workRef"],
        session=binding["session"],
        binding_scope="same-project",
        source_workspace_id=binding["workRef"]["workspaceId"],
        actor_id="agent:test",
    )

    assert result["workRef"] == binding["workRef"]
    assert [request[0]["operation"] for request in requests] == [
        "plan-native-bind-work",
        "bind-native-work",
    ]
    assert [options["endpoint"] for _request, options in requests] == [
        endpoint,
        endpoint,
    ]


def test_planned_console_observation_rejects_attempt_and_lifecycle_drift(
    monkeypatch,
):
    _status, binding, plan = _fresh_recovery_fixture()
    exact = binding["session"]
    observations = [
        {
            "workConsoleId": exact["workConsoleId"],
            "sessionAttemptId": "native:different",
            "lifecycleState": "running",
            "live": True,
        },
        {
            **exact,
            "lifecycleState": "ended",
            "live": False,
        },
    ]

    for observation in observations:
        monkeypatch.setattr(
            fresh_recovery_authority.session_surface,
            "invoke",
            lambda *_args, _observation=observation, **_kwargs: _observation,
        )
        with __import__("pytest").raises(
            ValueError, match="Console or SessionAttempt is not live"
        ):
            fresh_recovery_authority.observe_planned_console(plan)


def test_planned_workspace_verification_rejects_identity_drift(tmp_path):
    workspace_root = tmp_path / "project"
    runtime_dir = workspace_root / ".kungfu" / "runtime"
    runtime_dir.mkdir(parents=True)
    semantic = {
        "schema": "kungfu.workspace.identity-material/v1",
        "workspaceKind": "project",
        "workspaceKey": "workspace:test",
    }
    identity_root = assignment_fresh_recovery._root(semantic)
    identity_path = runtime_dir.parent / "workspace-identity.json"
    identity_path.write_text(
        json.dumps({**semantic, "identityRoot": identity_root}), encoding="utf-8"
    )
    plan = {
        "plannedTarget": {
            "workspace": {
                "id": f"project:{identity_root.removeprefix('sha256:')[:16]}",
                "root": str(workspace_root),
                "runtimeRoot": str(runtime_dir),
                "identityRoot": identity_root,
            }
        }
    }

    _runtime, observation = fresh_recovery_authority.verify_planned_workspace(plan)
    assert observation["identityRoot"] == identity_root
    identity_path.write_text(
        json.dumps({**semantic, "identityRoot": f"sha256:{'f' * 64}"}),
        encoding="utf-8",
    )
    with __import__("pytest").raises(ValueError, match="workspace identity changed"):
        fresh_recovery_authority.verify_planned_workspace(plan)


def test_planned_workspace_verification_accepts_home_runtime(tmp_path):
    runtime_dir = tmp_path / ".kungfu" / "runtime"
    runtime_dir.mkdir(parents=True)
    semantic = {
        "schema": "kungfu.workspace.identity-material/v1",
        "workspaceKind": "home",
        "workspaceKey": "home",
    }
    identity_root = assignment_fresh_recovery._root(semantic)
    identity_path = runtime_dir.parent / "workspace-identity.json"
    identity_path.write_text(
        json.dumps({**semantic, "identityRoot": identity_root}), encoding="utf-8"
    )
    plan = {
        "plannedTarget": {
            "workspace": {
                "id": "home",
                "root": None,
                "runtimeRoot": str(runtime_dir),
                "identityRoot": identity_root,
            }
        }
    }

    observed_runtime, observation = fresh_recovery_authority.verify_planned_workspace(
        plan
    )

    assert observed_runtime == runtime_dir
    assert observation["workspaceId"] == "home"
    assert observation["identityRoot"] == identity_root


def test_planned_profile_verification_never_accepts_a_caller_selected_source(
    tmp_path, monkeypatch
):
    _status, _binding, plan = _fresh_recovery_fixture()
    monkeypatch.setattr(
        fresh_recovery_authority,
        "validated_recovery_profile",
        lambda *_args: (_ for _ in ()).throw(
            AssertionError("must reject before validating another source")
        ),
    )

    with __import__("pytest").raises(ValueError, match="locator differs"):
        fresh_recovery_authority.verify_recovery_profile_source(
            plan, tmp_path / "different-profile", tmp_path / "runtime"
        )


def _expired_execution_recovery_fixture(*, profile_active=True):
    status, binding, _ = _fresh_recovery_fixture()
    status.update(
        phase="executing",
        active_lease=None,
        execution_claims=[
            {
                "claim_id": "execution:old",
                "claim_type": "assignment-execution-claim",
                "assignment_id": "assignment:test",
                "attempt_id": "native:old",
                "owner": "owner:test",
                "agent": "codex",
                "slot": "pro-test",
                "lease_id": "lease:old",
                "lease_expires_at": "2026-08-25T08:00:00Z",
                "authorized_by": "maintainer:test",
                "grant_scope": "assignment-execution",
            }
        ],
        phase_transitions=[
            {
                "claim_id": "phase:executing",
                "from_phase": "claimed",
                "to_phase": "executing",
            }
        ],
        completion_claim_count=0,
        completion_claims=[],
        next_actions=[{"action": "fresh-recovery-plan"}],
    )
    plan = assignment_fresh_recovery.build_plan(
        workspace={
            "id": "project:test",
            "root": "/project",
            "identityRoot": f"sha256:{'4' * 64}",
        },
        status=status,
        binding=binding,
        previous_attempt_id="native:old",
        expected_request_root=f"sha256:{'1' * 64}",
        expected_work_definition_root=f"sha256:{'2' * 64}",
        expected_profile_root=f"sha256:{'3' * 64}",
        recovery_profile={
            "profileId": "kungfu.work-control",
            "profileRoot": f"sha256:{'3' * 64}",
            "sourceContractRoot": f"sha256:{'6' * 64}",
            "sourceLocator": "/profile/work-control",
        },
        profile_active=profile_active,
        now="2026-08-25T09:00:00Z",
    )
    return status, binding, plan


def test_fresh_recovery_plan_is_resume_new_attempt_without_lifecycle_replay():
    status, binding, plan = _fresh_recovery_fixture()

    assert plan["continuationMode"] == "resume/new-attempt"
    assert plan["attempt"] == {
        "previousSessionAttemptId": "native:old",
        "newSessionAttemptId": "native:new",
        "workConsoleId": "assistant:project:test",
    }
    assert plan["workRef"] == binding["workRef"]
    assert plan["recoveryProfile"] == plan["plannedProfileSource"]
    assert (
        plan["plannedProfileSource"]["profileRoot"]
        == (binding["workRef"]["profileRoot"])
    )
    assert plan["plannedProfileSource"]["sourceLocator"] == ("/profile/work-control")
    assert [effect["stage"] for effect in plan["effects"]] == [
        "activate-profile",
        "bind-new-attempt",
    ]
    assert set(plan["forbiddenEffects"]) == {"admit", "claim", "kickoff"}
    assert plan["work"]["phase"] == status["phase"]
    assert plan["writeOccurred"] is False


def test_fresh_recovery_plans_exact_lease_without_expanding_authority():
    status, binding, plan = _expired_execution_recovery_fixture()

    assert [effect["stage"] for effect in plan["effects"]] == [
        "bind-new-attempt",
        "claim-new-attempt-lease",
    ]
    effect = plan["effects"][-1]
    assert effect["attemptId"] == binding["session"]["sessionAttemptId"]
    assert effect["leaseId"].startswith("fresh-recovery-")
    assert effect["authority"] == {
        "owner": "owner:test",
        "agent": "codex",
        "slot": "pro-test",
        "authorizedBy": "maintainer:test",
        "grantScope": "assignment-execution",
    }
    assert plan["executionRecovery"] == {
        "previousExecutionClaimRoot": assignment_fresh_recovery._root(
            status["execution_claims"][0]
        ),
        "previousLeaseId": "lease:old",
        "previousLeaseExpiresAt": "2026-08-25T08:00:00Z",
        "authority": effect["authority"],
    }
    assert set(plan["forbiddenEffects"]) == {
        "admit",
        "kickoff",
        "completion-authority",
    }


def test_fresh_recovery_plan_adopts_current_native_console(monkeypatch, tmp_path):
    observed = {}

    def current_native_console(runtime_dir, **options):
        observed.update(runtime_dir=runtime_dir, options=options)
        return {
            "source": "ambient-provider-session",
            "envelope": {
                "consoleId": "assistant:project:test",
                "attemptId": "native:codex:ambient:current",
                "workspaceId": "project:test",
            },
        }

    monkeypatch.setattr(
        fresh_recovery_authority.session_surface,
        "current_native_console",
        current_native_console,
    )

    binding = assignment_fresh_recovery._current_binding_context(
        str(tmp_path), "project:test"
    )
    assert binding["session"] == {
        "workConsoleId": "assistant:project:test",
        "sessionAttemptId": "native:codex:ambient:current",
    }
    assert binding["console"]["sourceWorkspaceId"] == "project:test"
    assert binding["console"]["bindingScope"] == "same-project"
    assert observed == {
        "runtime_dir": str(tmp_path),
        "options": {"adopt": True, "project_work_binding": False},
    }


def test_fresh_recovery_appends_one_exact_current_attempt_lease():
    status, binding, plan = _expired_execution_recovery_fixture()
    effect = plan["effects"][-1]
    after = json.loads(json.dumps(status))
    recovered_claim = {
        **status["execution_claims"][0],
        "claim_id": "execution:new",
        "attempt_id": effect["attemptId"],
        "lease_id": effect["leaseId"],
        "lease_expires_at": effect["leaseExpiresAt"],
    }
    after["execution_claims"].append(recovered_claim)
    after["active_lease"] = recovered_claim
    after["next_actions"] = [{"action": "stage"}]
    observations = iter(
        [
            json.loads(json.dumps(status)),
            json.loads(json.dumps(status)),
            json.loads(json.dumps(status)),
            after,
        ]
    )
    writes = []

    receipt = assignment_fresh_recovery.apply_plan(
        plan,
        expected_plan_root=plan["planRoot"],
        authorized_by="maintainer:test",
        status_reader=lambda: next(observations),
        session_reader=lambda: dict(binding["session"]),
        prepare_profile=lambda _actor: {"status": "ready"},
        bind_work=lambda expected: {
            "workRef": dict(expected["workRef"]),
            "session": dict(expected["session"]),
            "receipt": {"receiptRoot": f"sha256:{'8' * 64}"},
        },
        claim_execution=lambda values, actor: (
            writes.append((dict(values), actor))
            or {"runtimeReceipt": f"sha256:{'9' * 64}"}
        ),
        now="2026-08-25T09:01:00Z",
    )

    assert writes == [
        (
            {
                "initiativeId": "initiative:test",
                "assignmentId": "assignment:test",
                "owner": "owner:test",
                "agent": "codex",
                "slot": "pro-test",
                "leaseId": effect["leaseId"],
                "leaseExpiresAt": effect["leaseExpiresAt"],
                "attemptId": "native:new",
                "authorizedBy": "maintainer:test",
                "grantScope": "assignment-execution",
                "actorType": "user",
                "source": "kungfu",
            },
            "maintainer:test",
        )
    ]
    assert receipt["executionLease"] == {
        "attemptId": "native:new",
        "leaseId": effect["leaseId"],
        "leaseExpiresAt": effect["leaseExpiresAt"],
        "claimRoot": assignment_fresh_recovery._root(recovered_claim),
    }
    assert receipt["assignmentWrites"][0]["kind"] == "execution-claim"
    assert receipt["nextActions"][0]["action"] == "stage"
    assert receipt["continuationDecision"]["nextAction"] == (receipt["nextActions"][0])


def test_fresh_recovery_execution_lease_fails_closed_before_writes():
    status, binding, plan = _expired_execution_recovery_fixture()
    active = json.loads(json.dumps(status))
    active["active_lease"] = status["execution_claims"][0]
    with __import__("pytest").raises(ValueError, match="active execution lease"):
        assignment_fresh_recovery.build_plan(
            workspace=plan["workspace"],
            status=active,
            binding=binding,
            previous_attempt_id="native:old",
            expected_request_root=status["assignment"]["request_root"],
            expected_work_definition_root=status["assignment"]["work_definition_root"],
            expected_profile_root=plan["workRef"]["profileRoot"],
            recovery_profile=plan["recoveryProfile"],
            profile_active=True,
            now="2026-08-25T09:00:00Z",
        )
    with __import__("pytest").raises(ValueError, match="latest execution claim"):
        assignment_fresh_recovery.build_plan(
            workspace=plan["workspace"],
            status=status,
            binding=binding,
            previous_attempt_id="native:other",
            expected_request_root=status["assignment"]["request_root"],
            expected_work_definition_root=status["assignment"]["work_definition_root"],
            expected_profile_root=plan["workRef"]["profileRoot"],
            recovery_profile=plan["recoveryProfile"],
            profile_active=True,
            now="2026-08-25T09:00:00Z",
        )
    mutations = []
    with __import__("pytest").raises(ValueError, match="expired claim"):
        assignment_fresh_recovery.apply_plan(
            plan,
            expected_plan_root=plan["planRoot"],
            authorized_by="other-maintainer",
            status_reader=lambda: json.loads(json.dumps(status)),
            session_reader=lambda: dict(binding["session"]),
            prepare_profile=lambda _actor: mutations.append("profile") or {},
            bind_work=lambda _expected: mutations.append("bind") or {},
            claim_execution=lambda _values, _actor: mutations.append("claim") or {},
            now="2026-08-25T09:01:00Z",
        )
    assert mutations == []


def test_recovered_execution_status_requires_stage_before_completion():
    status, _binding, plan = _expired_execution_recovery_fixture()
    assert assignment_command.orchestration.next_actions(status)[0]["action"] == (
        "fresh-recovery-plan"
    )
    effect = plan["effects"][-1]
    recovered = json.loads(json.dumps(status))
    recovered["active_lease"] = {
        "attempt_id": effect["attemptId"],
        "lease_id": effect["leaseId"],
        "lease_expires_at": effect["leaseExpiresAt"],
    }
    assert assignment_command.orchestration.next_actions(recovered)[0]["action"] == (
        "stage"
    )


def test_fresh_recovery_separates_retained_authority_from_target_profile(
    tmp_path, monkeypatch
):
    retained = tmp_path / "retained"
    retained.mkdir()
    (retained / "profile.json").write_text("{}", encoding="utf-8")
    target = tmp_path / "target"
    target.mkdir()
    retained_root = f"sha256:{'a' * 64}"
    target_root = f"sha256:{'b' * 64}"
    source_contract_root = f"sha256:{'c' * 64}"

    def lifecycle(_runtime, operation, **_values):
        assert operation == "get"
        return {
            "profile_suite_root": retained_root,
            "latest_event": {
                "closure": {"profile_path": str(retained / "profile.json")}
            },
        }

    def validate(source, _runtime):
        resolved = source.resolve()
        if resolved == retained.resolve():
            return {"inspection": {"profile_suite_root": retained_root}}
        assert resolved == target.resolve()
        return {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": target_root,
                "closure": {"source_contract": {"root": source_contract_root}},
            }
        }

    monkeypatch.setattr(
        assignment_fresh_recovery.storage_service, "profile_lifecycle", lifecycle
    )
    monkeypatch.setattr(
        assignment_fresh_recovery.profile_sdk, "validate_source", validate
    )

    assert assignment_fresh_recovery._retained_profile_source(tmp_path) == retained
    validated = assignment_fresh_recovery._validated_recovery_profile(target, tmp_path)
    assert validated["schema"] == "kungfu.work.planned-profile-source/v1"
    assert validated["profileId"] == "kungfu.work-control"
    assert validated["profileRoot"] == target_root
    assert validated["sourceContractRoot"] == source_contract_root
    assert validated["sourceLocator"] == str(target.resolve())
    assert validated["sourceRoot"] == assignment_fresh_recovery._root(
        {key: value for key, value in validated.items() if key != "sourceRoot"}
    )


def test_resume_prepare_reconciles_the_explicit_recovery_source(tmp_path, monkeypatch):
    source = tmp_path / "historical-work-control"
    source.mkdir()
    desired_root = f"sha256:{'d' * 64}"
    previous_root = f"sha256:{'e' * 64}"
    reconciled = []

    monkeypatch.setattr(
        assignment_command.profile_sdk,
        "validate_source",
        lambda actual, _runtime: (
            {
                "inspection": {
                    "profile": {"id": "kungfu.work-control"},
                    "profile_suite_root": desired_root,
                }
            }
            if actual == source.resolve()
            else (_ for _ in ()).throw(AssertionError("unexpected Profile source"))
        ),
    )

    def lifecycle(_runtime, operation, **_values):
        if operation == "list":
            return {
                "profiles": [
                    {
                        "profile_id": "kungfu.work-control",
                        "profile_suite_root": previous_root,
                        "removed": False,
                    }
                ]
            }
        assert operation == "get"
        return {
            "profile_suite_root": desired_root,
            "qualified": True,
            "activated": True,
        }

    monkeypatch.setattr(
        assignment_command.storage_service, "profile_lifecycle", lifecycle
    )
    monkeypatch.setattr(
        assignment_command.profile_lifecycle,
        "ensure_work_profile",
        lambda actual, runtime, actor: (
            reconciled.append((actual, runtime, actor)) or [{"status": "activated"}]
        ),
    )

    receipt = assignment_command._prepare_resume_profile(
        tmp_path / "runtime", "maintainer:test", source
    )

    assert reconciled == [(source.resolve(), tmp_path / "runtime", "maintainer:test")]
    assert receipt["previousProfileSuiteRoot"] == previous_root
    assert receipt["profileSuiteRoot"] == desired_root


def test_fresh_recovery_prepare_does_not_require_newer_profile_work_hooks(
    tmp_path, monkeypatch
):
    source = tmp_path / "historical-work-control"
    source.mkdir()
    desired_root = f"sha256:{'d' * 64}"
    reconciled = []

    monkeypatch.setattr(
        assignment_command.profile_sdk,
        "validate_source",
        lambda actual, _runtime: {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": desired_root,
            }
        },
    )

    def lifecycle(_runtime, operation, **_values):
        if operation == "list":
            return {"profiles": []}
        assert operation == "get"
        return {
            "profile_suite_root": desired_root,
            "qualified": True,
            "activated": True,
        }

    monkeypatch.setattr(
        assignment_command.storage_service, "profile_lifecycle", lifecycle
    )
    monkeypatch.setattr(
        assignment_command.profile_lifecycle,
        "ensure_profile_lifecycle",
        lambda actual, runtime, actor: (
            reconciled.append((actual, runtime, actor)) or [{"status": "activated"}]
        ),
    )
    monkeypatch.setattr(
        assignment_command.profile_lifecycle,
        "ensure_work_profile",
        lambda *_args: (_ for _ in ()).throw(
            AssertionError("fresh recovery must not invoke newer Profile Work hooks")
        ),
    )

    receipt = assignment_command.profile_lifecycle.prepare_fresh_recovery_profile(
        tmp_path / "runtime", "maintainer:test", source
    )

    assert reconciled == [(source.resolve(), tmp_path / "runtime", "maintainer:test")]
    assert receipt["profileSuiteRoot"] == desired_root
    assert receipt["profileContractMutation"] == "not-permitted"


def test_fresh_recovery_apply_uses_only_planned_authority_ports(tmp_path, monkeypatch):
    status, binding, plan = _fresh_recovery_fixture()
    plan["generatedAt"] = "2099-01-01T00:00:00Z"
    plan["expiresAt"] = "2099-01-01T00:10:00Z"
    plan["planRoot"] = assignment_fresh_recovery._root(
        {key: value for key, value in plan.items() if key != "planRoot"}
    )
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps(plan), encoding="utf-8")
    observed = {}
    profile_source = Path(plan["plannedProfileSource"]["sourceLocator"])
    runtime_dir = tmp_path / "project" / ".kungfu" / "runtime"

    monkeypatch.setattr(
        assignment_fresh_recovery,
        "_verify_planned_workspace",
        lambda *_args: (
            runtime_dir,
            {
                "workspaceId": plan["workspace"]["id"],
                "identityRoot": plan["workspace"]["identityRoot"],
                "runtimeRoot": str(runtime_dir),
                "available": True,
            },
        ),
    )
    monkeypatch.setattr(
        assignment_fresh_recovery,
        "_verify_recovery_profile_source",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        assignment_fresh_recovery,
        "_observe_planned_console",
        lambda *_args: (
            dict(binding["session"]),
            {
                **binding["session"],
                "lifecycleState": "running",
                "live": True,
            },
        ),
    )
    monkeypatch.setattr(
        assignment_fresh_recovery,
        "_status_from_planned_source",
        lambda *_args: json.loads(json.dumps(status)),
    )

    def bind_planned_native_work(*args, **kwargs):
        observed["args"] = args
        observed.update(kwargs)
        return {
            "workRef": dict(plan["workRef"]),
            "session": dict(binding["session"]),
            "receipt": {"receiptRoot": f"sha256:{'8' * 64}"},
        }

    monkeypatch.setattr(
        assignment_fresh_recovery.planned_work_binding,
        "bind_planned_native_work",
        bind_planned_native_work,
    )

    def poison(*_args, **_kwargs):
        raise AssertionError("post-plan authority rediscovery")

    receipt = assignment_fresh_recovery._apply_from_ports(
        ctx=SimpleNamespace(runtime_dir=tmp_path / "console-runtime"),
        plan_file=plan_file,
        expected_plan_root=plan["planRoot"],
        authorized_by="maintainer:test",
        recovery_profile_source=profile_source,
        runtime=poison,
        status=poison,
        prepare_resume_profile=lambda *_args: {
            "status": "ready",
            "profileSuiteRoot": plan["workRef"]["profileRoot"],
        },
    )

    assert receipt["ok"] is True
    assert observed["args"] == (plan["plannedConsoleBinding"]["consoleRuntimeRoot"],)
    assert observed["work_ref"] == plan["workRef"]
    assert observed["session"] == binding["session"]
    assert observed["binding_scope"] == "same-project"
    assert observed["source_workspace_id"] == plan["workspace"]["id"]


def test_fresh_recovery_failure_keeps_public_executable_next_actions(
    tmp_path, monkeypatch
):
    emitted = []
    source = tmp_path / "missing-profile-source"
    failure = assignment_fresh_recovery.FreshRecoveryError(
        "WorkRef is unavailable",
        assignment_fresh_recovery._profile_recovery_actions(source),
    )
    monkeypatch.setattr(assignment_command, "_emit", emitted.append)

    with __import__("pytest").raises(__import__("click").exceptions.Exit):
        assignment_command._run(lambda: (_ for _ in ()).throw(failure))

    assert emitted[0]["ok"] is False
    assert emitted[0]["message"] == "WorkRef is unavailable"
    assert emitted[0]["next_actions"] == failure.next_actions
    assert emitted[0]["next_actions"][0]["command"] == [
        "kungfu",
        "profile",
        "history",
        "kungfu.work-control",
        "--json",
    ]
    assert emitted[0]["next_actions"][1]["command"] == [
        "kungfu",
        "profile",
        "validate",
        str(source),
        "--json",
    ]


def test_fresh_recovery_apply_preserves_complete_lifecycle_state():
    status, binding, plan = _fresh_recovery_fixture()
    events = []

    receipt = assignment_fresh_recovery.apply_plan(
        plan,
        expected_plan_root=plan["planRoot"],
        authorized_by="maintainer:test",
        status_reader=lambda: json.loads(json.dumps(status)),
        session_reader=lambda: dict(binding["session"]),
        prepare_profile=lambda actor: (
            events.append(("profile", actor))
            or {
                "status": "reconciled",
                "profileSuiteRoot": plan["workRef"]["profileRoot"],
            }
        ),
        bind_work=lambda expected: (
            events.append(("bind", expected))
            or {
                "workRef": dict(expected["workRef"]),
                "receipt": {"receiptRoot": f"sha256:{'8' * 64}"},
            }
        ),
        now="2026-08-25T09:01:00Z",
    )

    assert receipt["ok"] is True
    assert receipt["continuationMode"] == "resume/new-attempt"
    assert receipt["assignmentWrites"] == []
    assert receipt["preservation"]["phase"] == "completion-claimed"
    assert [event[0] for event in events] == ["profile", "bind"]


def test_fresh_recovery_ignores_profile_reader_work_semantics_projection():
    status, binding, plan = _fresh_recovery_fixture()
    projected = json.loads(json.dumps(status))
    projected["work_semantics"] = {
        "schema": "kungfu.work-semantics.status/v1",
        "phase": "completion-claimed",
        "next_actions": [{"action": "record-input-snapshot"}],
    }
    observations = iter(
        [
            projected,
            json.loads(json.dumps(status)),
            json.loads(json.dumps(status)),
        ]
    )

    receipt = assignment_fresh_recovery.apply_plan(
        plan,
        expected_plan_root=plan["planRoot"],
        authorized_by="maintainer:test",
        status_reader=lambda: next(observations),
        session_reader=lambda: dict(binding["session"]),
        prepare_profile=lambda _actor: {},
        bind_work=lambda expected: {
            "workRef": dict(expected["workRef"]),
            "receipt": {"receiptRoot": f"sha256:{'8' * 64}"},
        },
        now="2026-08-25T09:01:00Z",
    )

    assert receipt["ok"] is True
    assert receipt["assignmentWrites"] == []
    assert (
        receipt["preservation"]["beforeLifecycleStateRoot"]
        == plan["work"]["lifecycleStateRoot"]
    )


def test_fresh_recovery_fails_closed_on_attempt_plan_or_state_drift():
    status, binding, plan = _fresh_recovery_fixture()
    with __import__("pytest").raises(ValueError, match="new SessionAttempt"):
        assignment_fresh_recovery.build_plan(
            workspace=plan["workspace"],
            status=status,
            binding=binding,
            previous_attempt_id="native:new",
            expected_request_root=status["assignment"]["request_root"],
            expected_work_definition_root=status["assignment"]["work_definition_root"],
            expected_profile_root=plan["workRef"]["profileRoot"],
            recovery_profile=plan["recoveryProfile"],
            profile_active=True,
        )
    drifted = json.loads(json.dumps(status))
    drifted["completion_claim_count"] = 2
    with __import__("pytest").raises(ValueError, match="lifecycle state changed"):
        assignment_fresh_recovery.apply_plan(
            plan,
            expected_plan_root=plan["planRoot"],
            authorized_by="maintainer:test",
            status_reader=lambda: drifted,
            session_reader=lambda: dict(binding["session"]),
            prepare_profile=lambda _actor: {},
            bind_work=lambda expected: {"workRef": dict(expected["workRef"])},
            now="2026-08-25T09:01:00Z",
        )
    forged = {**plan, "continuationMode": "first-attempt"}
    with __import__("pytest").raises(ValueError, match="root does not verify"):
        assignment_fresh_recovery.apply_plan(
            forged,
            expected_plan_root=plan["planRoot"],
            authorized_by="maintainer:test",
            status_reader=lambda: status,
            session_reader=lambda: dict(binding["session"]),
            prepare_profile=lambda _actor: {},
            bind_work=lambda expected: {"workRef": dict(expected["workRef"])},
            now="2026-08-25T09:01:00Z",
        )


def test_fresh_recovery_rejects_expiry_attempt_drift_and_unknown_effects():
    status, binding, plan = _fresh_recovery_fixture()
    mutations = []
    common = {
        "authorized_by": "maintainer:test",
        "status_reader": lambda: status,
        "prepare_profile": lambda _actor: mutations.append("profile") or {},
        "bind_work": lambda expected: (
            mutations.append("bind") or {"workRef": dict(expected["workRef"])}
        ),
    }
    with __import__("pytest").raises(ValueError, match="expired"):
        assignment_fresh_recovery.apply_plan(
            plan,
            expected_plan_root=plan["planRoot"],
            session_reader=lambda: dict(binding["session"]),
            now="2026-08-25T09:11:00Z",
            **common,
        )
    with __import__("pytest").raises(ValueError, match="another current"):
        assignment_fresh_recovery.apply_plan(
            plan,
            expected_plan_root=plan["planRoot"],
            session_reader=lambda: {
                **binding["session"],
                "sessionAttemptId": "native:other",
            },
            now="2026-08-25T09:01:00Z",
            **common,
        )
    forged_body = {
        **{key: value for key, value in plan.items() if key != "planRoot"},
        "effects": [*plan["effects"], {"stage": "admit"}],
    }
    forged = {
        **forged_body,
        "planRoot": assignment_fresh_recovery._root(forged_body),
    }
    with __import__("pytest").raises(ValueError, match="effect sequence"):
        assignment_fresh_recovery.apply_plan(
            forged,
            expected_plan_root=forged["planRoot"],
            session_reader=lambda: dict(binding["session"]),
            now="2026-08-25T09:01:00Z",
            **common,
        )
    assert mutations == []
