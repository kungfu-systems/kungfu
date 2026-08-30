# SPDX-License-Identifier: Apache-2.0

"""Independent Assignment review planning and settlement CLI."""

from __future__ import annotations

import importlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import click

_facade = importlib.import_module("kungfu.cli.commands.assignment")
assignment = _facade.assignment
assignment_context = _facade.assignment_context
surface = _facade.surface
assignment_evidence = _facade.assignment_evidence
assignment_review_lifecycle = _facade.assignment_review_lifecycle
run_agent = _facade.run_agent
orchestration = _facade.orchestration
initiative_family = _facade.initiative_family
_emit = _facade._emit
_run = _facade._run
_runtime = _facade._runtime
_status = _facade._status
_advance = _facade._advance
_assignment_runtime = _facade._assignment_runtime
_work_start_receipt = _facade._work_start_receipt
_agent_report_summary = _facade._agent_report_summary
_find_retained_reviewer_evidence = _facade._find_retained_reviewer_evidence


def _reviewer_read_only_safe(reviewer):
    return reviewer.get("provider") == "codex" or (
        reviewer.get("provider") == "synthetic"
        and reviewer.get("id") == "kungfu.mock-agent.review-fit"
        and reviewer.get("source") == "qualification"
    )


def _work_review_plan(
    *,
    config_home,
    runtime_home,
    agent_report_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    reviewer_profile_id,
    allow_foreign_binding,
):
    identity, runtime_dir, _ = _runtime(workspace_root, home, "read-only")
    status_value = _status(runtime_dir, initiative_id, assignment_id)
    if status_value["phase"] not in {
        "executing",
        "stage-ready",
        "completion-claimed",
    }:
        raise ValueError(
            "independent review settlement requires executing, stage-ready, or "
            f"completion-claimed Work, got {status_value['phase']}"
        )
    report_path, execution_report = assignment_evidence.load_execution_agent_report(
        agent_report_file,
        runtime_dir,
        initiative_id,
        assignment_id,
    )
    reviewer, selection = run_agent.select_profile(
        reviewer_profile_id,
        config_home=config_home,
        runtime_home=runtime_home,
    )
    verification = run_agent.runtime_profiles.verify_profile(reviewer)
    binding = orchestration.binding_provenance(allow_foreign=allow_foreign_binding)
    workspace = Path(identity.workspace_root or "").resolve()
    work_definition = status_value["assignment"]["work_definition"]
    evidence = assignment_evidence.project_review_evidence(
        workspace,
        report_path,
        work_definition,
    )
    acceptance_checks = list(work_definition.get("acceptance_criteria") or [])
    if not acceptance_checks:
        raise ValueError("Assignment has no acceptance criteria to review")
    stable_verification = {
        "ok": verification["ok"],
        "available": verification["available"],
        "version": verification["version"],
        "error": verification["error"],
    }
    reviewer_safe = _reviewer_read_only_safe(reviewer)
    body = {
        "schema": "kungfu.work-review.plan/v1",
        "workspace": {
            "id": identity.workspace_id,
            "root": str(workspace),
            "identityRoot": identity.identity_root,
        },
        "work": {
            "initiativeId": initiative_id,
            "assignmentId": assignment_id,
            "phase": status_value["phase"],
            "queryProofRoot": status_value["query_proof_root"],
            "assignmentRoot": initiative_family.semantic_root(
                status_value["assignment"]
            ),
            "workDefinitionRoot": status_value["assignment"]["work_definition_root"],
            "acceptanceChecks": acceptance_checks,
        },
        "deliverable": evidence["primary"],
        "inputs": evidence["supporting"],
        "evidenceMode": evidence["mode"],
        "execution": {
            "reportPath": str(report_path),
            "reportRoot": execution_report["reportRoot"],
            "runId": execution_report["runId"],
            "episodeId": execution_report["episode"]["episodeId"],
            "agent": execution_report["runtimeProfile"],
            "workRef": execution_report["work"]["workRef"],
        },
        "reviewer": {
            "id": reviewer["id"],
            "label": reviewer["label"],
            "provider": reviewer["provider"],
            "profileRoot": run_agent.canonical_root(reviewer),
            "selection": selection,
            "verification": stable_verification,
            "permissionMode": "read-only" if reviewer_safe else "unsupported",
            "priorTranscriptBytes": 0,
        },
        "admissionBinding": {
            "ok": binding["ok"],
            "state": binding["state"],
            "override": binding["override"],
            "provenanceRoot": binding["provenance_root"],
            "sourceRevision": binding["source_revision"],
        },
        "skippedEffects": [
            "continuation-decision",
            "git-commit",
            "git-push",
            "publication",
        ],
        "confirmationRequired": True,
        "executable": bool(
            binding["ok"] and stable_verification["ok"] and reviewer_safe
        ),
        "writeOccurred": False,
    }
    retained = _find_retained_reviewer_evidence(runtime_dir, body)
    body["reviewExecution"] = (
        {
            "mode": "retained-evidence",
            "reportPath": retained["reportPath"],
            "reportRoot": retained["report"]["reportRoot"],
            "runId": retained["report"]["runId"],
            "episodeId": retained["report"]["episode"]["episodeId"],
            "reviewCut": retained["report"]["work"]["workRef"]["systemTimeCut"],
            "assessmentRoot": initiative_family.semantic_root(retained["assessment"]),
        }
        if retained is not None
        else {
            "mode": "fresh-process",
            "reportPath": None,
            "reportRoot": None,
            "runId": None,
            "episodeId": None,
            "reviewCut": None,
            "assessmentRoot": None,
        }
    )
    body["reviewer"]["freshProcess"] = retained is None  # type: ignore[index]
    effects = []
    if retained is None:
        effects.extend(
            [
                {
                    "stage": "run",
                    "label": "Launch one fresh reviewer in a read-only project sandbox",
                },
                {
                    "stage": "assess",
                    "label": "Check every acceptance criterion against retained sources",
                },
            ]
        )
    else:
        effects.append(
            {
                "stage": "reuse",
                "label": "Reuse the exact retained passing review without rerunning the Agent",
            }
        )
    if status_value["phase"] == "executing":
        effects.extend(
            [
                {
                    "stage": "lease",
                    "label": "Mint a new two-hour lease for bounded review settlement",
                },
                {
                    "stage": "stage",
                    "label": "Record stage-ready only when every criterion passes",
                },
            ]
        )
    if status_value["phase"] in {"executing", "stage-ready"}:
        effects.append(
            {
                "stage": "claim",
                "label": "Publish a proof-bound completion claim by local-user",
            }
        )
    effects.append(
        {
            "stage": "review",
            "label": "Record the reviewer as native independent review",
        }
    )
    body["effects"] = effects
    return {**body, "planRoot": initiative_family.semantic_root(body)}


