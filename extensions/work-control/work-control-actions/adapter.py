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


def _text(values: Mapping[str, Any], key: str, default: str = "") -> str:
    return str(values.get(key) or default)


def _string_rows(values: Mapping[str, Any], key: str) -> list[str]:
    return [str(row) for row in (values.get(key) or [])]


def _object_rows(values: Mapping[str, Any], key: str) -> list[dict[str, Any]]:
    return [dict(row) for row in (values.get(key) or [])]


def _mapping(values: Mapping[str, Any], key: str) -> dict[str, Any]:
    return dict(values.get(key) or {})


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


def _create_initiative(domain, runtime_dir: str, values: Mapping[str, Any]):
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
        "create-initiative",
    )
    receipt = domain.work_control.create_initiative(
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
    return receipt, [receipt["initiative_subject"]]


_CREATE_ASSIGNMENT_FIELDS = {
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
}


def _create_assignment(domain, runtime_dir: str, values: Mapping[str, Any]):
    _only(values, _CREATE_ASSIGNMENT_FIELDS, "create-assignment")
    receipt = domain.work_control.create_assignment(
        runtime_dir,
        initiative_id=_text(values, "initiativeId"),
        assignment_id=_text(values, "assignmentId"),
        title=_text(values, "title"),
        objective=_text(values, "objective"),
        actor=_text(values, "actor"),
        actor_type=_text(values, "actorType", "agent"),
        storage_source_id=_text(values, "source", "kungfu"),
        status=_text(values, "status", "active"),
        parent_assignment_id=_text(values, "parentAssignmentId"),
        depends_on=_string_rows(values, "dependsOn"),
        owning_workspace_identity_root=_text(values, "owningWorkspaceIdentityRoot"),
        initiative_ref=_mapping(values, "initiativeRef"),
        parent_assignment_ref=_mapping(values, "parentAssignmentRef"),
        dependency_refs=_object_rows(values, "dependencyRefs"),
        responsibility=_text(values, "responsibility"),
        acceptance_root=_text(values, "acceptanceRoot"),
        context_root=_text(values, "contextRoot"),
        context_binding=_mapping(values, "contextBinding"),
        project_cut_root=_text(values, "projectCutRoot"),
        evidence_episode_roots=_string_rows(values, "evidenceEpisodeRoots"),
        request_root=_text(values, "requestRoot"),
        capture_receipt_roots=_string_rows(values, "captureReceiptRoots"),
        work_definition=_mapping(values, "workDefinition"),
    )
    return receipt, [receipt["initiative_subject"], receipt["assignment_subject"]]


def _append_assignment_relation_event(
    domain, runtime_dir: str, values: Mapping[str, Any]
):
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
        "append-assignment-relation-event",
    )
    receipt = domain.work_control.append_assignment_relation_event(
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
    relation = receipt["event"]["relation"]
    return receipt, [relation["source"]["subject"], relation["target"]["subject"]]


def _claim_assignment(domain, runtime_dir: str, values: Mapping[str, Any]):
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
        "claim-assignment",
    )
    receipt = domain.work_control.claim_assignment_execution(
        runtime_dir,
        initiative_id=_text(values, "initiativeId"),
        assignment_id=_text(values, "assignmentId"),
        owner=_text(values, "owner"),
        agent=_text(values, "agent"),
        slot=_text(values, "slot"),
        lease_id=_text(values, "leaseId"),
        lease_expires_at=_text(values, "leaseExpiresAt"),
        attempt_id=_text(values, "attemptId"),
        authorized_by=_text(values, "authorizedBy"),
        grant_scope=_text(values, "grantScope", "assignment-execution"),
        actor_type=_text(values, "actorType", "agent"),
        storage_source_id=_text(values, "source", "kungfu"),
    )
    return receipt, [receipt["receipt"]["subject_key"]]


def _advance_assignment(domain, runtime_dir: str, values: Mapping[str, Any]):
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
        "advance-assignment",
    )
    receipt = domain.work_control.advance_assignment_phase(
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
    return receipt, [receipt["receipt"]["subject_key"]]


def _claim_completion(domain, runtime_dir: str, values: Mapping[str, Any]):
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
        "claim-completion",
    )
    receipt = domain.work_control.claim_completion(
        runtime_dir,
        initiative_id=_text(values, "initiativeId"),
        assignment_id=_text(values, "assignmentId"),
        statement=_text(values, "statement"),
        actor=_text(values, "actor"),
        actor_type=_text(values, "actorType", "agent"),
        storage_source_id=_text(values, "source", "kungfu"),
        evidence_episode_ids=[int(row) for row in values.get("evidenceEpisodeIds", [])],
        assignment_set=_string_rows(values, "assignmentSet"),
        acceptance_root=_text(values, "acceptanceRoot"),
        input_context_root=_text(values, "inputContextRoot"),
        result_context_root=_text(values, "resultContextRoot"),
        project_cut_root=_text(values, "projectCutRoot"),
        project_cut_receipt_root=_text(values, "projectCutReceiptRoot"),
        git_commit=_text(values, "gitCommit"),
        git_tree_root=_text(values, "gitTreeRoot"),
        proof_roots=_string_rows(values, "proofRoots"),
        known_gaps=_string_rows(values, "knownGaps"),
        evidence_availability=list(values.get("evidenceAvailability", [])),
    )
    return receipt, [
        receipt["initiative_subject"],
        receipt["assignment_subject"],
        receipt["claim"]["claim_id"],
    ]


