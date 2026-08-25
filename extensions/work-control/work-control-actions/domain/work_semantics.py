# SPDX-License-Identifier: Apache-2.0

"""Domain-neutral Work execution and effect-settlement protocol.

The protocol stores only stable identities, enums, and content roots. Adopters
retain their private inputs and transport details while Work Control owns the
freshness, attempt, authorization, and reconciliation decisions.
"""

from __future__ import annotations

import re
import time
from collections.abc import Mapping
from typing import Any

from . import work_control_runtime as runtime

INPUT_SNAPSHOT = "work-input-snapshot"
MANAGED_RUN = "work-managed-run"
EFFECT_AUTHORIZATION = "work-effect-authorization"
EFFECT_ATTEMPT = "work-effect-attempt"
EFFECT_OUTCOME = "work-effect-outcome"
RECORD_TYPES = {
    INPUT_SNAPSHOT,
    MANAGED_RUN,
    EFFECT_AUTHORIZATION,
    EFFECT_ATTEMPT,
    EFFECT_OUTCOME,
}
STABLE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$")


def _root(value: Any, field: str) -> str:
    return runtime._root_id(str(value or ""), field, required=True)


def _roots(values: Any, field: str) -> list[str]:
    if not isinstance(values, list):
        raise TypeError(f"{field} must be an array of content roots")
    return sorted({_root(row, field) for row in values})


def _stable(value: Any, field: str) -> str:
    text = str(value or "").strip()
    if not STABLE_TOKEN.fullmatch(text):
        raise ValueError(f"{field} must be a stable public identifier")
    return text


def _linked_records(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    storage_source_id: str,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    from . import native_state

    state = runtime.query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
    )
    assignment = native_state.assignment_row(state, assignment_id)
    assignment_subject = str(assignment["subject_key"])
    records = []
    for row in state["claims"] + state["reviews"]:
        payload = row.get("payload", {})
        if payload.get("links", {}).get("assignment_id") != assignment_subject:
            continue
        record = dict(payload.get("record") or {})
        if record.get("record_type") in RECORD_TYPES:
            records.append(record)
    records.sort(
        key=lambda row: (
            int(row.get("recorded_at_system_time") or 0),
            str(row.get("record_root") or ""),
        )
    )
    return state, assignment, records


