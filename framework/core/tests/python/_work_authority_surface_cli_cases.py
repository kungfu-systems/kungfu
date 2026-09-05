# SPDX-License-Identifier: Apache-2.0
"""Public Work CLI and session evidence cases."""
# ruff: noqa: F401,F403

from _work_authority_surface_support import *


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
