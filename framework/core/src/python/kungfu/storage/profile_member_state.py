# SPDX-License-Identifier: Apache-2.0

"""Classify the retained lifecycle state of one exact Profile member source."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from kungfu.storage import service as storage_service

ACTIVE_REQUIRED = "Profile member adapters require an active exact Profile root"
FAILURES = {
    ("missing", False, False): ACTIVE_REQUIRED,
    ("missing", True, False): ACTIVE_REQUIRED,
    ("missing", True, True): ACTIVE_REQUIRED,
    ("conflict", False, False): "Conflicting exact Profile root",
    ("conflict", False, True): "Conflicting exact Profile root",
    ("conflict", True, False): "Conflicting exact Profile root",
    ("conflict", True, True): "Conflicting exact Profile root",
    ("inactive", False, False): ACTIVE_REQUIRED,
    ("inactive", True, False): ACTIVE_REQUIRED,
}


def _load_profile_state(
    runtime_dir: str | Path, profile_id: str
) -> Mapping[str, Any] | None:
    """Return one retained lifecycle row, including inactive exact sources."""

    try:
        return storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=profile_id
        )
    except (KeyError, ValueError):
        return None


def classify(state: Mapping[str, Any] | None, profile_suite_root: str) -> str:
    """Separate missing, conflicting, inactive, and active exact roots."""

    if state is None:
        return "missing"
    if state.get("profile_suite_root") != profile_suite_root:
        return "conflict"
    if not state.get("activated"):
        return "inactive"
    return "active"


def adapter_failure(
    runtime_dir: str | Path,
    profile_id: str,
    profile_suite_root: str,
    authorized_action: bool,
    inactive_projection_read: bool,
) -> str:
    """Return the fail-closed adapter rejection message, or an empty value."""

    state = _load_profile_state(runtime_dir, profile_id)
    mode = (
        classify(state, profile_suite_root),
        authorized_action,
        inactive_projection_read,
    )
    return FAILURES.get(mode, "")
