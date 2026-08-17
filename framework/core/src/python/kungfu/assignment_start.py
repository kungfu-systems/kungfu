# SPDX-License-Identifier: Apache-2.0

"""Owned start and resume execution service for native Assignment lifecycle."""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Protocol

from kungfu import assignment_lifecycle as bound_session
from kungfu.assignment_lifecycle.ports import (
    AssignmentAdvancePort,
    AssignmentEventSink,
)
from kungfu.agent import run_agent
from kungfu.workspace import resolve_workspace_target

JsonObject = dict[str, Any]
claim = bound_session.claim


class StartPlanPort(Protocol):
    def __call__(
        self,
        *,
        config_home: str | Path,
        runtime_home: str | Path,
        request_file: Path,
        workspace_root: str | None,
        home: bool,
        initiative_id: str,
        assignment_id: str,
        profile_id: str,
        actor: str,
        allow_foreign_binding: bool,
    ) -> JsonObject: ...


class AssignmentAdmissionPort(Protocol):
    def __call__(
        self,
        *,
        request_file: Path,
        workspace_root: str | None,
        home: bool,
        initiative_id: str,
        assignment_id: str,
        initiative_admission: str | None,
        actor: str,
        actor_type: str,
        allow_foreign_binding: bool,
    ) -> JsonObject: ...


@dataclass(frozen=True)
class StartRequest:
    config_home: str | Path
    runtime_home: str | Path
    request_file: Path
    workspace_root: str | None
    home: bool
    initiative_id: str
    assignment_id: str
    profile_id: str
    actor: str
    expected_plan_root: str
    execute: bool
    allow_foreign_binding: bool


@dataclass(frozen=True)
class StartServices:
    """Typed application ports supplied by the CLI composition root."""

    plan: StartPlanPort
    receipt: Callable[[JsonObject], JsonObject]
    status: Callable[[str, str, str], JsonObject]
    admit: AssignmentAdmissionPort
    admission_summary: Callable[[JsonObject, JsonObject], JsonObject]
    profile_action: Callable[[str, str, JsonObject, str], JsonObject]
    claim_summary: Callable[[JsonObject, JsonObject], JsonObject]
    advance_bound: AssignmentAdvancePort
    kickoff_summary: Callable[[JsonObject], JsonObject]
    project_prompt: Callable[[JsonObject], str]
    agent_report_summary: Callable[[JsonObject], JsonObject]


