# SPDX-License-Identifier: Apache-2.0

"""Supported Python API for the Dogfood Feedback Domain Profile.

This facade owns no dogfood semantics. It binds callers to the exact installed
Profile root and delegates reads and authorized intents to the content-bound
``dogfood-actions`` member used by the CLI.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from kungfu import profile_composition, profile_sdk
from kungfu.storage import service as storage_service
from kungfu.workspace import semantic_root


PROFILE_ID = "kungfu.dogfood-feedback"
MEMBER_ID = "dogfood-actions"
PROFILE_DIAGNOSIS_SCHEMA = "kungfu.dogfood-feedback.profile-diagnosis/v1"
PROFILE_RECOVERY_PLAN_SCHEMA = "kungfu.dogfood-feedback.profile-recovery-plan/v1"


def source() -> Path:
    packaged = Path(__file__).resolve().parent / "profiles" / "dogfood"
    if packaged.is_dir():
        return packaged
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "extensions" / "dogfood"
        if candidate.is_dir():
            return candidate
    raise ValueError("Dogfood Feedback Profile is absent from this Kungfu product")


def ensure_profile(runtime_dir: str, authorized_by: str) -> list[dict[str, Any]]:
    profile_source = source()
    validated = profile_sdk.validate_source(profile_source, runtime_dir)
    inspection = validated["inspection"]
    desired_root = inspection["profile_suite_root"]
    lifecycle = storage_service.profile_lifecycle(
        runtime_dir, "list", include_removed=True
    )
    state = next(
        (
            row
            for row in lifecycle.get("profiles", [])
            if row.get("profile_id") == PROFILE_ID and not row.get("removed")
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
    receipts = []
    for action in actions:
        values = {"granted_permissions": ["storage"]} if action == "activate" else {}
        plan = profile_sdk.lifecycle_plan(runtime_dir, action, profile_source, **values)
        answer = profile_sdk.answer_decision(
            plan["decisionCard"], "approve", authorized_by
        )
        receipts.append(
            profile_sdk.authorized_lifecycle_apply(runtime_dir, plan, answer)
        )
    contract = profile_composition.contract_materialization_plan(
        profile_source, runtime_dir
    )
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


def profile_diagnosis(runtime_dir: str) -> dict[str, Any]:
    """Inspect exact-root lifecycle compatibility without mutating anything."""

    profile_source = source()
    validated = profile_sdk.validate_source(profile_source, runtime_dir)
    inspection = validated["inspection"]
    desired_root = inspection["profile_suite_root"]
    lifecycle = storage_service.profile_lifecycle(
        runtime_dir, "list", include_removed=True
    )
    state = next(
        (
            row
            for row in lifecycle.get("profiles", [])
            if row.get("profile_id") == PROFILE_ID
        ),
        None,
    )
    current_root = str((state or {}).get("profile_suite_root") or "")
    removed = bool((state or {}).get("removed"))
    qualified = bool((state or {}).get("qualified"))
    activated = bool((state or {}).get("activated"))
    if state is None:
        lifecycle_state = "absent"
        cause = "profile-not-installed"
        actions = ["install", "qualify", "activate", "materialize-contract"]
    elif removed:
        lifecycle_state = "removed"
        cause = "profile-removed"
        actions = ["install", "qualify", "activate", "materialize-contract"]
    elif current_root != desired_root:
        lifecycle_state = str(state.get("state") or "root-drift")
        cause = "exact-profile-root-drift"
        actions = ["upgrade", "qualify", "activate", "materialize-contract"]
    else:
        lifecycle_state = str(state.get("state") or "installed")
        actions = []
        if not qualified:
            actions.append("qualify")
        if not activated:
            actions.append("activate")
        if not actions:
            cause = "exact-profile-root-active"
            try:
                contract = profile_composition.contract_materialization_plan(
                    profile_source, runtime_dir
                )
                if contract["operations"]:
                    actions.append("materialize-contract")
                    cause = "profile-contract-not-materialized"
            except profile_sdk.ProfileSdkError:
                actions.append("materialize-contract")
                cause = "profile-contract-inspection-failed"
        else:
            cause = "profile-lifecycle-incomplete"
    body = {
        "schema": PROFILE_DIAGNOSIS_SCHEMA,
        "ok": not actions,
        "profile_id": PROFILE_ID,
        "current_root": current_root,
        "desired_root": desired_root,
        "lifecycle_state": lifecycle_state,
        "revision": (state or {}).get("revision"),
        "qualified": qualified,
        "activated": activated,
        "removed": removed,
        "cause": cause,
        "next_actions": [
            {
                "action": "dogfood-profile-recovery-plan",
                "operations": actions,
                "requires_authorization": True,
            }
        ]
        if actions
        else [],
        "writes": [],
    }
    return {**body, "diagnosis_root": semantic_root(body)}


def recovery_plan(runtime_dir: str) -> dict[str, Any]:
    """Describe the exact desired root and bounded recovery operations."""

    diagnosis = profile_diagnosis(runtime_dir)
    operations = [
        {
            "order": index,
            "operation": action,
            "profile_id": PROFILE_ID,
            "desired_root": diagnosis["desired_root"],
            "impact": (
                "append canonical Profile lifecycle event"
                if action != "materialize-contract"
                else "append missing Fact contract declarations"
            ),
        }
        for index, action in enumerate(
            (
                (diagnosis["next_actions"][0]["operations"])
                if diagnosis["next_actions"]
                else []
            ),
            1,
        )
    ]
    body = {
        "schema": PROFILE_RECOVERY_PLAN_SCHEMA,
        "profile_id": PROFILE_ID,
        "current_root": diagnosis["current_root"],
        "desired_root": diagnosis["desired_root"],
        "diagnosis_root": diagnosis["diagnosis_root"],
        "operations": operations,
        "requires_authorization": bool(operations),
        "rollback_boundary": {
            "mode": "append-forward-lifecycle-event",
            "deletes_facts": False,
            "restores_old_bytes": False,
        },
        "writes": [],
    }
    return {
        **body,
        "plan_root": semantic_root(body),
        "status": "ready" if operations else "no-op",
    }


def apply_recovery(
    runtime_dir: str,
    *,
    expected_plan_root: str,
    authorized_by: str,
) -> dict[str, Any]:
    """Apply one still-current recovery plan through canonical decision cards."""

    plan = recovery_plan(runtime_dir)
    if not expected_plan_root or plan["plan_root"] != expected_plan_root:
        raise profile_sdk.ProfileSdkError(
            "dogfood-recovery-plan-stale",
            "Dogfood Profile recovery plan changed; review the current plan",
            expectedPlanRoot=expected_plan_root,
            actualPlanRoot=plan["plan_root"],
        )
    if not plan["operations"]:
        return {
            "schema": "kungfu.dogfood-feedback.profile-recovery-receipt/v1",
            "status": "already-current",
            "plan_root": plan["plan_root"],
            "profile_id": PROFILE_ID,
            "desired_root": plan["desired_root"],
            "receipts": [],
            "verified_no_op": True,
        }
    profile_source = source()
    receipts = []
    for operation in plan["operations"]:
        action = operation["operation"]
        if action == "materialize-contract":
            contract = profile_composition.contract_materialization_plan(
                profile_source, runtime_dir
            )
            answer = (
                profile_sdk.answer_decision(
                    contract["decisionCard"], "approve", authorized_by
                )
                if contract["operations"]
                else None
            )
            receipts.append(
                profile_composition.authorized_contract_materialize(
                    runtime_dir, contract, answer
                )
            )
            continue
        values = {"granted_permissions": ["storage"]} if action == "activate" else {}
        lifecycle_plan = profile_sdk.lifecycle_plan(
            runtime_dir, action, profile_source, **values
        )
        answer = profile_sdk.answer_decision(
            lifecycle_plan["decisionCard"], "approve", authorized_by
        )
        receipts.append(
            profile_sdk.authorized_lifecycle_apply(runtime_dir, lifecycle_plan, answer)
        )
    after = profile_diagnosis(runtime_dir)
    if not after["ok"]:
        raise profile_sdk.ProfileSdkError(
            "dogfood-recovery-incomplete",
            "Dogfood Profile recovery did not reach the exact desired root",
            diagnosis=after,
        )
    return {
        "schema": "kungfu.dogfood-feedback.profile-recovery-receipt/v1",
        "status": "recovered",
        "plan_root": plan["plan_root"],
        "profile_id": PROFILE_ID,
        "desired_root": plan["desired_root"],
        "receipts": receipts,
        "verified_no_op": False,
        "diagnosis": after,
    }


def read(
    runtime_dir: str, operation: str, values: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    input_value = dict(values or {})
    if operation == "capabilities":
        domain = profile_sdk.load_member_python_package(
            str(source()), MEMBER_ID, "domain"
        ).dogfood
        return domain.capabilities()
    diagnosis = profile_diagnosis(runtime_dir)
    if not diagnosis["ok"]:
        raise profile_sdk.ProfileSdkError(
            "dogfood-profile-not-current",
            "Dogfood read requires the exact active Profile root",
            profileDiagnosis=diagnosis,
            currentRoot=diagnosis["current_root"],
            desiredRoot=diagnosis["desired_root"],
            lifecycleState=diagnosis["lifecycle_state"],
            cause=diagnosis["cause"],
            nextActions=diagnosis["next_actions"],
        )
    return profile_sdk.invoke_member_adapter(
        str(source()),
        runtime_dir,
        MEMBER_ID,
        operation,
        input_value,
    )["result"]


def action(
    runtime_dir: str,
    intent_id: str,
    values: Mapping[str, Any],
    authorized_by: str,
) -> dict[str, Any]:
    profile_source = str(source())
    plan = profile_sdk.intent_plan(profile_source, runtime_dir, intent_id, dict(values))
    answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", authorized_by)
    receipt = profile_sdk.intent_apply(runtime_dir, plan, answer)
    return receipt["actionReceipt"]["coreReceipt"]


def consider_assignment(
    runtime_dir: str,
    *,
    workspace_root: str,
    home: bool,
    assignment: Mapping[str, Any],
    stage: str,
    actor: str,
    dispositions: list[dict[str, Any]] | None = None,
    scope: str = "local",
    limit: int = 50,
) -> dict[str, Any]:
    ensure_profile(runtime_dir, actor)
    return action(
        runtime_dir,
        "record-consideration",
        {
            "workspaceRoot": workspace_root,
            "home": home,
            "assignment": dict(assignment),
            "stage": stage,
            "actor": actor,
            "dispositions": dispositions or [],
            "scope": scope,
            "limit": limit,
        },
        actor,
    )


def consideration_gate(
    runtime_dir: str,
    *,
    assignment_definition_root: str,
    target: str = "closeout",
    required_stages: list[str] | None = None,
    now: str = "",
) -> dict[str, Any]:
    values: dict[str, Any] = {
        "assignmentDefinitionRoot": assignment_definition_root,
        "target": target,
        "now": now,
    }
    if required_stages is not None:
        values["requiredStages"] = required_stages
    return read(runtime_dir, "consideration-gate", values)
