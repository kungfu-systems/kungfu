# SPDX-License-Identifier: Apache-2.0

"""Bounded project evidence selection and retained Agent-run recovery service."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from kungfu.initiative_family.canonical import semantic_root
from kungfu.assignment_lifecycle.ports import AssignmentRuntimePort
from kungfu.agent.session_evidence import (
    _final_observation_text as _final_observation_text,
    finalize_session_agent_report as finalize_session_agent_report,
    load_execution_agent_report as load_execution_agent_report,
)

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class EvidenceServices:
    runtime: AssignmentRuntimePort
    status: Callable[[str, str, str], JsonObject]
    receipt: Callable[[JsonObject], JsonObject]
    agent_report_summary: Callable[[JsonObject], JsonObject]


def content_root(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


_REVIEW_EVIDENCE_SUFFIXES = {
    ".csv",
    ".json",
    ".md",
    ".rst",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}
_REVIEW_EVIDENCE_EXCLUDED_DIRECTORIES = {
    ".git",
    ".kungfu",
    ".venv",
    "build",
    "dist",
    "node_modules",
    "target",
}
_REVIEW_EVIDENCE_FILE_LIMIT = 24
_REVIEW_EVIDENCE_BYTES_LIMIT = 1024 * 1024


def project_review_evidence(
    workspace: str | Path,
    report_path: str | Path,
    work_definition: JsonObject,
) -> JsonObject:
    workspace = Path(workspace).resolve()
    report_path = Path(report_path).resolve()
    try:
        report_display_path = report_path.relative_to(workspace).as_posix()
    except ValueError:
        report_display_path = str(report_path)
    explicit = work_definition.get("evidence_paths") or []
    if not isinstance(explicit, list) or any(
        not isinstance(value, str) or not value.strip() for value in explicit
    ):
        raise ValueError("Assignment evidence_paths must be an array of paths")
    candidates = []
    if explicit:
        for value in explicit:
            candidate = (workspace / value).resolve()
            if workspace not in candidate.parents or not candidate.is_file():
                raise ValueError(f"Assignment evidence path is unavailable: {value}")
            candidates.append(candidate)
    else:
        for root, directories, filenames in os.walk(workspace):
            directories[:] = sorted(
                directory
                for directory in directories
                if directory not in _REVIEW_EVIDENCE_EXCLUDED_DIRECTORIES
                and not directory.startswith(".")
            )
            for filename in sorted(filenames):
                candidate = Path(root) / filename
                if candidate.suffix.lower() not in _REVIEW_EVIDENCE_SUFFIXES:
                    continue
                try:
                    size = candidate.stat().st_size
                except OSError:
                    continue
                if size <= _REVIEW_EVIDENCE_BYTES_LIMIT:
                    candidates.append(candidate.resolve())

    def priority(candidate):
        relative = candidate.relative_to(workspace)
        parts = relative.parts
        return (
            0
            if parts and parts[0] == "deliverables"
            else 1
            if relative.as_posix() == "WORK.md"
            else 2
            if relative.as_posix() == "README.md"
            else 3
            if parts and parts[0] == "inputs"
            else 4,
            relative.as_posix(),
        )

    selected: list[Path] = []
    total_bytes = 0
    for candidate in sorted(set(candidates), key=priority):
        size = candidate.stat().st_size
        if len(selected) >= _REVIEW_EVIDENCE_FILE_LIMIT:
            break
        if total_bytes + size > _REVIEW_EVIDENCE_BYTES_LIMIT:
            continue
        selected.append(candidate)
        total_bytes += size
    if selected:
        primary, *supporting = selected
        retained_execution = []
        if report_path not in selected:
            retained_execution.append(
                {
                    "path": report_display_path,
                    "root": content_root(report_path),
                    "content": report_path.read_text(encoding="utf-8"),
                }
            )
        return {
            "mode": "project-files",
            "primary": {
                "path": primary.relative_to(workspace).as_posix(),
                "root": content_root(primary),
                "content": primary.read_text(encoding="utf-8"),
            },
            "supporting": retained_execution
            + [
                {
                    "path": candidate.relative_to(workspace).as_posix(),
                    "root": content_root(candidate),
                }
                for candidate in supporting
            ],
        }
    return {
        "mode": "execution-report",
        "primary": {
            "path": report_display_path,
            "root": content_root(report_path),
            "content": report_path.read_text(encoding="utf-8"),
        },
        "supporting": [],
    }


def latest_starter_agent_report(
    runtime_dir: str | Path, initiative_id: str, assignment_id: str
) -> JsonObject | None:
    reports = sorted(
        (Path(runtime_dir) / "agent-runs").glob("*/bundle/report.json"),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    for report_path in reports:
        try:
            _, report = load_execution_agent_report(
                report_path,
                runtime_dir,
                initiative_id,
                assignment_id,
                require_success=False,
            )
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        work_ref = (report.get("work") or {}).get("workRef") or {}
        if work_ref.get("purpose") in {
            "complete-starter-deliverable",
            "complete-project-assignment",
        }:
            return report
    return None


def resume_starter_work(
    *,
    workspace_root: str | None,
    home: bool,
    initiative_id: str,
    assignment_id: str,
    services: EvidenceServices,
) -> JsonObject:
    runtime = services.runtime(workspace_root, home, "read-only")
    identity, runtime_dir = runtime.identity, runtime.runtime_dir
    status_value = services.status(runtime_dir, initiative_id, assignment_id)
    report = latest_starter_agent_report(runtime_dir, initiative_id, assignment_id)
    if report is None:
        return {
            "schema": "kungfu.work-start.resume/v1",
            "status": "no-retained-agent-run",
            "workReceipt": None,
            "writeOccurred": False,
        }
    assignment_value = status_value["assignment"]
    request_root = assignment_value["request_root"]
    request_digest = request_root.removeprefix("sha256:")
    request_path = (
        Path(identity.data_home)
        / "inbox"
        / "assignment-requests"
        / "sha256"
        / request_digest[:2]
        / request_digest
        / "request.json"
    )
    runtime_profile = report["runtimeProfile"]
    work = {
        "requestPath": str(request_path),
        "requestRoot": request_root,
        "initiativeId": initiative_id,
        "assignmentId": assignment_id,
        "title": assignment_value["title"],
        "objective": assignment_value["objective"],
        "acceptanceChecks": list(
            assignment_value["work_definition"].get("acceptance_criteria") or []
        ),
    }
    plan_root = semantic_root(
        {
            "schema": "kungfu.work-start.resume-plan/v1",
            "queryProofRoot": status_value["query_proof_root"],
            "reportRoot": report["reportRoot"],
        }
    )
    exit_code = int(report["launch"]["exitCode"])
    receipt = services.receipt(
        {
            "schema": "kungfu.work-start.receipt/v1",
            "ok": exit_code == 0,
            "status": "agent-finished" if exit_code == 0 else "agent-failed",
            "planRoot": plan_root,
            "workPhase": status_value["phase"],
            "workspace": identity.as_dict(),
            "workRef": report["work"]["workRef"],
            "work": work,
            "agent": {
                "id": runtime_profile["id"],
                "label": runtime_profile["id"],
                "provider": runtime_profile["provider"],
                "profileRoot": runtime_profile["root"],
                "selection": runtime_profile["selection"],
                "verification": {
                    "ok": runtime_profile["verified"],
                    "available": runtime_profile["verified"],
                    "version": runtime_profile["version"],
                    "error": None,
                },
            },
            "agentReport": services.agent_report_summary(report),
            "nextActions": (
                ["run-independent-review"]
                if exit_code == 0
                else ["inspect-retained-agent-report", "retry-agent-run"]
            ),
            "nonClaims": [
                "Restoring this receipt does not rerun the Agent.",
                "Agent exit does not settle Work.",
            ],
            "writeOccurred": True,
        }
    )
    return {
        "schema": "kungfu.work-start.resume/v1",
        "status": "retained-agent-run",
        "workReceipt": receipt,
        "writeOccurred": False,
    }
