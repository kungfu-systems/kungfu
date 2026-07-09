#  SPDX-License-Identifier: Apache-2.0
#
# Shared append helpers for reported Rewind facts. Managed-run and trace own
# processes; this module owns the lower-fidelity path where a user, agent, or
# script reports facts after using an external workflow.

from __future__ import annotations

import json
import os
import uuid
from typing import Any

import kungfu
from kungfu.rewind import (
    ACTION_APPROVAL_DECISION,
    ACTION_RUN_BEGIN,
    ACTION_RUN_END,
    SCHEMA_VERSION,
    bundle,
    cost_wire,
    events,
)
from kungfu.rewind.cost.model import AttributionLevel, CostSnapshot, TokenUsage
from kungfu.rewind.fb.CaptureLayer import CaptureLayer
from kungfu.rewind.fb.Decision import Decision
from kungfu.rewind.fb.RunStatus import RunStatus
from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle

DECISION_BY_NAME = {
    "approve": Decision.Approve,
    "deny": Decision.Deny,
    "interrupt": Decision.Interrupt,
    "resume": Decision.Resume,
}

RUN_STATUS_BY_NAME = {
    "running": RunStatus.Running,
    "succeeded": RunStatus.Succeeded,
    "failed": RunStatus.Failed,
    "interrupted": RunStatus.Interrupted,
    "blocked": RunStatus.Failed,
}

ATTRIBUTION_BY_NAME = {level.value: level for level in AttributionLevel}


def new_run_id() -> str:
    return uuid.uuid4().hex[:12]


def _source(run_id: str, runtime_dir: str) -> dict[str, Any]:
    return {
        "mode": "LIVE",
        "role": "SYSTEM",
        "namespace": "rewind",
        "name": run_id,
        "dest": 0,
    }


def bundle_dir(runtime_dir: str, run_id: str) -> str:
    return os.path.join(runtime_dir, "rewind", run_id, "bundle")


def emit_manifest(
    runtime_dir: str,
    run_id: str,
    *,
    capture_mode: str = "reported",
    extra: dict[str, Any] | None = None,
) -> str:
    target = bundle_dir(runtime_dir, run_id)
    os.makedirs(target, exist_ok=True)
    manifest_extra = {
        "fact_bridge": {
            "schema": "kungfu.fact-bridge/v1",
            "capture_mode": capture_mode,
            "source": "reported",
        }
    }
    if extra:
        manifest_extra["fact_bridge"].update(extra)
    return bundle.emit(
        target, runtime_dir, _source(run_id, runtime_dir), manifest_extra
    )


def _episode(
    runtime_dir: str, run_id: str, *, actor: str = "report"
) -> RuntimeEpisodeLifecycle:
    return RuntimeEpisodeLifecycle.resume_or_begin(
        runtime_dir,
        namespace="rewind",
        name=run_id,
        title=f"reported run {run_id}",
        actor=actor,
        source=f"rewind:{run_id}",
    )


def emit_event(runtime_dir: str, run_id: str, action_type: str, payload: bytes) -> None:
    _episode(runtime_dir, run_id).record_event(action_type, payload, run_id=run_id)


def begin_run(
    runtime_dir: str,
    *,
    run_id: str,
    provider: str,
    cwd: str | None,
    work_id: str | None,
    command: str | None = None,
) -> str:
    command_text = command or f"{provider} reported-run"
    runtime = f"reported:{cwd}" if cwd else "reported"
    episode = _episode(runtime_dir, run_id, actor=provider)
    episode.record_event(
        ACTION_RUN_BEGIN,
        events.run_begin(
            run_id=run_id,
            command=command_text,
            runtime=runtime,
            supervisor_version=kungfu.__version__,
            schema_version=SCHEMA_VERSION,
        ),
        run_id=run_id,
    )
    manifest = emit_manifest(
        runtime_dir,
        run_id,
        extra={"provider": provider, "work_id": work_id, "cwd": cwd},
    )
    episode.attach_payload_ref(manifest)
    return manifest


def end_run(runtime_dir: str, *, run_id: str, status: str, exit_code: int) -> str:
    episode = _episode(runtime_dir, run_id)
    episode.record_event(
        ACTION_RUN_END,
        events.run_end(run_id, RUN_STATUS_BY_NAME[status], exit_code),
        run_id=run_id,
    )
    manifest = emit_manifest(runtime_dir, run_id, extra={"status": status})
    episode.attach_payload_ref(manifest)
    episode.close(ok=status == "succeeded", reason=f"reported-run {status}")
    return manifest


def report_cost(
    runtime_dir: str,
    *,
    run_id: str,
    provider: str,
    surface: str,
    source: str,
    attribution: str,
    work_id: str | None = None,
    model: str | None = None,
    session_id: str | None = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cached_input_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    reasoning_tokens: int = 0,
    cost_usd: float | None = None,
    raw_ref: str | None = None,
) -> str:
    snapshot = CostSnapshot(
        provider=provider,
        surface=surface,
        attribution=ATTRIBUTION_BY_NAME[attribution],
        source=source,
        tokens=TokenUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_input_tokens=cached_input_tokens,
            cache_creation_input_tokens=cache_creation_input_tokens,
            reasoning_tokens=reasoning_tokens,
        ),
        model=model,
        session_id=session_id,
        run_id=run_id,
        work_id=work_id,
        cost_usd=cost_usd,
        raw_ref=raw_ref,
    )
    action_type, payload = cost_wire.snapshot_to_event(snapshot, CaptureLayer.Adapter)
    emit_event(runtime_dir, run_id, action_type, payload)
    return emit_manifest(
        runtime_dir,
        run_id,
        extra={
            "cost_attribution": snapshot.attribution.value,
            "cost_confidence": snapshot.confidence,
            "cost_usd_known": snapshot.cost_usd is not None,
        },
    )


def report_approval(
    runtime_dir: str,
    *,
    run_id: str,
    decision: str,
    request_id: str | None = None,
    surface: str | None = None,
    decided_by: str | None = None,
    detail: str | None = None,
    reason: str | None = None,
) -> str:
    emit_event(
        runtime_dir,
        run_id,
        ACTION_APPROVAL_DECISION,
        events.approval_decision(
            run_id=run_id,
            request_id=request_id,
            decision=DECISION_BY_NAME[decision],
            surface=surface,
            decided_by=decided_by,
            detail=detail,
            reason=reason,
        ),
    )
    return emit_manifest(
        runtime_dir,
        run_id,
        extra={"approval_decision": decision, "approval_surface": surface},
    )


def report_event(
    runtime_dir: str,
    *,
    run_id: str,
    event_type: str,
    message: str,
    severity: str = "info",
) -> str:
    target = bundle_dir(runtime_dir, run_id)
    os.makedirs(target, exist_ok=True)
    path = os.path.join(target, "report-events.jsonl")
    row = {
        "schema": "kungfu.report-event/v1",
        "run_id": run_id,
        "type": event_type,
        "severity": severity,
        "message": message,
    }
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, sort_keys=True))
        f.write("\n")
    return emit_manifest(
        runtime_dir,
        run_id,
        extra={
            "report_events": {
                "path": "report-events.jsonl",
                "latest_type": event_type,
                "latest_severity": severity,
            }
        },
    )
