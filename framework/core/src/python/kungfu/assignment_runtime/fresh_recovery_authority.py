# SPDX-License-Identifier: Apache-2.0

"""Plan-time discovery and apply-time verification for fresh recovery."""

from __future__ import annotations

from collections.abc import Mapping
import json
from pathlib import Path
from typing import Any

from kungfu import assignment_orchestration, profile_sdk, work_authority
from kungfu.agent import session_surface
from kungfu.assignment_runtime import LocalAssignmentRuntimeApplication

JsonObject = dict[str, Any]


def _text(value: Any, default: Any = "") -> str:
    return str(value if value is not None and value != "" else default)


def _planned_profile(recovery_profile: Mapping[str, Any]) -> JsonObject:
    return {
        "schema": work_authority.PLANNED_PROFILE_SOURCE_SCHEMA,
        "profileId": _text(recovery_profile.get("profileId")),
        "profileRoot": _text(recovery_profile.get("profileRoot")),
        "sourceContractRoot": _text(recovery_profile.get("sourceContractRoot")),
        "sourceLocator": _text(recovery_profile.get("sourceLocator")),
    }


def _planned_target(
    workspace: Mapping[str, Any], work_ref: Mapping[str, Any]
) -> JsonObject:
    return {
        "schema": work_authority.PLANNED_TARGET_SCHEMA,
        "workspace": dict(workspace),
        "workRef": dict(work_ref),
    }


def _planned_console(
    workspace: Mapping[str, Any], binding: Mapping[str, Any]
) -> JsonObject:
    session = dict(binding.get("session", {}))
    console = dict(binding.get("console", {}))
    console_runtime = _text(console.get("consoleRuntimeRoot"), workspace["runtimeRoot"])
    return {
        "schema": work_authority.PLANNED_CONSOLE_BINDING_SCHEMA,
        "workConsoleId": _text(session.get("workConsoleId")),
        "sessionAttemptId": _text(session.get("sessionAttemptId")),
        "sourceWorkspaceId": _text(
            console.get("sourceWorkspaceId"), workspace.get("id")
        ),
        "consoleRuntimeRoot": console_runtime,
        "consoleEndpoint": _text(
            console.get("consoleEndpoint"),
            session_surface.endpoint_for_runtime(console_runtime),
        ),
        "bindingScope": _text(console.get("bindingScope"), "same-project"),
    }


def planned_roles(
    workspace: Mapping[str, Any],
    work_ref: Mapping[str, Any],
    recovery_profile: Mapping[str, Any],
    binding: Mapping[str, Any],
) -> tuple[JsonObject, JsonObject, JsonObject]:
    workspace_value = dict(workspace)
    workspace_root = Path(_text(workspace_value.get("root"))).expanduser()
    workspace_value.setdefault(
        "runtimeRoot", str((workspace_root / ".kungfu" / "runtime").resolve())
    )
    profile_body = _planned_profile(recovery_profile)
    target_body = _planned_target(workspace_value, work_ref)
    console_body = _planned_console(workspace_value, binding)
    return (
        work_authority.rooted(profile_body, "sourceRoot"),
        work_authority.rooted(target_body, "targetRoot"),
        work_authority.rooted(console_body, "bindingRoot"),
    )


def _require_checks(checks: tuple[bool, ...]) -> None:
    if not all(checks):
        raise ValueError("fresh recovery planned authority roles do not agree")


def _verify_assignment_role(
    retained: Mapping[str, Any], work: Mapping[str, Any]
) -> None:
    _require_checks(
        (
            retained.get("schema")
            == work_authority.RETAINED_ASSIGNMENT_AUTHORITY_SCHEMA,
            retained == work_authority.retained_assignment_authority(retained),
            work_authority.semantic_root(retained) == work.get("lifecycleStateRoot"),
            work_authority.semantic_root(retained.get("assignment", {}))
            == work.get("assignmentRoot"),
        )
    )


def _verify_profile_role(profile: Mapping[str, Any], plan: Mapping[str, Any]) -> None:
    _require_checks(
        (
            profile == plan.get("recoveryProfile"),
            profile.get("profileId") == "kungfu.work-control",
            profile.get("profileRoot") == plan.get("workRef", {}).get("profileRoot"),
            bool(_text(profile.get("sourceLocator"))),
            _text(profile.get("sourceContractRoot")).startswith("sha256:"),
        )
    )


def _verify_target_role(
    target: Mapping[str, Any], plan: Mapping[str, Any], work_ref: Mapping[str, Any]
) -> None:
    _require_checks(
        (
            target.get("workspace") == plan.get("workspace"),
            target.get("workRef") == plan.get("workRef"),
            work_ref.get("workspaceId") == target.get("workspace", {}).get("id"),
        )
    )


