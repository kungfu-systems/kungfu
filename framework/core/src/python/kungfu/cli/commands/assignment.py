# SPDX-License-Identifier: Apache-2.0

"""`kungfu work` — the native Work authority and orchestration surface."""

from __future__ import annotations

import json
import os
from pathlib import Path

import click

from kungfu import assignment_orchestration as orchestration
from kungfu import assignment_close
from kungfu import assignment_evidence
from kungfu import assignment_review_lifecycle  # noqa: F401 -- private owner seam
from kungfu import assignment_start
from kungfu import initiative_family
from kungfu.assignment_runtime import (
    LocalAssignmentRuntimeApplication,
    create_runtime_host_command,
    profile_source,
)
from kungfu.assignment_runtime import profile_lifecycle
from kungfu import dogfood as dogfood_api
from kungfu import profile_sdk
from kungfu.agent import run_agent  # noqa: F401 -- private owner seam
from kungfu.agent import resources as agent_resources
from kungfu.cli.commands import (
    PrioritizedCommandGroup,
    assignment_runtime_recovery,
    kfc,
)
from kungfu.cli.commands import assignment_review
from kungfu.cli.commands import assignment_session
from kungfu.cli.surface_contract import surface
from kungfu.initiative_family import (  # noqa: F401 -- private owner seam
    typed_v2 as initiative_family_v2,
)
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
    content = (initiative_family.canonical_json(value) + "\n").encode("utf-8")
    if output.exists() and output.read_bytes() != content:
        raise ValueError("immutable output exists with different bytes")
    output.parent.mkdir(parents=True, exist_ok=True)
    if not output.exists():
        output.write_bytes(content)
    return str(output)


def _run(operation):
    try:
        return operation()
    except click.exceptions.Exit:
        raise
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        _emit(
            {
                "schema": "kungfu.assignment-orchestration.diagnosis/v1",
                "ok": False,
                "code": "assignment-operation-failed",
                "message": str(error),
                "next_actions": list(getattr(error, "next_actions", [])),
            }
        )
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
for (
    runtime_recovery_command
) in assignment_runtime_recovery.create_runtime_recovery_commands(
    _runtime, _emit, _run, _write_immutable_json
):
    assignment.add_command(runtime_recovery_command)


def _reconcile_work_profile(runtime_dir, authorized_by):
    return profile_lifecycle.ensure_work_profile(
        profile_source(), runtime_dir, authorized_by
    )


_ensure_profile = _reconcile_work_profile


def _prepare_resume_profile(runtime_dir, actor, source=None):
    source = profile_lifecycle.resolve_profile_source(source, profile_source)
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
    receipts = profile_lifecycle.ensure_work_profile(source, runtime_dir, actor)
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


def _attach_recovery_continuation(result, runtime_dir, initiative_id, assignment_id):
    if result.get("phase") != "executing" or result.get("active_lease"):
        return
    from kungfu.assignment_runtime import recovery_continuation

    continuation = recovery_continuation.resolve(
        runtime_dir, initiative_id, assignment_id, result
    )
    if continuation is not None:
        result["recovery_continuation"] = {
            "continuationRoot": continuation["continuationRoot"],
            "newSessionAttemptId": continuation["attempt"]["newSessionAttemptId"],
            "writeAuthority": continuation["writeAuthority"],
            "allowedNextActions": list(continuation["allowedNextActions"]),
        }


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
    _attach_recovery_continuation(result, runtime_dir, initiative_id, assignment_id)
    result.update(initiative_id=initiative_id, assignment_id=assignment_id)
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
    projected = orchestration.assignment_projection(
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
    def capture_operation():
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
    _emit(_run(capture_operation))


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
    def admit_operation():
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

    result = _run(admit_operation)
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


_find_retained_reviewer_evidence = assignment_review.find_passing_evidence


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
    def relation_event_operation():
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

    result = _run(relation_event_operation)
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


@assignment.command(help="evaluate the native run or closeout gate")
@assignment_identity_options
@click.option("--target", type=click.Choice(["run", "closeout"]), required=True)
@assignment_context
def gate(ctx, workspace_root, home, initiative_id, assignment_id, target):
    def gate_operation():
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

    result = _run(gate_operation)
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
        def assignment_action_operation():
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

        _emit(_run(assignment_action_operation))

    return command


claim_completion = _json_action("claim-completion", "claim-completion")
review = _json_action("review", "review-completion")
decide = _json_action("decide", "decide-continuation")


from kungfu.cli.commands._assignment.start import (  # noqa: E402
    start_plan as start_plan,
    start_work as start_work,
    resume_prepare as resume_prepare,
    start_resume as start_resume,
)
from kungfu.cli.commands._assignment.review import (  # noqa: E402
    _reviewer_read_only_safe as _reviewer_read_only_safe,
    _work_review_plan as _work_review_plan,
    _mint_review_settlement_lease as _mint_review_settlement_lease,
    _native_completion_review_values as _native_completion_review_values,
    _native_completion_claim_values as _native_completion_claim_values,
    review_agent_plan as review_agent_plan,
    review_agent_run as review_agent_run,
)
from kungfu.cli.commands._assignment.family import (  # noqa: E402
    family_contract_command as family_contract_command,
    family_create as family_create,
    family_transition as family_transition,
    family_verify as family_verify,
    family_contract_v2_command as family_contract_v2_command,
    family_upgrade_v2 as family_upgrade_v2,
    family_transition_v2 as family_transition_v2,
    family_verify_v2 as family_verify_v2,
    binding_create as binding_create,
    bind as bind,
    verify_binding as verify_binding,
    seal as seal,
    verify_seal as verify_seal,
)
