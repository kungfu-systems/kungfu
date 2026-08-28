# SPDX-License-Identifier: Apache-2.0

"""Exact execution-lease restoration for fresh Assignment attempts."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any

from kungfu import initiative_family

JsonObject = dict[str, Any]
_RECOVERY_LEASE_DURATION = timedelta(hours=2)


def _root(value: Any) -> str:
    return initiative_family.semantic_root(value)


def expired_execution_claim(
    status: Mapping[str, Any], previous_attempt_id: str, instant: datetime
) -> JsonObject:
    claims = [dict(row) for row in status.get("execution_claims") or []]
    if not claims:
        raise ValueError("fresh recovery requires one retained execution claim")
    latest = max(
        claims,
        key=lambda row: datetime.fromisoformat(
            str(row.get("lease_expires_at") or "").replace("Z", "+00:00")
        ),
    )
    if previous_attempt_id and latest.get("attempt_id") != previous_attempt_id:
        raise ValueError(
            "fresh recovery previous attempt does not match the latest execution claim"
        )
    lease_expiry = datetime.fromisoformat(
        str(latest.get("lease_expires_at") or "").replace("Z", "+00:00")
    )
    if lease_expiry > instant:
        raise ValueError("fresh recovery requires an expired execution lease")
    return latest


def recovery_authority(claim: Mapping[str, Any]) -> JsonObject:
    fields = {
        "owner": "owner",
        "agent": "agent",
        "slot": "slot",
        "authorizedBy": "authorized_by",
        "grantScope": "grant_scope",
    }
    authority = {
        public: str(claim.get(native) or "") for public, native in fields.items()
    }
    if not all(authority.values()):
        raise ValueError("retained execution claim authority is incomplete")
    return authority


def _recovery_lease(
    status: Mapping[str, Any],
    previous: Mapping[str, Any],
    current_attempt: str,
    generated_at: datetime,
) -> JsonObject:
    generated = generated_at.isoformat().replace("+00:00", "Z")
    basis = {
        "schema": "kungfu.work.fresh-recovery-lease-basis/v1",
        "assignmentRoot": _root(status.get("assignment") or {}),
        "previousExecutionClaimRoot": _root(previous),
        "newSessionAttemptId": current_attempt,
        "generatedAt": generated,
    }
    return {
        "attemptId": current_attempt,
        "leaseId": f"fresh-recovery-{_root(basis)[7:39]}",
        "leaseExpiresAt": (generated_at + _RECOVERY_LEASE_DURATION)
        .isoformat()
        .replace("+00:00", "Z"),
    }


def plan_lease_effect(
    status: Mapping[str, Any],
    previous_attempt_id: str,
    current_attempt: str,
    generated_at: datetime,
) -> JsonObject | None:
    if str(status.get("phase") or "") != "executing":
        return None
    if status.get("active_lease"):
        raise ValueError("fresh recovery refuses to replace an active execution lease")
    previous = expired_execution_claim(status, previous_attempt_id, generated_at)
    return {
        "stage": "claim-new-attempt-lease",
        **_recovery_lease(status, previous, current_attempt, generated_at),
        "previousExecutionClaimRoot": _root(previous),
        "authority": recovery_authority(previous),
    }


def execution_recovery(
    status: Mapping[str, Any], previous_attempt_id: str, generated_at: datetime
) -> JsonObject | None:
    if str(status.get("phase") or "") != "executing":
        return None
    previous = expired_execution_claim(status, previous_attempt_id, generated_at)
    return {
        "previousExecutionClaimRoot": _root(previous),
        "previousLeaseId": str(previous.get("lease_id") or ""),
        "previousLeaseExpiresAt": str(previous.get("lease_expires_at") or ""),
        "authority": recovery_authority(previous),
    }


def lease_effect(effects: list[JsonObject]) -> JsonObject | None:
    matches = [
        effect for effect in effects if effect.get("stage") == "claim-new-attempt-lease"
    ]
    if len(matches) > 1:
        raise ValueError("fresh recovery plan contains multiple lease effects")
    return matches[0] if matches else None


def verify_execution_recovery(
    plan: Mapping[str, Any],
    status: Mapping[str, Any],
    effect: Mapping[str, Any],
    authorized_by: str,
    instant: datetime,
) -> None:
    previous_attempt_id = str(
        (plan.get("attempt") or {}).get("previousSessionAttemptId") or ""
    )
    previous = expired_execution_claim(status, previous_attempt_id, instant)
    recovery = dict(plan.get("executionRecovery") or {})
    authority = recovery_authority(previous)
    checks = (
        status.get("phase") == "executing",
        status.get("active_lease") is None,
        recovery.get("previousExecutionClaimRoot") == _root(previous),
        recovery.get("previousLeaseId") == previous.get("lease_id"),
        recovery.get("previousLeaseExpiresAt") == previous.get("lease_expires_at"),
        recovery.get("authority") == authority,
        effect.get("previousExecutionClaimRoot") == _root(previous),
        effect.get("authority") == authority,
        effect.get("attemptId")
        == (plan.get("attempt") or {}).get("newSessionAttemptId"),
        authority.get("authorizedBy") == authorized_by,
        datetime.fromisoformat(
            str(effect.get("leaseExpiresAt") or "").replace("Z", "+00:00")
        )
        > instant,
    )
    if not all(checks):
        raise ValueError(
            "fresh recovery execution authority does not match the expired claim"
        )


def _verify_recovered_preservation(
    before: Mapping[str, Any], after: Mapping[str, Any]
) -> None:
    if after.get("phase") != before.get("phase"):
        raise RuntimeError("fresh recovery changed the Assignment phase")
    if _root(after.get("assignment") or {}) != _root(before.get("assignment") or {}):
        raise RuntimeError("fresh recovery changed the Assignment identity")
    for field in (
        "phase_transitions",
        "completion_claims",
        "independent_reviews",
        "continuation_decisions",
    ):
        if list(after.get(field) or []) != list(before.get(field) or []):
            raise RuntimeError(
                f"fresh recovery changed retained {field.replace('_', ' ')}"
            )


def _appended_execution_claim(
    before: Mapping[str, Any], after: Mapping[str, Any]
) -> JsonObject:
    old_claims = [dict(row) for row in before.get("execution_claims") or []]
    new_claims = [dict(row) for row in after.get("execution_claims") or []]
    appended = [row for row in new_claims if row not in old_claims]
    if len(new_claims) != len(old_claims) + 1 or len(appended) != 1:
        raise RuntimeError("fresh recovery did not append exactly one execution claim")
    return appended[0]


def _expected_execution_claim(effect: Mapping[str, Any]) -> JsonObject:
    authority = dict(effect.get("authority") or {})
    return {
        "attempt_id": effect.get("attemptId"),
        "lease_id": effect.get("leaseId"),
        "lease_expires_at": effect.get("leaseExpiresAt"),
        "owner": authority.get("owner"),
        "agent": authority.get("agent"),
        "slot": authority.get("slot"),
        "authorized_by": authority.get("authorizedBy"),
        "grant_scope": authority.get("grantScope"),
    }


def _verify_exact_execution_claim(
    claim: Mapping[str, Any], expected: Mapping[str, Any], failure: str
) -> None:
    if any(claim.get(key) != value for key, value in expected.items()):
        raise RuntimeError(f"fresh recovery {failure} execution claim")


def verify_recovered_lease(
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    effect: Mapping[str, Any],
) -> JsonObject:
    _verify_recovered_preservation(before, after)
    claim = _appended_execution_claim(before, after)
    expected = _expected_execution_claim(effect)
    _verify_exact_execution_claim(claim, expected, "appended a different")
    _verify_exact_execution_claim(
        dict(after.get("active_lease") or {}),
        expected,
        "did not activate the exact new",
    )
    return claim


def execution_claim_values(
    plan: Mapping[str, Any], effect: Mapping[str, Any]
) -> JsonObject:
    authority = dict(effect.get("authority") or {})
    return {
        "initiativeId": (plan.get("work") or {}).get("initiativeId"),
        "assignmentId": (plan.get("work") or {}).get("assignmentId"),
        "owner": authority.get("owner"),
        "agent": authority.get("agent"),
        "slot": authority.get("slot"),
        "leaseId": effect.get("leaseId"),
        "leaseExpiresAt": effect.get("leaseExpiresAt"),
        "attemptId": effect.get("attemptId"),
        "authorizedBy": authority.get("authorizedBy"),
        "grantScope": authority.get("grantScope"),
        "actorType": "user",
        "source": "kungfu",
    }


def apply_execution_recovery(
    *,
    plan: Mapping[str, Any],
    before: JsonObject,
    after_binding: JsonObject,
    effect: JsonObject | None,
    authorized_by: str,
    status_reader: Callable[[], JsonObject],
    claim_execution: Callable[[Mapping[str, Any], str], JsonObject] | None,
) -> tuple[JsonObject, JsonObject | None, JsonObject | None]:
    if effect is None:
        return after_binding, None, None
    if claim_execution is None:
        raise RuntimeError("fresh recovery execution claim port is unavailable")
    claim_receipt = claim_execution(execution_claim_values(plan, effect), authorized_by)
    after = status_reader()
    return after, claim_receipt, verify_recovered_lease(before, after, effect)


def claim_port_missing(
    effect: JsonObject | None,
    claim_execution: Callable[[Mapping[str, Any], str], JsonObject] | None,
) -> bool:
    return effect is not None and claim_execution is None