def _mint_review_settlement_lease(runtime_dir, plan, actor):
    lease_id = f"work-review-{uuid.uuid4().hex}"
    lease_expires_at = (
        (datetime.now(UTC) + timedelta(hours=2)).isoformat().replace("+00:00", "Z")
    )
    agent = plan["execution"]["agent"]
    return _facade._profile_action(
        runtime_dir,
        "claim-assignment",
        {
            "initiativeId": plan["work"]["initiativeId"],
            "assignmentId": plan["work"]["assignmentId"],
            "owner": actor,
            "agent": agent["id"],
            "slot": f"starter-{agent['provider']}",
            "leaseId": lease_id,
            "leaseExpiresAt": lease_expires_at,
            "authorizedBy": actor,
            "grantScope": "assignment-execution",
            "actorType": "user",
            "source": "kungfu",
        },
        actor,
    )


def _native_completion_review_values(plan, reviewer_report):
    return {
        "initiativeId": plan["work"]["initiativeId"],
        "assignmentId": plan["work"]["assignmentId"],
        "reviewer": plan["reviewer"]["id"],
        "reviewerSource": reviewer_report["runId"],
        "source": "kungfu",
        "purpose": "handoff",
        "cutSystemTime": 0,
        # This selects how the native assessment itself executes. The external
        # reviewer identity is carried separately by reviewer/reviewerSource.
        "executorProfile": "thread",
        "proposedFollowups": [],
        # Starter Projects deliberately do not initialize Git. Their sealed
        # Agent Episodes and proof roots are the completion evidence.
        "checkoutPath": "",
    }


