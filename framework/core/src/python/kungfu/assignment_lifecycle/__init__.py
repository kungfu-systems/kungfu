# SPDX-License-Identifier: Apache-2.0

"""Owned helpers and contracts for native Assignment lifecycle services."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from kungfu import assignment_orchestration as orchestration
from kungfu.assignment_lifecycle.ports import AssignmentAdvancePort, JsonObject


def work_ref(
    admission: Mapping[str, Any],
    plan: Mapping[str, Any],
    status: Mapping[str, Any],
) -> dict[str, Any]:
    """Bind a SessionAttempt to the exact admitted Assignment observation."""
    return {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": admission["workspace"]["workspace_id"],
        "profileId": plan["workControl"]["profileId"],
        "profileRoot": plan["workControl"]["profileRoot"],
        "entityType": "assignment",
        "entityId": plan["work"]["assignmentId"],
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
    """Enter execution only after the exact Work-bound SessionAttempt exists."""
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
    """Return whether the new SessionAttempt must advance Work to execution."""
    return continuation_mode in {
        "first-attempt",
        "existing-admitted-work",
        "existing-claimed-work",
    }


def session_invoker(surface: Any, runtime_dir: str) -> Callable[..., Mapping[str, Any]]:
    """Bind all Session operations to one runtime-scoped native endpoint."""
    endpoint = surface.ensure(runtime_dir)
    return lambda request: surface.invoke(request, endpoint=endpoint)


def emit_run_start(
    event: Callable[..., None], label: str, ref: Mapping[str, Any]
) -> None:
    """Publish the observable boundary after Work authority admits the Session."""
    event("run", "started", f"Launching fresh {label} process.", ref["entityRoot"])
