# SPDX-License-Identifier: Apache-2.0

"""Work Profile lifecycle reconciliation for Assignment Runtime clients."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from kungfu import profile_sdk
from kungfu.storage import service as storage_service


def resolve_profile_source(
    source: str | Path | None, fallback: Callable[[], str | Path]
) -> Path:
    """Resolve an explicit retained source or the caller's current source."""

    return Path(source).resolve() if source is not None else Path(fallback()).resolve()


def _required_actions(state: dict[str, Any] | None, desired_root: str) -> list[str]:
    if state is None:
        return ["install", "qualify", "activate"]
    if state.get("profile_suite_root") != desired_root:
        return ["upgrade", "qualify", "activate"]
    actions = []
    if not state.get("qualified"):
        actions.append("qualify")
    if not state.get("activated"):
        actions.append("activate")
    return actions


def _profile_state(runtime_dir: str | Path, profile_id: str) -> dict[str, Any] | None:
    lifecycle = storage_service.profile_lifecycle(
        runtime_dir, "list", include_removed=True
    )
    return next(
        (
            row
            for row in lifecycle.get("profiles", [])
            if row.get("profile_id") == profile_id and not row.get("removed")
        ),
        None,
    )


def ensure_work_profile(
    source: str | Path, runtime_dir: str | Path, authorized_by: str
) -> list[dict[str, Any]]:
    """Reconcile lifecycle state and its Profile-owned compatibility contract."""

    receipts = []
    inspection = profile_sdk.validate_source(source, runtime_dir)["inspection"]
    profile_id = inspection["profile"]["id"]
    desired_root = inspection["profile_suite_root"]
    lifecycle = storage_service.profile_lifecycle(
        runtime_dir, "list", include_removed=True
    )
    state = next(
        (
            row
            for row in lifecycle.get("profiles", [])
            if row.get("profile_id") == profile_id and not row.get("removed")
        ),
        None,
    )
    actions = _required_actions(state, desired_root)
    for action in actions:
        values = {"granted_permissions": ["storage"]} if action == "activate" else {}
        plan = profile_sdk.lifecycle_plan(runtime_dir, action, source, **values)
        answer = profile_sdk.answer_decision(
            plan["decisionCard"], "approve", authorized_by
        )
        receipts.append(
            profile_sdk.authorized_lifecycle_apply(runtime_dir, plan, answer)
        )
    domain = profile_sdk.load_member_python_package(
        source, "work-control-actions", "domain"
    )
    receipts.extend(
        domain.work_control.ensure_profile_contract(
            str(runtime_dir), str(source), authorized_by
        )
    )
    return receipts


def ensure_profile_lifecycle(
    source: str | Path, runtime_dir: str | Path, authorized_by: str
) -> list[dict[str, Any]]:
    """Activate one exact Profile root without invoking Profile Work hooks."""

    receipts = []
    inspection = profile_sdk.validate_source(source, runtime_dir)["inspection"]
    profile_id = inspection["profile"]["id"]
    desired_root = inspection["profile_suite_root"]
    state = _profile_state(runtime_dir, profile_id)
    for action in _required_actions(state, desired_root):
        values = {"granted_permissions": ["storage"]} if action == "activate" else {}
        plan = profile_sdk.lifecycle_plan(runtime_dir, action, source, **values)
        answer = profile_sdk.answer_decision(
            plan["decisionCard"], "approve", authorized_by
        )
        receipts.append(
            profile_sdk.authorized_lifecycle_apply(runtime_dir, plan, answer)
        )
    return receipts


def prepare_fresh_recovery_profile(
    runtime_dir: str | Path, actor: str, source: str | Path
) -> dict[str, Any]:
    """Activate exact retained Profile bytes without replaying Work setup."""

    resolved_source = Path(source).resolve()
    inspection = profile_sdk.validate_source(resolved_source, runtime_dir)["inspection"]
    profile_id = inspection["profile"]["id"]
    desired_root = inspection["profile_suite_root"]
    previous = _profile_state(runtime_dir, profile_id)
    receipts = ensure_profile_lifecycle(resolved_source, runtime_dir, actor)
    current = storage_service.profile_lifecycle(
        runtime_dir,
        "get",
        profile_id=profile_id,
    )
    if (
        not current.get("activated")
        or not current.get("qualified")
        or current.get("profile_suite_root") != desired_root
    ):
        raise RuntimeError(
            "Fresh recovery did not activate the exact Work Control Profile root"
        )
    return {
        "schema": "kungfu.work.fresh-recovery-profile/v1",
        "status": "reconciled" if receipts else "ready",
        "profileId": profile_id,
        "previousProfileSuiteRoot": (
            previous.get("profile_suite_root") if previous is not None else None
        ),
        "profileSuiteRoot": desired_root,
        "profileLifecycleReceiptCount": len(receipts),
        "profileContractMutation": "not-permitted",
        "writeOccurred": bool(receipts),
    }
