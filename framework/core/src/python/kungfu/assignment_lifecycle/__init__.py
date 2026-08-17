# SPDX-License-Identifier: Apache-2.0

"""Owned helpers and contracts for native Assignment lifecycle services."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from kungfu import assignment_orchestration as orchestration
from kungfu.assignment_lifecycle.ports import AssignmentAdvancePort, JsonObject


def claim(
    *,
    workspace_root: str | None,
    home: bool,
    initiative_id: str,
    assignment_id: str,
    owner: str,
    agent: str,
    slot: str,
    lease_id: str,
    lease_expires_at: str,
    authorized_by: str,
    grant_scope: str,
    actor_type: str,
    runtime: Callable[..., tuple[Any, str, JsonObject]],
    ensure_profile: Callable[..., Any],
    profile_action: Callable[..., JsonObject],
    status: Callable[..., JsonObject],
) -> JsonObject:
    """Claim Work without consulting any Agent Session implementation state."""
    _, runtime_dir, _ = runtime(workspace_root, home)
    ensure_profile(runtime_dir, authorized_by)
    receipt = profile_action(
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
    return {
        **receipt,
        "status": status(runtime_dir, initiative_id, assignment_id),
    }


def work_ref(
    admission: Mapping[str, Any],
    plan: Mapping[str, Any],
    status: Mapping[str, Any],
) -> dict[str, Any]:
    """Build an optional Agent Session observation of an admitted Assignment."""
    return {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": admission["workspace"]["workspace_id"],
        "profileId": plan["workControl"]["profileId"],
        "profileRoot": plan["workControl"]["profileRoot"],
        "entityType": "assignment",
        "entityId": plan["work"]["assignmentId"],
        "initiativeId": plan["work"]["initiativeId"],
        "entityRoot": orchestration.semantic_root(status["assignment"]),
        "purpose": "complete-project-assignment",
        "systemTimeCut": status["query_proof_root"],
    }


def kickoff(
    advance_bound: AssignmentAdvancePort,
    workspace_root: str | None,
    home: bool,
    plan: Mapping[str, Any],
    actor: str,
) -> tuple[JsonObject, JsonObject]:
    """Advance Work under its own active execution lease."""
    receipt = advance_bound(
        workspace_root,
        home,
        plan["work"]["initiativeId"],
        plan["work"]["assignmentId"],
        "executing",
        actor,
        "Start the user-selected verified Agent for this Assignment",
    )
    return receipt, receipt["status"]


def require_run_gate(status: Mapping[str, Any]) -> None:
    """Fail before instruction delivery unless native Work permits execution."""
    run_gate = orchestration.gate(status, "run")
    if run_gate["ok"] is not True:
        raise RuntimeError(run_gate["reason"])


def requires_kickoff(continuation_mode: str) -> bool:
    """Return whether this delivery workflow still needs to advance Work."""
    return continuation_mode in {
        "first-attempt",
        "existing-admitted-work",
        "existing-claimed-work",
    }


def session_invoker(
    surface: Any, runtime_dir: str, *, event_driven: bool = False
) -> Callable[..., Mapping[str, Any]]:
    """Bind all Session operations to one runtime-scoped native endpoint."""
    endpoint = (
        surface.ensure(runtime_dir, timeout=None)
        if event_driven
        else surface.ensure(runtime_dir)
    )

    def invoke(request: Mapping[str, Any]) -> Mapping[str, Any]:
        # A structured provider may need a cold network round trip before it
        # acknowledges start or control admission.  The request remains
        # bounded, but must not inherit the five-second read probe used by
        # status/capability calls: timing out the caller does not cancel the
        # provider side effect and would split the retained Work receipt from
        # the live SessionAttempt.
        operation = str(request.get("operation") or "")
        timeout = (
            None
            if event_driven or operation == "wait-status-change"
            else 30.0
            if operation
            in {
                "start",
                "acquire-control",
                "release-control",
                "instruct",
                "send-key",
                "interrupt",
                "respond-control",
                "end",
            }
            else 5.0
        )
        return surface.invoke(request, endpoint=endpoint, timeout=timeout)

    return invoke


def emit_run_start(
    event: Callable[..., None], label: str, ref: Mapping[str, Any]
) -> None:
    """Publish the observable boundary after Work authority admits the Session."""
    event("run", "started", f"Launching fresh {label} process.", ref["entityRoot"])
