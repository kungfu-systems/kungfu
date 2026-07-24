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


PROFILE_ID = "kungfu.dogfood-feedback"
MEMBER_ID = "dogfood-actions"


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


def read(
    runtime_dir: str, operation: str, values: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    input_value = dict(values or {})
    if operation in {"capabilities", "migration-plan"}:
        domain = profile_sdk.load_member_python_package(
            str(source()), MEMBER_ID, "domain"
        ).dogfood
        if operation == "capabilities":
            return domain.capabilities()
        return domain.atlas_migration_plan(str(input_value.get("sourcePath") or ""))
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
