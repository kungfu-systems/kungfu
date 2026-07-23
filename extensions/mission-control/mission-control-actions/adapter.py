# SPDX-License-Identifier: Apache-2.0

"""Mission Control Profile member adapter.

The generic Profile runtime binds this module to the exact Suite/member roots.
All Mission, Go, Atlas projection and portable bundle semantics stay here.
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any

from kungfu import profile_sdk


def _object(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("Mission Control adapter input must be an object")
    return value


def _only(values: Mapping[str, Any], allowed: set[str], operation: str) -> None:
    unknown = set(values) - allowed
    if unknown:
        raise ValueError(f"unknown {operation} input: {sorted(unknown)}")


def _projection(runtime_dir: str):
    from kungfu.atlas import store

    return store.load(runtime_dir)


def _domain(context: Mapping[str, Any]):
    return profile_sdk.load_member_python_package(
        str(context["source"]), "mission-control-actions", "domain"
    )


def _mission_cards(domain, runtime_dir: str, cut_system_time: int = 0):
    mission_control = domain.mission_control

    projection = _projection(runtime_dir)
    cards = dict((projection or {}).get("missions", {}))
    for record in mission_control.list_missions(
        runtime_dir, cut_system_time=cut_system_time
    ):
        mission_id = str(record["mission_id"])
        cards[mission_id] = {**record, **cards.get(mission_id, {})}
    return sorted(cards.values(), key=lambda row: row["mission_id"])


def _goal_cards(
    domain,
    runtime_dir: str,
    *,
    status: str | None = None,
    mission_id: str | None = None,
    cut_system_time: int = 0,
):
    mission_control = domain.mission_control

    projection = _projection(runtime_dir)
    cards = dict((projection or {}).get("goals", {}))
    for record in mission_control.list_goals(
        runtime_dir, cut_system_time=cut_system_time
    ):
        goal_id = str(record["goal_id"])
        cards[goal_id] = {**record, **cards.get(goal_id, {})}
    return [
        row
        for row in sorted(cards.values(), key=lambda item: item["goal_id"])
        if (status is None or row.get("status") == status)
        and (
            mission_id is None
            or row.get("mission_id") == mission_id
            or row.get("mission_subject") == mission_id
        )
    ]


def _action(domain, operation: str, runtime_dir: str, values: Mapping[str, Any]):
    mission_bundle = domain.mission_bundle
    mission_control = domain.mission_control

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
            },
            operation,
        )
        receipt = mission_control.create_initiative(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            title=str(values.get("title") or ""),
            intent=str(values.get("intent") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            status=str(values.get("status") or "active"),
            horizon=str(values.get("horizon") or "long-term"),
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
                "atlasRoot",
                "contextBinding",
                "projectCutRoot",
                "evidenceEpisodeRoots",
                "requestRoot",
                "captureReceiptRoots",
                "workDefinition",
            },
            operation,
        )
        receipt = mission_control.create_assignment(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            title=str(values.get("title") or ""),
            objective=str(values.get("objective") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            storage_source_id=str(values.get("source") or "atlas"),
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
            atlas_root=str(values.get("atlasRoot") or ""),
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
    elif operation == "create-mission":
        _only(
            values,
            {"missionId", "title", "intent", "actor", "actorType", "status", "horizon"},
            operation,
        )
        receipt = mission_control.create_mission(
            runtime_dir,
            mission_id=str(values.get("missionId") or ""),
            title=str(values.get("title") or ""),
            intent=str(values.get("intent") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            status=str(values.get("status") or "active"),
            horizon=str(values.get("horizon") or "long-term"),
        )
        affected = [receipt["mission_subject"]]
    elif operation == "create-go":
        _only(
            values,
            {
                "missionId",
                "goalId",
                "title",
                "objective",
                "actor",
                "actorType",
                "source",
                "status",
                "parentGoalId",
                "dependsOn",
                "owningWorkspaceIdentityRoot",
                "initiativeRef",
                "parentAssignmentRef",
                "dependencyRefs",
                "responsibility",
                "acceptanceRoot",
                "atlasRoot",
                "contextBinding",
                "projectCutRoot",
                "evidenceEpisodeRoots",
            },
            operation,
        )
        receipt = mission_control.create_go(
            runtime_dir,
            mission_id=str(values.get("missionId") or ""),
            goal_id=str(values.get("goalId") or ""),
            title=str(values.get("title") or ""),
            objective=str(values.get("objective") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            storage_source_id=str(values.get("source") or "atlas"),
            status=str(values.get("status") or "active"),
            parent_goal_id=str(values.get("parentGoalId") or ""),
            depends_on=[str(row) for row in (values.get("dependsOn") or [])],
            owning_workspace_identity_root=str(
                values.get("owningWorkspaceIdentityRoot") or ""
            ),
            initiative_ref=dict(values.get("initiativeRef") or {}),
            parent_assignment_ref=dict(values.get("parentAssignmentRef") or {}),
            dependency_refs=[dict(row) for row in (values.get("dependencyRefs") or [])],
            responsibility=str(values.get("responsibility") or ""),
            acceptance_root=str(values.get("acceptanceRoot") or ""),
            atlas_root=str(values.get("atlasRoot") or ""),
            context_binding=dict(values.get("contextBinding") or {}),
            project_cut_root=str(values.get("projectCutRoot") or ""),
            evidence_episode_roots=[
                str(row) for row in (values.get("evidenceEpisodeRoots") or [])
            ],
        )
        affected = [receipt["mission_subject"], receipt["go_subject"]]
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
        receipt = mission_control.append_assignment_relation_event(
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
                "authorizedBy",
                "grantScope",
                "actorType",
                "source",
            },
            operation,
        )
        receipt = mission_control.claim_assignment_execution(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            owner=str(values.get("owner") or ""),
            agent=str(values.get("agent") or ""),
            slot=str(values.get("slot") or ""),
            lease_id=str(values.get("leaseId") or ""),
            lease_expires_at=str(values.get("leaseExpiresAt") or ""),
            authorized_by=str(values.get("authorizedBy") or ""),
            grant_scope=str(values.get("grantScope") or "assignment-execution"),
            actor_type=str(values.get("actorType") or "agent"),
            storage_source_id=str(values.get("source") or "atlas"),
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
        receipt = mission_control.advance_assignment_phase(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            to_phase=str(values.get("toPhase") or ""),
            expected_phase=str(values.get("expectedPhase") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            reason=str(values.get("reason") or ""),
            storage_source_id=str(values.get("source") or "atlas"),
        )
        affected = [receipt["receipt"]["subject_key"]]
    elif operation == "claim-completion":
        _only(
            values,
            {
                "missionId",
                "goalId",
                "statement",
                "actor",
                "actorType",
                "source",
                "evidenceEpisodeIds",
                "goSet",
                "acceptanceRoot",
                "inputAtlasRoot",
                "resultAtlasRoot",
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
        receipt = mission_control.claim_completion(
            runtime_dir,
            mission_id=str(values.get("missionId") or ""),
            goal_id=str(values.get("goalId") or ""),
            statement=str(values.get("statement") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            storage_source_id=str(values.get("source") or "atlas"),
            evidence_episode_ids=[
                int(row) for row in values.get("evidenceEpisodeIds", [])
            ],
            go_set=[str(row) for row in values.get("goSet", [])],
            acceptance_root=str(values.get("acceptanceRoot") or ""),
            input_atlas_root=str(values.get("inputAtlasRoot") or ""),
            result_atlas_root=str(values.get("resultAtlasRoot") or ""),
            project_cut_root=str(values.get("projectCutRoot") or ""),
            project_cut_receipt_root=str(values.get("projectCutReceiptRoot") or ""),
            git_commit=str(values.get("gitCommit") or ""),
            git_tree_root=str(values.get("gitTreeRoot") or ""),
            proof_roots=[str(row) for row in values.get("proofRoots", [])],
            known_gaps=[str(row) for row in values.get("knownGaps", [])],
            evidence_availability=list(values.get("evidenceAvailability", [])),
        )
        affected = [
            receipt["mission_subject"],
            receipt["go_subject"],
            receipt["claim"]["claim_id"],
        ]
    elif operation == "assess-progress":
        _only(
            values,
            {
                "missionId",
                "goalId",
                "source",
                "purpose",
                "authorizedBy",
                "cutSystemTime",
                "executorProfile",
            },
            operation,
        )
        common = {
            "mission_id": str(values.get("missionId") or ""),
            "storage_source_id": str(values.get("source") or "atlas"),
            "purpose": str(values.get("purpose") or "operator-review"),
            "authorized_by": str(values.get("authorizedBy") or "kungfu-profile"),
            "cut_system_time": int(values.get("cutSystemTime") or 0),
            "executor_profile": str(values.get("executorProfile") or "thread"),
        }
        if values.get("goalId"):
            receipt = mission_control.assess_completion(
                runtime_dir, goal_id=str(values["goalId"]), **common
            )
        else:
            receipt = mission_control.assess_progress(runtime_dir, **common)
        affected = [receipt["state"]["mission_subject"]]
    elif operation == "review-completion":
        _only(
            values,
            {
                "missionId",
                "goalId",
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
        receipt = mission_control.review_completion(
            runtime_dir,
            mission_id=str(values.get("missionId") or ""),
            goal_id=str(values.get("goalId") or ""),
            reviewer=str(values.get("reviewer") or ""),
            reviewer_source=str(values.get("reviewerSource") or ""),
            storage_source_id=str(values.get("source") or "atlas"),
            purpose=str(values.get("purpose") or "handoff"),
            cut_system_time=int(values.get("cutSystemTime") or 0),
            executor_profile=str(values.get("executorProfile") or "thread"),
            proposed_followups=list(values.get("proposedFollowups", [])),
            checkout_path=str(values.get("checkoutPath") or ""),
        )
        affected = [
            receipt["trust_report"]["state"]["mission_subject"],
            receipt["review"]["review_id"],
        ]
    elif operation == "decide-continuation":
        _only(
            values,
            {
                "missionId",
                "goalId",
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
        receipt = mission_control.decide_continuation(
            runtime_dir,
            mission_id=str(values.get("missionId") or ""),
            goal_id=str(values.get("goalId") or ""),
            review_id=str(values.get("reviewId") or ""),
            expected_review_root=str(values.get("expectedReviewRoot") or ""),
            expected_plan_root=str(values.get("expectedPlanRoot") or ""),
            action=str(values.get("action") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            change_class=str(values.get("changeClass") or "mechanical"),
            storage_source_id=str(values.get("source") or "atlas"),
            reason=str(values.get("reason") or ""),
        )
        affected = [receipt["decision"]["review_id"]]
    elif operation == "export-mission":
        _only(values, {"missionId", "out", "mode", "source", "purpose"}, operation)
        receipt = mission_bundle.write_mission_bundle(
            runtime_dir,
            str(values.get("out") or ""),
            mission_id=str(values.get("missionId") or ""),
            mode=str(values.get("mode") or "full"),
            storage_source_id=str(values.get("source") or "atlas"),
            purpose=str(values.get("purpose") or "operator-review"),
        )
        affected = [receipt["mission_subject"]]
    elif operation == "import-mission":
        _only(values, {"from", "execute"}, operation)
        mission_control._ensure_native_write_allowed(runtime_dir)
        receipt = mission_bundle.import_mission_bundle_file(
            runtime_dir,
            str(values.get("from") or ""),
            execute=bool(values.get("execute")),
        )
        affected = [receipt["mission_subject"]]
    elif operation == "import-atlas":
        _only(values, {"repo", "source", "range"}, operation)
        from kungfu.atlas.store import ImportStore

        mission_control._ensure_atlas_write_allowed(runtime_dir)
        receipt = ImportStore(runtime_dir).run_import(
            str(values.get("repo") or ""),
            storage_source_id=str(values.get("source") or "atlas"),
            range_filter=values.get("range"),
            on_sealed=lambda sealed: mission_control.admit_import(
                runtime_dir,
                import_id=sealed["import_id"],
                import_episode_id=sealed["episode_id"],
                import_episode_root=sealed["episode_root"],
                repo_head=sealed["repo_head"],
                storage_source_id=sealed["storage_source_id"],
                entries=sealed["entries"],
            ),
        )
        receipt["mission_control"] = receipt.pop("post_seal")
        affected = [str(values.get("repo") or "")]
    elif operation == "cutover-authority":
        _only(
            values,
            {
                "source",
                "expectedParityRoot",
                "projectCutRoot",
                "atlasRoot",
                "actor",
                "actorType",
                "reason",
            },
            operation,
        )
        receipt = mission_control.cutover_authority(
            runtime_dir,
            storage_source_id=str(values.get("source") or "atlas"),
            expected_parity_root=str(values.get("expectedParityRoot") or ""),
            project_cut_root=str(values.get("projectCutRoot") or ""),
            atlas_root=str(values.get("atlasRoot") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            reason=str(values.get("reason") or ""),
        )
        affected = ["mission-go-authority"]
    elif operation == "rollback-authority":
        _only(
            values,
            {"expectedMigrationId", "actor", "actorType", "reason"},
            operation,
        )
        receipt = mission_control.rollback_authority(
            runtime_dir,
            expected_migration_id=str(values.get("expectedMigrationId") or ""),
            actor=str(values.get("actor") or ""),
            actor_type=str(values.get("actorType") or "agent"),
            reason=str(values.get("reason") or ""),
        )
        affected = ["mission-go-authority"]
    else:
        raise ValueError(f"unsupported Mission Control action: {operation}")
    return {
        "coreReceipt": receipt,
        "affected": {
            "profileId": "kungfu.mission-control",
            "entityKeys": affected,
            "queryKeys": ["mission-state", "mission-timeline", "mission-attention"],
        },
    }


def invoke(
    operation: str, *, runtime_dir: str, input_value: Any, context: Mapping[str, Any]
):
    values = _object(input_value)
    domain = _domain(context)
    if operation in {
        "create-initiative",
        "create-assignment",
        "claim-assignment",
        "advance-assignment",
        "create-mission",
        "create-go",
        "claim-completion",
        "assess-progress",
        "review-completion",
        "decide-continuation",
        "export-mission",
        "import-mission",
        "import-atlas",
        "cutover-authority",
        "rollback-authority",
    }:
        if context.get("invocationMode") != "authorized-action":
            raise ValueError(
                "Mission Control writes require the Profile intent authorization path"
            )
        return _action(domain, operation, runtime_dir, values)
    if operation == "dashboard":
        _only(values, set(), operation)
        projection = _projection(runtime_dir)
        cut = time.time_ns()
        import_info = None
        if projection is not None:
            import_info = {
                "import_id": projection["import_id"],
                "repo_root": projection["repo_root"],
                "repo_head": projection["repo_head"],
                "missions": len(projection["missions"]),
                "goals": len(projection["goals"]),
                "markers": len(projection["markers"]),
            }
        return {
            "schema": "kungfu.mission-control.dashboard-snapshot/v1",
            "cut": {"kind": "system_time", "system_time": str(cut)},
            "freshness": {"status": "fresh", "basis": "request-cut"},
            "projection_authority": {
                "mode": "adapter-projection",
                "source": "atlas-and-kungfu-facts",
                "profileSuiteRoot": context["profileSuiteRoot"],
                "memberRoot": context["memberRoot"],
                "cutSystemTime": str(cut),
                "writableAuthority": False,
            },
            "import_info": import_info,
            "authority": domain.mission_control.authority_status(runtime_dir),
            "missions": _mission_cards(domain, runtime_dir, cut),
            "goals": _goal_cards(domain, runtime_dir, cut_system_time=cut),
        }
    if operation == "mission":
        _only(values, {"missionId"}, operation)
        state = domain.mission_control.query_state(
            runtime_dir, mission_id=str(values.get("missionId") or "")
        )
        return {
            "mission": state["mission"]["payload"]["record"],
            "goals": [row["payload"]["record"] for row in state["goals"]],
        }
    if operation == "mission-home":
        _only(values, {"missionId", "source", "cutSystemTime"}, operation)
        return domain.mission_control.query_mission_home(
            runtime_dir,
            mission_id=str(values.get("missionId") or ""),
            storage_source_id=str(values.get("source") or "atlas"),
            cut_system_time=int(values.get("cutSystemTime") or 0),
        )
    if operation == "goals":
        return _goal_cards(
            domain,
            runtime_dir,
            status=str(values["status"]) if values.get("status") else None,
            mission_id=str(values["missionId"]) if values.get("missionId") else None,
        )
    if operation == "markers":
        projection = _projection(runtime_dir)
        return sorted(
            (projection or {}).get("markers", {}).values(),
            key=lambda row: row["branch"],
        )
    if operation == "authority-status":
        _only(values, {"source"}, operation)
        return {
            "authority": domain.mission_control.authority_status(runtime_dir),
            "parity": domain.mission_control.authority_parity(
                runtime_dir,
                storage_source_id=str(values.get("source") or "atlas"),
            ),
        }
    if operation == "assignment-status":
        _only(values, {"initiativeId", "assignmentId", "source", "now"}, operation)
        return domain.mission_control.assignment_orchestration_status(
            runtime_dir,
            initiative_id=str(values.get("initiativeId") or ""),
            assignment_id=str(values.get("assignmentId") or ""),
            storage_source_id=str(values.get("source") or "atlas"),
            now=str(values.get("now") or ""),
        )
    raise ValueError(f"unsupported Mission Control adapter operation: {operation}")