def execute(
    request: StartRequest, services: StartServices, event: AssignmentEventSink
) -> JsonObject:
    """Execute one exact start plan while retaining every authority receipt."""

    request_file = request.request_file
    workspace_root = request.workspace_root
    home = request.home
    initiative_id = request.initiative_id
    assignment_id = request.assignment_id
    profile_id = request.profile_id
    actor = request.actor
    expected_plan_root = request.expected_plan_root
    execute = request.execute
    allow_foreign_binding = request.allow_foreign_binding
    stage = "plan"
    write_occurred = False
    last_status = None
    plan = services.plan(
        config_home=request.config_home,
        runtime_home=request.runtime_home,
        request_file=request_file,
        workspace_root=workspace_root,
        home=home,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        profile_id=profile_id,
        actor=actor,
        allow_foreign_binding=allow_foreign_binding,
    )
    if expected_plan_root != plan["planRoot"]:
        return services.receipt(
            {
                "schema": "kungfu.work-start.receipt/v1",
                "ok": False,
                "status": "plan-drift",
                "planRoot": plan["planRoot"],
                "expectedPlanRoot": expected_plan_root,
                "failedAt": stage,
                "message": "Work start plan changed; preview and confirm again",
                "workPhase": "captured",
                "nextActions": ["preview-work-start-again"],
                "writeOccurred": False,
            }
        )
    if not execute:
        return services.receipt(
            {
                "schema": "kungfu.work-start.receipt/v1",
                "ok": False,
                "status": "confirmation-required",
                "planRoot": plan["planRoot"],
                "failedAt": stage,
                "message": "Work start requires --execute after plan confirmation",
                "workPhase": "captured",
                "nextActions": ["confirm-work-start"],
                "writeOccurred": False,
            }
        )
    if not plan["executable"]:
        return services.receipt(
            {
                "schema": "kungfu.work-start.receipt/v1",
                "ok": False,
                "status": "not-executable",
                "planRoot": plan["planRoot"],
                "failedAt": stage,
                "message": plan["blockedReason"]
                or "Agent or native admission binding did not verify",
                "workPhase": plan["work"]["phase"],
                "nextActions": [
                    "inspect-current-work-status",
                    "preview-work-start-again",
                ],
                "writeOccurred": False,
            }
        )
    receipts = {}
    try:
        event(
            "plan",
            "completed",
            "Exact Work start plan verified.",
            plan["planRoot"],
        )
        continuation_mode = plan["continuationMode"]
        if continuation_mode != "first-attempt":
            stage = "resume"
            target = resolve_workspace_target(
                "read-only",
                workspace_root or None,
                home=home,
                cwd=os.getcwd(),
            )
            runtime_dir = str(target.runtime_dir)
            last_status = services.status(
                runtime_dir,
                plan["work"]["initiativeId"],
                plan["work"]["assignmentId"],
            )
            admission = {
                "workspace": {
                    "workspace_id": plan["workspace"]["id"],
                    "workspace_root": plan["workspace"]["root"],
                    "runtime_dir": runtime_dir,
                }
            }
            event(
                stage,
                "completed",
                f"Resuming Work from its {last_status['phase']} phase.",
                last_status["query_proof_root"],
            )
        else:
            stage = "admit"
            event(stage, "started", "Admitting captured Work into native authority.")
            admission = services.admit(
                request_file=request_file,
                workspace_root=workspace_root,
                home=home,
                initiative_id=plan["work"]["initiativeId"],
                assignment_id=plan["work"]["assignmentId"],
                initiative_admission=None,
                actor=actor,
                actor_type="user",
                allow_foreign_binding=allow_foreign_binding,
            )
            if admission["ok"] is not True:
                raise RuntimeError("captured Work admission did not qualify")
            write_occurred = True
            runtime_dir = admission["workspace"]["runtime_dir"]
            last_status = services.status(
                runtime_dir,
                plan["work"]["initiativeId"],
                plan["work"]["assignmentId"],
            )
            receipts["admission"] = services.admission_summary(admission, last_status)
            event(
                stage,
                "completed",
                "Initiative and Assignment admitted.",
                last_status["query_proof_root"],
            )

        if continuation_mode in {
            "first-attempt",
            "existing-admitted-work",
        }:
            stage = "claim"
            event(stage, "started", "Minting a bounded Agent execution lease.")
            lease_id = f"work-start-{uuid.uuid4().hex}"
            lease_expires_at = (
                (datetime.now(UTC) + timedelta(hours=2))
                .isoformat()
                .replace("+00:00", "Z")
            )
            claim_receipt = services.profile_action(
                runtime_dir,
                "claim-assignment",
                {
                    "initiativeId": plan["work"]["initiativeId"],
                    "assignmentId": plan["work"]["assignmentId"],
                    "owner": actor,
                    "agent": plan["agent"]["id"],
                    "slot": f"project-{plan['agent']['provider']}",
                    "leaseId": lease_id,
                    "leaseExpiresAt": lease_expires_at,
                    "authorizedBy": actor,
                    "grantScope": "assignment-execution",
                    "actorType": "user",
                    "source": "kungfu",
                },
                actor,
            )
            write_occurred = True
            last_status = services.status(
                runtime_dir,
                plan["work"]["initiativeId"],
                plan["work"]["assignmentId"],
            )
            receipts["claim"] = services.claim_summary(claim_receipt, last_status)
            event(
                stage,
                "completed",
                f"Execution lease bound to {plan['agent']['label']}.",
                last_status["query_proof_root"],
            )

        if last_status is None:
            raise RuntimeError("Assignment status unavailable before Session start")
        needs_kickoff = bound_session.requires_kickoff(continuation_mode)
        work_ref = bound_session.work_ref(admission, plan, last_status)
        if needs_kickoff:
            stage = "kickoff"
            event(
                stage,
                "started",
                "Starting an Agent Session with an optional observation of this Work.",
                work_ref["entityRoot"],
            )
        else:
            bound_session.require_run_gate(last_status)

        invoke_session = bound_session.session_invoker(
            run_agent.session_surface,
            runtime_dir,
            event_driven=plan["agent"]["provider"] == "synthetic",
        )

        def on_session_started(_session_ref, _started):
            nonlocal last_status, write_occurred, stage
            if needs_kickoff:
                stage = "kickoff"
                kickoff_receipt, last_status = bound_session.kickoff(
                    services.advance_bound,
                    workspace_root,
                    home,
                    plan,
                    actor,
                )
                write_occurred = True
                receipts["kickoff"] = services.kickoff_summary(kickoff_receipt)
                bound_session.require_run_gate(last_status)
                event(
                    stage,
                    "completed",
                    "Work execution admitted; Agent Session observes the current Work.",
                    last_status["query_proof_root"],
                )
            stage = "run"
            bound_session.emit_run_start(event, plan["agent"]["label"], work_ref)

        stage = "run"

        def on_agent_activity(activity):
            event(
                stage,
                str(activity.get("phase") or "progress"),
                str(activity.get("text") or "Agent activity"),
                activity=activity,
            )

        agent_report = run_agent.execute(
            prompt=services.project_prompt(plan),
            runtime_dir=runtime_dir,
            config_home=str(request.config_home),
            profile_id=plan["agent"]["id"],
            workspace_root=admission["workspace"]["workspace_root"],
            home=str(request.runtime_home),
            work_ref=work_ref,
            event_sink=on_agent_activity,
            session_invoker=invoke_session,
            use_session=True,
            session_started_callback=on_session_started,
            project_trust=plan["agent"].get("projectTrust"),
        )
        exit_code = int(agent_report["launch"]["exitCode"])
        session_value = agent_report.get("session") or {}
        session_live = session_value.get("live") is True
        event(
            stage,
            "waiting" if session_live else "completed" if exit_code == 0 else "failed",
            (
                "Agent Session needs your attention; Work remains executing."
                if session_live
                else "Agent process finished; independent assessment is still required."
                if exit_code == 0
                else f"Agent process exited {exit_code}; Work remains executing."
            ),
            agent_report["reportRoot"],
        )
        body = {
            "schema": "kungfu.work-start.receipt/v1",
            "ok": exit_code == 0,
            "status": (
                "agent-waiting"
                if session_live
                else "agent-finished"
                if exit_code == 0
                else "agent-failed"
            ),
            "planRoot": plan["planRoot"],
            "workPhase": last_status["phase"],
            "workspace": admission["workspace"],
            "workRef": work_ref,
            "work": plan["work"],
            "agent": plan["agent"],
            "agentReport": services.agent_report_summary(agent_report),
            "authorityReceipts": receipts,
            "nextActions": (
                list(
                    ((session_value.get("workAgent") or {}).get("attention") or {}).get(
                        "nextActions"
                    )
                    or ["inspect-agent-session"]
                )
                if session_live
                else [
                    "review-project-changes",
                    "run-independent-assessment",
                    "claim-completion-only-with-evidence",
                ]
                if exit_code == 0
                else [
                    "inspect-retained-agent-report",
                    "repair-agent-runtime-or-project",
                    "inspect-current-work-status",
                ]
            ),
            "nonClaims": [
                "Agent process exit does not complete the Assignment.",
                "The executing Agent does not independently assess its own result.",
                "No Git commit, push, or publication was attempted.",
            ],
            "writeOccurred": True,
        }
        if exit_code != 0:
            body["failedAt"] = "run"
            body["message"] = (
                f"Agent process exited {exit_code}; inspect retained report "
                f"{agent_report['reportRoot']} before recovery."
            )
        return services.receipt(body)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        phase = (
            str(last_status.get("phase") or "captured")
            if isinstance(last_status, dict)
            else "captured"
        )
        event(stage, "failed", str(error))
        return services.receipt(
            {
                "schema": "kungfu.work-start.receipt/v1",
                "ok": False,
                "status": "failed",
                "planRoot": plan["planRoot"],
                "failedAt": stage,
                "message": str(error),
                "workPhase": phase,
                "authorityReceipts": receipts,
                "nextActions": [
                    "inspect-current-work-status",
                    "repair-the-failed-stage",
                    "do-not-repeat-completed-authority-effects",
                ],
                "writeOccurred": write_occurred,
            }
        )
