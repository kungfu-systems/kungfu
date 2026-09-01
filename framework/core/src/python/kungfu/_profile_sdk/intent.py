# SPDX-License-Identifier: Apache-2.0

"""Shared Profile intent protocol owner."""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any, Mapping

_facade = importlib.import_module("kungfu.profile_sdk")

ProfileSdkError = _facade.ProfileSdkError
INTENT_PLAN_SCHEMA = _facade.INTENT_PLAN_SCHEMA
INTENT_RECEIPT_SCHEMA = _facade.INTENT_RECEIPT_SCHEMA
_root = _facade._root
application = _facade.application
plan_action = _facade.plan_action
authorized_action_invoke = _facade.authorized_action_invoke
answer_decision = _facade.answer_decision


def intent_inspect(
    source: str | Path, runtime_dir: str | Path, intent_id: str
) -> dict[str, Any]:
    projection = application(source, runtime_dir, include_qualification=False)
    intent = next(
        (row for row in projection["intents"] if row["id"] == intent_id), None
    )
    if intent is None:
        raise ProfileSdkError(
            "collaboration-intent-not-found", f"intent not found: {intent_id}"
        )
    return {
        "schema": "kungfu.profile-intent-inspection/v1",
        "profileId": projection["profileId"],
        "profileSuiteRoot": projection["profileSuiteRoot"],
        "collaborationRoot": projection["collaborationRoot"],
        "closureRoot": projection["closureRoot"],
        "source": projection["source"],
        "profileRevision": projection["profileRevision"],
        "activeExactRoot": projection["activeExactRoot"],
        "intent": intent,
        "cut": {
            "kind": "profile-revision",
            "value": projection["profileRevision"],
        },
    }


def intent_advise(
    source: str | Path, runtime_dir: str | Path, intent_id: str
) -> dict[str, Any]:
    inspected = intent_inspect(source, runtime_dir, intent_id)
    intent = inspected["intent"]
    application_value = application(source, runtime_dir, include_qualification=False)
    constraints = [
        row
        for row in application_value["constraints"]
        if "*" in row["appliesTo"] or intent_id in row["appliesTo"]
    ]
    eligible = inspected["activeExactRoot"] and not intent["missingCapabilities"]
    return {
        "schema": "kungfu.profile-intent-advice/v1",
        "profileId": inspected["profileId"],
        "profileSuiteRoot": inspected["profileSuiteRoot"],
        "collaborationRoot": inspected["collaborationRoot"],
        "closureRoot": inspected["closureRoot"],
        "source": inspected["source"],
        "intentId": intent_id,
        "eligible": eligible,
        "recommendation": "preview" if eligible else "resolve-preconditions",
        "constraints": constraints,
        "knownLimits": application_value["knownLimits"],
        "missingCapabilities": intent["missingCapabilities"],
        "preconditions": {
            "activeExactRoot": inspected["activeExactRoot"],
            "profileRevision": inspected["profileRevision"],
        },
    }


def intent_plan(
    source: str | Path,
    runtime_dir: str | Path,
    intent_id: str,
    input_value: Any,
) -> dict[str, Any]:
    advice = intent_advise(source, runtime_dir, intent_id)
    if not advice["eligible"]:
        raise ProfileSdkError(
            "intent-precondition-failed",
            "intent cannot be previewed until its active-root and capability preconditions hold",
            advice=advice,
        )
    inspected = intent_inspect(source, runtime_dir, intent_id)
    action_plan = plan_action(
        source, runtime_dir, inspected["intent"]["actionId"], input_value
    )
    identity = {
        "profileSuiteRoot": inspected["profileSuiteRoot"],
        "collaborationRoot": inspected["collaborationRoot"],
        "closureRoot": inspected["closureRoot"],
        "intentId": intent_id,
        "actionPlanId": action_plan["planId"],
        "input": input_value,
    }
    return {
        "schema": INTENT_PLAN_SCHEMA,
        "planId": _root(identity),
        **identity,
        "source": inspected["source"],
        "actionPlan": action_plan,
        "decisionCard": action_plan.get("decisionCard"),
        "protocolStage": "preview",
    }


