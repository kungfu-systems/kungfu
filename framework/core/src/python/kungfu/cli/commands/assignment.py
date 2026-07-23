# SPDX-License-Identifier: Apache-2.0

"""`kungfu assignment` — native admission and go orchestration."""

from __future__ import annotations

import json
import os
from pathlib import Path

import click

from kungfu import assignment_orchestration as orchestration
from kungfu import profile_composition, profile_sdk
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.surface_contract import surface
from kungfu.storage import service as storage_service
from kungfu.workspace import ensure_workspace_data_home, inspect_workspace

assignment_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="admit captured work and operate the native Assignment state machine",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def assignment(ctx):
    pass


def _emit(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


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
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        _failure("assignment-operation-failed", error)
        raise click.exceptions.Exit(2) from error


def _runtime(workspace_root=""):
    identity = inspect_workspace(
        workspace_root or None,
        cwd=os.getcwd(),
    )
    if identity is None or identity.workspace_kind != "project":
        raise ValueError(
            "Assignment orchestration requires a project workspace; pass --workspace"
        )
    receipt = ensure_workspace_data_home(identity, "assignment-orchestration")
    qualified = inspect_workspace(identity.workspace_root)
    if qualified is None or qualified.identity_state != "qualified":
        raise ValueError("Assignment workspace identity did not qualify")
    return qualified, receipt["runtime_dir"]


def _profile_source():
    return orchestration.source_root() / "extensions" / "mission-control"


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


def _profile_read(runtime_dir, operation, values):
    return profile_sdk.invoke_member_adapter(
        str(_profile_source()),
        runtime_dir,
        "mission-control-actions",
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


@assignment.command(help="admit one verified captured request into this workspace")
@click.argument(
    "request_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--initiative-id", default="")
@click.option("--assignment-id", default="")
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
    initiative_id,
    assignment_id,
    actor,
    actor_type,
    allow_foreign_binding,
):
    def operation():
        binding = orchestration.binding_provenance(allow_foreign=allow_foreign_binding)
        if not binding["ok"]:
            _emit(
                {
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
            )
            raise click.exceptions.Exit(3)
        captured = orchestration.load_captured_request(request_file)
        projected = orchestration.atlas_assignment_projection(
            captured,
            initiative_id=initiative_id,
            assignment_id=assignment_id,
        )
        identity, runtime_dir = _runtime(workspace_root)
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
                "contextBinding": {},
                "projectCutRoot": "",
                "evidenceEpisodeRoots": [],
                "requestRoot": projected["request_root"],
                "captureReceiptRoots": projected["capture_receipt_roots"],
                "workDefinition": projected["work_definition"],
            },
            actor,
        )
        status = _status(
            runtime_dir, projected["initiative_id"], projected["assignment_id"]
        )
        return {
            "schema": "kungfu.assignment-orchestration.admission/v1",
            "ok": True,
            "status": "admitted",
            "admitted": True,
            "binding": binding,
            "workspace": identity.as_dict(),
            "request_root": projected["request_root"],
            "capture_receipt_roots": projected["capture_receipt_roots"],
            "initiative_receipt": initiative_receipt,
            "assignment_receipt": assignment_receipt,
            "profile_lifecycle_receipt_count": len(lifecycle),
            "phase": status["phase"],
            "next_actions": status["next_actions"],
        }

    result = _run(operation)
    if result is not None:
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
            click.option("--initiative-id", required=True),
            click.option("--assignment-id", required=True),
        ]
    ):
        function = decorator(function)
    return function


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
        _, runtime_dir = _runtime(workspace_root)
        _ensure_profile(runtime_dir, authorized_by)
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


def _advance(workspace_root, initiative_id, assignment_id, to_phase, actor, reason):
    _, runtime_dir = _runtime(workspace_root)
    _ensure_profile(runtime_dir, actor)
    current = _status(runtime_dir, initiative_id, assignment_id)
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
    return {**receipt, "status": _status(runtime_dir, initiative_id, assignment_id)}


@assignment.command(help="enter executing phase under the active lease")
@_identity_options
@click.option("--actor", required=True)
@click.option("--reason", required=True)
@assignment_context
def kickoff(ctx, workspace_root, initiative_id, assignment_id, actor, reason):
    _emit(
        _run(
            lambda: _advance(
                workspace_root, initiative_id, assignment_id, "executing", actor, reason
            )
        )
    )


@assignment.command(help="record the stage-ready boundary")
@_identity_options
@click.option("--actor", required=True)
@click.option("--reason", required=True)
@assignment_context
def stage(ctx, workspace_root, initiative_id, assignment_id, actor, reason):
    _emit(
        _run(
            lambda: _advance(
                workspace_root,
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
def status(ctx, workspace_root, initiative_id, assignment_id, now):
    def operation():
        _, runtime_dir = _runtime(workspace_root)
        _ensure_profile(runtime_dir, "assignment-status")
        return _status(runtime_dir, initiative_id, assignment_id, now)

    _emit(_run(operation))


@assignment.command(help="evaluate the native run or closeout gate")
@_identity_options
@click.option("--target", type=click.Choice(["run", "closeout"]), required=True)
@assignment_context
def gate(ctx, workspace_root, initiative_id, assignment_id, target):
    def operation():
        _, runtime_dir = _runtime(workspace_root)
        _ensure_profile(runtime_dir, "assignment-gate")
        return orchestration.gate(
            _status(runtime_dir, initiative_id, assignment_id), target
        )

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
    @click.option("--authorized-by", required=True)
    @assignment_context
    @surface(id=f"kungfu.assignment.{name.replace('-', '.')}")
    def command(ctx, input_file, workspace_root, authorized_by):
        def operation():
            values = json.loads(input_file.read_text(encoding="utf-8"))
            _, runtime_dir = _runtime(workspace_root)
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


@assignment.command(help="plan or write a portable content-addressed state snapshot")
@_identity_options
@click.option("--execute", is_flag=True)
@click.option("--expected-state-root", default="")
@assignment_context
def seal(
    ctx, workspace_root, initiative_id, assignment_id, execute, expected_state_root
):
    def operation():
        identity, runtime_dir = _runtime(workspace_root)
        _ensure_profile(runtime_dir, "assignment-seal")
        current = _status(runtime_dir, initiative_id, assignment_id)
        plan = orchestration.sealed_state_plan(identity.workspace_root, current)
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