def _native_completion_claim_values(plan, reviewer_report, assessment):
    return {
        "initiativeId": plan["work"]["initiativeId"],
        "assignmentId": plan["work"]["assignmentId"],
        "statement": assessment["summary"],
        "actor": "local-user",
        "actorType": "user",
        "source": "kungfu",
        "evidenceEpisodeIds": [
            int(plan["execution"]["episodeId"]),
            int(reviewer_report["episode"]["episodeId"]),
        ],
        "assignmentSet": [plan["work"]["assignmentId"]],
        "acceptanceRoot": plan["work"]["workDefinitionRoot"],
        # Native Assignment evidence is carried by sealed Episodes and proof
        # roots. Atlas and Project Cut roots belong only to legacy authority.
        "proofRoots": [
            plan["execution"]["reportRoot"],
            reviewer_report["reportRoot"],
            plan["deliverable"]["root"],
        ],
        "knownGaps": [],
        "evidenceAvailability": [
            {
                "acceptance": criterion,
                "level": "full",
                "state": "available",
            }
            for criterion in plan["work"]["acceptanceChecks"]
        ],
    }


@assignment.command(
    name="review-agent-plan",
    help="preview a fresh read-only Agent review and native completion review",
)
@click.argument(
    "agent_report_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True)
@click.option("--initiative-id", required=True)
@click.option("--assignment-id", required=True)
@click.option("--reviewer", "reviewer_profile_id", required=True)
@click.option("--allow-foreign-binding", is_flag=True)
@assignment_context
def review_agent_plan(
    ctx,
    agent_report_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    reviewer_profile_id,
    allow_foreign_binding,
):
    _emit(
        _run(
            lambda: _work_review_plan(
                config_home=ctx.config_home,
                runtime_home=ctx.home,
                agent_report_file=agent_report_file,
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
                reviewer_profile_id=reviewer_profile_id,
                allow_foreign_binding=allow_foreign_binding,
            )
        )
    )


@assignment.command(
    name="review-agent-run",
    help="run one exact fresh Agent review and submit passing native evidence",
)
@click.argument(
    "agent_report_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True)
@click.option("--initiative-id", required=True)
@click.option("--assignment-id", required=True)
@click.option("--reviewer", "reviewer_profile_id", required=True)
@click.option("--expected-plan-root", required=True)
@click.option("--execute", is_flag=True)
@click.option("--events-json", is_flag=True)
@click.option("--allow-foreign-binding", is_flag=True)
@assignment_context
@surface(id="kungfu.work.review.agent.run")
def review_agent_run(
    ctx,
    agent_report_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    reviewer_profile_id,
    expected_plan_root,
    execute,
    events_json,
    allow_foreign_binding,
    emit_result=True,
    on_event=None,
):
    event_index = 0

    def event(stage, status, text, root=None, activity=None):
        nonlocal event_index
        event_index += 1
        value = {
            "schema": "kungfu.work-review.event/v1",
            "index": event_index,
            "stage": stage,
            "status": status,
            "text": text,
            "root": root,
        }
        if activity is not None:
            value["activity"] = activity
        if on_event is not None:
            on_event(value)
        if events_json:
            click.echo(json.dumps(value, sort_keys=True))
            click.get_text_stream("stdout").flush()

    services = assignment_review_lifecycle.ReviewServices(
        plan=_work_review_plan,
        receipt=_work_start_receipt,
        runtime=_assignment_runtime,
        retained_evidence=_find_retained_reviewer_evidence,
        agent_report_summary=_agent_report_summary,
        status=_status,
        mint_lease=_mint_review_settlement_lease,
        advance=_advance,
        completion_claim_values=_native_completion_claim_values,
        profile_action=_facade._profile_action,
        completion_review_values=_native_completion_review_values,
    )
    request = assignment_review_lifecycle.ReviewRequest(
        config_home=ctx.config_home,
        runtime_home=ctx.home,
        agent_report_file=agent_report_file,
        workspace_root=workspace_root,
        home=home,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        reviewer_profile_id=reviewer_profile_id,
        expected_plan_root=expected_plan_root,
        execute=execute,
        allow_foreign_binding=allow_foreign_binding,
    )
    result = assignment_review_lifecycle.execute(
        request, services, event, lambda: event_index
    )
    if emit_result:
        if events_json:
            click.echo(json.dumps(result, sort_keys=True))
        else:
            _emit(result)
    return result


for _symbol in ("review_agent_plan", "review_agent_run"):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.assignment"
    globals()[_symbol].callback.__qualname__ = _symbol
