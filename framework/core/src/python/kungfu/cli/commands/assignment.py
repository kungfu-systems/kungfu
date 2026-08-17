# SPDX-License-Identifier: Apache-2.0

"""`kungfu work` — the native Work authority and orchestration surface."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
import uuid

import click

from kungfu import assignment_orchestration as orchestration
from kungfu import assignment_close
from kungfu import assignment_evidence
from kungfu import assignment_review_lifecycle
from kungfu import assignment_start
from kungfu.assignment_runtime import (
    LocalAssignmentRuntimeApplication,
    create_runtime_host_command,
    profile_source,
)
from kungfu import dogfood as dogfood_api
from kungfu import profile_composition, profile_sdk
from kungfu.agent import run_agent
from kungfu.agent import resources as agent_resources
from kungfu.cli.commands import (
    PrioritizedCommandGroup,
    kfc,
)
from kungfu.cli.commands import assignment_review
from kungfu.cli.commands import assignment_session
from kungfu.cli.surface_contract import surface
from kungfu.storage import service as storage_service
from kungfu.workspace import prepare_workspace_write, resolve_workspace_target
from kungfu.assignment_lifecycle.ports import AssignmentRuntime

assignment_context = kfc.pass_context()


def assignment_identity_options(command):
    """Decorate every Work command with a fresh identity option set."""

    decorators = (
        click.option("--workspace", "workspace_root", type=click.Path(file_okay=False)),
        click.option("--home", is_flag=True),
        click.option("--initiative-id", required=True),
        click.option("--assignment-id", required=True),
    )
    for decorator in reversed(decorators):
        command = decorator(command)
    return command


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
    if operation_class != "read-only":
        agent_resources.require_current_native_bootstrap_for_mutation()
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


def _assignment_runtime(workspace_root, home, operation_class):
    identity, runtime_dir, receipt = _runtime(workspace_root, home, operation_class)
    return AssignmentRuntime(identity, str(runtime_dir), receipt)


assignment.add_command(create_runtime_host_command(_runtime))


def _ensure_profile(runtime_dir, authorized_by):
    source = profile_source()
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
    source = profile_source()
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
    if operation != "assignment-status":
        raise ValueError(f"unsupported Assignment Runtime read: {operation}")
    return LocalAssignmentRuntimeApplication(
        runtime_dir,
        client_id="kungfu.work.cli",
        kind="cli",
    ).status(values.get("initiativeId"), values.get("assignmentId"))


def _profile_action(runtime_dir, intent_id, values, authorized_by):
    return LocalAssignmentRuntimeApplication(
        runtime_dir,
        client_id="kungfu.work.cli",
        kind="cli",
    ).authorize(intent_id, values, authorized_by)


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


@profile_sdk.validation_scope()
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
    # Dogfood is a separate Domain Profile. Its lifecycle reconciliation may
    # change which exact Profile root is active, so restore Work Control before
    # returning to the Assignment orchestration path.
    _ensure_profile(runtime_dir, actor)
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
    config_home,
    runtime_home,
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
        config_home=config_home,
        runtime_home=runtime_home,
        request_file=request_file,
        workspace_root=workspace_root,
        home=home,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        profile_id=profile_id,
        actor=actor,
        allow_foreign_binding=allow_foreign_binding,
        profile_source=profile_source,
        status_reader=_status,
    )


_work_start_phase_plan = assignment_review.phase_plan
_project_work_prompt = assignment_review.project_prompt
_work_start_receipt = assignment_review.receipt
_admission_summary = assignment_review.admission_summary
_claim_summary = assignment_review.claim_summary
_kickoff_summary = assignment_review.kickoff_summary
_agent_report_summary = assignment_review.agent_report_summary
_project_review_evidence = assignment_evidence.project_review_evidence


_EVIDENCE_SERVICES = assignment_evidence.EvidenceServices(
    runtime=_assignment_runtime,
    status=_status,
    receipt=_work_start_receipt,
    agent_report_summary=_agent_report_summary,
)


assignment_session.register_finalize_agent_session_command(
    assignment,
    assignment_context=assignment_context,
    runtime=_runtime,
    emit=_emit,
    run_operation=_run,
    agent_report_summary=_agent_report_summary,
)


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
                config_home=ctx.config_home,
                runtime_home=ctx.home,
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
    on_event=None,
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
        if on_event is not None:
            on_event(payload)
        if events_json:
            click.echo(json.dumps(payload, sort_keys=True))
            click.get_text_stream("stdout").flush()

    services = assignment_start.StartServices(
        plan=_work_start_plan,
        receipt=_work_start_receipt,
        status=_status,
        admit=_admit_captured_assignment,
        admission_summary=_admission_summary,
        profile_action=_profile_action,
        claim_summary=_claim_summary,
        advance_bound=_advance,
        kickoff_summary=_kickoff_summary,
        project_prompt=_project_work_prompt,
        agent_report_summary=_agent_report_summary,
    )
    request = assignment_start.StartRequest(
        config_home=ctx.config_home,
        runtime_home=ctx.home,
        request_file=request_file,
        workspace_root=workspace_root,
        home=home,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        profile_id=profile_id,
        actor=actor,
        expected_plan_root=expected_plan_root,
        execute=execute,
        allow_foreign_binding=allow_foreign_binding,
    )
    result = assignment_start.execute(request, services, event)
    if emit_result:
        if events_json:
            click.echo(json.dumps(result, sort_keys=True))
        else:
            _emit(result)
    return result


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
            lambda: assignment_evidence.resume_starter_work(
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
                services=_EVIDENCE_SERVICES,
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
            _, report = assignment_evidence.load_execution_agent_report(
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
        profile_action=_profile_action,
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


_close_services = lambda: assignment_close.CloseServices(  # noqa: E731
    # Resolve the composition-root ports at invocation time. Tests and native
    # embeddings may replace these ports after importing the CLI module.
    runtime=_assignment_runtime,
    status=_status,
    receipt=_work_start_receipt,
    ensure_profile=_ensure_profile,
    profile_action=_profile_action,
)


@assignment.command(
    name="close-resume",
    help="restore reviewed or closed Starter Work without writing",
)
@assignment_identity_options
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
            lambda: assignment_close.resume(
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
                services=_close_services(),
            )
        )
    )


@assignment.command(
    name="close-plan",
    help="preview the explicit reviewed-Work close decision and portable seal",
)
@assignment_identity_options
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
            lambda: assignment_close.build_plan(
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
                services=_close_services(),
            )
        )
    )


@assignment.command(
    name="close",
    help="confirm reviewed Work as closed and write its portable sealed state",
)
@assignment_identity_options
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
    services = _close_services()
    request = assignment_close.CloseRequest(
        workspace_root=workspace_root,
        home=home,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        actor=actor,
        expected_plan_root=expected_plan_root,
        execute=execute,
    )
    _emit(_run(lambda: assignment_close.execute(request, services)))


@assignment.command(
    name="claim", help="claim execution with a bounded owner/agent lease"
)
@assignment_identity_options
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
    _emit(
        _run(
            lambda: assignment_start.claim(
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
                owner=owner,
                agent=agent,
                slot=slot,
                lease_id=lease_id,
                lease_expires_at=lease_expires_at,
                authorized_by=authorized_by,
                grant_scope=grant_scope,
                actor_type=actor_type,
                runtime=_runtime,
                ensure_profile=_ensure_profile,
                profile_action=_profile_action,
                status=_status,
            )
        )
    )


def _advance(
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    to_phase,
    actor,
    reason,
):
    identity, runtime_dir, _ = _runtime(workspace_root, home)
    _ensure_profile(runtime_dir, actor)
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
        # The Dogfood Profile is independent of Work Control. Re-establish the
        # exact Work Control root before invoking its member adapter.
        _ensure_profile(runtime_dir, actor)
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
@assignment_identity_options
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
@assignment_identity_options
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
@assignment_identity_options
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
@assignment_identity_options
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
@assignment_identity_options
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
@assignment_identity_options
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
