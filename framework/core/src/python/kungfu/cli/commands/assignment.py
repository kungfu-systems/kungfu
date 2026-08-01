# SPDX-License-Identifier: Apache-2.0

"""`kungfu work` — the native Work authority and orchestration surface."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
import hashlib
from pathlib import Path
import uuid

import click

from kungfu import assignment_orchestration as orchestration
from kungfu import dogfood as dogfood_api
from kungfu import profile_composition, profile_sdk
from kungfu.agent import run_agent
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.commands import assignment_review
from kungfu.cli.surface_contract import surface
from kungfu.storage import service as storage_service
from kungfu.workspace import prepare_workspace_write, resolve_workspace_target

assignment_context = kfc.pass_context()


@kfc.group(
    name="work",
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="capture, admit, execute, and inspect Work through native authority",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def assignment(ctx):
    pass


def _emit(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _write_immutable_json(path, value):
    if path is None:
        return None
    output = path.expanduser().resolve()
    content = (orchestration.canonical_json(value) + "\n").encode("utf-8")
    if output.exists() and output.read_bytes() != content:
        raise ValueError("immutable output exists with different bytes")
    output.parent.mkdir(parents=True, exist_ok=True)
    if not output.exists():
        output.write_bytes(content)
    return str(output)


def _failure(code, error, next_actions=None):
    _emit(
        {
            "schema": "kungfu.assignment-orchestration.diagnosis/v1",
            "ok": False,
            "code": code,
            "message": str(error),
            "next_actions": next_actions or [],
        }
    )


def _run(operation):
    try:
        return operation()
    except click.exceptions.Exit:
        raise
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        _failure("assignment-operation-failed", error)
        raise click.exceptions.Exit(2) from error


def _runtime(workspace_root="", home=False, operation_class="semantic-write"):
    target = resolve_workspace_target(
        operation_class,
        workspace_root or None,
        home=home,
        cwd=os.getcwd(),
    )
    identity = target.identity
    if identity.workspace_kind not in {"project", "home"}:
        raise ValueError("Assignment orchestration requires --workspace or --home")
    if operation_class == "read-only":
        if not identity.initialized:
            raise ValueError("Assignment workspace is uninitialized")
        receipt = {
            "schema": "kungfu.workspace.target-receipt/v1",
            "operation_class": "read-only",
            "workspace_id": identity.workspace_id,
            "workspace_kind": identity.workspace_kind,
            "initialized": False,
            "created_paths": [],
            "git_effects": [],
        }
    else:
        receipt = prepare_workspace_write(target, "assignment-orchestration")
        target = resolve_workspace_target(
            operation_class,
            workspace_root or None,
            home=home,
            cwd=os.getcwd(),
        )
        identity = target.identity
        if (
            not identity.initialized
            or identity.identity_root != receipt["workspace_identity_root"]
        ):
            raise RuntimeError("Assignment workspace identity did not stabilize")
    return identity, target.runtime_dir, receipt


def _profile_source():
    profiles = Path(orchestration.__file__).resolve().parent / "profiles"
    for profile_name in ("work-control", "mission-control"):  # compatibility path
        packaged = profiles / profile_name
        if packaged.is_dir():
            return packaged
    extensions = orchestration.source_root() / "extensions"
    for profile_name in ("work-control", "mission-control"):  # compatibility path
        source = extensions / profile_name
        if source.is_dir():
            return source
    raise ValueError("Work Control Profile is absent from this Kungfu product")


def _ensure_profile(runtime_dir, authorized_by):
    source = _profile_source()
    receipts = []
    validated = profile_sdk.validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    profile_id = inspection["profile"]["id"]
    desired_root = inspection["profile_suite_root"]
    lifecycle = storage_service.profile_lifecycle(
        runtime_dir, "list", include_removed=True
    )
    state = next(
        (
            row
            for row in lifecycle.get("profiles", [])
            if row.get("profile_id") == profile_id and not row.get("removed")
        ),
        None,
    )
    if state is None:
        actions = ["install", "qualify", "activate"]
    elif state.get("profile_suite_root") != desired_root:
        actions = ["upgrade", "qualify", "activate"]
    else:
        actions = []
        if not state.get("qualified"):
            actions.append("qualify")
        if not state.get("activated"):
            actions.append("activate")
    for action in actions:
        values = {"granted_permissions": ["storage"]} if action == "activate" else {}
        plan = profile_sdk.lifecycle_plan(runtime_dir, action, source, **values)
        answer = profile_sdk.answer_decision(
            plan["decisionCard"], "approve", authorized_by
        )
        receipts.append(
            profile_sdk.authorized_lifecycle_apply(runtime_dir, plan, answer)
        )
    contract = profile_composition.contract_materialization_plan(source, runtime_dir)
    if contract["operations"]:
        answer = profile_sdk.answer_decision(
            contract["decisionCard"], "approve", authorized_by
        )
        receipts.append(
            profile_composition.authorized_contract_materialize(
                runtime_dir, contract, answer
            )
        )
    return receipts


def _prepare_resume_profile(runtime_dir, actor):
    source = _profile_source()
    validated = profile_sdk.validate_source(source, runtime_dir)
    profile_id = validated["inspection"]["profile"]["id"]
    desired_root = validated["inspection"]["profile_suite_root"]
    lifecycle = storage_service.profile_lifecycle(
        runtime_dir, "list", include_removed=True
    )
    previous = next(
        (
            row
            for row in lifecycle.get("profiles", [])
            if row.get("profile_id") == profile_id and not row.get("removed")
        ),
        None,
    )
    receipts = _ensure_profile(runtime_dir, actor)
    current = storage_service.profile_lifecycle(
        runtime_dir,
        "get",
        profile_id=profile_id,
    )
    if (
        not current.get("activated")
        or not current.get("qualified")
        or current.get("profile_suite_root") != desired_root
    ):
        raise RuntimeError(
            "Work resume did not activate the exact current Work Control Profile root"
        )
    return {
        "schema": "kungfu.work.resume-prepare/v1",
        "status": "reconciled" if receipts else "ready",
        "profileId": profile_id,
        "previousProfileSuiteRoot": (
            previous.get("profile_suite_root") if previous is not None else None
        ),
        "profileSuiteRoot": desired_root,
        "profileLifecycleReceiptCount": len(receipts),
        "writeOccurred": bool(receipts),
    }


def _profile_read(runtime_dir, operation, values):
    return profile_sdk.invoke_member_adapter(
        str(_profile_source()),
        runtime_dir,
        "work-control-actions",
        operation,
        values,
    )["result"]


def _profile_action(runtime_dir, intent_id, values, authorized_by):
    source = str(_profile_source())
    plan = profile_sdk.intent_plan(source, runtime_dir, intent_id, values)
    answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", authorized_by)
    receipt = profile_sdk.intent_apply(runtime_dir, plan, answer)
    return receipt["actionReceipt"]["coreReceipt"]


def _status(runtime_dir, initiative_id, assignment_id, now=""):
    result = _profile_read(
        runtime_dir,
        "assignment-status",
        {
            "initiativeId": initiative_id,
            "assignmentId": assignment_id,
            "source": "atlas",
            "now": now,
        },
    )
    result["initiative_id"] = initiative_id
    result["assignment_id"] = assignment_id
    result["next_actions"] = orchestration.next_actions(result)
    return result


def _admit_captured_assignment(
    *,
    request_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    initiative_admission,
    initiative_admission_stdin="",
    actor,
    actor_type,
    allow_foreign_binding,
):
    binding = orchestration.binding_provenance(allow_foreign=allow_foreign_binding)
    if not binding["ok"]:
        return {
            "schema": "kungfu.assignment-orchestration.admission/v1",
            "ok": False,
            "status": "degraded",
            "admitted": False,
            "binding": binding,
            "next_actions": [
                {
                    "action": "build-core",
                    "command": "./shifu build:core",
                    "description": "Assemble pykungfu from the current checkout",
                }
            ],
        }
    captured = orchestration.load_captured_request(request_file)
    promoted = None
    if initiative_admission:
        promoted = orchestration.load_initiative_admission(
            initiative_admission, stdin_text=initiative_admission_stdin
        )
    projected = orchestration.atlas_assignment_projection(
        captured,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        initiative_admission=promoted,
    )
    identity, runtime_dir, workspace_receipt = _runtime(workspace_root, home)
    lifecycle = _ensure_profile(runtime_dir, actor)
    initiative_receipt = None
    if not projected["initiative_ref"]:
        initiative_receipt = _profile_action(
            runtime_dir,
            "create-initiative",
            {
                "initiativeId": projected["initiative_id"],
                "title": projected["initiative_title"],
                "intent": projected["initiative_intent"],
                "actor": actor,
                "actorType": actor_type,
                "status": "active",
                "horizon": "long-term",
                "sourceIdentity": projected["initiative_source_identity"],
            },
            actor,
        )
    assignment_receipt = _profile_action(
        runtime_dir,
        "create-assignment",
        {
            "initiativeId": projected["initiative_id"],
            "assignmentId": projected["assignment_id"],
            "title": projected["title"],
            "objective": projected["objective"],
            "actor": actor,
            "actorType": actor_type,
            # The Initiative above is created under Kungfu-native authority.
            # Select that same source family when linking the Assignment;
            # capture roots preserve the Atlas request provenance.
            "source": "kungfu",
            "status": "active",
            "parentAssignmentId": projected["parent_assignment_id"],
            "dependsOn": projected["depends_on"],
            "owningWorkspaceIdentityRoot": identity.identity_root,
            "initiativeRef": projected["initiative_ref"],
            "parentAssignmentRef": projected["parent_assignment_ref"],
            "dependencyRefs": projected["dependency_refs"],
            "responsibility": projected["responsibility"],
            "acceptanceRoot": "",
            "atlasRoot": "",
            "contextBinding": projected["context_binding"],
            "projectCutRoot": projected["project_cut_root"],
            "evidenceEpisodeRoots": projected["evidence_episode_roots"],
            "requestRoot": projected["request_root"],
            "captureReceiptRoots": projected["capture_receipt_roots"],
            "workDefinition": projected["work_definition"],
        },
        actor,
    )
    status = _status(
        runtime_dir, projected["initiative_id"], projected["assignment_id"]
    )
    dogfood_receipts = [
        dogfood_api.consider_assignment(
            runtime_dir,
            workspace_root=identity.workspace_root or "",
            home=home,
            assignment=status["assignment"],
            stage=stage,
            actor=actor,
        )
        for stage in ("design", "admission")
    ]
    return {
        "schema": "kungfu.assignment-orchestration.admission/v1",
        "ok": True,
        "status": "admitted",
        "admitted": True,
        "binding": binding,
        "workspace": identity.as_dict(),
        "workspace_receipt": workspace_receipt,
        "request_root": projected["request_root"],
        "capture_receipt_roots": projected["capture_receipt_roots"],
        "initiative_receipt": initiative_receipt,
        "assignment_receipt": assignment_receipt,
        "dogfood_consideration_roots": [
            row["consideration"]["receipt_root"] for row in dogfood_receipts
        ],
        "profile_lifecycle_receipt_count": len(lifecycle),
        "phase": status["phase"],
        "next_actions": status["next_actions"],
    }


@assignment.command(help="capture one canonical request without runtime admission")
@click.option("--request", "request_value", required=True, help="request file or -")
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True, help="capture into the logical Home Workspace")
@click.option("--cwd", type=click.Path(exists=True, file_okay=False))
@click.option("--json", "json_output", is_flag=True, help="machine-readable output")
@assignment_context
@surface(id="kungfu.work.capture")
def capture(ctx, request_value, workspace_root, home, cwd, json_output):
    def operation():
        if request_value == "-":
            request = json.load(click.get_text_stream("stdin"))
        else:
            request = json.loads(
                Path(request_value).expanduser().read_text(encoding="utf-8")
            )
        target = resolve_workspace_target(
            "capture-only",
            workspace_root or None,
            home=home,
            cwd=cwd or os.getcwd(),
        )
        return orchestration.capture_assignment_request(request, target)

    _ = json_output
    _emit(_run(operation))


@assignment.command(help="admit one verified captured request into this workspace")
@click.argument("request_file", type=click.Path(dir_okay=False, path_type=Path))
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True, help="admit into the logical Home Workspace")
@click.option("--initiative-id", default="")
@click.option("--assignment-id", default="")
@click.option(
    "--initiative-admission",
    type=str,
    help="exact parent Initiative admission JSON",
)
@click.option("--actor", required=True)
@click.option("--actor-type", type=click.Choice(["user", "agent"]), default="agent")
@click.option(
    "--allow-foreign-binding",
    is_flag=True,
    help="explicit recovery/testing override; reported as degraded provenance",
)
@assignment_context
def admit(
    ctx,
    request_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    initiative_admission,
    actor,
    actor_type,
    allow_foreign_binding,
):
    def operation():
        initiative_admission_stdin = ""
        if initiative_admission:
            initiative_admission_stdin = (
                click.get_text_stream("stdin").read()
                if initiative_admission == "-"
                else ""
            )
        return _admit_captured_assignment(
            request_file=request_file,
            workspace_root=workspace_root,
            home=home,
            initiative_id=initiative_id,
            assignment_id=assignment_id,
            initiative_admission=initiative_admission,
            initiative_admission_stdin=initiative_admission_stdin,
            actor=actor,
            actor_type=actor_type,
            allow_foreign_binding=allow_foreign_binding,
        )

    result = _run(operation)
    if result is not None:
        _emit(result)
        if result.get("ok") is not True:
            raise click.exceptions.Exit(3)


def _work_start_plan(
    *,
    ctx,
    request_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    profile_id,
    actor,
    allow_foreign_binding,
):
    return assignment_review.build_plan(
        ctx=ctx,
        request_file=request_file,
        workspace_root=workspace_root,
        home=home,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        profile_id=profile_id,
        actor=actor,
        allow_foreign_binding=allow_foreign_binding,
        profile_source=_profile_source,
        status_reader=_status,
    )


_work_start_phase_plan = assignment_review.phase_plan
_project_work_prompt = assignment_review.project_prompt
_work_start_receipt = assignment_review.receipt
_admission_summary = assignment_review.admission_summary
_claim_summary = assignment_review.claim_summary
_kickoff_summary = assignment_review.kickoff_summary
_agent_report_summary = assignment_review.agent_report_summary


@assignment.command(
    name="start-plan",
    help="preview admission, lease, kickoff, and one bound Agent run",
)
@click.argument(
    "request_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True)
@click.option("--initiative-id", default="")
@click.option("--assignment-id", default="")
@click.option("--agent", "profile_id", required=True)
@click.option("--actor", default="local-user", show_default=True)
@click.option(
    "--allow-foreign-binding",
    is_flag=True,
    help="development/testing override; retained as degraded provenance",
)
@assignment_context
def start_plan(
    ctx,
    request_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    profile_id,
    actor,
    allow_foreign_binding,
):
    _emit(
        _run(
            lambda: _work_start_plan(
                ctx=ctx,
                request_file=request_file,
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
                profile_id=profile_id,
                actor=actor,
                allow_foreign_binding=allow_foreign_binding,
            )
        )
    )


@assignment.command(
    name="start",
    help="admit, lease, kickoff, and launch one Agent from an exact plan",
)
@click.argument(
    "request_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True)
@click.option("--initiative-id", default="")
@click.option("--assignment-id", default="")
@click.option("--agent", "profile_id", required=True)
@click.option("--actor", default="local-user", show_default=True)
@click.option("--expected-plan-root", required=True)
@click.option("--execute", is_flag=True)
@click.option("--events-json", is_flag=True)
@click.option(
    "--allow-foreign-binding",
    is_flag=True,
    help="development/testing override; retained as degraded provenance",
)
@assignment_context
@surface(id="kungfu.work.start")
def start_work(
    ctx,
    request_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    profile_id,
    actor,
    expected_plan_root,
    execute,
    events_json,
    allow_foreign_binding,
    emit_result=True,
):
    event_index = 0

    def event(stage, status, text, root=None, activity=None):
        nonlocal event_index
        event_index += 1
        payload = {
            "schema": "kungfu.work-start.event/v1",
            "index": event_index,
            "stage": stage,
            "status": status,
            "text": text,
            "root": root,
        }
        if activity is not None:
            payload["activity"] = dict(activity)
        if events_json:
            click.echo(json.dumps(payload, sort_keys=True))
            click.get_text_stream("stdout").flush()

    def operation():
        stage = "plan"
        write_occurred = False
        last_status = None
        plan = _work_start_plan(
            ctx=ctx,
            request_file=request_file,
            workspace_root=workspace_root,
            home=home,
            initiative_id=initiative_id,
            assignment_id=assignment_id,
            profile_id=profile_id,
            actor=actor,
            allow_foreign_binding=allow_foreign_binding,
        )
        if expected_plan_root != plan["planRoot"]:
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-start.receipt/v1",
                    "ok": False,
                    "status": "plan-drift",
                    "planRoot": plan["planRoot"],
                    "expectedPlanRoot": expected_plan_root,
                    "failedAt": stage,
                    "message": "Work start plan changed; preview and confirm again",
                    "workPhase": "captured",
                    "nextActions": ["preview-work-start-again"],
                    "writeOccurred": False,
                }
            )
        if not execute:
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-start.receipt/v1",
                    "ok": False,
                    "status": "confirmation-required",
                    "planRoot": plan["planRoot"],
                    "failedAt": stage,
                    "message": "Work start requires --execute after plan confirmation",
                    "workPhase": "captured",
                    "nextActions": ["confirm-work-start"],
                    "writeOccurred": False,
                }
            )
        if not plan["executable"]:
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-start.receipt/v1",
                    "ok": False,
                    "status": "not-executable",
                    "planRoot": plan["planRoot"],
                    "failedAt": stage,
                    "message": plan["blockedReason"]
                    or "Agent or native admission binding did not verify",
                    "workPhase": plan["work"]["phase"],
                    "nextActions": [
                        "inspect-current-work-status",
                        "preview-work-start-again",
                    ],
                    "writeOccurred": False,
                }
            )
        receipts = {}
        try:
            event(
                "plan",
                "completed",
                "Exact Work start plan verified.",
                plan["planRoot"],
            )
            continuation_mode = plan["continuationMode"]
            if continuation_mode != "first-attempt":
                stage = "resume"
                target = resolve_workspace_target(
                    "read-only",
                    workspace_root or None,
                    home=home,
                    cwd=os.getcwd(),
                )
                runtime_dir = str(target.runtime_dir)
                last_status = _status(
                    runtime_dir,
                    plan["work"]["initiativeId"],
                    plan["work"]["assignmentId"],
                )
                admission = {
                    "workspace": {
                        "workspace_id": plan["workspace"]["id"],
                        "workspace_root": plan["workspace"]["root"],
                        "runtime_dir": runtime_dir,
                    }
                }
                event(
                    stage,
                    "completed",
                    f"Resuming Work from its {last_status['phase']} phase.",
                    last_status["query_proof_root"],
                )
            else:
                stage = "admit"
                event(
                    stage, "started", "Admitting captured Work into native authority."
                )
                admission = _admit_captured_assignment(
                    request_file=request_file,
                    workspace_root=workspace_root,
                    home=home,
                    initiative_id=plan["work"]["initiativeId"],
                    assignment_id=plan["work"]["assignmentId"],
                    initiative_admission=None,
                    actor=actor,
                    actor_type="user",
                    allow_foreign_binding=allow_foreign_binding,
                )
                if admission["ok"] is not True:
                    raise RuntimeError("captured Work admission did not qualify")
                write_occurred = True
                runtime_dir = admission["workspace"]["runtime_dir"]
                last_status = _status(
                    runtime_dir,
                    plan["work"]["initiativeId"],
                    plan["work"]["assignmentId"],
                )
                receipts["admission"] = _admission_summary(admission, last_status)
                event(
                    stage,
                    "completed",
                    "Initiative and Assignment admitted.",
                    last_status["query_proof_root"],
                )

            if continuation_mode in {
                "first-attempt",
                "existing-admitted-work",
            }:
                stage = "claim"
                event(stage, "started", "Minting a bounded Agent execution lease.")
                lease_id = f"work-start-{uuid.uuid4().hex}"
                lease_expires_at = (
                    (datetime.now(UTC) + timedelta(hours=2))
                    .isoformat()
                    .replace("+00:00", "Z")
                )
                claim_receipt = _profile_action(
                    runtime_dir,
                    "claim-assignment",
                    {
                        "initiativeId": plan["work"]["initiativeId"],
                        "assignmentId": plan["work"]["assignmentId"],
                        "owner": actor,
                        "agent": plan["agent"]["id"],
                        "slot": f"project-{plan['agent']['provider']}",
                        "leaseId": lease_id,
                        "leaseExpiresAt": lease_expires_at,
                        "authorizedBy": actor,
                        "grantScope": "assignment-execution",
                        "actorType": "user",
                        "source": "kungfu",
                    },
                    actor,
                )
                write_occurred = True
                last_status = _status(
                    runtime_dir,
                    plan["work"]["initiativeId"],
                    plan["work"]["assignmentId"],
                )
                receipts["claim"] = _claim_summary(claim_receipt, last_status)
                event(
                    stage,
                    "completed",
                    f"Execution lease bound to {plan['agent']['label']}.",
                    last_status["query_proof_root"],
                )

            if continuation_mode in {
                "first-attempt",
                "existing-admitted-work",
                "existing-claimed-work",
            }:
                stage = "kickoff"
                event(stage, "started", "Entering the executing phase.")
                kickoff_receipt = _advance(
                    workspace_root,
                    home,
                    plan["work"]["initiativeId"],
                    plan["work"]["assignmentId"],
                    "executing",
                    actor,
                    "Start the user-selected verified Agent for this Assignment",
                )
                write_occurred = True
                last_status = kickoff_receipt["status"]
                receipts["kickoff"] = _kickoff_summary(kickoff_receipt)
            run_gate = orchestration.gate(last_status, "run")
            if run_gate["ok"] is not True:
                raise RuntimeError(run_gate["reason"])
            event(
                stage,
                "completed",
                "Work is executing under the active lease.",
                last_status["query_proof_root"],
            )

            stage = "run"
            work_ref = {
                "schema": "kungfu.work-ref/v1",
                "workspaceId": admission["workspace"]["workspace_id"],
                "profileId": plan["workControl"]["profileId"],
                "profileRoot": plan["workControl"]["profileRoot"],
                "entityType": "assignment",
                "entityId": plan["work"]["assignmentId"],
                "entityRoot": orchestration.semantic_root(last_status["assignment"]),
                "purpose": "complete-project-assignment",
                "systemTimeCut": last_status["query_proof_root"],
            }
            event(
                stage,
                "started",
                f"Launching fresh {plan['agent']['label']} process.",
                work_ref["entityRoot"],
            )

            def on_agent_activity(activity):
                event(
                    stage,
                    str(activity.get("phase") or "progress"),
                    str(activity.get("text") or "Agent activity"),
                    activity=activity,
                )

            agent_report = run_agent.execute(
                prompt=_project_work_prompt(plan),
                runtime_dir=runtime_dir,
                config_home=ctx.config_home,
                profile_id=plan["agent"]["id"],
                workspace_root=admission["workspace"]["workspace_root"],
                home=ctx.home,
                work_ref=work_ref,
                event_sink=on_agent_activity,
            )
            exit_code = int(agent_report["launch"]["exitCode"])
            session_value = agent_report.get("session") or {}
            session_live = session_value.get("live") is True
            event(
                stage,
                "waiting"
                if session_live
                else "completed"
                if exit_code == 0
                else "failed",
                (
                    "Agent Session needs your attention; Work remains executing."
                    if session_live
                    else "Agent process finished; independent assessment is still required."
                    if exit_code == 0
                    else f"Agent process exited {exit_code}; Work remains executing."
                ),
                agent_report["reportRoot"],
            )
            body = {
                "schema": "kungfu.work-start.receipt/v1",
                "ok": exit_code == 0,
                "status": (
                    "agent-waiting"
                    if session_live
                    else "agent-finished"
                    if exit_code == 0
                    else "agent-failed"
                ),
                "planRoot": plan["planRoot"],
                "workPhase": last_status["phase"],
                "workspace": admission["workspace"],
                "workRef": work_ref,
                "work": plan["work"],
                "agent": plan["agent"],
                "agentReport": _agent_report_summary(agent_report),
                "authorityReceipts": receipts,
                "nextActions": (
                    list(
                        (
                            (session_value.get("workAgent") or {}).get("attention")
                            or {}
                        ).get("nextActions")
                        or ["inspect-agent-session"]
                    )
                    if session_live
                    else [
                        "review-project-changes",
                        "run-independent-assessment",
                        "claim-completion-only-with-evidence",
                    ]
                    if exit_code == 0
                    else [
                        "inspect-retained-agent-report",
                        "repair-agent-runtime-or-project",
                        "inspect-current-work-status",
                    ]
                ),
                "nonClaims": [
                    "Agent process exit does not complete the Assignment.",
                    "The executing Agent does not independently assess its own result.",
                    "No Git commit, push, or publication was attempted.",
                ],
                "writeOccurred": True,
            }
            if exit_code != 0:
                body["failedAt"] = "run"
                body["message"] = (
                    f"Agent process exited {exit_code}; inspect retained report "
                    f"{agent_report['reportRoot']} before recovery."
                )
            return _work_start_receipt(body)
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            phase = (
                str(last_status.get("phase") or "captured")
                if isinstance(last_status, dict)
                else "captured"
            )
            event(stage, "failed", str(error))
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-start.receipt/v1",
                    "ok": False,
                    "status": "failed",
                    "planRoot": plan["planRoot"],
                    "failedAt": stage,
                    "message": str(error),
                    "workPhase": phase,
                    "authorityReceipts": receipts,
                    "nextActions": [
                        "inspect-current-work-status",
                        "repair-the-failed-stage",
                        "do-not-repeat-completed-authority-effects",
                    ],
                    "writeOccurred": write_occurred,
                }
            )

    result = operation()
    if emit_result:
        if events_json:
            click.echo(json.dumps(result, sort_keys=True))
        else:
            _emit(result)
    return result


def _content_root(path):
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


_REVIEW_EVIDENCE_SUFFIXES = {
    ".csv",
    ".json",
    ".md",
    ".rst",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}
_REVIEW_EVIDENCE_EXCLUDED_DIRECTORIES = {
    ".git",
    ".kungfu",
    ".venv",
    "build",
    "dist",
    "node_modules",
    "target",
}
_REVIEW_EVIDENCE_FILE_LIMIT = 24
_REVIEW_EVIDENCE_BYTES_LIMIT = 1024 * 1024


def _project_review_evidence(workspace, report_path, work_definition):
    workspace = Path(workspace).resolve()
    explicit = work_definition.get("evidence_paths") or []
    if not isinstance(explicit, list) or any(
        not isinstance(value, str) or not value.strip() for value in explicit
    ):
        raise ValueError("Assignment evidence_paths must be an array of paths")
    candidates = []
    if explicit:
        for value in explicit:
            candidate = (workspace / value).resolve()
            if workspace not in candidate.parents or not candidate.is_file():
                raise ValueError(f"Assignment evidence path is unavailable: {value}")
            candidates.append(candidate)
    else:
        for root, directories, filenames in os.walk(workspace):
            directories[:] = sorted(
                directory
                for directory in directories
                if directory not in _REVIEW_EVIDENCE_EXCLUDED_DIRECTORIES
                and not directory.startswith(".")
            )
            for filename in sorted(filenames):
                candidate = Path(root) / filename
                if candidate.suffix.lower() not in _REVIEW_EVIDENCE_SUFFIXES:
                    continue
                try:
                    size = candidate.stat().st_size
                except OSError:
                    continue
                if size <= _REVIEW_EVIDENCE_BYTES_LIMIT:
                    candidates.append(candidate.resolve())

    def priority(candidate):
        relative = candidate.relative_to(workspace)
        parts = relative.parts
        return (
            0
            if parts and parts[0] == "deliverables"
            else 1
            if relative.as_posix() == "WORK.md"
            else 2
            if relative.as_posix() == "README.md"
            else 3
            if parts and parts[0] == "inputs"
            else 4,
            relative.as_posix(),
        )

    selected: list[Path] = []
    total_bytes = 0
    for candidate in sorted(set(candidates), key=priority):
        size = candidate.stat().st_size
        if len(selected) >= _REVIEW_EVIDENCE_FILE_LIMIT:
            break
        if total_bytes + size > _REVIEW_EVIDENCE_BYTES_LIMIT:
            continue
        selected.append(candidate)
        total_bytes += size
    if selected:
        primary, *supporting = selected
        return {
            "mode": "project-files",
            "primary": {
                "path": primary.relative_to(workspace).as_posix(),
                "root": _content_root(primary),
                "content": primary.read_text(encoding="utf-8"),
            },
            "supporting": [
                {
                    "path": candidate.relative_to(workspace).as_posix(),
                    "root": _content_root(candidate),
                }
                for candidate in supporting
            ],
        }
    report_path = Path(report_path).resolve()
    try:
        display_path = report_path.relative_to(workspace).as_posix()
    except ValueError:
        display_path = str(report_path)
    return {
        "mode": "execution-report",
        "primary": {
            "path": display_path,
            "root": _content_root(report_path),
            "content": report_path.read_text(encoding="utf-8"),
        },
        "supporting": [],
    }


def _load_execution_agent_report(
    path,
    runtime_dir,
    initiative_id,
    assignment_id,
    *,
    require_success=True,
):
    report_path = Path(path).expanduser().resolve()
    allowed_root = (Path(runtime_dir) / "agent-runs").resolve()
    if report_path != allowed_root and allowed_root not in report_path.parents:
        raise ValueError("Agent report must belong to this workspace runtime")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("schema") != run_agent.REPORT_SCHEMA:
        raise ValueError("Agent report schema is not supported")
    expected_root = run_agent.canonical_root(
        {key: value for key, value in report.items() if key != "reportRoot"}
    )
    if report.get("reportRoot") != expected_root:
        raise ValueError("Agent report root does not match its content")
    work_ref = (report.get("work") or {}).get("workRef") or {}
    if (
        work_ref.get("entityType") != "assignment"
        or work_ref.get("entityId") != assignment_id
    ):
        raise ValueError("Agent report is not bound to this Assignment")
    if require_success and report.get("launch", {}).get("exitCode") != 0:
        raise ValueError("Agent report does not contain a successful execution")
    return report_path, report


def _latest_starter_agent_report(runtime_dir, initiative_id, assignment_id):
    reports = sorted(
        (Path(runtime_dir) / "agent-runs").glob("*/bundle/report.json"),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    for report_path in reports:
        try:
            _, report = _load_execution_agent_report(
                report_path,
                runtime_dir,
                initiative_id,
                assignment_id,
                require_success=False,
            )
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        work_ref = (report.get("work") or {}).get("workRef") or {}
        if work_ref.get("purpose") in {
            "complete-starter-deliverable",
            "complete-project-assignment",
        }:
            return report
    return None


def _resume_starter_work(
    *,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
):
    identity, runtime_dir, _ = _runtime(workspace_root, home, "read-only")
    status_value = _status(runtime_dir, initiative_id, assignment_id)
    report = _latest_starter_agent_report(runtime_dir, initiative_id, assignment_id)
    if report is None:
        return {
            "schema": "kungfu.work-start.resume/v1",
            "status": "no-retained-agent-run",
            "workReceipt": None,
            "writeOccurred": False,
        }
    assignment_value = status_value["assignment"]
    request_root = assignment_value["request_root"]
    request_digest = request_root.removeprefix("sha256:")
    request_path = (
        Path(identity.data_home)
        / "inbox"
        / "assignment-requests"
        / "sha256"
        / request_digest[:2]
        / request_digest
        / "request.json"
    )
    runtime_profile = report["runtimeProfile"]
    work = {
        "requestPath": str(request_path),
        "requestRoot": request_root,
        "initiativeId": initiative_id,
        "assignmentId": assignment_id,
        "title": assignment_value["title"],
        "objective": assignment_value["objective"],
        "acceptanceChecks": list(
            assignment_value["work_definition"].get("acceptance_criteria") or []
        ),
    }
    plan_root = orchestration.semantic_root(
        {
            "schema": "kungfu.work-start.resume-plan/v1",
            "queryProofRoot": status_value["query_proof_root"],
            "reportRoot": report["reportRoot"],
        }
    )
    exit_code = int(report["launch"]["exitCode"])
    receipt = _work_start_receipt(
        {
            "schema": "kungfu.work-start.receipt/v1",
            "ok": exit_code == 0,
            "status": "agent-finished" if exit_code == 0 else "agent-failed",
            "planRoot": plan_root,
            "workPhase": status_value["phase"],
            "workspace": identity.as_dict(),
            "workRef": report["work"]["workRef"],
            "work": work,
            "agent": {
                "id": runtime_profile["id"],
                "label": runtime_profile["id"],
                "provider": runtime_profile["provider"],
                "profileRoot": runtime_profile["root"],
                "selection": runtime_profile["selection"],
                "verification": {
                    "ok": runtime_profile["verified"],
                    "available": runtime_profile["verified"],
                    "version": runtime_profile["version"],
                    "error": None,
                },
            },
            "agentReport": _agent_report_summary(report),
            "nextActions": (
                ["run-independent-review"]
                if exit_code == 0
                else ["inspect-retained-agent-report", "retry-agent-run"]
            ),
            "nonClaims": [
                "Restoring this receipt does not rerun the Agent.",
                "Agent exit does not settle Work.",
            ],
            "writeOccurred": True,
        }
    )
    return {
        "schema": "kungfu.work-start.resume/v1",
        "status": "retained-agent-run",
        "workReceipt": receipt,
        "writeOccurred": False,
    }


@assignment.command(
    name="resume-prepare",
    help="reconcile the exact Work Control Profile before product resume",
    hidden=True,
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True)
@click.option("--actor", default="kungfu-product", show_default=True)
@click.option("--execute", is_flag=True)
@assignment_context
def resume_prepare(
    ctx,
    workspace_root,
    home,
    actor,
    execute,
):
    del ctx

    def operation():
        if not execute:
            raise ValueError("resume-prepare requires explicit --execute")
        identity, runtime_dir, _ = _runtime(
            workspace_root,
            home,
            "read-only",
        )
        return {
            **_prepare_resume_profile(runtime_dir, actor),
            "workspace": identity.as_dict(),
        }

    _emit(_run(operation))


@assignment.command(
    name="start-resume",
    help="resume the latest retained Starter Agent run without writing",
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True)
@click.option("--initiative-id", required=True)
@click.option("--assignment-id", required=True)
@assignment_context
@surface(id="kungfu.work.start.resume")
def start_resume(
    ctx,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
):
    del ctx
    _emit(
        _run(
            lambda: _resume_starter_work(
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
            )
        )
    )


def _reviewer_read_only_safe(reviewer):
    return reviewer.get("provider") == "codex" or (
        reviewer.get("provider") == "synthetic"
        and reviewer.get("id") == "kungfu.mock-agent.review-fit"
        and reviewer.get("source") == "qualification"
    )


def _work_review_plan(
    *,
    ctx,
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
    report_path, execution_report = _load_execution_agent_report(
        agent_report_file,
        runtime_dir,
        initiative_id,
        assignment_id,
    )
    reviewer, selection = run_agent.select_profile(
        reviewer_profile_id,
        config_home=ctx.config_home,
        runtime_home=ctx.home,
    )
    verification = run_agent.runtime_profiles.verify_profile(reviewer)
    binding = orchestration.binding_provenance(allow_foreign=allow_foreign_binding)
    workspace = Path(identity.workspace_root or "").resolve()
    work_definition = status_value["assignment"]["work_definition"]
    evidence = _project_review_evidence(
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
            "assignmentRoot": orchestration.semantic_root(status_value["assignment"]),
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
            "assessmentRoot": orchestration.semantic_root(retained["assessment"]),
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
    return {**body, "planRoot": orchestration.semantic_root(body)}


def _find_retained_reviewer_evidence(runtime_dir, plan):
    expected_prompt_root = run_agent.canonical_root(
        assignment_review.review_agent_prompt(plan)
    )
    reports = sorted(
        (Path(runtime_dir) / "agent-runs").glob("*/bundle/report.json"),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    for report_path in reports:
        try:
            _, report = _load_execution_agent_report(
                report_path,
                runtime_dir,
                plan["work"]["initiativeId"],
                plan["work"]["assignmentId"],
            )
            work_ref = report["work"]["workRef"]
            runtime_profile = report["runtimeProfile"]
            launch = report["launch"]
            privacy = report["privacy"]
            argv = list(launch.get("argvWithoutPrompt") or [])
            read_only_launch = launch.get("permissionMode") == "read-only" or (
                "--sandbox" in argv and "read-only" in argv
            )
            if (
                work_ref.get("workspaceId") != plan["workspace"]["id"]
                or work_ref.get("profileId") != "kungfu.work-control"
                or work_ref.get("profileRoot")
                != plan["execution"]["workRef"]["profileRoot"]
                or work_ref.get("entityRoot") != plan["work"]["assignmentRoot"]
                or work_ref.get("purpose") != "independent-completion-review"
                or runtime_profile.get("id") != plan["reviewer"]["id"]
                or runtime_profile.get("root") != plan["reviewer"]["profileRoot"]
                or launch.get("cwd") != plan["workspace"]["root"]
                or launch.get("promptRoot") != expected_prompt_root
                or not read_only_launch
                or privacy.get("priorTranscriptBytesGivenToAgent") != 0
                or privacy.get("privateProviderSessionStoreRead") is not False
            ):
                continue
            assessment = assignment_review.parse_reviewer_result(
                report, plan["work"]["acceptanceChecks"]
            )
            if assessment["verdict"] != "fit":
                continue
        except (KeyError, OSError, ValueError, json.JSONDecodeError):
            continue
        return {
            "reportPath": str(report_path),
            "report": report,
            "assessment": assessment,
        }
    return None


def _mint_review_settlement_lease(runtime_dir, plan, actor):
    lease_id = f"work-review-{uuid.uuid4().hex}"
    lease_expires_at = (
        (datetime.now(UTC) + timedelta(hours=2)).isoformat().replace("+00:00", "Z")
    )
    agent = plan["execution"]["agent"]
    return _profile_action(
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
                ctx=ctx,
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
        if events_json:
            click.echo(json.dumps(value, sort_keys=True))
            click.get_text_stream("stdout").flush()

    def operation():
        plan = _work_review_plan(
            ctx=ctx,
            agent_report_file=agent_report_file,
            workspace_root=workspace_root,
            home=home,
            initiative_id=initiative_id,
            assignment_id=assignment_id,
            reviewer_profile_id=reviewer_profile_id,
            allow_foreign_binding=allow_foreign_binding,
        )
        if plan["planRoot"] != expected_plan_root:
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-review.receipt/v1",
                    "ok": False,
                    "status": "plan-drift",
                    "planRoot": plan["planRoot"],
                    "message": "Review plan changed; preview it again.",
                    "workPhase": plan["work"]["phase"],
                    "nextActions": ["preview-review-again"],
                    "writeOccurred": False,
                }
            )
        if not execute:
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-review.receipt/v1",
                    "ok": False,
                    "status": "confirmation-required",
                    "planRoot": plan["planRoot"],
                    "message": "Explicit --execute confirmation is required.",
                    "workPhase": plan["work"]["phase"],
                    "nextActions": ["confirm-independent-review"],
                    "writeOccurred": False,
                }
            )
        if not plan["executable"]:
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-review.receipt/v1",
                    "ok": False,
                    "status": "not-executable",
                    "planRoot": plan["planRoot"],
                    "message": "Reviewer or native binding verification failed.",
                    "workPhase": plan["work"]["phase"],
                    "nextActions": ["repair-reviewer-verification"],
                    "writeOccurred": False,
                }
            )
        identity, runtime_dir, _ = _runtime(workspace_root, home, "read-only")
        work_ref = {
            "schema": "kungfu.work-ref/v1",
            "workspaceId": plan["workspace"]["id"],
            "profileId": "kungfu.work-control",
            "profileRoot": plan["execution"]["workRef"]["profileRoot"],
            "entityType": "assignment",
            "entityId": assignment_id,
            "entityRoot": plan["work"]["assignmentRoot"],
            "purpose": "independent-completion-review",
            "systemTimeCut": plan["work"]["queryProofRoot"],
        }
        retained = _find_retained_reviewer_evidence(runtime_dir, plan)
        if plan["reviewExecution"]["mode"] == "retained-evidence":
            if (
                retained is None
                or retained["report"]["reportRoot"]
                != plan["reviewExecution"]["reportRoot"]
            ):
                raise RuntimeError(
                    "retained reviewer evidence changed before settlement"
                )
            reviewer_report = retained["report"]
            assessment = retained["assessment"]
            event(
                "reuse",
                "completed",
                "Exact passing reviewer evidence restored; no Agent was rerun.",
                reviewer_report["reportRoot"],
            )
        else:
            if retained is not None:
                raise RuntimeError(
                    "passing reviewer evidence appeared; preview the resumable plan"
                )
            event(
                "run",
                "started",
                f"Fresh {plan['reviewer']['label']} reviewer started.",
            )

            def on_agent_activity(activity):
                event(
                    "run",
                    str(activity.get("phase") or "progress"),
                    str(activity.get("text") or "Reviewer activity"),
                    activity=activity,
                )

            reviewer_report = run_agent.execute(
                prompt=assignment_review.review_agent_prompt(plan),
                runtime_dir=runtime_dir,
                config_home=ctx.config_home,
                profile_id=plan["reviewer"]["id"],
                workspace_root=identity.workspace_root,
                home=ctx.home,
                work_ref=work_ref,
                permission_mode="read-only",
                event_sink=on_agent_activity,
            )
            exit_code = int(reviewer_report["launch"]["exitCode"])
            if exit_code != 0:
                event(
                    "run",
                    "failed",
                    f"Reviewer process exited {exit_code}.",
                    reviewer_report["reportRoot"],
                )
                return _work_start_receipt(
                    {
                        "schema": "kungfu.work-review.receipt/v1",
                        "ok": False,
                        "status": "reviewer-failed",
                        "planRoot": plan["planRoot"],
                        "message": f"Reviewer process exited {exit_code}.",
                        "workPhase": plan["work"]["phase"],
                        "reviewerReport": _agent_report_summary(reviewer_report),
                        "nextActions": ["inspect-reviewer-report", "retry-review"],
                        "writeOccurred": True,
                    }
                )
            assessment = assignment_review.parse_reviewer_result(
                reviewer_report, plan["work"]["acceptanceChecks"]
            )
            event(
                "assess",
                "completed" if assessment["verdict"] == "fit" else "failed",
                (
                    "Every acceptance criterion passed."
                    if assessment["verdict"] == "fit"
                    else "Reviewer found required revisions."
                ),
                reviewer_report["reportRoot"],
            )
        if assessment["verdict"] != "fit":
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-review.receipt/v1",
                    "ok": False,
                    "status": "revision-required",
                    "planRoot": plan["planRoot"],
                    "message": assessment["summary"],
                    "workPhase": plan["work"]["phase"],
                    "assessment": assessment,
                    "reviewerReport": _agent_report_summary(reviewer_report),
                    "nextActions": ["revise-deliverable", "run-review-again"],
                    "writeOccurred": True,
                }
            )
        authority_receipts = {}
        current = _status(runtime_dir, initiative_id, assignment_id)
        if current["phase"] == "executing":
            event(
                "lease",
                "started",
                "Minting a bounded lease for review settlement.",
            )
            lease_receipt = _mint_review_settlement_lease(
                runtime_dir, plan, "local-user"
            )
            authority_receipts["lease"] = lease_receipt
            current = _status(runtime_dir, initiative_id, assignment_id)
            event(
                "lease",
                "completed",
                "Review settlement lease is active for two hours.",
                current["query_proof_root"],
            )
            event("stage", "started", "Recording the stage-ready boundary.")
            stage_receipt = _advance(
                workspace_root,
                home,
                initiative_id,
                assignment_id,
                "stage-ready",
                "local-user",
                (
                    f"Independent reviewer {reviewer_report['reportRoot']} "
                    "passed every criterion"
                ),
            )
            authority_receipts["stage"] = stage_receipt
            current = stage_receipt["status"]
            event(
                "stage",
                "completed",
                "Work is stage-ready.",
                current["query_proof_root"],
            )
        if current["phase"] not in {"stage-ready", "completion-claimed"}:
            raise RuntimeError(
                f"review settlement cannot continue from {current['phase']}"
            )
        claim_values = _native_completion_claim_values(
            plan, reviewer_report, assessment
        )
        if current["phase"] == "stage-ready":
            event("claim", "started", "Publishing the proof-bound completion claim.")
            claim_receipt = _profile_action(
                runtime_dir, "claim-completion", claim_values, "local-user"
            )
            authority_receipts["claim"] = claim_receipt
            current = _status(runtime_dir, initiative_id, assignment_id)
            event(
                "claim",
                "completed",
                "Completion claim recorded.",
                current["query_proof_root"],
            )
        if current["phase"] != "completion-claimed":
            raise RuntimeError(
                f"native independent review requires completion-claimed Work, got "
                f"{current['phase']}"
            )
        review_values = _native_completion_review_values(plan, reviewer_report)
        event("review", "started", "Recording native independent review.")
        review_receipt = _profile_action(
            runtime_dir,
            "review-completion",
            review_values,
            plan["reviewer"]["id"],
        )
        authority_receipts["review"] = review_receipt
        current = _status(runtime_dir, initiative_id, assignment_id)
        native_review = review_receipt.get("review") or {}
        verdict = str(native_review.get("verdict") or "unknown")
        event(
            "review",
            "completed" if verdict == "fit" else "failed",
            f"Native independent review verdict: {verdict}.",
        )
        return _work_start_receipt(
            {
                "schema": "kungfu.work-review.receipt/v1",
                "ok": verdict == "fit",
                "status": "review-passed"
                if verdict == "fit"
                else "review-needs-action",
                "planRoot": plan["planRoot"],
                "message": assessment["summary"],
                "workPhase": current["phase"],
                "assessment": assessment,
                "nativeVerdict": verdict,
                "reviewerReport": _agent_report_summary(reviewer_report),
                "authorityReceipts": authority_receipts,
                "nextActions": (
                    ["decide-close-or-continue"]
                    if verdict == "fit"
                    else list(current["next_actions"])
                ),
                "writeOccurred": True,
            }
        )

    try:
        result = operation()
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        write_occurred = event_index > 0
        event("review", "failed", str(error))
        try:
            current_phase = _status(
                _runtime(workspace_root, home, "read-only")[1],
                initiative_id,
                assignment_id,
            )["phase"]
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
            current_phase = "unknown"
        result = _work_start_receipt(
            {
                "schema": "kungfu.work-review.receipt/v1",
                "ok": False,
                "status": "settlement-interrupted",
                "planRoot": expected_plan_root,
                "message": str(error),
                "workPhase": current_phase,
                "nextActions": [
                    "resume-review-settlement",
                    "inspect-current-work-status",
                ],
                "writeOccurred": write_occurred,
            }
        )
    if events_json:
        click.echo(json.dumps(result, sort_keys=True))
    else:
        _emit(result)


@assignment.command(
    name="relation-event",
    help="append one retryable workspace-routed Assignment relation event",
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option(
    "--relation",
    "relation_file",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option(
    "--event",
    "event_type",
    required=True,
    type=click.Choice(
        [
            "delegation-offer",
            "destination-acceptance",
            "source-observation",
            "child-contribution",
            "parent-admission",
            "parent-assessment",
            "parent-decision",
        ]
    ),
)
@click.option("--actor", required=True)
@click.option("--predecessor-root", "predecessor_roots", multiple=True)
@click.option("--evidence-root", "evidence_roots", multiple=True)
@assignment_context
def relation_event(
    ctx,
    workspace_root,
    relation_file,
    event_type,
    actor,
    predecessor_roots,
    evidence_roots,
):
    def operation():
        identity, runtime_dir = _runtime(workspace_root)
        _ensure_profile(runtime_dir, actor)
        relation = json.loads(relation_file.read_text(encoding="utf-8"))
        if isinstance(relation, dict) and isinstance(relation.get("relation"), dict):
            relation = relation["relation"]
        if not isinstance(relation, dict):
            raise ValueError("relation file must contain one relation object")
        receipt = _profile_action(
            runtime_dir,
            "append-assignment-relation-event",
            {
                "workspaceIdentityRoot": identity.identity_root,
                "relation": relation,
                "eventType": event_type,
                "actor": actor,
                "actorType": "agent",
                "predecessorEventRoots": list(predecessor_roots),
                "evidenceRoots": list(evidence_roots),
                "knownRelations": [],
            },
            actor,
        )
        return {
            **receipt,
            "workspace": identity.as_dict(),
        }

    result = _run(operation)
    if result is not None:
        _emit(result)


def _identity_options(function):
    for decorator in reversed(
        [
            click.option(
                "--workspace", "workspace_root", type=click.Path(file_okay=False)
            ),
            click.option("--home", is_flag=True),
            click.option("--initiative-id", required=True),
            click.option("--assignment-id", required=True),
        ]
    ):
        function = decorator(function)
    return function


def _exact_pending_fit_review(
    current,
    *,
    missing_message,
    conflicting_message,
):
    reviews = list(current.get("independent_reviews") or [])
    decisions = list(current.get("continuation_decisions") or [])
    decided_review_ids = {str(row.get("review_id") or "") for row in decisions}
    pending = [
        row
        for row in reviews
        if str(row.get("review_id") or "") not in decided_review_ids
        and row.get("verdict") == "fit"
    ]
    if not pending:
        raise ValueError(missing_message)
    exact_fit_roots = {
        (
            str(row.get("claim_id") or ""),
            str(row.get("claim_payload_hash") or ""),
            str(row.get("continuation_plan_root") or ""),
        )
        for row in pending
    }
    if len(exact_fit_roots) != 1:
        raise ValueError(conflicting_message)
    # Repeated product requests can retain more than one independent review
    # event for the same exact completion claim and continuation plan. They
    # are equivalent evidence, not an ambiguous human decision.
    return pending[-1]


def _work_close_plan(
    *,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
):
    identity, runtime_dir, _ = _runtime(workspace_root, home, "read-only")
    current = _status(runtime_dir, initiative_id, assignment_id)
    reviews = list(current.get("independent_reviews") or [])
    decisions = list(current.get("continuation_decisions") or [])
    decision_mode = "required"
    decision = None
    if current["phase"] == "independently-reviewed":
        review = _exact_pending_fit_review(
            current,
            missing_message=(
                "Work close requires one exact undecided fit independent review"
            ),
            conflicting_message="Work close found conflicting fit reviews",
        )
    elif current["phase"] == "continuation-decided":
        close_decisions = [row for row in decisions if row.get("action") == "close"]
        if not close_decisions:
            raise ValueError("Work has a continuation decision, but it is not close")
        decision = close_decisions[-1]
        review = next(
            (
                row
                for row in reviews
                if row.get("review_id") == decision.get("review_id")
            ),
            None,
        )
        if review is None:
            raise ValueError("Retained close decision has no exact independent review")
        decision_mode = "retained"
    else:
        raise ValueError(
            "Work close requires independently-reviewed or continuation-decided Work"
        )
    allowed_actions = list(
        (review.get("continuation_plan") or {}).get("allowed_actions") or []
    )
    review_root = orchestration.semantic_root(review)
    executable = bool(
        review.get("verdict") == "fit"
        and "close" in allowed_actions
        and (
            decision is None
            or (
                decision.get("review_root") == review_root
                and decision.get("continuation_plan_root")
                == review.get("continuation_plan_root")
            )
        )
    )
    effects = []
    if decision_mode == "required":
        effects.append(
            {
                "stage": "decide",
                "label": (
                    "Record your explicit close decision against the exact "
                    "independent review"
                ),
            }
        )
    effects.append(
        {
            "stage": "seal",
            "label": (
                "Create a portable, content-addressed Work state snapshot "
                "inside this project"
            ),
        }
    )
    body = {
        "schema": "kungfu.work-close.plan/v1",
        "workspace": {
            "id": identity.workspace_id,
            "root": identity.workspace_root or identity.data_home,
            "identityRoot": identity.identity_root,
        },
        "work": {
            "initiativeId": initiative_id,
            "assignmentId": assignment_id,
            "phase": current["phase"],
            "queryProofRoot": current["query_proof_root"],
            "assignmentRoot": orchestration.semantic_root(current["assignment"]),
        },
        "review": {
            "id": review["review_id"],
            "root": review_root,
            "verdict": review.get("verdict"),
            "continuationPlanRoot": review.get("continuation_plan_root"),
            "allowedActions": allowed_actions,
        },
        "decision": {
            "mode": decision_mode,
            "action": "close",
            "root": (
                orchestration.semantic_root(decision) if decision is not None else None
            ),
        },
        "effects": effects,
        "skippedEffects": ["git-init", "git-commit", "git-push", "publish"],
        "confirmationRequired": True,
        "executable": executable,
        "writeOccurred": False,
    }
    return {**body, "planRoot": orchestration.semantic_root(body)}


def _resume_starter_close(
    *,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
):
    identity, runtime_dir, _ = _runtime(workspace_root, home, "read-only")
    current = _status(runtime_dir, initiative_id, assignment_id)
    review_receipt = None
    close_receipt = None
    if current["phase"] == "independently-reviewed":
        review = _exact_pending_fit_review(
            current,
            missing_message="retained review state is missing one exact fit review",
            conflicting_message="retained review state has conflicting fit reviews",
        )
        review_receipt = _work_start_receipt(
            {
                "schema": "kungfu.work-review.receipt/v1",
                "ok": True,
                "status": "review-passed",
                "planRoot": review["continuation_plan_root"],
                "message": (
                    "The retained independent review passed every acceptance criterion."
                ),
                "workPhase": current["phase"],
                "nativeVerdict": "fit",
                "nextActions": ["decide-close-or-continue"],
                "writeOccurred": True,
            }
        )
    elif current["phase"] == "continuation-decided":
        plan = _work_close_plan(
            workspace_root=workspace_root,
            home=home,
            initiative_id=initiative_id,
            assignment_id=assignment_id,
        )
        seal_plan = orchestration.sealed_state_plan(
            identity.workspace_root or identity.data_home,
            current,
            workspace_identity=identity.as_dict(),
        )
        state_path = Path(seal_plan["storage_root"]) / seal_plan["state_path"]
        verification = (
            orchestration.verify_sealed_state(state_path)
            if state_path.is_file()
            else {"ok": False}
        )
        if verification.get("ok"):
            sealed_state = json.loads(
                state_path.with_name("receipt.json").read_text(encoding="utf-8")
            )
            close_receipt = _work_start_receipt(
                {
                    "schema": "kungfu.work-close.receipt/v1",
                    "ok": True,
                    "status": "completed",
                    "planRoot": plan["planRoot"],
                    "message": (
                        "Work is complete. The decision and portable evidence "
                        "are retained."
                    ),
                    "workPhase": current["phase"],
                    "decisionAction": "close",
                    "reviewRoot": plan["review"]["root"],
                    "sealedState": sealed_state,
                    "nextActions": ["start-your-next-work"],
                    "writeOccurred": True,
                }
            )
        else:
            close_receipt = _work_start_receipt(
                {
                    "schema": "kungfu.work-close.receipt/v1",
                    "ok": False,
                    "status": "settlement-interrupted",
                    "planRoot": plan["planRoot"],
                    "message": (
                        "The close decision is retained; the portable evidence "
                        "seal remains."
                    ),
                    "workPhase": current["phase"],
                    "reviewRoot": plan["review"]["root"],
                    "nextActions": ["resume-work-close"],
                    "writeOccurred": True,
                }
            )
    return {
        "schema": "kungfu.work-close.resume/v1",
        "status": (
            "completed"
            if close_receipt and close_receipt["status"] == "completed"
            else "close-pending"
            if close_receipt
            else "review-passed"
            if review_receipt
            else "not-ready"
        ),
        "reviewReceipt": review_receipt,
        "closeReceipt": close_receipt,
        "writeOccurred": False,
    }


@assignment.command(
    name="close-resume",
    help="restore reviewed or closed Starter Work without writing",
)
@_identity_options
@assignment_context
def close_resume(
    ctx,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
):
    del ctx
    _emit(
        _run(
            lambda: _resume_starter_close(
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
            )
        )
    )


@assignment.command(
    name="close-plan",
    help="preview the explicit reviewed-Work close decision and portable seal",
)
@_identity_options
@assignment_context
def close_plan(
    ctx,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
):
    del ctx
    _emit(
        _run(
            lambda: _work_close_plan(
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
            )
        )
    )


@assignment.command(
    name="close",
    help="confirm reviewed Work as closed and write its portable sealed state",
)
@_identity_options
@click.option("--actor", default="local-user")
@click.option("--expected-plan-root", required=True)
@click.option("--execute", is_flag=True)
@assignment_context
def close_work(
    ctx,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    actor,
    expected_plan_root,
    execute,
):
    del ctx

    def operation():
        plan = _work_close_plan(
            workspace_root=workspace_root,
            home=home,
            initiative_id=initiative_id,
            assignment_id=assignment_id,
        )
        if plan["planRoot"] != expected_plan_root:
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-close.receipt/v1",
                    "ok": False,
                    "status": "plan-drift",
                    "planRoot": plan["planRoot"],
                    "message": "Work close plan changed; preview it again.",
                    "workPhase": plan["work"]["phase"],
                    "nextActions": ["preview-work-close-again"],
                    "writeOccurred": False,
                }
            )
        if not execute:
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-close.receipt/v1",
                    "ok": False,
                    "status": "confirmation-required",
                    "planRoot": plan["planRoot"],
                    "message": "Explicit --execute confirmation is required.",
                    "workPhase": plan["work"]["phase"],
                    "nextActions": ["confirm-work-close"],
                    "writeOccurred": False,
                }
            )
        if not plan["executable"]:
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-close.receipt/v1",
                    "ok": False,
                    "status": "not-executable",
                    "planRoot": plan["planRoot"],
                    "message": (
                        "The retained independent review does not admit close."
                    ),
                    "workPhase": plan["work"]["phase"],
                    "nextActions": ["inspect-independent-review"],
                    "writeOccurred": False,
                }
            )
        identity, runtime_dir, _ = _runtime(workspace_root, home, "read-only")
        authority_receipts = {}
        write_occurred = False
        try:
            if plan["decision"]["mode"] == "required":
                _ensure_profile(runtime_dir, actor)
                authority_receipts["decision"] = _profile_action(
                    runtime_dir,
                    "decide-continuation",
                    {
                        "initiativeId": initiative_id,
                        "assignmentId": assignment_id,
                        "reviewId": plan["review"]["id"],
                        "expectedReviewRoot": plan["review"]["root"],
                        "expectedPlanRoot": plan["review"]["continuationPlanRoot"],
                        "action": "close",
                        "actor": actor,
                        "actorType": "user",
                        "changeClass": "mechanical",
                        "source": "kungfu",
                        "reason": (
                            "User confirmed the independently reviewed "
                            "Starter Work is complete"
                        ),
                    },
                    actor,
                )
                write_occurred = True
            current = _status(runtime_dir, initiative_id, assignment_id)
            if current["phase"] != "continuation-decided":
                raise RuntimeError(
                    "Work close decision did not reach continuation-decided"
                )
            seal_plan = orchestration.sealed_state_plan(
                identity.workspace_root or identity.data_home,
                current,
                workspace_identity=identity.as_dict(),
            )
            seal_receipt = orchestration.apply_sealed_state(
                seal_plan, seal_plan["state_root"]
            )
            write_occurred = True
            authority_receipts["seal"] = seal_receipt
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-close.receipt/v1",
                    "ok": True,
                    "status": "completed",
                    "planRoot": plan["planRoot"],
                    "message": (
                        "Work is complete. The decision and portable evidence "
                        "are retained."
                    ),
                    "workPhase": current["phase"],
                    "decisionAction": "close",
                    "reviewRoot": plan["review"]["root"],
                    "sealedState": seal_receipt,
                    "authorityReceipts": authority_receipts,
                    "nextActions": ["start-your-next-work"],
                    "writeOccurred": True,
                }
            )
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            try:
                current_phase = _status(runtime_dir, initiative_id, assignment_id)[
                    "phase"
                ]
            except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
                current_phase = "unknown"
            return _work_start_receipt(
                {
                    "schema": "kungfu.work-close.receipt/v1",
                    "ok": False,
                    "status": "settlement-interrupted",
                    "planRoot": plan["planRoot"],
                    "message": str(error),
                    "workPhase": current_phase,
                    "authorityReceipts": authority_receipts,
                    "nextActions": [
                        "resume-work-close",
                        "inspect-current-work-status",
                    ],
                    "writeOccurred": write_occurred,
                }
            )

    _emit(_run(operation))


@assignment.command(
    name="claim", help="claim execution with a bounded owner/agent lease"
)
@_identity_options
@click.option("--owner", required=True)
@click.option("--agent", required=True)
@click.option("--slot", required=True)
@click.option("--lease-id", required=True)
@click.option("--lease-expires-at", required=True)
@click.option("--authorized-by", required=True)
@click.option("--grant-scope", default="assignment-execution")
@click.option("--actor-type", type=click.Choice(["user", "agent"]), default="agent")
@assignment_context
def claim(
    ctx,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    owner,
    agent,
    slot,
    lease_id,
    lease_expires_at,
    authorized_by,
    grant_scope,
    actor_type,
):
    def operation():
        _, runtime_dir, _ = _runtime(workspace_root, home)
        _ensure_profile(runtime_dir, authorized_by)
        run_agent.bind_current_native_work(runtime_dir, initiative_id, assignment_id)
        receipt = _profile_action(
            runtime_dir,
            "claim-assignment",
            {
                "initiativeId": initiative_id,
                "assignmentId": assignment_id,
                "owner": owner,
                "agent": agent,
                "slot": slot,
                "leaseId": lease_id,
                "leaseExpiresAt": lease_expires_at,
                "authorizedBy": authorized_by,
                "grantScope": grant_scope,
                "actorType": actor_type,
                "source": "atlas",
            },
            authorized_by,
        )
        return {**receipt, "status": _status(runtime_dir, initiative_id, assignment_id)}

    _emit(_run(operation))


def _advance(
    workspace_root, home, initiative_id, assignment_id, to_phase, actor, reason
):
    identity, runtime_dir, _ = _runtime(workspace_root, home)
    _ensure_profile(runtime_dir, actor)
    if to_phase == "executing":
        run_agent.bind_current_native_work(runtime_dir, initiative_id, assignment_id)
    current = _status(runtime_dir, initiative_id, assignment_id)
    dogfood_receipt = None
    if to_phase == "executing":
        dogfood_receipt = dogfood_api.consider_assignment(
            runtime_dir,
            workspace_root=identity.workspace_root or "",
            home=home,
            assignment=current["assignment"],
            stage="kickoff",
            actor=actor,
        )
    receipt = _profile_action(
        runtime_dir,
        "advance-assignment",
        {
            "initiativeId": initiative_id,
            "assignmentId": assignment_id,
            "toPhase": to_phase,
            "expectedPhase": current["phase"],
            "actor": actor,
            "actorType": "agent",
            "reason": reason,
            "source": "atlas",
        },
        actor,
    )
    return {
        **receipt,
        "dogfood_consideration_root": (
            dogfood_receipt["consideration"]["receipt_root"]
            if dogfood_receipt is not None
            else None
        ),
        "status": _status(runtime_dir, initiative_id, assignment_id),
    }


@assignment.command(help="enter executing phase under the active lease")
@_identity_options
@click.option("--actor", required=True)
@click.option("--reason", required=True)
@assignment_context
def kickoff(ctx, workspace_root, home, initiative_id, assignment_id, actor, reason):
    _emit(
        _run(
            lambda: _advance(
                workspace_root,
                home,
                initiative_id,
                assignment_id,
                "executing",
                actor,
                reason,
            )
        )
    )


@assignment.command(help="record the stage-ready boundary")
@_identity_options
@click.option("--actor", required=True)
@click.option("--reason", required=True)
@assignment_context
def stage(ctx, workspace_root, home, initiative_id, assignment_id, actor, reason):
    _emit(
        _run(
            lambda: _advance(
                workspace_root,
                home,
                initiative_id,
                assignment_id,
                "stage-ready",
                actor,
                reason,
            )
        )
    )


@assignment.command(help="show the proof-bound orchestration state")
@_identity_options
@click.option("--now", default="", help="ISO-8601 cut used to test lease expiry")
@assignment_context
def status(ctx, workspace_root, home, initiative_id, assignment_id, now):
    def operation():
        _, runtime_dir, _ = _runtime(workspace_root, home, "read-only")
        return _status(runtime_dir, initiative_id, assignment_id, now)

    _emit(_run(operation))


@assignment.command(
    name="family-contract",
    help="show the versioned native Initiative-family protocol",
)
@assignment_context
def family_contract_command(ctx):
    _emit(orchestration.family_contract())


@assignment.command(
    name="family-create",
    help="create one rooted inert-parent and bounded-Wave family state",
)
@click.argument(
    "blueprint_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@assignment_context
def family_create(ctx, blueprint_file, out):
    def operation():
        blueprint = json.loads(blueprint_file.read_text(encoding="utf-8"))
        state = orchestration.create_family_state(blueprint)
        return {
            "schema": "kungfu.work-control.initiative-family-create/v1",
            "state": state,
            "stateRoot": state["stateRoot"],
            "outputPath": _write_immutable_json(out, state),
            "verification": orchestration.verify_family_state(state),
        }

    _emit(_run(operation))


@assignment.command(
    name="family-transition",
    help="append one expected-root terminal or acceptance transition",
)
@click.argument(
    "state_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.argument(
    "transition_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@assignment_context
def family_transition(ctx, state_file, transition_file, out):
    def operation():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        transition = json.loads(transition_file.read_text(encoding="utf-8"))
        successor = orchestration.transition_family_state(state, transition)
        return {
            "schema": "kungfu.work-control.initiative-family-transition-result/v1",
            "state": successor,
            "stateRoot": successor["stateRoot"],
            "previousStateRoot": successor["previousStateRoot"],
            "outputPath": _write_immutable_json(out, successor),
            "verification": orchestration.verify_family_state(successor),
        }

    _emit(_run(operation))


@assignment.command(
    name="family-verify",
    help="verify one native Initiative-family state without runtime mutation",
)
@click.argument(
    "state_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@assignment_context
def family_verify(ctx, state_file):
    def operation():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        return orchestration.verify_family_state(state)

    _emit(_run(operation))


@assignment.command(
    name="family-contract-v2",
    help="show the additive typed Initiative-family envelope protocol",
)
@assignment_context
def family_contract_v2_command(ctx):
    _emit(orchestration.family_contract_v2())


@assignment.command(
    name="family-upgrade-v2",
    help="explicitly bind one immutable v1 state into a typed v2 envelope",
)
@click.argument(
    "state_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.argument(
    "binding_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@assignment_context
def family_upgrade_v2(ctx, state_file, binding_file, out):
    def operation():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        bindings = json.loads(binding_file.read_text(encoding="utf-8"))
        upgrade = orchestration.upgrade_family_state_v2(state, bindings)
        successor = upgrade["successorState"]
        return {
            **upgrade,
            "outputPath": _write_immutable_json(out, successor),
            "verification": orchestration.verify_family_state_v2(successor),
        }

    _emit(_run(operation))


@assignment.command(
    name="family-transition-v2",
    help="advance a typed family state with an exact v1 transition and bindings",
)
@click.argument(
    "state_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.argument(
    "transition_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@assignment_context
def family_transition_v2(ctx, state_file, transition_file, out):
    def operation():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        transition = json.loads(transition_file.read_text(encoding="utf-8"))
        successor = orchestration.transition_family_state_v2(state, transition)
        return {
            "schema": "kungfu.work-control.initiative-family-transition-result/v2",
            "state": successor,
            "stateRoot": successor["stateRoot"],
            "previousStateRoot": successor["previousStateRoot"],
            "v1ProjectionRoot": successor["v1ProjectionRoot"],
            "typedBindingRoot": successor["typedBindingRoot"],
            "outputPath": _write_immutable_json(out, successor),
            "verification": orchestration.verify_family_state_v2(successor),
        }

    _emit(_run(operation))


@assignment.command(
    name="family-verify-v2",
    help="read v1 as under-typed or verify one complete typed v2 state",
)
@click.argument(
    "state_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@assignment_context
def family_verify_v2(ctx, state_file):
    def operation():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        return orchestration.verify_family_state_v2(state)

    _emit(_run(operation))


@assignment.command(help="evaluate the native run or closeout gate")
@_identity_options
@click.option("--target", type=click.Choice(["run", "closeout"]), required=True)
@assignment_context
def gate(ctx, workspace_root, home, initiative_id, assignment_id, target):
    def operation():
        _, runtime_dir, _ = _runtime(workspace_root, home, "read-only")
        status_value = _status(runtime_dir, initiative_id, assignment_id)
        orchestration_gate = orchestration.gate(status_value, target)
        required_stages = (
            ["design", "admission", "kickoff"]
            if target == "run"
            else ["design", "admission", "kickoff", "closeout"]
        )
        dogfood_gate = dogfood_api.consideration_gate(
            runtime_dir,
            assignment_definition_root=status_value["assignment"][
                "work_definition_root"
            ],
            target=target,
            required_stages=required_stages,
        )
        return {
            **orchestration_gate,
            "ok": bool(orchestration_gate["ok"] and dogfood_gate["ok"]),
            "dogfood": dogfood_gate,
            "next_actions": [
                *orchestration_gate.get("next_actions", []),
                *dogfood_gate.get("next_actions", []),
            ],
        }

    result = _run(operation)
    _emit(result)
    if not result["ok"]:
        raise click.exceptions.Exit(4)


def _json_action(name, intent_id):
    @assignment.command(
        name=name, help=f"run the native {name} intent from a JSON input"
    )
    @click.argument(
        "input_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
    )
    @click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
    @click.option("--home", is_flag=True)
    @click.option("--authorized-by", required=True)
    @assignment_context
    @surface(id=f"kungfu.work.{name.replace('-', '.')}")
    def command(ctx, input_file, workspace_root, home, authorized_by):
        def operation():
            values = json.loads(input_file.read_text(encoding="utf-8"))
            _, runtime_dir, _ = _runtime(workspace_root, home)
            _ensure_profile(runtime_dir, authorized_by)
            receipt = _profile_action(runtime_dir, intent_id, values, authorized_by)
            initiative = str(
                values.get("initiativeId") or values.get("missionId") or ""
            )
            assignment_id = str(
                values.get("assignmentId") or values.get("goalId") or ""
            )
            current = _status(runtime_dir, initiative, assignment_id)
            return {
                **receipt,
                "status": current,
                "next_actions": current["next_actions"],
            }

        _emit(_run(operation))

    return command


claim_completion = _json_action("claim-completion", "claim-completion")
review = _json_action("review", "review-completion")
decide = _json_action("decide", "decide-continuation")


@assignment.command(
    name="binding-create",
    help="build one path-free cross-workspace parent/child binding from receipts",
)
@click.option(
    "--parent-admission",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--parent-status",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--child-admission",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--child-status",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@assignment_context
def binding_create(
    ctx,
    parent_admission,
    parent_status,
    child_admission,
    child_status,
    out,
):
    def operation():
        binding = orchestration.cross_workspace_binding(
            json.loads(parent_admission.read_text(encoding="utf-8")),
            json.loads(parent_status.read_text(encoding="utf-8")),
            json.loads(child_admission.read_text(encoding="utf-8")),
            json.loads(child_status.read_text(encoding="utf-8")),
        )
        output_path = None
        if out is not None:
            output_path = out.expanduser().resolve()
            content = (orchestration.canonical_json(binding) + "\n").encode("utf-8")
            if output_path.exists() and output_path.read_bytes() != content:
                raise ValueError("binding output exists with different bytes")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            if not output_path.exists():
                output_path.write_bytes(content)
        return {
            "schema": "kungfu.assignment-orchestration.cross-workspace-binding-create/v1",
            "binding": binding,
            "bindingRoot": binding["bindingRoot"],
            "outputPath": str(output_path) if output_path else None,
            "next_actions": [
                {
                    "action": "bind",
                    "description": "admit the exact binding in both endpoint workspaces",
                }
            ],
        }

    _emit(_run(operation))


@assignment.command(
    name="bind",
    help="plan or admit one exact cross-workspace binding in this endpoint",
)
@click.argument(
    "binding_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@_identity_options
@click.option("--execute", is_flag=True)
@click.option("--expected-binding-root", default="")
@assignment_context
def bind(
    ctx,
    binding_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    execute,
    expected_binding_root,
):
    def operation():
        binding = json.loads(binding_file.read_text(encoding="utf-8"))
        identity, runtime_dir, _ = _runtime(workspace_root, home, "read-only")
        current = _status(runtime_dir, initiative_id, assignment_id)
        plan = orchestration.cross_workspace_binding_plan(
            identity.workspace_root or identity.data_home,
            identity.as_dict(),
            current,
            binding,
        )
        if not execute:
            return {
                **plan,
                "next_actions": [
                    {
                        "action": "bind",
                        "expected_binding_root": plan["bindingRoot"],
                    }
                ],
            }
        return orchestration.apply_cross_workspace_binding(
            plan, binding, expected_binding_root
        )

    _emit(_run(operation))


@assignment.command(
    name="verify-binding",
    help="verify a local cross-workspace binding receipt without a live runtime",
)
@click.option(
    "--binding",
    "binding_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--receipt",
    "receipt_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@assignment_context
def verify_binding(ctx, binding_file, receipt_file):
    result = _run(
        lambda: orchestration.verify_cross_workspace_binding_receipt(
            binding_file, receipt_file
        )
    )
    _emit(result)
    if not result["ok"]:
        raise click.exceptions.Exit(5)


@assignment.command(help="plan or write a portable content-addressed state snapshot")
@_identity_options
@click.option("--execute", is_flag=True)
@click.option("--expected-state-root", default="")
@assignment_context
def seal(
    ctx,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    execute,
    expected_state_root,
):
    def operation():
        identity, runtime_dir, _ = _runtime(workspace_root, home)
        _ensure_profile(runtime_dir, "assignment-seal")
        current = _status(runtime_dir, initiative_id, assignment_id)
        plan = orchestration.sealed_state_plan(
            identity.workspace_root or identity.data_home,
            current,
            workspace_identity=identity.as_dict(),
        )
        if not execute:
            return {
                **plan,
                "executed": False,
                "next_actions": [
                    {"action": "seal", "expected_state_root": plan["state_root"]}
                ],
            }
        return orchestration.apply_sealed_state(plan, expected_state_root)

    _emit(_run(operation))


@assignment.command(
    name="verify-seal", help="verify sealed state without a live runtime"
)
@click.argument(
    "state_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@assignment_context
def verify_seal(ctx, state_file):
    result = _run(lambda: orchestration.verify_sealed_state(state_file))
    _emit(result)
    if not result["ok"]:
        raise click.exceptions.Exit(5)
