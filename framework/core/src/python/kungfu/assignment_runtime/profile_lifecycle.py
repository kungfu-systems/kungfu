# SPDX-License-Identifier: Apache-2.0

"""Work Profile lifecycle reconciliation for Assignment Runtime clients."""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal, NoReturn, overload

from kungfu import profile_sdk
from kungfu.storage import service as storage_service


WORK_CONTROL_PROFILE_ID = "kungfu.work-control"


def _missing_profile(runtime_dir: str | Path, message: str, **details: Any) -> NoReturn:
    raise profile_sdk.ProfileSdkError(
        details.pop("code"),
        message,
        profileId=WORK_CONTROL_PROFILE_ID,
        runtimeDir=str(Path(runtime_dir).expanduser().resolve()),
        **details,
    )


def _qualified_profile_state(
    runtime_dir: str | Path, *, required: bool
) -> dict[str, Any] | None:
    try:
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=WORK_CONTROL_PROFILE_ID
        )
    except ValueError as error:
        if not required and str(error).startswith("Profile not found:"):
            return None
        _missing_profile(
            runtime_dir,
            "Work Control Profile is not installed in the selected Project runtime",
            code="work-control-profile-not-installed",
        )
    if state.get("removed"):
        if not required:
            return None
        _missing_profile(
            runtime_dir,
            "Work Control Profile is removed from the selected Project runtime",
            code="work-control-profile-removed",
        )
    if state.get("qualified") and state.get("activated"):
        return state
    if not required:
        return None
    _missing_profile(
        runtime_dir,
        "Work Control Profile must be qualified and active in the selected Project runtime",
        code="work-control-profile-not-qualified",
        qualified=bool(state.get("qualified")),
        activated=bool(state.get("activated")),
    )


def _retained_profile_source(runtime_dir: str | Path, state: dict[str, Any]) -> Path:
    closure = dict((state.get("latest_event") or {}).get("closure") or {})
    profile_path = Path(str(closure.get("profile_path") or "")).expanduser()
    if not profile_path.is_file():
        return _relocated_profile_source(
            runtime_dir,
            profile_path,
        )
    return profile_path.resolve().parent


def _relocated_profile_source(
    runtime_dir: str | Path,
    profile_path: Path,
) -> Path:
    """Find only the current bundled copy of one missing retained source."""

    bundled_root = os.environ.get("KF_BUNDLED_EXTENSION_ROOT", "")
    if bundled_root:
        try:
            discovered = profile_sdk.discover_source(
                WORK_CONTROL_PROFILE_ID,
                runtime_dir,
                search_roots=[bundled_root],
            )
            return Path(discovered["source"]).expanduser().resolve()
        except (KeyError, profile_sdk.ProfileSdkError):
            pass

    _missing_profile(
        runtime_dir,
        "Qualified Work Control Profile retained source is unavailable",
        code="work-control-profile-source-unavailable",
        profilePath=str(profile_path),
        bundledExtensionRoot=bundled_root or None,
    )


@overload
def resolve_qualified_work_profile(
    runtime_dir: str | Path,
    *,
    required: Literal[True] = True,
    source: str | Path | None = None,
) -> dict[str, str]: ...


@overload
def resolve_qualified_work_profile(
    runtime_dir: str | Path,
    *,
    required: Literal[False],
    source: str | Path | None = None,
) -> dict[str, str] | None: ...


def resolve_qualified_work_profile(
    runtime_dir: str | Path,
    *,
    required: bool = True,
    source: str | Path | None = None,
) -> dict[str, str] | None:
    """Resolve the retained exact source for the qualified Work authority.

    Profile lifecycle state, rather than the caller's ambient extension search
    path, owns the source/root association.  This keeps a native Agent Console
    usable when its ``KF_RUNTIME_DIR`` and an explicit Work ``--workspace`` are
    different Projects.
    """

    state = _qualified_profile_state(runtime_dir, required=required)
    if state is None:
        return None
    retained_source = _retained_profile_source(runtime_dir, state)
    retained_root = str(state.get("profile_suite_root", ""))
    resolved_source = (
        Path(source).expanduser().resolve() if source is not None else retained_source
    )
    validated = profile_sdk.validate_source(resolved_source, runtime_dir)
    inspection = validated["inspection"]
    profile_id = str(inspection.get("profile", {}).get("id", ""))
    profile_root = str(inspection.get("profile_suite_root", ""))
    diagnosis = {
        False: (
            "work-control-profile-source-root-drift",
            "Qualified Work Control Profile retained source no longer matches its exact root",
        ),
        True: (
            "work-control-profile-source-drift",
            "Explicit Work Control Profile source does not match the qualified retained root",
        ),
    }[resolved_source != retained_source]
    if profile_id != WORK_CONTROL_PROFILE_ID or profile_root != retained_root:
        raise profile_sdk.ProfileSdkError(
            diagnosis[0],
            diagnosis[1],
            profileId=WORK_CONTROL_PROFILE_ID,
            retainedSource=str(retained_source),
            retainedRoot=retained_root,
            observedSource=str(resolved_source),
            observedProfileId=profile_id,
            observedRoot=profile_root,
        )
    return {
        "id": WORK_CONTROL_PROFILE_ID,
        "root": retained_root,
        "source": str(resolved_source),
    }


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