def intent_apply(
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
    answer: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if plan.get("schema") != INTENT_PLAN_SCHEMA:
        raise ProfileSdkError(
            "intent-plan-invalid", "intent apply requires an intent plan"
        )
    refreshed = intent_plan(
        str(plan.get("source") or ""),
        runtime_dir,
        str(plan.get("intentId") or ""),
        plan.get("input"),
    )
    if refreshed["planId"] != plan.get("planId"):
        raise ProfileSdkError("intent-plan-stale", "intent plan changed after preview")
    action_receipt = authorized_action_invoke(
        runtime_dir, plan.get("actionPlan") or {}, answer
    )
    identity = {
        "planId": plan["planId"],
        "actionPlanId": plan["actionPlanId"],
        "profileSuiteRoot": plan["profileSuiteRoot"],
        "collaborationRoot": plan["collaborationRoot"],
        "closureRoot": plan["closureRoot"],
        "intentId": plan["intentId"],
        "actionReceipt": action_receipt,
    }
    return {
        "schema": INTENT_RECEIPT_SCHEMA,
        "receiptId": _root(identity),
        **identity,
        "source": plan["source"],
        "protocolStage": "receipt",
        "executionReceiptVerified": action_receipt["verified"],
        "verified": False,
    }


def intent_verify(
    source: str | Path, runtime_dir: str | Path, receipt: Mapping[str, Any]
) -> dict[str, Any]:
    if receipt.get("schema") != INTENT_RECEIPT_SCHEMA:
        raise ProfileSdkError(
            "intent-receipt-invalid", "verify requires an intent receipt"
        )
    inspected = intent_inspect(source, runtime_dir, str(receipt.get("intentId") or ""))
    current = {
        "profileSuiteRoot": inspected["profileSuiteRoot"],
        "collaborationRoot": inspected["collaborationRoot"],
        "closureRoot": inspected["closureRoot"],
    }
    expected = {key: receipt.get(key) for key in current}
    if current != expected:
        raise ProfileSdkError(
            "intent-receipt-stale",
            "Profile or collaboration closure changed after execution",
            expected=expected,
            actual=current,
        )
    action_receipt = receipt.get("actionReceipt") or {}
    verified = bool(
        receipt.get("executionReceiptVerified")
        and action_receipt.get("verified")
        and action_receipt.get("planId") == receipt.get("actionPlanId")
    )
    if not verified:
        raise ProfileSdkError(
            "intent-execution-unverified", "underlying action receipt is not verified"
        )
    return {
        "schema": "kungfu.profile-intent-verification/v1",
        "receiptId": receipt["receiptId"],
        **current,
        "intentId": receipt["intentId"],
        "verifyView": inspected["intent"]["verifyView"],
        "protocolStage": "verify",
        "verified": True,
        "evidenceScope": "profile-root/collaboration-root/execution-receipt/declared-verify-view",
        "knownLimit": "declared verify view is bound but domain outcome truth remains evidence-dependent",
    }


def authorize_current_intent(
    runtime_dir: str | Path,
    source: str | Path,
    intent_id: str,
    input_value: Any,
    expected_plan_id: str,
    choice: str,
    authorized_by: str,
) -> dict[str, Any]:
    plan = intent_plan(source, runtime_dir, intent_id, input_value)
    if plan["planId"] != expected_plan_id:
        raise ProfileSdkError(
            "intent-plan-stale",
            "intent plan changed; review a fresh preview",
            expectedPlanId=expected_plan_id,
            actualPlanId=plan["planId"],
        )
    answer = answer_decision(plan["decisionCard"], choice, authorized_by)
    receipt = intent_apply(runtime_dir, plan, answer)
    return {**receipt, "verification": intent_verify(source, runtime_dir, receipt)}