def _assess_progress(domain, runtime_dir: str, values: Mapping[str, Any]):
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
        "assess-progress",
    )
    common = {
        "initiative_id": _text(values, "initiativeId"),
        "storage_source_id": _text(values, "source", "kungfu"),
        "purpose": _text(values, "purpose", "operator-review"),
        "authorized_by": _text(values, "authorizedBy", "kungfu-profile"),
        "cut_system_time": int(values.get("cutSystemTime") or 0),
        "executor_profile": _text(values, "executorProfile", "thread"),
    }
    if values.get("assignmentId"):
        receipt = domain.work_control.assess_completion(
            runtime_dir, assignment_id=str(values["assignmentId"]), **common
        )
    else:
        receipt = domain.work_control.assess_progress(runtime_dir, **common)
    return receipt, [receipt["state"]["initiative_subject"]]


def _review_completion(domain, runtime_dir: str, values: Mapping[str, Any]):
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
        "review-completion",
    )
    receipt = domain.work_control.review_completion(
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
    return receipt, [
        receipt["trust_report"]["state"]["initiative_subject"],
        receipt["review"]["review_id"],
    ]


def _decide_continuation(domain, runtime_dir: str, values: Mapping[str, Any]):
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
        "decide-continuation",
    )
    receipt = domain.work_control.decide_continuation(
        runtime_dir,
        initiative_id=_text(values, "initiativeId"),
        assignment_id=_text(values, "assignmentId"),
        review_id=_text(values, "reviewId"),
        expected_review_root=_text(values, "expectedReviewRoot"),
        expected_plan_root=_text(values, "expectedPlanRoot"),
        action=_text(values, "action"),
        actor=_text(values, "actor"),
        actor_type=_text(values, "actorType", "agent"),
        change_class=_text(values, "changeClass", "mechanical"),
        storage_source_id=_text(values, "source", "kungfu"),
        reason=_text(values, "reason"),
    )
    return receipt, [receipt["decision"]["review_id"]]


def _export_initiative(domain, runtime_dir: str, values: Mapping[str, Any]):
    _only(
        values,
        {"initiativeId", "out", "mode", "source", "purpose"},
        "export-initiative",
    )
    receipt = domain.initiative_bundle.write_initiative_bundle(
        runtime_dir,
        str(values.get("out") or ""),
        initiative_id=str(values.get("initiativeId") or ""),
        mode=str(values.get("mode") or "full"),
        storage_source_id=str(values.get("source") or "kungfu"),
        purpose=str(values.get("purpose") or "operator-review"),
    )
    return receipt, [receipt["initiative_subject"]]


def _import_initiative(domain, runtime_dir: str, values: Mapping[str, Any]):
    _only(values, {"from", "execute"}, "import-initiative")
    domain.work_control._ensure_native_write_allowed(runtime_dir)
    receipt = domain.initiative_bundle.import_initiative_bundle_file(
        runtime_dir,
        str(values.get("from") or ""),
        execute=bool(values.get("execute")),
    )
    return receipt, [receipt["initiative_subject"]]


_ACTION_HANDLERS = {
    "create-initiative": _create_initiative,
    "create-assignment": _create_assignment,
    "append-assignment-relation-event": _append_assignment_relation_event,
    "claim-assignment": _claim_assignment,
    "advance-assignment": _advance_assignment,
    "claim-completion": _claim_completion,
    "assess-progress": _assess_progress,
    "review-completion": _review_completion,
    "decide-continuation": _decide_continuation,
    "export-initiative": _export_initiative,
    "import-initiative": _import_initiative,
}


def _action(domain, operation: str, runtime_dir: str, values: Mapping[str, Any]):
    handler = _ACTION_HANDLERS.get(operation)
    if handler is None:
        raise ValueError(f"unsupported Work Control action: {operation}")
    receipt, affected = handler(domain, runtime_dir, values)
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
    raise ValueError(f"unsupported Work Control adapter operation: {operation}")
