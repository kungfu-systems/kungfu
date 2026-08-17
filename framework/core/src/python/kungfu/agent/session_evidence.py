# SPDX-License-Identifier: Apache-2.0

"""Immutable evidence derived from a completed native Agent Session."""

from __future__ import annotations

import copy
from datetime import UTC, datetime
import json
from pathlib import Path
from typing import Any, Callable
import uuid

from kungfu.agent import run_agent
from kungfu.content_hash import compute_content_hash_value
from kungfu.rewind import bundle

JsonObject = dict[str, Any]


def _final_observation_text(snapshot: JsonObject) -> str:
    """Return only output retained by the final native Session snapshot."""

    if snapshot.get("retainedAgentResponse") is True:
        agent_text = str(snapshot.get("agentText") or "").strip()
        if agent_text:
            return agent_text
    terminal = snapshot.get("terminal") or {}
    vt = terminal.get("vt") or {}
    return "\n".join(str(line) for line in vt.get("lines") or []).strip()


def load_execution_agent_report(
    path: str | Path,
    runtime_dir: str | Path,
    initiative_id: str,
    assignment_id: str,
    *,
    require_success: bool = True,
) -> tuple[Path, JsonObject]:
    report_path = Path(path).expanduser().resolve()
    allowed_root = (Path(runtime_dir) / "agent-runs").resolve()
    if report_path != allowed_root and allowed_root not in report_path.parents:
        raise ValueError("Agent report must belong to this workspace runtime")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("schema") != run_agent.REPORT_SCHEMA:
        raise ValueError("Agent report schema is not supported")
    expected_root = run_agent.canonical_root(
        {key: value for key, value in report.items() if key != "reportRoot"}
    )
    if report.get("reportRoot") != expected_root:
        raise ValueError("Agent report root does not match its content")
    work_ref = (report.get("work") or {}).get("workRef") or {}
    if (
        work_ref.get("entityType") != "assignment"
        or work_ref.get("entityId") != assignment_id
    ):
        raise ValueError("Agent report is not bound to this Assignment")
    if require_success and report.get("launch", {}).get("exitCode") != 0:
        raise ValueError("Agent report does not contain a successful execution")
    return report_path, report


def finalize_session_agent_report(
    path: str | Path,
    runtime_dir: str | Path,
    initiative_id: str,
    assignment_id: str,
    *,
    workspace_root: str | Path,
    session_invoke: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> tuple[Path, JsonObject]:
    """Seal the final observable Session state into a new immutable report."""

    source_path, source = load_execution_agent_report(
        path,
        runtime_dir,
        initiative_id,
        assignment_id,
    )
    source_session = source.get("session") or {}
    session_ref = {
        "workConsoleId": str(source_session.get("workConsoleId") or ""),
        "sessionAttemptId": str(source_session.get("sessionAttemptId") or ""),
    }
    if not all(session_ref.values()):
        raise ValueError("Agent report has no finalizable Session reference")
    invoke = session_invoke or (
        lambda request: run_agent.session_surface.invoke_for_project(
            request,
            fallback_runtime_dir=str(runtime_dir),
            cwd=str(workspace_root),
        )
    )
    status = invoke({"operation": "status", "session": session_ref})
    if any(status.get(key) != value for key, value in session_ref.items()):
        raise ValueError("Agent Session status does not match the retained report")
    attention = (status.get("workAgent") or {}).get("attention") or {}
    if status.get("live") is True or attention.get("kind") != "ready-for-review":
        raise ValueError(
            "Agent Session must end at ready-for-review before finalization"
        )
    snapshot = invoke(
        {
            "operation": "snapshot",
            "session": session_ref,
            "requestedSequence": 0,
        }
    )
    observation_text = _final_observation_text(snapshot)
    if not observation_text:
        raise ValueError("Agent Session final snapshot contains no observable output")

    finalization_id = f"{source['runId']}-session-final-{uuid.uuid4().hex}"
    bundle_dir = Path(runtime_dir) / "agent-runs" / finalization_id / "bundle"
    bundle_dir.mkdir(parents=True, exist_ok=False)
    report_path = bundle_dir / "report.json"
    manifest_path = bundle_dir / "manifest.json"
    report_body = copy.deepcopy(
        {key: value for key, value in source.items() if key != "reportRoot"}
    )
    report_body["providerObservation"] = {
        **(source.get("providerObservation") or {}),
        "text": observation_text,
    }
    report_body["session"] = status
    report_body["sessionFinalization"] = {
        "schema": "kungfu.agent-session.final-evidence/v1",
        "sourceReportPath": str(source_path),
        "sourceReportRoot": source["reportRoot"],
        "session": session_ref,
        "statusRoot": run_agent.canonical_root(status),
        "snapshotRoot": run_agent.canonical_root(snapshot),
        "observedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
    report_body["episode"] = {
        **source["episode"],
        "manifestPath": str(manifest_path),
        "reportPath": str(report_path),
    }
    report = {**report_body, "reportRoot": run_agent.canonical_root(report_body)}
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    bundle.emit(
        str(bundle_dir),
        str(runtime_dir),
        {
            "mode": "LIVE",
            "role": "SYSTEM",
            "namespace": "agent-run-finalization",
            "name": finalization_id,
            "dest": 0,
        },
        extra={
            "agent_run": {
                "schema": run_agent.REPORT_SCHEMA,
                "report": "report.json",
                "reportSha256": compute_content_hash_value(report_path.read_bytes()),
                "profileRoot": report["runtimeProfile"]["root"],
                "workRefRoot": run_agent.canonical_root(report["work"]["workRef"]),
                "completionAuthority": False,
                "derivedFromReportRoot": source["reportRoot"],
            }
        },
    )
    return report_path, report
