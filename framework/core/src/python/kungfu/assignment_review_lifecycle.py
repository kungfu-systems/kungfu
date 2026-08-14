# SPDX-License-Identifier: Apache-2.0

"""Owned independent-review and native settlement lifecycle service."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from kungfu.assignment_lifecycle.ports import (
    AssignmentAdvancePort,
    AssignmentEventSink,
    AssignmentRuntimePort,
)
from kungfu.agent import run_agent
from kungfu.cli.commands import assignment_review

JsonObject = dict[str, Any]


class ReviewPlanPort(Protocol):
    def __call__(
        self,
        *,
        config_home: str | Path,
        runtime_home: str | Path,
        agent_report_file: Path,
        workspace_root: str | None,
        home: bool,
        initiative_id: str,
        assignment_id: str,
        reviewer_profile_id: str,
        allow_foreign_binding: bool,
    ) -> JsonObject: ...


@dataclass(frozen=True)
class ReviewRequest:
    config_home: str | Path
    runtime_home: str | Path
    agent_report_file: Path
    workspace_root: str | None
    home: bool
    initiative_id: str
    assignment_id: str
    reviewer_profile_id: str
    expected_plan_root: str
    execute: bool
    allow_foreign_binding: bool


@dataclass(frozen=True)
class ReviewServices:
    """Typed ports supplied by the CLI composition root."""

    plan: ReviewPlanPort
    receipt: Callable[[JsonObject], JsonObject]
    runtime: AssignmentRuntimePort
    retained_evidence: Callable[[str, JsonObject], JsonObject | None]
    agent_report_summary: Callable[[JsonObject], JsonObject]
    status: Callable[[str, str, str], JsonObject]
    mint_lease: Callable[[str, JsonObject, str], JsonObject]
    advance: AssignmentAdvancePort
    completion_claim_values: Callable[[JsonObject, JsonObject, JsonObject], JsonObject]
    profile_action: Callable[[str, str, JsonObject, str], JsonObject]
    completion_review_values: Callable[[JsonObject, JsonObject], JsonObject]


def execute(
    request: ReviewRequest,
    services: ReviewServices,
    event: AssignmentEventSink,
    event_count: Callable[[], int],
) -> JsonObject:
    """Run or resume an independent review and settle its native evidence."""

    agent_report_file = request.agent_report_file
    workspace_root = request.workspace_root
    home = request.home
    initiative_id = request.initiative_id
    assignment_id = request.assignment_id
    reviewer_profile_id = request.reviewer_profile_id
    expected_plan_root = request.expected_plan_root
    execute = request.execute
    allow_foreign_binding = request.allow_foreign_binding

    def operation() -> JsonObject:
        plan = services.plan(
            config_home=request.config_home,
            runtime_home=request.runtime_home,
            agent_report_file=agent_report_file,
            workspace_root=workspace_root,
            home=home,
            initiative_id=initiative_id,
            assignment_id=assignment_id,
            reviewer_profile_id=reviewer_profile_id,
            allow_foreign_binding=allow_foreign_binding,
        )
        if plan["planRoot"] != expected_plan_root:
            return services.receipt(
                {
                    "schema": "kungfu.work-review.receipt/v1",
                    "ok": False,
                    "status": "plan-drift",
                    "planRoot": plan["planRoot"],
                    "message": "Review plan changed; preview it again.",
                    "workPhase": plan["work"]["phase"],
                    "nextActions": ["preview-review-again"],
                    "writeOccurred": False,
                }
            )
        if not execute:
            return services.receipt(
                {
                    "schema": "kungfu.work-review.receipt/v1",
                    "ok": False,
                    "status": "confirmation-required",
                    "planRoot": plan["planRoot"],
                    "message": "Explicit --execute confirmation is required.",
                    "workPhase": plan["work"]["phase"],
                    "nextActions": ["confirm-independent-review"],
                    "writeOccurred": False,
                }
            )
        if not plan["executable"]:
            return services.receipt(
                {
                    "schema": "kungfu.work-review.receipt/v1",
                    "ok": False,
                    "status": "not-executable",
                    "planRoot": plan["planRoot"],
                    "message": "Reviewer or native binding verification failed.",
                    "workPhase": plan["work"]["phase"],
                    "nextActions": ["repair-reviewer-verification"],
                    "writeOccurred": False,
                }
            )
        runtime = services.runtime(workspace_root, home, "read-only")
        identity, runtime_dir = runtime.identity, runtime.runtime_dir
        work_ref = assignment_review.review_work_ref(plan)
        retained = services.retained_evidence(runtime_dir, plan)
        if plan["reviewExecution"]["mode"] == "retained-evidence":
            if (
                retained is None
                or retained["report"]["reportRoot"]
                != plan["reviewExecution"]["reportRoot"]
            ):
                raise RuntimeError(
                    "retained reviewer evidence changed before settlement"
                )
            reviewer_report = retained["report"]
            assessment = retained["assessment"]
            event(
                "reuse",
                "completed",
                "Exact passing reviewer evidence restored; no Agent was rerun.",
                reviewer_report["reportRoot"],
            )
        else:
            if retained is not None:
                raise RuntimeError(
                    "passing reviewer evidence appeared; preview the resumable plan"
                )
            event(
                "run",
                "started",
                f"Fresh {plan['reviewer']['label']} reviewer started.",
            )

            def on_agent_activity(activity):
                event(
                    "run",
                    str(activity.get("phase") or "progress"),
                    str(activity.get("text") or "Reviewer activity"),
                    activity=activity,
                )

            reviewer_report = run_agent.execute(
                prompt=assignment_review.review_agent_prompt(plan),
                runtime_dir=runtime_dir,
                config_home=str(request.config_home),
                profile_id=plan["reviewer"]["id"],
                workspace_root=identity.workspace_root,
                home=str(request.runtime_home),
                work_ref=work_ref,
                continuation=assignment_review.review_continuation(plan),
                permission_mode="read-only",
                event_sink=on_agent_activity,
            )
            exit_code = int(reviewer_report["launch"]["exitCode"])
            if exit_code != 0:
                event(
                    "run",
                    "failed",
                    f"Reviewer process exited {exit_code}.",
                    reviewer_report["reportRoot"],
                )
                return services.receipt(
                    {
                        "schema": "kungfu.work-review.receipt/v1",
                        "ok": False,
                        "status": "reviewer-failed",
                        "planRoot": plan["planRoot"],
                        "message": f"Reviewer process exited {exit_code}.",
                        "workPhase": plan["work"]["phase"],
                        "reviewerReport": services.agent_report_summary(
                            reviewer_report
                        ),
                        "nextActions": ["inspect-reviewer-report", "retry-review"],
                        "writeOccurred": True,
                    }
                )
            assessment = assignment_review.parse_reviewer_result(
                reviewer_report, plan["work"]["acceptanceChecks"]
            )
            event(
                "assess",
                "completed" if assessment["verdict"] == "fit" else "failed",
                (
                    "Every acceptance criterion passed."
                    if assessment["verdict"] == "fit"
                    else "Reviewer found required revisions."
                ),
                reviewer_report["reportRoot"],
            )
        if assessment["verdict"] != "fit":
            return services.receipt(
                {
                    "schema": "kungfu.work-review.receipt/v1",
                    "ok": False,
                    "status": "revision-required",
                    "planRoot": plan["planRoot"],
                    "message": assessment["summary"],
                    "workPhase": plan["work"]["phase"],
                    "assessment": assessment,
                    "reviewerReport": services.agent_report_summary(reviewer_report),
                    "nextActions": ["revise-deliverable", "run-review-again"],
                    "writeOccurred": True,
                }
            )
        authority_receipts = {}
        current = services.status(runtime_dir, initiative_id, assignment_id)
        if current["phase"] == "executing":
            event(
                "lease",
                "started",
                "Minting a bounded lease for review settlement.",
            )
            lease_receipt = services.mint_lease(runtime_dir, plan, "local-user")
            authority_receipts["lease"] = lease_receipt
            current = services.status(runtime_dir, initiative_id, assignment_id)
            event(
                "lease",
                "completed",
                "Review settlement lease is active for two hours.",
                current["query_proof_root"],
            )
            event("stage", "started", "Recording the stage-ready boundary.")
            stage_receipt = services.advance(
                workspace_root,
                home,
                initiative_id,
                assignment_id,
                "stage-ready",
                "local-user",
                (
                    f"Independent reviewer {reviewer_report['reportRoot']} "
                    "passed every criterion"
                ),
            )
            authority_receipts["stage"] = stage_receipt
            current = stage_receipt["status"]
            event(
                "stage",
                "completed",
                "Work is stage-ready.",
                current["query_proof_root"],
            )
        if current["phase"] not in {"stage-ready", "completion-claimed"}:
            raise RuntimeError(
                f"review settlement cannot continue from {current['phase']}"
            )
        claim_values = services.completion_claim_values(
            plan, reviewer_report, assessment
        )
        if current["phase"] == "stage-ready":
            event("claim", "started", "Publishing the proof-bound completion claim.")
            claim_receipt = services.profile_action(
                runtime_dir, "claim-completion", claim_values, "local-user"
            )
            authority_receipts["claim"] = claim_receipt
            current = services.status(runtime_dir, initiative_id, assignment_id)
            event(
                "claim",
                "completed",
                "Completion claim recorded.",
                current["query_proof_root"],
            )
        if current["phase"] != "completion-claimed":
            raise RuntimeError(
                f"native independent review requires completion-claimed Work, got "
                f"{current['phase']}"
            )
        review_values = services.completion_review_values(plan, reviewer_report)
        event("review", "started", "Recording native independent review.")
        review_receipt = services.profile_action(
            runtime_dir,
            "review-completion",
            review_values,
            plan["reviewer"]["id"],
        )
        authority_receipts["review"] = review_receipt
        current = services.status(runtime_dir, initiative_id, assignment_id)
        native_review = review_receipt.get("review") or {}
        verdict = str(native_review.get("verdict") or "unknown")
        event(
            "review",
            "completed" if verdict == "fit" else "failed",
            f"Native independent review verdict: {verdict}.",
        )
        return services.receipt(
            {
                "schema": "kungfu.work-review.receipt/v1",
                "ok": verdict == "fit",
                "status": "review-passed"
                if verdict == "fit"
                else "review-needs-action",
                "planRoot": plan["planRoot"],
                "message": assessment["summary"],
                "workPhase": current["phase"],
                "assessment": assessment,
                "nativeVerdict": verdict,
                "reviewerReport": services.agent_report_summary(reviewer_report),
                "authorityReceipts": authority_receipts,
                "nextActions": (
                    ["decide-close-or-continue"]
                    if verdict == "fit"
                    else list(current["next_actions"])
                ),
                "writeOccurred": True,
            }
        )

    try:
        result = operation()
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        write_occurred = event_count() > 0
        event("review", "failed", str(error))
        try:
            current_phase = services.status(
                services.runtime(workspace_root, home, "read-only").runtime_dir,
                initiative_id,
                assignment_id,
            )["phase"]
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
            current_phase = "unknown"
        result = services.receipt(
            {
                "schema": "kungfu.work-review.receipt/v1",
                "ok": False,
                "status": "settlement-interrupted",
                "planRoot": expected_plan_root,
                "message": str(error),
                "workPhase": current_phase,
                "nextActions": [
                    "resume-review-settlement",
                    "inspect-current-work-status",
                ],
                "writeOccurred": write_occurred,
            }
        )
    return result
