# SPDX-License-Identifier: Apache-2.0

"""Exact native Work binding from already-authoritative recovery coordinates."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Mapping

from kungfu.agent import session_contract, session_surface


def _exact_binding_input(
    work_ref: Mapping[str, Any],
    session: Mapping[str, Any],
    binding_scope: str,
    source_workspace_id: str,
) -> tuple[dict[str, Any], dict[str, str]]:
    exact_work_ref = session_contract.validate_work_ref(dict(work_ref))
    exact_session = {
        "workConsoleId": str(session.get("workConsoleId") or ""),
        "sessionAttemptId": str(session.get("sessionAttemptId") or ""),
    }
    if not all(exact_session.values()):
        raise ValueError(
            "planned native Work binding requires exact Console identities"
        )
    if binding_scope not in {"same-project", "explicit-external-project"}:
        raise ValueError("planned native Work binding scope is invalid")
    if not source_workspace_id:
        raise ValueError("planned native Work binding requires a source workspace")
    if binding_scope == "same-project" and (
        source_workspace_id != exact_work_ref["workspaceId"]
    ):
        raise ValueError("planned same-project Work binding changed workspace identity")
    if binding_scope == "explicit-external-project" and (
        source_workspace_id == exact_work_ref["workspaceId"]
    ):
        raise ValueError("planned external Work binding did not change workspace")
    return exact_work_ref, exact_session


def bind_planned_native_work(
    console_runtime_dir: str | Path,
    *,
    work_ref: Mapping[str, Any],
    session: Mapping[str, Any],
    binding_scope: str,
    source_workspace_id: str,
    actor_id: str | None = None,
) -> dict[str, Any]:
    """Bind exact planned coordinates without rediscovering Work authority."""

    exact_work_ref, exact_session = _exact_binding_input(
        work_ref, session, binding_scope, source_workspace_id
    )
    endpoint = session_surface.endpoint_for_runtime(
        str(Path(console_runtime_dir).expanduser().resolve())
    )
    exact_actor = actor_id or os.environ.get(
        "KUNGFU_AGENT_SESSION_ACTOR", f"cli:{os.getpid()}"
    )
    plan = session_surface.invoke(
        {
            "operation": "plan-native-bind-work",
            "client": "kfd3-agent",
            "actorId": exact_actor,
            "input": {
                "session": exact_session,
                "workRef": exact_work_ref,
                "bindingScope": binding_scope,
                "sourceWorkspaceId": source_workspace_id,
            },
        },
        endpoint=endpoint,
    )
    receipt = session_surface.invoke(
        {
            "operation": "bind-native-work",
            "client": "kfd3-agent",
            "actorId": exact_actor,
            "plan": plan,
            "expectedPlanRoot": plan["root"],
        },
        endpoint=endpoint,
    )
    return {"workRef": exact_work_ref, "session": exact_session, "receipt": receipt}
