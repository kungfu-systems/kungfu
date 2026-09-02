# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable


def validate_native_authority(
    runtime_dir: str | Path,
    payload: Any,
    inspector: Callable[[str | Path, Mapping[str, Any]], dict[str, Any]],
) -> dict[str, Any] | None:
    if not isinstance(payload, Mapping):
        return None
    expected = payload.get("nativeAuthority")
    envelope = payload.get("envelope")
    if expected is None and isinstance(envelope, Mapping):
        expected = envelope.get("nativeAuthority")
    if not isinstance(expected, Mapping):
        return None
    authority = inspector(runtime_dir, expected)
    return authority if authority.get("status") != "current" else None


def authority_gate(runtime_dir, operation, payload, inspector) -> tuple[bool, Any]:
    if operation == "authority-inspect":
        expected = payload if isinstance(payload, Mapping) else None
        return True, inspector(runtime_dir, expected)
    authority = validate_native_authority(runtime_dir, payload, inspector)
    return authority is not None, authority


def operation_handler(operation: str):
    from kungfu.agent import action_loop

    operations = {
        "work-profile-bind": action_loop.bind_work_profile,
        "episode-resume-or-begin": action_loop.resume_or_begin_episode,
        "episode-inspect": action_loop.inspect_episode,
        "episode-seal": action_loop.seal_episode,
        "work-profile-atlas-refresh": action_loop.refresh_atlas,
        "completion-review": action_loop.review_completion,
        "fact-settle": action_loop.settle_fact,
        "checkpoint-save": action_loop.save_checkpoint,
        "checkpoint-load": action_loop.load_checkpoint,
        "checkpoint-resolve": action_loop.resolve_fact_ref,
    }
    handler = operations.get(operation)
    if handler is None:
        raise ValueError(f"unsupported Action Loop adapter operation: {operation}")
    return handler
