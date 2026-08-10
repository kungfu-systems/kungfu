# SPDX-License-Identifier: Apache-2.0

"""Owned close-decision and portable-seal service for native Assignment lifecycle."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from kungfu import assignment_orchestration as orchestration
from kungfu.initiative_family.canonical import semantic_root
from kungfu.assignment_lifecycle.ports import AssignmentRuntimePort

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class CloseRequest:
    workspace_root: str | None
    home: bool
    initiative_id: str
    assignment_id: str
    actor: str
    expected_plan_root: str
    execute: bool


@dataclass(frozen=True)
class CloseServices:
    """Typed authority ports supplied by the CLI composition root."""

    runtime: AssignmentRuntimePort
    status: Callable[[str, str, str], JsonObject]
    receipt: Callable[[JsonObject], JsonObject]
    ensure_profile: Callable[[str, str], list[JsonObject]]
    profile_action: Callable[[str, str, JsonObject, str], JsonObject]


def _exact_pending_fit_review(
    current: JsonObject, *, missing_message: str, conflicting_message: str
) -> JsonObject:
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
    return pending[-1]


def build_plan(
    *,
    workspace_root: str | None,
    home: bool,
    initiative_id: str,
    assignment_id: str,
    services: CloseServices,
) -> JsonObject:
    runtime = services.runtime(workspace_root, home, "read-only")
    identity, runtime_dir = runtime.identity, runtime.runtime_dir
    current = services.status(runtime_dir, initiative_id, assignment_id)
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
        retained_review = next(
            (
                row
                for row in reviews
                if row.get("review_id") == decision.get("review_id")
            ),
            None,
        )
        if retained_review is None:
            raise ValueError("Retained close decision has no exact independent review")
        review = retained_review
        decision_mode = "retained"
    else:
        raise ValueError(
            "Work close requires independently-reviewed or continuation-decided Work"
        )
    allowed_actions = list(
        (review.get("continuation_plan") or {}).get("allowed_actions") or []
    )
    review_root = semantic_root(review)
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
            "assignmentRoot": semantic_root(current["assignment"]),
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
            "root": (semantic_root(decision) if decision is not None else None),
        },
        "effects": effects,
        "skippedEffects": ["git-init", "git-commit", "git-push", "publish"],
        "confirmationRequired": True,
        "executable": executable,
        "writeOccurred": False,
    }
    return {**body, "planRoot": semantic_root(body)}


def resume(
    *,
    workspace_root: str | None,
    home: bool,
    initiative_id: str,
    assignment_id: str,
    services: CloseServices,
) -> JsonObject:
    runtime = services.runtime(workspace_root, home, "read-only")
    identity, runtime_dir = runtime.identity, runtime.runtime_dir
    current = services.status(runtime_dir, initiative_id, assignment_id)
    review_receipt = None
    close_receipt = None
    if current["phase"] == "independently-reviewed":
        review = _exact_pending_fit_review(
            current,
            missing_message="retained review state is missing one exact fit review",
            conflicting_message="retained review state has conflicting fit reviews",
        )
        review_receipt = services.receipt(
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
        plan = build_plan(
            workspace_root=workspace_root,
            home=home,
            initiative_id=initiative_id,
            assignment_id=assignment_id,
            services=services,
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
            close_receipt = services.receipt(
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
            close_receipt = services.receipt(
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


def execute(request: CloseRequest, services: CloseServices) -> JsonObject:
    """Apply one exact close decision and seal, or return resumable failure."""

    workspace_root = request.workspace_root
    home = request.home
    initiative_id = request.initiative_id
    assignment_id = request.assignment_id
    actor = request.actor
    expected_plan_root = request.expected_plan_root
    execute = request.execute
    plan = build_plan(
        workspace_root=workspace_root,
        home=home,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        services=services,
    )
    if plan["planRoot"] != expected_plan_root:
        return services.receipt(
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
        return services.receipt(
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
        return services.receipt(
            {
                "schema": "kungfu.work-close.receipt/v1",
                "ok": False,
                "status": "not-executable",
                "planRoot": plan["planRoot"],
                "message": ("The retained independent review does not admit close."),
                "workPhase": plan["work"]["phase"],
                "nextActions": ["inspect-independent-review"],
                "writeOccurred": False,
            }
        )
    runtime = services.runtime(workspace_root, home, "read-only")
    identity, runtime_dir = runtime.identity, runtime.runtime_dir
    authority_receipts = {}
    write_occurred = False
    try:
        if plan["decision"]["mode"] == "required":
            services.ensure_profile(runtime_dir, actor)
            authority_receipts["decision"] = services.profile_action(
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
        current = services.status(runtime_dir, initiative_id, assignment_id)
        if current["phase"] != "continuation-decided":
            raise RuntimeError("Work close decision did not reach continuation-decided")
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
        return services.receipt(
            {
                "schema": "kungfu.work-close.receipt/v1",
                "ok": True,
                "status": "completed",
                "planRoot": plan["planRoot"],
                "message": (
                    "Work is complete. The decision and portable evidence are retained."
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
            current_phase = services.status(runtime_dir, initiative_id, assignment_id)[
                "phase"
            ]
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
            current_phase = "unknown"
        return services.receipt(
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