def _console_source_matches(
    console: Mapping[str, Any], work_ref: Mapping[str, Any]
) -> bool:
    same_project = console.get("bindingScope") == "same-project"
    source_workspace = console.get("sourceWorkspaceId")
    work_workspace = work_ref.get("workspaceId")
    return (
        source_workspace == work_workspace
        if same_project
        else source_workspace != work_workspace
    )


def _verify_console_role(
    console: Mapping[str, Any], plan: Mapping[str, Any], work_ref: Mapping[str, Any]
) -> None:
    attempt = plan.get("attempt", {})
    _require_checks(
        (
            console.get("workConsoleId") == attempt.get("workConsoleId"),
            console.get("sessionAttemptId") == attempt.get("newSessionAttemptId"),
            console.get("consoleEndpoint")
            == session_surface.endpoint_for_runtime(
                _text(console.get("consoleRuntimeRoot"))
            ),
            console.get("bindingScope")
            in {"same-project", "explicit-external-project"},
            _console_source_matches(console, work_ref),
        )
    )


def verify_planned_roles(plan: Mapping[str, Any]) -> None:
    retained = dict(plan.get("retainedAssignmentAuthority", {}))
    profile = work_authority.verify_rooted(
        plan.get("plannedProfileSource", {}),
        schema=work_authority.PLANNED_PROFILE_SOURCE_SCHEMA,
        root_field="sourceRoot",
        label="fresh recovery planned Profile source",
    )
    target = work_authority.verify_rooted(
        plan.get("plannedTarget", {}),
        schema=work_authority.PLANNED_TARGET_SCHEMA,
        root_field="targetRoot",
        label="fresh recovery planned target",
    )
    console = work_authority.verify_rooted(
        plan.get("plannedConsoleBinding", {}),
        schema=work_authority.PLANNED_CONSOLE_BINDING_SCHEMA,
        root_field="bindingRoot",
        label="fresh recovery planned Console binding",
    )
    work = dict(plan.get("work", {}))
    work_ref = dict(plan.get("workRef", {}))
    _verify_assignment_role(retained, work)
    _verify_profile_role(profile, plan)
    _verify_target_role(target, plan, work_ref)
    _verify_console_role(console, plan, work_ref)


def validated_recovery_profile(source: Path, runtime_dir) -> JsonObject:
    exact_source = source.expanduser().resolve()
    inspection = profile_sdk.validate_source(exact_source, runtime_dir)["inspection"]
    source_contract = dict(
        (inspection.get("closure") or {}).get("source_contract") or {}
    )
    body = {
        "schema": work_authority.PLANNED_PROFILE_SOURCE_SCHEMA,
        "profileId": str(inspection["profile"]["id"]),
        "profileRoot": str(inspection["profile_suite_root"]),
        "sourceContractRoot": str(source_contract.get("root") or ""),
        "sourceLocator": str(exact_source),
    }
    return work_authority.rooted(body, "sourceRoot")


def verify_recovery_profile_source(
    plan: Mapping[str, Any], recovery_profile_source: Path, runtime_dir
) -> None:
    planned = dict(plan.get("plannedProfileSource") or {})
    exact_source = recovery_profile_source.expanduser().resolve()
    if str(exact_source) != str(planned.get("sourceLocator") or ""):
        raise ValueError("fresh recovery Profile source locator differs from the plan")
    if validated_recovery_profile(exact_source, runtime_dir) != planned:
        raise ValueError("fresh recovery Profile source differs from the plan")


