# SPDX-License-Identifier: Apache-2.0

"""Work Control Profile member adapter.

The generic Profile runtime binds this module to the exact Suite/member roots.
Only native Initiative/Assignment operations are exposed here.
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any

from kungfu import profile_sdk


def _object(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise TypeError("Work Control adapter input must be an object")
    return value


def _only(values: Mapping[str, Any], allowed: set[str], operation: str) -> None:
    unknown = set(values) - allowed
    if unknown:
        raise ValueError(f"unknown {operation} input: {sorted(unknown)}")


def _domain(context: Mapping[str, Any]):
    return profile_sdk.load_member_python_package(
        str(context["source"]), "work-control-actions", "domain"
    )


def _initiative_cards(domain, runtime_dir: str, cut_system_time: int = 0):
    return domain.work_control.list_initiatives(
        runtime_dir, cut_system_time=cut_system_time
    )


def _assignment_cards(
    domain,
    runtime_dir: str,
    *,
    status: str | None = None,
    initiative_id: str | None = None,
    cut_system_time: int = 0,
):
    rows = domain.work_control.list_assignments(
        runtime_dir, cut_system_time=cut_system_time
    )
    return [
        row
        for row in rows
        if (status is None or row.get("status") == status)
        and (
            initiative_id is None
            or row.get("initiative_id") == initiative_id
            or row.get("initiative_subject") == initiative_id
        )
    ]


def _work_semantics_action(
    domain, operation: str, runtime_dir: str, values: Mapping[str, Any]
):
    common_allowed = {
        "initiativeId",
        "assignmentId",
        "attemptId",
        "leaseId",
        "actor",
        "actorType",
        "source",
    }
    common = {
        "initiative_id": str(values.get("initiativeId") or ""),
        "assignment_id": str(values.get("assignmentId") or ""),
        "attempt_id": str(values.get("attemptId") or ""),
        "lease_id": str(values.get("leaseId") or ""),
        "actor": str(values.get("actor") or ""),
        "actor_type": str(values.get("actorType") or "agent"),
        "storage_source_id": str(values.get("source") or "kungfu"),
    }
    semantics = domain.work_semantics
    if operation == "work-input-snapshot":
        _only(
            values,
            common_allowed | {"snapshotId", "inputRoot", "evidenceRoots"},
            operation,
        )
        receipt = semantics.record_input_snapshot(
            runtime_dir,
            snapshot_id=str(values.get("snapshotId") or ""),
            input_root=str(values.get("inputRoot") or ""),
            evidence_roots=[str(row) for row in values.get("evidenceRoots", [])],
            **common,
        )
    elif operation == "work-managed-run":
        _only(
            values,
            common_allowed
            | {
                "runId",
                "inputSnapshotRoot",
                "role",
                "resultState",
                "resultRoot",
                "evidenceRoots",
            },
            operation,
        )
        receipt = semantics.record_managed_run(
            runtime_dir,
            run_id=str(values.get("runId") or ""),
            input_snapshot_root=str(values.get("inputSnapshotRoot") or ""),
            role=str(values.get("role") or ""),
            result_state=str(values.get("resultState") or ""),
            result_root=str(values.get("resultRoot") or ""),
            evidence_roots=[str(row) for row in values.get("evidenceRoots", [])],
            **common,
        )
    elif operation == "work-effect-authorize":
        _only(
            values,
            common_allowed
            | {
                "authorizationId",
                "effectId",
                "effectKind",
                "inputSnapshotRoot",
                "scopeRoot",
                "evidenceRoots",
            },
            operation,
        )
        receipt = semantics.authorize_effect(
            runtime_dir,
            authorization_id=str(values.get("authorizationId") or ""),
            effect_id=str(values.get("effectId") or ""),
            effect_kind=str(values.get("effectKind") or ""),
            input_snapshot_root=str(values.get("inputSnapshotRoot") or ""),
            scope_root=str(values.get("scopeRoot") or ""),
            evidence_roots=[str(row) for row in values.get("evidenceRoots", [])],
            **common,
        )
    elif operation == "work-effect-attempt":
        _only(
            values,
            common_allowed
            | {"effectAttemptId", "authorizationRoot", "transportRequestRoot"},
            operation,
        )
        receipt = semantics.record_effect_attempt(
            runtime_dir,
            effect_attempt_id=str(values.get("effectAttemptId") or ""),
            authorization_root=str(values.get("authorizationRoot") or ""),
            transport_request_root=str(values.get("transportRequestRoot") or ""),
            **common,
        )
    elif operation == "work-effect-outcome":
        _only(
            values,
            common_allowed
            | {
                "effectAttemptRoot",
                "transportState",
                "businessState",
                "outcomeRoot",
                "evidenceRoots",
            },
            operation,
        )
        receipt = semantics.record_effect_outcome(
            runtime_dir,
            effect_attempt_root=str(values.get("effectAttemptRoot") or ""),
            transport_state=str(values.get("transportState") or ""),
            business_state=str(values.get("businessState") or ""),
            outcome_root=str(values.get("outcomeRoot") or ""),
            evidence_roots=[str(row) for row in values.get("evidenceRoots", [])],
            **common,
        )
    else:
        raise ValueError(f"unsupported Work semantics action: {operation}")
    return {
        "coreReceipt": receipt,
        "affected": {
            "profileId": "kungfu.work-control",
            "entityKeys": [receipt["receipt"]["subject_key"]],
            "queryKeys": ["assignment-status", "work-semantics-status"],
        },
    }


def _action(domain, operation: str, runtime_dir: str, values: Mapping[str, Any]):
    work_control = domain.work_control

    if operation.startswith("work-"):
        return _work_semantics_action(domain, operation, runtime_dir, values)

    if operation == "create-initiative":
        _only(
            values,
            {
                "initiativeId",
                "title",
                "intent",
                "actor",
                "actorType",
                "status",
                "horizon",
                "sourceIdentity",
            },
            operation,
        )
        receipt = work_control.create_initiative(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            title=str(values.get("title") or ""),
            intent=str(values.get("intent") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            status=str(values.get("status") or "active"),
            horizon=str(values.get("horizon") or "long-term"),
            source_identity=dict(values.get("sourceIdentity") or {}),
        )
        affected = [receipt["initiative_subject"]]
    elif operation == "create-assignment":
        _only(
            values,
            {
                "initiativeId",
                "assignmentId",
                "title",
                "objective",
                "actor",
                "actorType",
                "source",
                "status",
                "parentAssignmentId",
                "dependsOn",
                "owningWorkspaceIdentityRoot",
                "initiativeRef",
                "parentAssignmentRef",
                "dependencyRefs",
                "responsibility",
                "acceptanceRoot",
                "contextRoot",
                "contextBinding",
                "projectCutRoot",
                "evidenceEpisodeRoots",
                "requestRoot",
                "captureReceiptRoots",
                "workDefinition",
            },
            operation,
        )
        receipt = work_control.create_assignment(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            title=str(values.get("title") or ""),
            objective=str(values.get("objective") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            storage_source_id=str(values.get("source") or "kungfu"),
            status=str(values.get("status") or "active"),
            parent_assignment_id=str(values.get("parentAssignmentId") or ""),
            depends_on=[str(row) for row in (values.get("dependsOn") or [])],
            owning_workspace_identity_root=str(
                values.get("owningWorkspaceIdentityRoot") or ""
            ),
            initiative_ref=dict(values.get("initiativeRef") or {}),
            parent_assignment_ref=dict(values.get("parentAssignmentRef") or {}),
            dependency_refs=[dict(row) for row in (values.get("dependencyRefs") or [])],
            responsibility=str(values.get("responsibility") or ""),
            acceptance_root=str(values.get("acceptanceRoot") or ""),
            context_root=str(values.get("contextRoot") or ""),
            context_binding=dict(values.get("contextBinding") or {}),
            project_cut_root=str(values.get("projectCutRoot") or ""),
            evidence_episode_roots=[
                str(row) for row in (values.get("evidenceEpisodeRoots") or [])
            ],
            request_root=str(values.get("requestRoot") or ""),
            capture_receipt_roots=[
                str(row) for row in (values.get("captureReceiptRoots") or [])
            ],
            work_definition=dict(values.get("workDefinition") or {}),
        )
        affected = [
            receipt["initiative_subject"],
            receipt["assignment_subject"],
        ]
    elif operation == "append-assignment-relation-event":
        _only(
            values,
            {
                "workspaceIdentityRoot",
                "relation",
                "eventType",
                "actor",
                "predecessorEventRoots",
                "evidenceRoots",
                "knownRelations",
                "actorType",
            },
            operation,
        )
        receipt = work_control.append_assignment_relation_event(
            runtime_dir,
            workspace_identity_root=str(values.get("workspaceIdentityRoot") or ""),
            relation=dict(values.get("relation") or {}),
            event_type=str(values.get("eventType") or ""),
            actor=str(values.get("actor") or ""),
            predecessor_event_roots=[
                str(row) for row in (values.get("predecessorEventRoots") or [])
            ],
            evidence_roots=[str(row) for row in (values.get("evidenceRoots") or [])],
            known_relations=[dict(row) for row in (values.get("knownRelations") or [])],
            actor_type=str(values.get("actorType") or "agent"),
        )
        affected = [
            receipt["event"]["relation"]["source"]["subject"],
            receipt["event"]["relation"]["target"]["subject"],
        ]
    elif operation == "claim-assignment":
        _only(
            values,
            {
                "initiativeId",
                "assignmentId",
                "owner",
                "agent",
                "slot",
                "leaseId",
                "leaseExpiresAt",
                "attemptId",
                "authorizedBy",
                "grantScope",
                "actorType",
                "source",
            },
            operation,
        )
        receipt = work_control.claim_assignment_execution(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            owner=str(values.get("owner") or ""),
            agent=str(values.get("agent") or ""),
            slot=str(values.get("slot") or ""),
            lease_id=str(values.get("leaseId") or ""),
            lease_expires_at=str(values.get("leaseExpiresAt") or ""),
            attempt_id=str(values.get("attemptId") or ""),
            authorized_by=str(values.get("authorizedBy") or ""),
            grant_scope=str(values.get("grantScope") or "assignment-execution"),
            actor_type=str(values.get("actorType") or "agent"),
            storage_source_id=str(values.get("source") or "kungfu"),
        )
        affected = [receipt["receipt"]["subject_key"]]
    elif operation == "advance-assignment":
        _only(
            values,
            {
                "initiativeId",
                "assignmentId",
                "toPhase",
                "expectedPhase",
                "actor",
                "actorType",
                "reason",
                "source",
            },
            operation,
        )
        receipt = work_control.advance_assignment_phase(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            to_phase=str(values.get("toPhase") or ""),
            expected_phase=str(values.get("expectedPhase") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            reason=str(values.get("reason") or ""),
            storage_source_id=str(values.get("source") or "kungfu"),
        )
        affected = [receipt["receipt"]["subject_key"]]
    elif operation == "claim-completion":
        _only(
            values,
            {
                "initiativeId",
                "assignmentId",
                "statement",
                "actor",
                "actorType",
                "source",
                "evidenceEpisodeIds",
                "assignmentSet",
                "acceptanceRoot",
                "inputContextRoot",
                "resultContextRoot",
                "projectCutRoot",
                "projectCutReceiptRoot",
                "gitCommit",
                "gitTreeRoot",
                "proofRoots",
                "knownGaps",
                "evidenceAvailability",
            },
            operation,
        )
        receipt = work_control.claim_completion(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            statement=str(values.get("statement") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            storage_source_id=str(values.get("source") or "kungfu"),
            evidence_episode_ids=[
                int(row) for row in values.get("evidenceEpisodeIds", [])
            ],
            assignment_set=[str(row) for row in values.get("assignmentSet", [])],
            acceptance_root=str(values.get("acceptanceRoot") or ""),
            input_context_root=str(values.get("inputContextRoot") or ""),
            result_context_root=str(values.get("resultContextRoot") or ""),
            project_cut_root=str(values.get("projectCutRoot") or ""),
            project_cut_receipt_root=str(values.get("projectCutReceiptRoot") or ""),
            git_commit=str(values.get("gitCommit") or ""),
            git_tree_root=str(values.get("gitTreeRoot") or ""),
            proof_roots=[str(row) for row in values.get("proofRoots", [])],
            known_gaps=[str(row) for row in values.get("knownGaps", [])],
            evidence_availability=list(values.get("evidenceAvailability", [])),
        )
        affected = [
            receipt["initiative_subject"],
            receipt["assignment_subject"],
            receipt["claim"]["claim_id"],
        ]
    elif operation == "assess-progress":
        _only(
            values,
            {
                "initiativeId",
                "assignmentId",
                "source",
                "purpose",
                "authorizedBy",
                "cutSystemTime",
                "executorProfile",
            },
            operation,
        )
        common = {
            "initiative_id": str(values.get("initiativeId") or ""),
            "storage_source_id": str(values.get("source") or "kungfu"),
            "purpose": str(values.get("purpose") or "operator-review"),
            "authorized_by": str(values.get("authorizedBy") or "kungfu-profile"),
            "cut_system_time": int(values.get("cutSystemTime") or 0),
            "executor_profile": str(values.get("executorProfile") or "thread"),
        }
        if values.get("assignmentId"):
            receipt = work_control.assess_completion(
                runtime_dir, assignment_id=str(values["assignmentId"]), **common
            )
        else:
            receipt = work_control.assess_progress(runtime_dir, **common)
        affected = [receipt["state"]["initiative_subject"]]
    elif operation == "review-completion":
        _only(
            values,
            {
                "initiativeId",
                "assignmentId",
                "reviewer",
                "reviewerSource",
                "source",
                "purpose",
                "cutSystemTime",
                "executorProfile",
                "proposedFollowups",
                "checkoutPath",
            },
            operation,
        )
        receipt = work_control.review_completion(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            reviewer=str(values.get("reviewer") or ""),
            reviewer_source=str(values.get("reviewerSource") or ""),
            storage_source_id=str(values.get("source") or "kungfu"),
            purpose=str(values.get("purpose") or "handoff"),
            cut_system_time=int(values.get("cutSystemTime") or 0),
            executor_profile=str(values.get("executorProfile") or "thread"),
            proposed_followups=list(values.get("proposedFollowups", [])),
            checkout_path=str(values.get("checkoutPath") or ""),
        )
        affected = [
            receipt["trust_report"]["state"]["initiative_subject"],
            receipt["review"]["review_id"],
        ]
    elif operation == "decide-continuation":
        _only(
            values,
            {
                "initiativeId",
                "assignmentId",
                "reviewId",
                "expectedReviewRoot",
                "expectedPlanRoot",
                "action",
                "actor",
                "actorType",
                "changeClass",
                "source",
                "reason",
            },
            operation,
        )
        receipt = work_control.decide_continuation(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            review_id=str(values.get("reviewId") or ""),
            expected_review_root=str(values.get("expectedReviewRoot") or ""),
            expected_plan_root=str(values.get("expectedPlanRoot") or ""),
            action=str(values.get("action") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            change_class=str(values.get("changeClass") or "mechanical"),
            storage_source_id=str(values.get("source") or "kungfu"),
            reason=str(values.get("reason") or ""),
        )
        affected = [receipt["decision"]["review_id"]]
    elif operation == "export-initiative":
        _only(
            values,
            {
                "initiativeId",
                "out",
                "mode",
                "source",
                "purpose",
            },
            operation,
        )
        options = {
            "mode": str(values.get("mode") or "full"),
            "storage_source_id": str(values.get("source") or "kungfu"),
            "purpose": str(values.get("purpose") or "operator-review"),
        }
        receipt = domain.initiative_bundle.write_initiative_bundle(
            runtime_dir,
            str(values.get("out") or ""),
            initiative_id=str(values.get("initiativeId") or ""),
            **options,
        )
        affected = [receipt["initiative_subject"]]
    elif operation == "import-initiative":
        _only(values, {"from", "execute"}, operation)
        work_control._ensure_native_write_allowed(runtime_dir)
        receipt = domain.initiative_bundle.import_initiative_bundle_file(
            runtime_dir,
            str(values.get("from") or ""),
            execute=bool(values.get("execute")),
        )
        affected = [receipt["initiative_subject"]]
    else:
        raise ValueError(f"unsupported Work Control action: {operation}")
    return {
        "coreReceipt": receipt,
        "affected": {
            "profileId": "kungfu.work-control",
            "entityKeys": affected,
            "queryKeys": [
                "initiative-state",
                "initiative-timeline",
                "initiative-attention",
            ],
        },
    }


def invoke(
    operation: str, *, runtime_dir: str, input_value: Any, context: Mapping[str, Any]
):
    domain = _domain(context)
    return domain.work_control._with_profile_source(
        str(context["source"]),
        lambda: _invoke(operation, runtime_dir, input_value, context, domain),
    )


def _invoke(
    operation: str,
    runtime_dir: str,
    input_value: Any,
    context: Mapping[str, Any],
    domain: Any,
):
    values = _object(input_value)
    if operation in {
        "create-initiative",
        "create-assignment",
        "append-assignment-relation-event",
        "claim-assignment",
        "advance-assignment",
        "claim-completion",
        "assess-progress",
        "review-completion",
        "decide-continuation",
        "export-initiative",
        "import-initiative",
        "work-input-snapshot",
        "work-managed-run",
        "work-effect-authorize",
        "work-effect-attempt",
        "work-effect-outcome",
    }:
        if context.get("invocationMode") != "authorized-action":
            raise ValueError(
                "Work Control writes require the Profile intent authorization path"
            )
        return _action(domain, operation, runtime_dir, values)
    if operation == "portfolio":
        _only(values, set(), operation)
        cut = time.time_ns()
        return {
            "schema": "kungfu.work-control.portfolio-snapshot/v1",
            "cut": {"kind": "system_time", "system_time": str(cut)},
            "projection_authority": {
                "mode": "read-only",
                "scope": "owning-workspace",
                "profileSuiteRoot": context["profileSuiteRoot"],
                "memberRoot": context["memberRoot"],
                "writableAuthority": False,
                "atomicGlobalCut": False,
                "completionAuthority": False,
            },
            "initiatives": _initiative_cards(domain, runtime_dir, cut),
            "assignments": _assignment_cards(domain, runtime_dir, cut_system_time=cut),
        }
    if operation == "initiatives":
        _only(values, set(), operation)
        return _initiative_cards(domain, runtime_dir)
    if operation == "assignments":
        _only(values, {"status", "initiativeId"}, operation)
        return _assignment_cards(
            domain,
            runtime_dir,
            status=str(values["status"]) if values.get("status") else None,
            initiative_id=(
                str(values["initiativeId"]) if values.get("initiativeId") else None
            ),
        )
    if operation == "initiative-state":
        _only(values, {"initiativeId", "source", "cutSystemTime"}, operation)
        state = domain.work_control.query_state(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            storage_source_id=str(values.get("source") or "kungfu"),
            cut_system_time=int(values.get("cutSystemTime") or 0),
        )
        return {
            "initiative": (state.get("initiative") or {})
            .get("payload", {})
            .get("record"),
            "assignments": [
                row.get("payload", {}).get("record")
                for row in state.get("assignments") or []
            ],
        }
    if operation == "initiative-home":
        _only(values, {"initiativeId", "source", "cutSystemTime"}, operation)
        return domain.work_control.query_initiative_home(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            storage_source_id=str(values.get("source") or "kungfu"),
            cut_system_time=int(values.get("cutSystemTime") or 0),
        )
    if operation in {"authority-status", "runtime-authority-status"}:
        _only(values, set(), operation)
        return {"authority": domain.work_control.authority_status(runtime_dir)}
    if operation == "assignment-status":
        _only(values, {"initiativeId", "assignmentId", "source", "now"}, operation)
        return domain.work_control.assignment_orchestration_status(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            storage_source_id=str(values.get("source") or "kungfu"),
            now=str(values.get("now") or ""),
        )
    if operation == "work-semantics-status":
        _only(values, {"initiativeId", "assignmentId", "source"}, operation)
        return domain.work_semantics.status(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            storage_source_id=str(values.get("source") or "kungfu"),
        )
    raise ValueError(f"unsupported Work Control adapter operation: {operation}")
