# SPDX-License-Identifier: Apache-2.0

"""Lossless fresh-attempt recovery for one existing native Assignment Runtime."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
from typing import Any

import click

from kungfu import initiative_family, profile_sdk
from kungfu.agent import run_agent, session_contract, session_surface
from kungfu.assignment_runtime import LocalAssignmentRuntimeApplication
from kungfu.assignment_runtime import fresh_recovery_lease as lease_recovery
from kungfu.assignment_runtime import profile_lifecycle
from kungfu.assignment_runtime.recovery_continuation import (
    register as register_continuation,
)
from kungfu.storage import service as storage_service

JsonObject = dict[str, Any]
PLAN_SCHEMA = "kungfu.work.fresh-recovery-plan/v2"
RECEIPT_SCHEMA = "kungfu.work.fresh-recovery-receipt/v2"
CONTINUATION_MODE = "resume/new-attempt"


class FreshRecoveryError(ValueError):
    """Fail closed while retaining executable public recovery actions."""

    def __init__(self, message: str, next_actions: list[JsonObject]):
        super().__init__(message)
        self.next_actions = next_actions


def _now(value: str | None = None) -> datetime:
    if value:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    return datetime.now(UTC)


def _root(value: Any) -> str:
    return initiative_family.semantic_root(value)


def _current_session(runtime_dir: str) -> JsonObject:
    current = session_surface.current_native_console(
        runtime_dir, adopt=True, project_work_binding=False
    )
    if current is None:
        raise ValueError("fresh recovery requires a current native Agent Console")
    envelope = dict(current["envelope"])
    return {
        "workConsoleId": str(envelope["consoleId"]),
        "sessionAttemptId": str(envelope["attemptId"]),
    }


def preserved_state(status: Mapping[str, Any]) -> JsonObject:
    """Retain native lifecycle authority, not reader-specific projections."""

    return {
        str(key): value
        for key, value in status.items()
        if key not in {"query_proof_root", "work_semantics"}
    }


def _attempt_coordinates(
    binding: Mapping[str, Any], previous_attempt_id: str
) -> tuple[str, str]:
    session = binding.get("session") or {}
    current_attempt = str(session.get("sessionAttemptId") or "")
    if not previous_attempt_id or not current_attempt:
        raise ValueError(
            "fresh recovery requires exact previous and current attempt identities"
        )
    if current_attempt == previous_attempt_id:
        raise ValueError("fresh recovery requires a new SessionAttempt")
    return current_attempt, str(session.get("workConsoleId") or "")


def _verify_retained_roots(
    assignment: Mapping[str, Any],
    work_ref: Mapping[str, Any],
    expected_request_root: str,
    expected_work_definition_root: str,
    expected_profile_root: str,
) -> None:
    checks = {
        "requestRoot": (assignment.get("request_root"), expected_request_root),
        "workDefinitionRoot": (
            assignment.get("work_definition_root"),
            expected_work_definition_root,
        ),
        "profileRoot": (work_ref.get("profileRoot"), expected_profile_root),
    }
    for field, (actual, expected) in checks.items():
        if not expected or actual != expected:
            raise ValueError(
                f"fresh recovery {field} does not match the retained authority"
            )


def _recovery_effects(
    work_ref: Mapping[str, Any],
    current_attempt: str,
    profile_active: bool,
) -> list[JsonObject]:
    profile_effects = []
    if not profile_active:
        profile_effects.append(
            {
                "stage": "activate-profile",
                "profileId": work_ref["profileId"],
                "profileRoot": work_ref["profileRoot"],
            }
        )
    return [
        *profile_effects,
        {
            "stage": "bind-new-attempt",
            "sessionAttemptId": current_attempt,
            "workRefRoot": _root(work_ref),
        },
    ]


def _recovery_effects_with_lease(
    work_ref: Mapping[str, Any],
    current_attempt: str,
    profile_active: bool,
    status: Mapping[str, Any],
    previous_attempt_id: str,
    generated_at: datetime,
) -> list[JsonObject]:
    effects = _recovery_effects(work_ref, current_attempt, profile_active)
    effect = lease_recovery.plan_lease_effect(
        status, previous_attempt_id, current_attempt, generated_at
    )
    if effect is not None:
        effects.append(effect)
    return effects


def _work_coordinates(
    status: Mapping[str, Any],
    assignment: Mapping[str, Any],
    expected_request_root: str,
    expected_work_definition_root: str,
) -> JsonObject:
    return {
        "initiativeId": str(assignment.get("initiative_id") or ""),
        "assignmentId": str(assignment.get("assignment_id") or ""),
        "phase": str(status.get("phase") or ""),
        "requestRoot": expected_request_root,
        "workDefinitionRoot": expected_work_definition_root,
        "assignmentRoot": _root(assignment),
        "lifecycleStateRoot": _root(preserved_state(status)),
        "systemTimeCut": str(status.get("query_proof_root") or ""),
    }


def _plan_body(
    *,
    workspace: Mapping[str, Any],
    status: Mapping[str, Any],
    assignment: Mapping[str, Any],
    work_ref: JsonObject,
    recovery_profile: Mapping[str, Any],
    previous_attempt_id: str,
    current_attempt: str,
    work_console_id: str,
    expected_request_root: str,
    expected_work_definition_root: str,
    profile_active: bool,
    generated_at: datetime,
) -> JsonObject:
    execution_recovery = lease_recovery.execution_recovery(
        status, previous_attempt_id, generated_at
    )
    return {
        "schema": PLAN_SCHEMA,
        "continuationMode": CONTINUATION_MODE,
        "generatedAt": generated_at.isoformat().replace("+00:00", "Z"),
        "expiresAt": (generated_at + timedelta(minutes=10))
        .isoformat()
        .replace("+00:00", "Z"),
        "workspace": dict(workspace),
        "work": _work_coordinates(
            status,
            assignment,
            expected_request_root,
            expected_work_definition_root,
        ),
        "attempt": {
            "previousSessionAttemptId": previous_attempt_id,
            "newSessionAttemptId": current_attempt,
            "workConsoleId": work_console_id,
        },
        "workRef": work_ref,
        "recoveryProfile": dict(recovery_profile),
        "effects": _recovery_effects_with_lease(
            work_ref,
            current_attempt,
            profile_active,
            status,
            previous_attempt_id,
            generated_at,
        ),
        "executionRecovery": execution_recovery,
        "forbiddenEffects": (
            ["admit", "kickoff", "completion-authority"]
            if execution_recovery is not None
            else ["admit", "claim", "kickoff"]
        ),
        "writeOccurred": False,
        "nextActions": ["apply-exact-fresh-recovery-plan"],
    }


def build_plan(
    *,
    workspace: Mapping[str, Any],
    status: Mapping[str, Any],
    binding: Mapping[str, Any],
    previous_attempt_id: str,
    expected_request_root: str,
    expected_work_definition_root: str,
    expected_profile_root: str,
    recovery_profile: Mapping[str, Any],
    profile_active: bool,
    now: str | None = None,
) -> JsonObject:
    assignment = dict(status.get("assignment") or {})
    work_ref = session_contract.validate_work_ref(dict(binding["workRef"]))
    current_attempt, work_console_id = _attempt_coordinates(
        binding, previous_attempt_id
    )
    _verify_retained_roots(
        assignment,
        work_ref,
        expected_request_root,
        expected_work_definition_root,
        expected_profile_root,
    )
    body = _plan_body(
        workspace=workspace,
        status=status,
        assignment=assignment,
        work_ref=work_ref,
        recovery_profile=recovery_profile,
        previous_attempt_id=previous_attempt_id,
        current_attempt=current_attempt,
        work_console_id=work_console_id,
        expected_request_root=expected_request_root,
        expected_work_definition_root=expected_work_definition_root,
        profile_active=profile_active,
        generated_at=_now(now),
    )
    return {**body, "planRoot": _root(body)}


def _verify_plan_envelope(
    plan: Mapping[str, Any], expected_plan_root: str, now: str | None
) -> tuple[str, list[JsonObject]]:
    if plan.get("schema") != PLAN_SCHEMA:
        raise ValueError("fresh recovery plan schema is unsupported")
    body = {key: value for key, value in plan.items() if key != "planRoot"}
    actual_root = _root(body)
    if plan.get("planRoot") != actual_root or expected_plan_root != actual_root:
        raise ValueError("fresh recovery plan root does not verify")
    if plan.get("continuationMode") != CONTINUATION_MODE:
        raise ValueError("fresh recovery refuses a first-attempt plan")
    _verify_recovery_profile_identity(plan)
    effects = [dict(effect) for effect in plan.get("effects") or []]
    stages = [str(effect.get("stage") or "") for effect in effects]
    allowed_stages = {
        ("bind-new-attempt",),
        ("activate-profile", "bind-new-attempt"),
        ("bind-new-attempt", "claim-new-attempt-lease"),
        (
            "activate-profile",
            "bind-new-attempt",
            "claim-new-attempt-lease",
        ),
    }
    if tuple(stages) not in allowed_stages:
        raise ValueError("fresh recovery plan has an invalid effect sequence")
    if _now(now) > _now(str(plan.get("expiresAt") or "")):
        raise ValueError("fresh recovery plan expired; create a new plan")
    return actual_root, effects


def _verify_recovery_profile_identity(plan: Mapping[str, Any]) -> None:
    recovery_profile = dict(plan.get("recoveryProfile") or {})
    if (
        recovery_profile.get("profileId") != "kungfu.work-control"
        or recovery_profile.get("profileRoot")
        != (plan.get("workRef") or {}).get("profileRoot")
        or not str(recovery_profile.get("sourceContractRoot") or "").startswith(
            "sha256:"
        )
    ):
        raise ValueError("fresh recovery Profile source identity does not verify")


def _binding_coordinates(
    plan: Mapping[str, Any], effects: list[JsonObject]
) -> tuple[JsonObject, JsonObject]:
    work_ref = session_contract.validate_work_ref(dict(plan.get("workRef") or {}))
    work = dict(plan.get("work") or {})
    workspace = dict(plan.get("workspace") or {})
    attempt = dict(plan.get("attempt") or {})
    expected_session = {
        "workConsoleId": str(attempt.get("workConsoleId") or ""),
        "sessionAttemptId": str(attempt.get("newSessionAttemptId") or ""),
    }
    if not all(expected_session.values()) or (
        attempt.get("previousSessionAttemptId") == expected_session["sessionAttemptId"]
    ):
        raise ValueError("fresh recovery plan does not bind a new SessionAttempt")
    binding_effect = effects[int(effects[0].get("stage") == "activate-profile")]
    checks = (
        binding_effect.get("sessionAttemptId") == expected_session["sessionAttemptId"],
        binding_effect.get("workRefRoot") == _root(work_ref),
        work_ref.get("workspaceId") == workspace.get("id"),
        work_ref.get("initiativeId") == work.get("initiativeId"),
        work_ref.get("entityId") == work.get("assignmentId"),
        work_ref.get("entityRoot") == work.get("assignmentRoot"),
        work_ref.get("systemTimeCut") == work.get("systemTimeCut"),
    )
    if not all(checks):
        raise ValueError("fresh recovery plan binding coordinates do not verify")
    return work_ref, expected_session


def _preservation_roots(plan: Mapping[str, Any]) -> tuple[str, str]:
    work = plan.get("work") or {}
    return (
        str(work.get("lifecycleStateRoot") or ""),
        str(work.get("assignmentRoot") or ""),
    )


def _verify_retained_state(
    status: Mapping[str, Any], state_root: str, assignment_root: str
) -> None:
    if _root(preserved_state(status)) != state_root:
        raise ValueError("fresh recovery lifecycle state changed; create a new plan")
    if _root(status.get("assignment") or {}) != assignment_root:
        raise ValueError(
            "fresh recovery Assignment identity changed; create a new plan"
        )


def _apply_binding(
    *,
    plan: Mapping[str, Any],
    authorized_by: str,
    work_ref: JsonObject,
    expected_session: JsonObject,
    state_root: str,
    status_reader: Callable[[], JsonObject],
    prepare_profile: Callable[[str], JsonObject],
    bind_work: Callable[[Mapping[str, Any]], JsonObject],
) -> tuple[JsonObject, JsonObject, JsonObject]:
    profile_receipt = prepare_profile(authorized_by)
    after_profile = status_reader()
    if _root(preserved_state(after_profile)) != state_root:
        raise RuntimeError("Work Control activation changed Assignment lifecycle state")
    binding = bind_work({"workRef": work_ref, "session": expected_session})
    if binding.get("workRef") != plan.get("workRef"):
        raise RuntimeError("fresh recovery bound a different WorkRef")
    after = status_reader()
    if _root(preserved_state(after)) != state_root:
        raise RuntimeError("fresh recovery changed Assignment lifecycle state")
    return profile_receipt, binding, after


def _recovery_receipt(
    *,
    plan: Mapping[str, Any],
    actual_root: str,
    authorized_by: str,
    profile_receipt: JsonObject,
    binding: JsonObject,
    recovery: Mapping[str, Any],
) -> JsonObject:
    plan_work = dict(plan.get("work", {}))
    if actual_root != plan.get("planRoot"):
        raise RuntimeError("fresh recovery receipt plan root changed")
    if recovery.get("assignment_root") != plan_work.get("assignmentRoot"):
        raise RuntimeError("fresh recovery receipt Assignment root changed")
    if recovery.get("state_root") != plan_work.get("lifecycleStateRoot"):
        raise RuntimeError("fresh recovery receipt lifecycle root changed")
    if (recovery.get("claim_receipt") is None) != (
        recovery.get("recovered_claim") is None
    ):
        raise RuntimeError("fresh recovery receipt execution evidence is incomplete")
    body = _recovery_receipt_body(
        plan=plan,
        actual_root=actual_root,
        authorized_by=authorized_by,
        profile_receipt=profile_receipt,
        binding=binding,
        recovery=recovery,
    )
    return {**body, "receiptRoot": _root(body)}


def _execution_write_projection(
    claim_receipt: JsonObject | None, recovered_claim: JsonObject | None
) -> tuple[list[JsonObject], JsonObject | None]:
    if claim_receipt is None or recovered_claim is None:
        return [], None
    claim_root = _root(recovered_claim)
    return [
        {
            "kind": "execution-claim",
            "claimRoot": claim_root,
            "runtimeReceiptRoot": _root(claim_receipt),
        }
    ], {
        "attemptId": recovered_claim["attempt_id"],
        "leaseId": recovered_claim["lease_id"],
        "leaseExpiresAt": recovered_claim["lease_expires_at"],
        "claimRoot": claim_root,
    }


def _preservation_projection(
    assignment_root: str,
    state_root: str,
    before: Mapping[str, Any],
    after: Mapping[str, Any],
) -> JsonObject:
    return {
        "assignmentRoot": assignment_root,
        "beforeLifecycleStateRoot": state_root,
        "afterLifecycleStateRoot": _root(preserved_state(after)),
        "phase": after.get("phase"),
        "queryProofRoot": after.get("query_proof_root"),
        "previousExecutionClaimCount": len(before.get("execution_claims") or []),
        "currentExecutionClaimCount": len(after.get("execution_claims") or []),
    }


def _recovery_receipt_body(
    *,
    plan: Mapping[str, Any],
    actual_root: str,
    authorized_by: str,
    profile_receipt: JsonObject,
    binding: JsonObject,
    recovery: Mapping[str, Any],
) -> JsonObject:
    assignment_writes, execution_lease = _execution_write_projection(
        recovery.get("claim_receipt"), recovery.get("recovered_claim")
    )
    after = recovery["after"]
    return {
        "schema": RECEIPT_SCHEMA,
        "ok": True,
        "status": "recovered",
        "continuationMode": CONTINUATION_MODE,
        "planRoot": actual_root,
        "authorizedBy": authorized_by,
        "workRef": dict(plan["workRef"]),
        "attempt": dict(plan["attempt"]),
        "profile": profile_receipt,
        "binding": binding,
        "executionLease": execution_lease,
        "preservation": _preservation_projection(
            recovery["assignment_root"],
            recovery["state_root"],
            recovery["before"],
            after,
        ),
        "writeOccurred": True,
        "assignmentWrites": assignment_writes,
        "nextActions": list(after.get("next_actions") or []),
    }


def _apply_context(
    plan: Mapping[str, Any],
    *,
    expected_plan_root: str,
    authorized_by: str,
    status_reader: Callable[[], JsonObject],
    session_reader: Callable[[], JsonObject],
    now: str | None = None,
) -> JsonObject:
    actual_root, effects = _verify_plan_envelope(plan, expected_plan_root, now)
    work_ref, expected_session = _binding_coordinates(plan, effects)
    if session_reader() != expected_session:
        raise ValueError(
            "fresh recovery plan belongs to another current SessionAttempt"
        )
    state_root, assignment_root = _preservation_roots(plan)
    before = status_reader()
    _verify_retained_state(before, state_root, assignment_root)
    lease_effect = lease_recovery.lease_effect(effects)
    if lease_effect is not None:
        lease_recovery.verify_execution_recovery(
            plan, before, lease_effect, authorized_by, _now(now)
        )
    return {
        "actual_root": actual_root,
        "work_ref": work_ref,
        "expected_session": expected_session,
        "state_root": state_root,
        "assignment_root": assignment_root,
        "before": before,
        "lease_effect": lease_effect,
    }


def apply_plan(
    plan: Mapping[str, Any],
    *,
    expected_plan_root: str,
    authorized_by: str,
    status_reader: Callable[[], JsonObject],
    session_reader: Callable[[], JsonObject],
    prepare_profile: Callable[[str], JsonObject],
    bind_work: Callable[[Mapping[str, Any]], JsonObject],
    claim_execution: Callable[[Mapping[str, Any], str], JsonObject] | None = None,
    now: str | None = None,
) -> JsonObject:
    context = _apply_context(
        plan,
        expected_plan_root=expected_plan_root,
        authorized_by=authorized_by,
        status_reader=status_reader,
        session_reader=session_reader,
        now=now,
    )
    if lease_recovery.claim_port_missing(context["lease_effect"], claim_execution):
        raise RuntimeError("fresh recovery execution claim port is unavailable")
    profile_receipt, binding, after_binding = _apply_binding(
        plan=plan,
        authorized_by=authorized_by,
        work_ref=context["work_ref"],
        expected_session=context["expected_session"],
        state_root=context["state_root"],
        status_reader=status_reader,
        prepare_profile=prepare_profile,
        bind_work=bind_work,
    )
    after, claim_receipt, recovered_claim = lease_recovery.apply_execution_recovery(
        plan=plan,
        before=context["before"],
        after_binding=after_binding,
        effect=context["lease_effect"],
        authorized_by=authorized_by,
        status_reader=status_reader,
        claim_execution=claim_execution,
    )
    return _recovery_receipt(
        plan=plan,
        actual_root=context["actual_root"],
        authorized_by=authorized_by,
        profile_receipt=profile_receipt,
        binding=binding,
        recovery={
            "assignment_root": context["assignment_root"],
            "state_root": context["state_root"],
            "before": context["before"],
            "after": after,
            "claim_receipt": claim_receipt,
            "recovered_claim": recovered_claim,
        },
    )


def _profile_is_active(runtime_dir: str, expected_profile_root: str) -> bool:
    lifecycle = storage_service.profile_lifecycle(
        runtime_dir, "list", include_removed=True
    )
    return any(
        row.get("profile_id") == "kungfu.work-control"
        and row.get("profile_suite_root") == expected_profile_root
        and row.get("qualified")
        and row.get("activated")
        and not row.get("removed")
        for row in lifecycle.get("profiles", [])
    )


def _retained_profile_source(runtime_dir: str | Path) -> Path:
    state = storage_service.profile_lifecycle(
        runtime_dir, "get", profile_id="kungfu.work-control"
    )
    closure = dict((state.get("latest_event") or {}).get("closure") or {})
    profile_path = Path(str(closure.get("profile_path") or "")).expanduser()
    if not profile_path.is_file():
        raise FreshRecoveryError(
            "retained Work Control Profile source is unavailable",
            _profile_recovery_actions(profile_path.parent),
        )
    source = profile_path.resolve().parent
    inspection = profile_sdk.validate_source(source, runtime_dir)["inspection"]
    if inspection.get("profile_suite_root") != state.get("profile_suite_root"):
        raise FreshRecoveryError(
            "retained Work Control Profile source root changed",
            _profile_recovery_actions(source),
        )
    return source


def _retained_status(runtime_dir, initiative_id, assignment_id) -> JsonObject:
    return LocalAssignmentRuntimeApplication(
        runtime_dir,
        client_id="kungfu.work.fresh-recovery",
        kind="cli",
        source=_retained_profile_source(runtime_dir),
    ).status(initiative_id, assignment_id)


def _validated_recovery_profile(source: Path, runtime_dir) -> JsonObject:
    inspection = profile_sdk.validate_source(source, runtime_dir)["inspection"]
    source_contract = dict(
        (inspection.get("closure") or {}).get("source_contract") or {}
    )
    return {
        "profileId": str(inspection["profile"]["id"]),
        "profileRoot": str(inspection["profile_suite_root"]),
        "sourceContractRoot": str(source_contract.get("root") or ""),
    }


def _profile_recovery_actions(source: Path) -> list[JsonObject]:
    return [
        {
            "action": "inspect-work-control-history",
            "command": [
                "kungfu",
                "profile",
                "history",
                "kungfu.work-control",
                "--json",
            ],
        },
        {
            "action": "validate-recovery-profile-source",
            "command": ["kungfu", "profile", "validate", str(source), "--json"],
        },
        {
            "action": "regenerate-fresh-recovery-plan",
            "command": ["kungfu", "work", "fresh-recovery-plan", "--help"],
        },
    ]


def _diagnosed_recovery(
    operation: Callable[[], JsonObject], source: Path
) -> JsonObject:
    try:
        return operation()
    except FreshRecoveryError:
        raise
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        raise FreshRecoveryError(
            str(error), _profile_recovery_actions(source)
        ) from error


def _diagnosed_plan_from_ports(
    *, recovery_profile_source: Path, **values
) -> JsonObject:
    return _diagnosed_recovery(
        lambda: _plan_from_ports(
            recovery_profile_source=recovery_profile_source, **values
        ),
        recovery_profile_source,
    )


def _diagnosed_apply_from_ports(
    *, recovery_profile_source: Path, **values
) -> JsonObject:
    return _diagnosed_recovery(
        lambda: _apply_from_ports(
            recovery_profile_source=recovery_profile_source, **values
        ),
        recovery_profile_source,
    )


def _recovery_plan_authority(
    runtime_dir,
    initiative_id: str,
    assignment_id: str,
    recovery_profile_source: Path,
    expected_profile_root: str,
) -> tuple[JsonObject, JsonObject]:
    current_status = _retained_status(runtime_dir, initiative_id, assignment_id)
    recovery_profile = _validated_recovery_profile(recovery_profile_source, runtime_dir)
    if recovery_profile["profileRoot"] != expected_profile_root:
        raise ValueError(
            "fresh recovery Profile source root does not match expected root"
        )
    return current_status, recovery_profile


def _verify_recovery_profile_source(
    plan: Mapping[str, Any], recovery_profile_source: Path, runtime_dir
) -> None:
    recovery_profile = _validated_recovery_profile(recovery_profile_source, runtime_dir)
    if recovery_profile != dict(plan.get("recoveryProfile") or {}):
        raise ValueError("fresh recovery Profile source differs from the plan")


def _current_binding_context(runtime_dir: str) -> tuple[JsonObject, JsonObject]:
    current = session_surface.current_native_console(
        runtime_dir, adopt=True, project_work_binding=False
    )
    if current is None:
        raise ValueError("fresh recovery requires a current native Agent Console")
    source = str(current["source"])
    envelope = dict(current["envelope"])
    session = {
        "workConsoleId": str(envelope["consoleId"]),
        "sessionAttemptId": str(envelope["attemptId"]),
    }
    if source not in {"injected-native-console", "ambient-provider-session"}:
        raise ValueError("fresh recovery requires an exact native Console source")
    options = {
        "injected-native-console": {},
        "ambient-provider-session": {
            "envelope_override": envelope,
            "console_workspace_root": str(current["workspaceRoot"]),
        },
    }
    return session, options[source]


def _plan_from_ports(
    *,
    ctx,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    previous_attempt_id,
    expected_request_root,
    expected_work_definition_root,
    expected_profile_root,
    recovery_profile_source,
    out,
    runtime,
    status,
    write_immutable_json,
) -> JsonObject:
    identity, runtime_dir, _ = runtime(workspace_root, home, "read-only")
    current_status, recovery_profile = _recovery_plan_authority(
        runtime_dir,
        initiative_id,
        assignment_id,
        recovery_profile_source,
        expected_profile_root,
    )
    work_ref = session_contract.validate_work_ref(
        {
            "schema": "kungfu.work-ref/v1",
            "workspaceId": identity.workspace_id,
            "profileId": recovery_profile["profileId"],
            "profileRoot": recovery_profile["profileRoot"],
            "entityType": "assignment",
            "entityId": assignment_id,
            "entityRoot": _root(current_status["assignment"]),
            "purpose": "continue-project-assignment",
            "systemTimeCut": current_status["query_proof_root"],
            "initiativeId": initiative_id,
        }
    )
    plan = build_plan(
        workspace={
            "id": identity.workspace_id,
            "root": identity.workspace_root,
            "identityRoot": identity.identity_root,
        },
        status=current_status,
        binding={
            "workRef": work_ref,
            "session": _current_session(str(ctx.runtime_dir)),
        },
        previous_attempt_id=previous_attempt_id,
        expected_request_root=expected_request_root,
        expected_work_definition_root=expected_work_definition_root,
        expected_profile_root=expected_profile_root,
        recovery_profile=recovery_profile,
        profile_active=_profile_is_active(runtime_dir, expected_profile_root),
    )
    return {**plan, "outputPath": write_immutable_json(out, plan)}


def _apply_from_ports(
    *,
    ctx,
    plan_file: Path,
    expected_plan_root: str,
    authorized_by: str,
    recovery_profile_source: Path,
    runtime,
    status,
    prepare_resume_profile,
) -> JsonObject:
    plan = json.loads(plan_file.read_text(encoding="utf-8"))
    workspace = dict(plan.get("workspace") or {})
    work = dict(plan.get("work") or {})
    workspace_root = str(workspace.get("root") or "")
    initiative_id = str(work.get("initiativeId") or "")
    assignment_id = str(work.get("assignmentId") or "")
    identity, runtime_dir, _ = runtime(workspace_root, False, "semantic-write")
    if identity.workspace_id != workspace.get(
        "id"
    ) or identity.identity_root != workspace.get("identityRoot"):
        raise ValueError("fresh recovery workspace identity changed")
    _verify_recovery_profile_source(plan, recovery_profile_source, runtime_dir)
    current_session, bind_options = _current_binding_context(str(ctx.runtime_dir))
    receipt = apply_plan(
        plan,
        expected_plan_root=expected_plan_root,
        authorized_by=authorized_by,
        status_reader=lambda: _retained_status(
            runtime_dir, initiative_id, assignment_id
        ),
        session_reader=lambda: dict(current_session),
        prepare_profile=lambda actor: prepare_resume_profile(
            runtime_dir, actor, recovery_profile_source
        ),
        bind_work=lambda expected: (
            run_agent.bind_current_native_work(
                str(ctx.runtime_dir),
                initiative_id,
                assignment_id,
                work_workspace_root=workspace_root,
                work_profile_source=recovery_profile_source,
                expected_binding=expected,
                **bind_options,
            )
            or {}
        ),
        claim_execution=lambda values, actor: LocalAssignmentRuntimeApplication(
            runtime_dir,
            client_id="kungfu.work.fresh-recovery",
            kind="cli",
            source=recovery_profile_source,
        ).authorize("claim-assignment", values, actor),
    )
    register_continuation(runtime_dir, plan, receipt)
    return receipt


def _create_plan_command(
    *,
    assignment_context,
    identity_options,
    surface,
    run,
    emit,
    write_immutable_json,
    runtime,
    status,
) -> click.Command:
    @click.command(
        name="fresh-recovery-plan",
        help=("plan exact fresh-attempt binding and expired execution lease recovery"),
    )
    @identity_options
    @click.option("--previous-attempt-id", required=True)
    @click.option("--expected-request-root", required=True)
    @click.option("--expected-work-definition-root", required=True)
    @click.option("--expected-profile-root", required=True)
    @click.option(
        "--recovery-profile-source",
        required=True,
        type=click.Path(exists=True, file_okay=False, path_type=Path),
    )
    @click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
    @assignment_context
    @surface(id="kungfu.work.fresh-recovery.plan")
    def command(ctx, **values):
        emit(
            run(
                lambda: _diagnosed_plan_from_ports(
                    ctx=ctx,
                    runtime=runtime,
                    status=status,
                    write_immutable_json=write_immutable_json,
                    **values,
                )
            )
        )

    return command


def _create_apply_command(
    *, assignment_context, surface, run, emit, runtime, status, prepare_resume_profile
) -> click.Command:
    @click.command(
        name="fresh-recover",
        help=("apply exact fresh-attempt recovery without replaying Work lifecycle"),
    )
    @click.option(
        "--plan",
        "plan_file",
        required=True,
        type=click.Path(exists=True, dir_okay=False, path_type=Path),
    )
    @click.option("--expected-plan-root", required=True)
    @click.option("--authorized-by", required=True)
    @click.option(
        "--recovery-profile-source",
        required=True,
        type=click.Path(exists=True, file_okay=False, path_type=Path),
    )
    @assignment_context
    @surface(id="kungfu.work.fresh-recovery.apply")
    def command(ctx, **values):
        emit(
            run(
                lambda: _diagnosed_apply_from_ports(
                    ctx=ctx,
                    runtime=runtime,
                    status=status,
                    prepare_resume_profile=prepare_resume_profile,
                    **values,
                )
            )
        )

    return command


def create_commands(
    *,
    assignment_context,
    identity_options,
    surface,
    run,
    emit,
    write_immutable_json,
    runtime,
    status,
    prepare_resume_profile,
) -> tuple[click.Command, click.Command]:
    """Compose the public plan/apply commands over existing application ports."""
    plan = _create_plan_command(
        assignment_context=assignment_context,
        identity_options=identity_options,
        surface=surface,
        run=run,
        emit=emit,
        write_immutable_json=write_immutable_json,
        runtime=runtime,
        status=status,
    )
    apply = _create_apply_command(
        assignment_context=assignment_context,
        surface=surface,
        run=run,
        emit=emit,
        runtime=runtime,
        status=status,
        prepare_resume_profile=prepare_resume_profile,
    )
    return plan, apply


def register_commands(work_commands) -> None:
    """Attach the public recovery protocol to the existing ``work`` group."""

    commands = create_commands(
        assignment_context=work_commands.assignment_context,
        identity_options=work_commands.assignment_identity_options,
        surface=work_commands.surface,
        run=work_commands._run,
        emit=work_commands._emit,
        write_immutable_json=work_commands._write_immutable_json,
        runtime=work_commands._runtime,
        status=work_commands._status,
        prepare_resume_profile=profile_lifecycle.prepare_fresh_recovery_profile,
    )
    for command in commands:
        work_commands.assignment.add_command(command)