def verify_planned_workspace(plan: Mapping[str, Any]) -> tuple[Path, JsonObject]:
    workspace = dict((plan.get("plannedTarget") or {}).get("workspace") or {})
    workspace_id = _text(workspace.get("id"))
    runtime_root = _text(workspace.get("runtimeRoot"))
    if not runtime_root:
        raise ValueError("fresh recovery planned workspace runtime changed")
    runtime_dir = Path(runtime_root).expanduser().resolve()
    if workspace_id == "home":
        expected_kind = "home"
        runtime_matches = not _text(workspace.get("root"))
    elif workspace_id.startswith("project:"):
        expected_kind = "project"
        workspace_root = Path(_text(workspace.get("root"))).expanduser().resolve()
        runtime_matches = runtime_dir == workspace_root / ".kungfu" / "runtime"
    else:
        expected_kind = ""
        runtime_matches = False
    if not runtime_matches:
        raise ValueError("fresh recovery planned workspace runtime changed")
    identity_path = runtime_dir.parent / "workspace-identity.json"
    try:
        material = json.loads(identity_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(
            "fresh recovery planned workspace identity is unavailable"
        ) from error
    body = {key: value for key, value in material.items() if key != "identityRoot"}
    identity_root = str(material.get("identityRoot") or "")
    expected_workspace_id = (
        "home"
        if expected_kind == "home"
        else f"project:{identity_root.removeprefix('sha256:')[:16]}"
    )
    checks = (
        material.get("schema") == "kungfu.workspace.identity-material/v1",
        material.get("workspaceKind") == expected_kind,
        identity_root == work_authority.semantic_root(body),
        identity_root == workspace.get("identityRoot"),
        expected_workspace_id == workspace_id,
    )
    if not all(checks):
        raise ValueError("fresh recovery planned workspace identity changed")
    observation = {
        "workspaceId": expected_workspace_id,
        "identityRoot": identity_root,
        "runtimeRoot": str(runtime_dir),
        "available": runtime_dir.is_dir(),
    }
    if not observation["available"]:
        raise ValueError("fresh recovery planned workspace runtime is unavailable")
    return runtime_dir, observation


def observe_planned_console(plan: Mapping[str, Any]) -> tuple[JsonObject, JsonObject]:
    console = dict(plan.get("plannedConsoleBinding", {}))
    session = {
        "workConsoleId": _text(console.get("workConsoleId")),
        "sessionAttemptId": _text(console.get("sessionAttemptId")),
    }
    current = session_surface.invoke(
        {"operation": "show", "client": "kfd3-agent", "session": session},
        endpoint=_text(console.get("consoleEndpoint")),
    )
    current_console = dict(current.get("console", {}))
    current_attempt = dict(current.get("attempt", {}))
    observed_console = _text(
        current.get("workConsoleId"), current_console.get("consoleId")
    )
    observed_attempt = _text(
        current.get("sessionAttemptId"), current_attempt.get("sessionAttemptId")
    )
    lifecycle = _text(current.get("lifecycleState"))
    checks = (
        observed_console == session["workConsoleId"],
        observed_attempt == session["sessionAttemptId"],
        lifecycle not in {"ended", "unavailable", "unrecoverable", "orphaned"},
        current.get("live") is not False,
    )
    if not all(checks):
        raise ValueError("fresh recovery planned Console or SessionAttempt is not live")
    return session, {
        "workConsoleId": observed_console,
        "sessionAttemptId": observed_attempt,
        "lifecycleState": lifecycle,
        "live": current.get("live", True),
        "generation": current.get("generation"),
        "revision": current.get("revision"),
    }


def status_from_planned_source(
    runtime_dir: Path,
    source: Path,
    initiative_id: str,
    assignment_id: str,
) -> JsonObject:
    return LocalAssignmentRuntimeApplication(
        runtime_dir,
        client_id="kungfu.work.fresh-recovery",
        kind="cli",
        source=source,
    ).status(initiative_id, assignment_id)


def current_binding_context(runtime_dir: str, work_workspace_id: str) -> JsonObject:
    """Discover the Console once while creating the rooted recovery plan."""

    current = session_surface.current_native_console(
        runtime_dir, adopt=True, project_work_binding=False
    )
    if current is None:
        raise ValueError("fresh recovery requires a current native Agent Console")
    if str(current["source"]) not in {
        "injected-native-console",
        "ambient-provider-session",
    }:
        raise ValueError("fresh recovery requires an exact native Console source")
    envelope = dict(current["envelope"])
    source_workspace_id = str(envelope.get("workspaceId") or "")
    return {
        "session": {
            "workConsoleId": str(envelope["consoleId"]),
            "sessionAttemptId": str(envelope["attemptId"]),
        },
        "console": {
            "sourceWorkspaceId": source_workspace_id,
            "consoleRuntimeRoot": str(Path(runtime_dir).expanduser().resolve()),
            "consoleEndpoint": session_surface.endpoint_for_runtime(runtime_dir),
            "bindingScope": (
                "same-project"
                if source_workspace_id == work_workspace_id
                else "explicit-external-project"
            ),
        },
    }


def recovery_observation_input(value: Mapping[str, Any] | None) -> JsonObject:
    return dict(value) if value is not None else {}


def _fallback_recovery_observations(recovery: Mapping[str, Any]) -> JsonObject:
    after = recovery["after"]
    body = {
        "schema": work_authority.CURRENT_RECOVERY_OBSERVATIONS_SCHEMA,
        "console": dict(recovery.get("session", {})),
        "assignment": {
            "queryProofRoot": after.get("query_proof_root"),
            "activeLease": after.get("active_lease"),
        },
    }
    return work_authority.rooted(body, "observationRoot")


def recovery_receipt_semantics(
    recovery: Mapping[str, Any],
) -> tuple[JsonObject, JsonObject, list[JsonObject]]:
    observations = dict(recovery.get("observations", {}))
    if not observations:
        observations = _fallback_recovery_observations(recovery)
    continuation = work_authority.continuation_decision(
        recovery["after"], assignment_orchestration.next_actions(recovery["after"])
    )
    next_action = continuation.get("nextAction")
    next_actions = [dict(next_action)] if isinstance(next_action, Mapping) else []
    return observations, continuation, next_actions
