# SPDX-License-Identifier: Apache-2.0

"""Bind an exact native Agent Console attempt to Assignment Work."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
from typing import Any, Callable, Mapping

from kungfu.agent import resources as agent_resources
from kungfu.agent import session_contract
from kungfu.agent import session_surface
from kungfu.initiative_family import canonical as assignment_canonical
from kungfu.workspace import resolve_workspace_target


_ROOT = re.compile(r"sha256:[0-9a-f]{64}\Z")


def _verified_prompt_process(
    envelope: Mapping[str, Any],
    bootstrap_receipt: Mapping[str, Any],
) -> tuple[dict[str, Any], str, dict[str, Any], str]:
    session = {
        "workConsoleId": str(envelope["consoleId"]),
        "sessionAttemptId": str(envelope["attemptId"]),
    }
    actor_id = os.environ.get("KUNGFU_AGENT_SESSION_ACTOR", f"cli:{os.getpid()}")
    process_identity = {
        "attemptId": session["sessionAttemptId"],
        "bootstrapReceiptRoot": str(bootstrap_receipt["receiptRoot"]),
        "provider": str(envelope.get("provider") or "unknown"),
        "workspaceId": str(envelope["workspaceId"]),
    }
    runtime_profile_root = str(
        os.environ.get("KUNGFU_AGENT_RUNTIME_PROFILE_ROOT") or ""
    )
    if _ROOT.fullmatch(runtime_profile_root) is None:
        raise ValueError(
            "verified prompt Agent is missing its exact Runtime Profile root"
        )
    return session, actor_id, process_identity, runtime_profile_root


def _prompt_native_start_plan(
    invoke: Callable[[Mapping[str, Any]], Mapping[str, Any]],
    envelope: Mapping[str, Any],
    bootstrap_receipt: Mapping[str, Any],
    session: Mapping[str, Any],
    actor_id: str,
    runtime_profile_root: str,
) -> Mapping[str, Any]:
    start_input = {
        "workspaceId": str(envelope["workspaceId"]),
        **session,
        "provider": str(envelope.get("provider") or "unknown"),
        "providerVersion": str(
            os.environ.get("KUNGFU_AGENT_PROVIDER_VERSION") or "unknown"
        ),
        "profileRoot": runtime_profile_root,
        "runtimeProfileId": str(envelope.get("runtimeProfileId") or "unknown"),
        "bootstrap": agent_resources.bootstrap_context(bootstrap_receipt),
        "binding": {"kind": "workspace-assistant", "workRef": None},
    }
    return invoke(
        {
            "operation": "plan-native-start",
            "client": "kfd3-agent",
            "actorId": actor_id,
            "input": start_input,
        }
    )


def _start_and_observe_prompt_console(
    invoke: Callable[[Mapping[str, Any]], Mapping[str, Any]],
    plan: Mapping[str, Any],
    session: Mapping[str, Any],
    actor_id: str,
    process_identity: Mapping[str, Any],
) -> None:
    invoke(
        {
            "operation": "start-native",
            "client": "kfd3-agent",
            "actorId": actor_id,
            "plan": dict(plan),
            "expectedPlanRoot": plan["root"],
            "processIdentity": process_identity,
        }
    )
    invoke(
        {
            "operation": "heartbeat-native",
            "client": "kfd3-agent",
            "actorId": actor_id,
            "session": session,
            "processIdentity": process_identity,
            "observation": {
                "schema": "kungfu.attempt-heartbeat/v1",
                "state": "fresh",
                "staleAfterMs": 10000,
                "workRefRoot": None,
                "diagnostic": "verified-prompt-process-adoption",
            },
        }
    )


def _adopt_verified_injected_console(
    invoke: Callable[[Mapping[str, Any]], Mapping[str, Any]],
    envelope: Mapping[str, Any],
    bootstrap_receipt: Mapping[str, Any],
) -> None:
    """Register one verified prompt-launched process before its first Work bind."""

    session, actor_id, process_identity, profile_root = _verified_prompt_process(
        envelope, bootstrap_receipt
    )
    plan = _prompt_native_start_plan(
        invoke,
        envelope,
        bootstrap_receipt,
        session,
        actor_id,
        profile_root,
    )
    _start_and_observe_prompt_console(invoke, plan, session, actor_id, process_identity)


def _verified_injected_bootstrap(
    envelope: Mapping[str, Any], project_runtime_dir: str, injected: bool
) -> Mapping[str, Any] | None:
    if not injected:
        return None
    injected_runtime_dir = os.environ.get("KUNGFU_AGENT_RUNTIME_DIR", "").strip()
    if not injected_runtime_dir:
        raise ValueError(
            "native Agent Console is missing its stable Kungfu Project runtime"
        )
    if Path(injected_runtime_dir).expanduser().resolve() != Path(project_runtime_dir):
        raise ValueError(
            "native Agent Console runtime does not match its Kungfu Project"
        )
    return agent_resources.validated_current_bootstrap_receipt(envelope)


def _native_work_bind_plan(
    invoke: Callable[[Mapping[str, Any]], Mapping[str, Any]],
    *,
    actor_id: str,
    session: Mapping[str, Any],
    work_ref: Mapping[str, Any],
    binding_scope: str,
    source_workspace_id: str,
    envelope: Mapping[str, Any],
    bootstrap_receipt: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    request = {
        "operation": "plan-native-bind-work",
        "client": "kfd3-agent",
        "actorId": actor_id,
        "input": {
            "session": session,
            "workRef": work_ref,
            "bindingScope": binding_scope,
            "sourceWorkspaceId": source_workspace_id,
        },
    }
    try:
        return invoke(request)
    except ValueError as error:
        if bootstrap_receipt is None or "session_not_found" not in str(error):
            raise
        _adopt_verified_injected_console(invoke, envelope, bootstrap_receipt)
        return invoke(request)


def _console_project_context(
    envelope: Mapping[str, Any],
    *,
    injected: bool,
    console_workspace_root: str | None,
) -> tuple[str, str, Mapping[str, Any] | None]:
    workspace_root = (
        os.environ.get("KUNGFU_WORKSPACE_ROOT", "").strip()
        if injected
        else str(console_workspace_root or "").strip()
    )
    if not workspace_root:
        raise ValueError(
            "native Agent Console is missing its Kungfu Project workspace root"
        )
    target = resolve_workspace_target("read-only", workspace_root, cwd=workspace_root)
    if (
        target.identity.workspace_kind != "project"
        or target.identity.workspace_id != str(envelope.get("workspaceId") or "")
    ):
        raise ValueError(
            "native Agent Console workspace does not match its Kungfu Project"
        )
    project_runtime_dir = str(Path(target.runtime_dir).expanduser().resolve())
    receipt = _verified_injected_bootstrap(envelope, project_runtime_dir, injected)
    return workspace_root, project_runtime_dir, receipt


def _work_binding_target(
    envelope: Mapping[str, Any],
    project_runtime_dir: str,
    work_workspace_root: str | None,
) -> tuple[str, str, str]:
    if not work_workspace_root:
        return project_runtime_dir, str(envelope["workspaceId"]), "same-project"
    target = resolve_workspace_target(
        "read-only", work_workspace_root, cwd=work_workspace_root
    )
    if target.identity.workspace_kind != "project":
        raise ValueError("native Work binding requires an exact Project workspace")
    workspace_id = target.identity.workspace_id
    scope = (
        "same-project"
        if workspace_id == str(envelope["workspaceId"])
        else "explicit-external-project"
    )
    return str(Path(target.runtime_dir).expanduser().resolve()), workspace_id, scope


def _exact_assignment_work_ref(
    runtime_dir: str,
    workspace_id: str,
    initiative_id: str,
    assignment_id: str,
    profile_source: str | Path | None,
) -> dict[str, Any]:
    from kungfu.cli.commands import assignment as work_commands

    status = work_commands._status(runtime_dir, initiative_id, assignment_id)
    profile = work_commands.profile_lifecycle.resolve_qualified_work_profile(
        runtime_dir, source=profile_source
    )
    work_ref = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": workspace_id,
        "profileId": profile["id"],
        "profileRoot": profile["root"],
        "entityType": "assignment",
        "entityId": assignment_id,
        "entityRoot": assignment_canonical.semantic_root(status["assignment"]),
        "purpose": "continue-project-assignment",
        "systemTimeCut": status["query_proof_root"],
        "initiativeId": initiative_id,
    }
    return session_contract.validate_work_ref(work_ref)


def _apply_native_work_binding(
    *,
    envelope: Mapping[str, Any],
    work_ref: Mapping[str, Any],
    session: Mapping[str, Any],
    binding_scope: str,
    workspace_root: str,
    project_runtime_dir: str,
    bootstrap_receipt: Mapping[str, Any] | None,
) -> dict[str, Any]:
    actor_id = os.environ.get("KUNGFU_AGENT_SESSION_ACTOR", f"cli:{os.getpid()}")

    def invoke(request):
        return session_surface.invoke_for_project(
            request, fallback_runtime_dir=project_runtime_dir, cwd=workspace_root
        )

    plan = _native_work_bind_plan(
        invoke,
        actor_id=actor_id,
        session=session,
        work_ref=work_ref,
        binding_scope=binding_scope,
        source_workspace_id=str(envelope["workspaceId"]),
        envelope=envelope,
        bootstrap_receipt=bootstrap_receipt,
    )
    receipt = invoke(
        {
            "operation": "bind-native-work",
            "client": "kfd3-agent",
            "actorId": actor_id,
            "plan": plan,
            "expectedPlanRoot": plan["root"],
        }
    )
    return {"workRef": dict(work_ref), "session": dict(session), "receipt": receipt}


def _bind_verified_console_work(
    envelope: Mapping[str, Any],
    *,
    injected: bool,
    initiative_id: str,
    assignment_id: str,
    work_workspace_root: str | None,
    work_profile_source: str | Path | None,
    console_workspace_root: str | None,
    expected_binding: Mapping[str, Any] | None,
) -> dict[str, Any]:
    workspace_root, project_runtime, bootstrap = _console_project_context(
        envelope,
        injected=injected,
        console_workspace_root=console_workspace_root,
    )
    work_runtime, work_workspace_id, binding_scope = _work_binding_target(
        envelope, project_runtime, work_workspace_root
    )
    work_ref = _exact_assignment_work_ref(
        work_runtime,
        work_workspace_id,
        initiative_id,
        assignment_id,
        work_profile_source,
    )
    session = {
        "workConsoleId": str(envelope["consoleId"]),
        "sessionAttemptId": str(envelope["attemptId"]),
    }
    session_contract.require_expected_binding(expected_binding, work_ref, session)
    return _apply_native_work_binding(
        envelope=envelope,
        work_ref=work_ref,
        session=session,
        binding_scope=binding_scope,
        workspace_root=workspace_root,
        project_runtime_dir=project_runtime,
        bootstrap_receipt=bootstrap,
    )


def bind_current_native_work(
    runtime_dir: str,
    initiative_id: str,
    assignment_id: str,
    *,
    work_workspace_root: str | None = None,
    work_profile_source: str | Path | None = None,
    envelope_override: Mapping[str, Any] | None = None,
    console_workspace_root: str | None = None,
    expected_binding: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Atomically bind the current native attempt before it acts on Work."""

    raw = os.environ.get("KUNGFU_AGENT_CONSOLE_ENVELOPE", "").strip()
    if not raw and envelope_override is None:
        return None
    injected = envelope_override is None
    envelope = (
        json.loads(raw)
        if injected
        else session_contract.validate_agent_console_envelope(
            dict(envelope_override or {})
        )
    )
    return _bind_verified_console_work(
        envelope,
        injected=injected,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        work_workspace_root=work_workspace_root,
        work_profile_source=work_profile_source,
        console_workspace_root=console_workspace_root,
        expected_binding=expected_binding,
    )