def project(
    records: list[dict[str, Any]],
    *,
    phase: str,
    active_lease: Mapping[str, Any] | None,
    query_proof_root: str,
) -> dict[str, Any]:
    """Fold protocol records into deterministic next actions."""

    snapshots = [row for row in records if row.get("record_type") == INPUT_SNAPSHOT]
    runs = [row for row in records if row.get("record_type") == MANAGED_RUN]
    authorizations = [
        row for row in records if row.get("record_type") == EFFECT_AUTHORIZATION
    ]
    attempts = [row for row in records if row.get("record_type") == EFFECT_ATTEMPT]
    outcomes = [row for row in records if row.get("record_type") == EFFECT_OUTCOME]
    current_snapshot = snapshots[-1] if snapshots else None
    current_snapshot_root = str((current_snapshot or {}).get("record_root") or "")
    current_runs = [
        row for row in runs if row.get("input_snapshot_root") == current_snapshot_root
    ]
    matching_authorizations = [
        row
        for row in authorizations
        if row.get("input_snapshot_root") == current_snapshot_root
    ]
    latest_authorization_by_effect = {
        str(row.get("effect_id") or ""): row for row in matching_authorizations
    }
    current_authorizations = sorted(
        latest_authorization_by_effect.values(),
        key=lambda row: (
            int(row.get("recorded_at_system_time") or 0),
            str(row.get("record_root") or ""),
        ),
    )
    current_authorization_roots = {
        str(row.get("record_root") or "") for row in current_authorizations
    }
    current_attempts = [
        row
        for row in attempts
        if row.get("authorization_root") in current_authorization_roots
    ]
    current_attempt_roots = {
        str(row.get("record_root") or "") for row in current_attempts
    }
    current_outcomes = [
        row
        for row in outcomes
        if row.get("effect_attempt_root") in current_attempt_roots
    ]
    latest_outcome_by_attempt = {
        str(row["effect_attempt_root"]): row for row in current_outcomes
    }

    next_actions: list[dict[str, str]] = []
    completion_eligible = False
    if current_snapshot is None:
        next_actions.append(
            {"action": "record-input-snapshot", "reason": "no-current-input-snapshot"}
        )
    elif not current_runs:
        next_actions.append(
            {"action": "record-managed-run", "reason": "current-input-not-executed"}
        )
    elif current_runs[-1].get("result_state") != "succeeded":
        next_actions.append(
            {"action": "record-managed-run", "reason": "latest-run-did-not-succeed"}
        )
    elif not current_authorizations:
        next_actions.append(
            {"action": "authorize-effect", "reason": "no-fresh-effect-authorization"}
        )
    elif not current_attempts:
        next_actions.append(
            {
                "action": "record-effect-attempt",
                "reason": "authorized-effect-not-attempted",
            }
        )
    else:
        unresolved = []
        rejected = []
        accepted = []
        for attempt in current_attempts:
            outcome = latest_outcome_by_attempt.get(
                str(attempt.get("record_root") or "")
            )
            if outcome is None:
                unresolved.append("transport-outcome-missing")
            elif outcome.get("transport_state") == "unknown":
                unresolved.append("transport-outcome-ambiguous")
            elif (
                outcome.get("transport_state") == "accepted"
                and outcome.get("business_state") == "unknown"
            ):
                unresolved.append("business-outcome-unrecorded")
            elif outcome.get("business_state") == "accepted":
                accepted.append(outcome)
            else:
                rejected.append(outcome)
        if unresolved:
            next_actions.append(
                {
                    "action": "reconcile-effect-outcome",
                    "reason": min(unresolved),
                }
            )
        elif rejected:
            next_actions.append(
                {
                    "action": "authorize-effect",
                    "reason": "retry-requires-new-authorization",
                }
            )
        elif accepted and len(accepted) == len(current_attempts):
            completion_eligible = True
            next_actions.append(
                {"action": "claim-completion", "reason": "effects-settled-and-accepted"}
            )

    return {
        "schema": "kungfu.work-semantics.status/v1",
        "phase": phase,
        "query_proof_root": query_proof_root,
        "active_attempt_id": str((active_lease or {}).get("attempt_id") or ""),
        "active_lease_id": str((active_lease or {}).get("lease_id") or ""),
        "current_input_snapshot": current_snapshot,
        "managed_runs": current_runs,
        "effect_authorizations": current_authorizations,
        "effect_attempts": current_attempts,
        "effect_outcomes": current_outcomes,
        "completion_eligible": completion_eligible,
        "blind_retry_allowed": False if current_attempts else None,
        "next_actions": next_actions,
    }


def status(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    storage_source_id: str = "kungfu",
) -> dict[str, Any]:
    lifecycle = runtime.assignment_orchestration_status(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        storage_source_id=storage_source_id,
    )
    return dict(lifecycle["work_semantics"])


def _execution_context(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    attempt_id: str,
    lease_id: str,
    actor: str,
    storage_source_id: str,
) -> dict[str, Any]:
    lifecycle = runtime.assignment_orchestration_status(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        storage_source_id=storage_source_id,
    )
    if lifecycle["phase"] not in {"executing", "stage-ready"}:
        raise ValueError("Work semantics require an executing Assignment")
    lease = lifecycle.get("active_lease")
    if not isinstance(lease, Mapping):
        raise TypeError("an active execution lease is required")
    expected = {
        "attempt_id": _stable(attempt_id, "attempt_id"),
        "lease_id": _stable(lease_id, "lease_id"),
        "actor": _stable(actor, "actor"),
    }
    if lease.get("attempt_id") != expected["attempt_id"]:
        raise ValueError("attempt changed before Work semantics write")
    if lease.get("lease_id") != expected["lease_id"]:
        raise ValueError("lease changed before Work semantics write")
    if lease.get("agent") != expected["actor"]:
        raise ValueError("actor is not the active Assignment agent")
    return lifecycle


