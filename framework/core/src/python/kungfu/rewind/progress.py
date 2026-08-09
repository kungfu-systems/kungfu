# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os

CONTROL_RUNTIME_ENV = "KUNGFU_CONTROL_RUNTIME_DIR"
WORK_REF_ENV = "KUNGFU_WORK_REF"
ATTEMPT_ID_ENV = "KUNGFU_AGENT_ATTEMPT_ID"


def report_runtime_dir(default_runtime_dir: str) -> str:
    configured = os.environ.get(CONTROL_RUNTIME_ENV, "").strip()
    return os.path.abspath(os.path.expanduser(configured or default_runtime_dir))


def reported_run_id(run_id: str | None) -> str:
    resolved = (run_id or os.environ.get(ATTEMPT_ID_ENV, "")).strip()
    if not resolved:
        raise ValueError(f"run id is required; pass --run or set {ATTEMPT_ID_ENV}")
    return resolved


def reported_work_ref(raw: str | None = None) -> dict[str, str] | None:
    source = raw if raw is not None else os.environ.get(WORK_REF_ENV, "")
    if not source.strip():
        return None
    try:
        value = json.loads(source)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{WORK_REF_ENV} must contain valid JSON") from exc
    required = (
        "workspaceId",
        "profileId",
        "profileRoot",
        "entityType",
        "entityId",
        "entityRoot",
    )
    if value.get("schema") != "kungfu.work-ref/v1" or any(
        not isinstance(value.get(key), str) or not value[key].strip()
        for key in required
    ):
        raise ValueError(f"{WORK_REF_ENV} must contain one complete kungfu.work-ref/v1")
    return {key: value[key].strip() for key in required}
