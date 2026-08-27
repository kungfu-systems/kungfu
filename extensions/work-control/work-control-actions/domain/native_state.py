# SPDX-License-Identifier: Apache-2.0

"""Native Work Control state projection and input validation."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from . import work_control


def validate_source_identity(
    source_identity: dict[str, Any] | None, initiative_id: str
) -> dict[str, Any]:
    identity = dict(source_identity or {})
    if not identity:
        return {}
    required = {
        "schema",
        "authority",
        "kind",
        "sourceId",
        "versionRoot",
        "admissionRoot",
    }
    if set(identity) != required:
        raise ValueError("Initiative source identity has unsupported fields")
    if identity.get("schema") != "kungfu.work-control.exact-source/v1":
        raise ValueError("Initiative source identity schema is unsupported")
    if str(identity.get("sourceId") or "") != initiative_id:
        raise ValueError("Initiative source identity does not match Initiative id")
    for field in ("versionRoot", "admissionRoot"):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(identity.get(field) or "")):
            raise ValueError(f"Initiative source {field} must be an exact root")
    if not all(
        str(identity.get(field) or "").strip() for field in ("authority", "kind")
    ):
        raise ValueError("Initiative source authority and kind are required")
    return identity


def parse_lease_expiry(value: str) -> datetime:
    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError("lease_expires_at must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError("lease_expires_at must include a timezone")
    return parsed


def assignment_row(state: dict[str, Any], assignment_id: str) -> dict[str, Any]:
    stable_id = work_control._stable_id(assignment_id, "assignment_id")
    assignments = state.get("assignments") or state.get("assignments") or []
    row = next(
        (
            item
            for item in assignments
            if item.get("subject_key") in {stable_id, f"kungfu:{stable_id}"}
            or item.get("payload", {}).get("record", {}).get("assignment_id")
            == stable_id
            or item.get("payload", {}).get("record", {}).get("assignment_id")
            == stable_id
        ),
        None,
    )
    if row is None:
        raise ValueError(f"Assignment not found under Initiative: {stable_id}")
    return row


def fold_completion_cycle(
    linked: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], str]:
    """Project the latest append-only completion event into one live phase."""

    typed_rows: list[tuple[dict[str, Any], str]] = []
    for row in linked:
        record = row.get("payload", {}).get("record", {})
        if record.get("claim_type") == work_control.COMPLETION_CLAIM:
            typed_rows.append((row, "completion-claimed"))
        elif record.get("review_type") == work_control.INDEPENDENT_REVIEW:
            typed_rows.append((row, "independently-reviewed"))
        elif record.get("review_type") == work_control.CONTINUATION_DECISION:
            phase = (
                "stage-ready"
                if record.get("action") in {"reopen", "request-evidence"}
                else "continuation-decided"
            )
            typed_rows.append((row, phase))
    latest_phase = (
        max(
            typed_rows,
            key=lambda item: (
                int(item[0].get("system_time") or 0),
                str(item[0].get("observation_id") or ""),
            ),
        )[1]
        if typed_rows
        else ""
    )

    def records(kind: str, value: str) -> list[dict[str, Any]]:
        return [
            row["payload"]["record"]
            for row, _ in typed_rows
            if row.get("payload", {}).get("record", {}).get(kind) == value
        ]

    return (
        records("claim_type", work_control.COMPLETION_CLAIM),
        records("review_type", work_control.INDEPENDENT_REVIEW),
        records("review_type", work_control.CONTINUATION_DECISION),
        latest_phase,
    )


def query_state(
    runtime_dir: str,
    *,
    initiative_id: str,
    storage_source_id: str = "kungfu",
    cut_system_time: int = 0,
) -> dict[str, Any]:
    """Return native Initiative/Assignment state without legacy vocabulary."""

    state = work_control.query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
        cut_system_time=cut_system_time,
    )
    return {**state, "authority_mode": "work-control"}