def _append(
    runtime_dir: str,
    *,
    lifecycle: Mapping[str, Any],
    record_type: str,
    basis: dict[str, Any],
    actor_type: str,
    system_time: int,
) -> dict[str, Any]:
    recorded_at = system_time or time.time_ns()
    record = {
        "record_type": record_type,
        **basis,
        "recorded_at_system_time": recorded_at,
    }
    record["record_root"] = runtime._sha256_root(record)
    source_id = runtime._native_source(actor_type)
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": runtime._sha256_root(record),
            "actor": basis["actor"],
        },
        "links": {
            "initiative_id": lifecycle["initiative_subject"],
            "assignment_id": lifecycle["assignment_subject"],
        },
    }
    receipt = runtime._put_native_fact(
        runtime_dir,
        kind=record_type,
        surface_id=runtime.CLAIM_SURFACE_ID,
        subject_key=f"kungfu:work-semantics:{record['record_root'][7:]}",
        source_id=source_id,
        payload=payload,
        system_time=recorded_at,
    )
    return {
        "schema": "kungfu.work-semantics.write-receipt/v1",
        "record": record,
        "receipt": receipt,
    }


def record_input_snapshot(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    attempt_id: str,
    lease_id: str,
    snapshot_id: str,
    input_root: str,
    actor: str,
    evidence_roots: list[str] | None = None,
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    system_time: int = 0,
) -> dict[str, Any]:
    lifecycle = _execution_context(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        attempt_id=attempt_id,
        lease_id=lease_id,
        actor=actor,
        storage_source_id=storage_source_id,
    )
    return _append(
        runtime_dir,
        lifecycle=lifecycle,
        record_type=INPUT_SNAPSHOT,
        basis={
            "snapshot_id": _stable(snapshot_id, "snapshot_id"),
            "input_root": _root(input_root, "input_root"),
            "attempt_id": _stable(attempt_id, "attempt_id"),
            "lease_id": _stable(lease_id, "lease_id"),
            "actor": _stable(actor, "actor"),
            "evidence_roots": _roots(evidence_roots or [], "evidence_roots"),
        },
        actor_type=actor_type,
        system_time=system_time,
    )


def record_managed_run(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    attempt_id: str,
    lease_id: str,
    run_id: str,
    input_snapshot_root: str,
    role: str,
    result_state: str,
    result_root: str,
    actor: str,
    evidence_roots: list[str] | None = None,
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    system_time: int = 0,
) -> dict[str, Any]:
    lifecycle = _execution_context(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        attempt_id=attempt_id,
        lease_id=lease_id,
        actor=actor,
        storage_source_id=storage_source_id,
    )
    current = lifecycle["work_semantics"]["current_input_snapshot"]
    expected_snapshot = _root(input_snapshot_root, "input_snapshot_root")
    if not current or current.get("record_root") != expected_snapshot:
        raise ValueError("input snapshot changed before managed run was recorded")
    if result_state not in {"succeeded", "failed", "cancelled"}:
        raise ValueError("result_state must be succeeded, failed, or cancelled")
    return _append(
        runtime_dir,
        lifecycle=lifecycle,
        record_type=MANAGED_RUN,
        basis={
            "run_id": _stable(run_id, "run_id"),
            "input_snapshot_root": expected_snapshot,
            "role": _stable(role, "role"),
            "result_state": result_state,
            "result_root": _root(result_root, "result_root"),
            "attempt_id": _stable(attempt_id, "attempt_id"),
            "lease_id": _stable(lease_id, "lease_id"),
            "actor": _stable(actor, "actor"),
            "evidence_roots": _roots(evidence_roots or [], "evidence_roots"),
        },
        actor_type=actor_type,
        system_time=system_time,
    )


def authorize_effect(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    attempt_id: str,
    lease_id: str,
    authorization_id: str,
    effect_id: str,
    effect_kind: str,
    input_snapshot_root: str,
    scope_root: str,
    actor: str,
    evidence_roots: list[str] | None = None,
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    system_time: int = 0,
) -> dict[str, Any]:
    lifecycle = _execution_context(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        attempt_id=attempt_id,
        lease_id=lease_id,
        actor=actor,
        storage_source_id=storage_source_id,
    )
    semantics = lifecycle["work_semantics"]
    snapshot_root = _root(input_snapshot_root, "input_snapshot_root")
    current = semantics["current_input_snapshot"]
    if not current or current.get("record_root") != snapshot_root:
        raise ValueError("input snapshot changed before effect authorization")
    runs = semantics["managed_runs"]
    if not runs or runs[-1].get("result_state") != "succeeded":
        raise ValueError(
            "a successful managed run is required before effect authorization"
        )
    return _append(
        runtime_dir,
        lifecycle=lifecycle,
        record_type=EFFECT_AUTHORIZATION,
        basis={
            "authorization_id": _stable(authorization_id, "authorization_id"),
            "effect_id": _stable(effect_id, "effect_id"),
            "effect_kind": _stable(effect_kind, "effect_kind"),
            "input_snapshot_root": snapshot_root,
            "scope_root": _root(scope_root, "scope_root"),
            "attempt_id": _stable(attempt_id, "attempt_id"),
            "lease_id": _stable(lease_id, "lease_id"),
            "actor": _stable(actor, "actor"),
            "evidence_roots": _roots(evidence_roots or [], "evidence_roots"),
        },
        actor_type=actor_type,
        system_time=system_time,
    )


def record_effect_attempt(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    attempt_id: str,
    lease_id: str,
    effect_attempt_id: str,
    authorization_root: str,
    transport_request_root: str,
    actor: str,
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    system_time: int = 0,
) -> dict[str, Any]:
    lifecycle = _execution_context(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        attempt_id=attempt_id,
        lease_id=lease_id,
        actor=actor,
        storage_source_id=storage_source_id,
    )
    auth_root = _root(authorization_root, "authorization_root")
    authorizations = lifecycle["work_semantics"]["effect_authorizations"]
    authorization = next(
        (row for row in authorizations if row.get("record_root") == auth_root), None
    )
    if authorization is None:
        raise ValueError("effect authorization is stale or unknown")
    if any(
        row.get("authorization_root") == auth_root
        for row in lifecycle["work_semantics"]["effect_attempts"]
    ):
        raise ValueError("effect authorization already has an attempt; reconcile it")
    return _append(
        runtime_dir,
        lifecycle=lifecycle,
        record_type=EFFECT_ATTEMPT,
        basis={
            "effect_attempt_id": _stable(effect_attempt_id, "effect_attempt_id"),
            "authorization_root": auth_root,
            "transport_request_root": _root(
                transport_request_root, "transport_request_root"
            ),
            "attempt_id": _stable(attempt_id, "attempt_id"),
            "lease_id": _stable(lease_id, "lease_id"),
            "actor": _stable(actor, "actor"),
        },
        actor_type=actor_type,
        system_time=system_time,
    )


def record_effect_outcome(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    attempt_id: str,
    lease_id: str,
    effect_attempt_root: str,
    transport_state: str,
    business_state: str,
    outcome_root: str,
    actor: str,
    evidence_roots: list[str] | None = None,
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    system_time: int = 0,
) -> dict[str, Any]:
    lifecycle = _execution_context(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        attempt_id=attempt_id,
        lease_id=lease_id,
        actor=actor,
        storage_source_id=storage_source_id,
    )
    effect_root = _root(effect_attempt_root, "effect_attempt_root")
    effect_attempt = next(
        (
            row
            for row in lifecycle["work_semantics"]["effect_attempts"]
            if row.get("record_root") == effect_root
        ),
        None,
    )
    if effect_attempt is None:
        raise ValueError("effect attempt is stale or unknown")
    if transport_state not in {"unknown", "rejected", "accepted"}:
        raise ValueError("transport_state must be unknown, rejected, or accepted")
    if business_state not in {"unknown", "rejected", "accepted", "not-applicable"}:
        raise ValueError(
            "business_state must be unknown, rejected, accepted, or not-applicable"
        )
    if transport_state != "accepted" and business_state == "accepted":
        raise ValueError("business acceptance requires transport acceptance")
    return _append(
        runtime_dir,
        lifecycle=lifecycle,
        record_type=EFFECT_OUTCOME,
        basis={
            "effect_attempt_root": effect_root,
            "transport_state": transport_state,
            "business_state": business_state,
            "outcome_root": _root(outcome_root, "outcome_root"),
            "attempt_id": _stable(attempt_id, "attempt_id"),
            "lease_id": _stable(lease_id, "lease_id"),
            "actor": _stable(actor, "actor"),
            "evidence_roots": _roots(evidence_roots or [], "evidence_roots"),
        },
        actor_type=actor_type,
        system_time=system_time,
    )
