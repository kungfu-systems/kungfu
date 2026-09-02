# SPDX-License-Identifier: Apache-2.0

"""Fail-closed starter project templates owned by Agent Work Lab."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path, PurePosixPath
from typing import Any

from kungfu import assignment_orchestration as orchestration
from kungfu.agent_work_lab_evidence import (
    DEFAULT_TEMPLATE_ID,
    FORBIDDEN_TEMPLATE_ROOTS,
    PLAN_SCHEMA,
    RECEIPT_SCHEMA,
    TEMPLATE_SCHEMA,
)
from kungfu.initiative_family import canonical as assignment_canonical
from kungfu.workspace import resolve_workspace_target


class ProjectTemplateError(ValueError):
    """A fail-closed project-template diagnosis."""


def _template_candidates() -> list[Path]:
    candidates: list[Path] = []
    roots = [
        value
        for value in (
            os.environ.get("KF_BUNDLED_EXTENSION_ROOT"),
            *os.environ.get("KF_EXTENSION_PATH", "").split(os.pathsep),
        )
        if value
    ]
    for root in roots:
        candidates.append(
            Path(root).expanduser()
            / "agent-work-lab"
            / "experience"
            / "starter-project.json"
        )
    candidates.append(
        Path(__file__).resolve().parents[5]
        / "extensions"
        / "agent-work-lab"
        / "experience"
        / "starter-project.json"
    )
    return candidates


def _safe_relative_path(value: Any) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        raise ProjectTemplateError("template file path must be a non-empty string")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or value != path.as_posix()
        or any(part in {"", ".", ".."} for part in path.parts)
        or any(part in FORBIDDEN_TEMPLATE_ROOTS for part in path.parts)
    ):
        raise ProjectTemplateError(f"unsafe template file path: {value}")
    return path


def load_project_template(
    template_id: str = DEFAULT_TEMPLATE_ID,
    *,
    template_path: Path | None = None,
) -> tuple[dict[str, Any], Path, str]:
    candidates = [template_path] if template_path else _template_candidates()
    for candidate in candidates:
        if candidate is None or not candidate.is_file():
            continue
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ProjectTemplateError(
                f"invalid project template JSON: {candidate}"
            ) from error
        if payload.get("schema") != TEMPLATE_SCHEMA:
            raise ProjectTemplateError(f"invalid project template schema: {candidate}")
        if payload.get("id") != template_id:
            if template_path:
                raise ProjectTemplateError(
                    f"project template id mismatch: expected {template_id}"
                )
            continue
        files = payload.get("files")
        if not isinstance(files, list) or not files:
            raise ProjectTemplateError("project template requires at least one file")
        seen: set[str] = set()
        for row in files:
            if not isinstance(row, dict):
                raise ProjectTemplateError("project template file must be an object")
            relative = _safe_relative_path(row.get("path"))
            if relative.as_posix() in seen:
                raise ProjectTemplateError(
                    f"duplicate template file path: {relative.as_posix()}"
                )
            seen.add(relative.as_posix())
            if not isinstance(row.get("content"), str):
                raise ProjectTemplateError(
                    f"template file content must be text: {relative.as_posix()}"
                )
        initial_work = payload.get("initialWork")
        required_work = {
            "initiativeId",
            "assignmentId",
            "title",
            "objective",
            "acceptanceChecks",
        }
        if not isinstance(initial_work, dict) or not required_work.issubset(
            initial_work
        ):
            raise ProjectTemplateError("project template initialWork is incomplete")
        if not all(
            isinstance(initial_work[field], str) and initial_work[field]
            for field in required_work - {"acceptanceChecks"}
        ):
            raise ProjectTemplateError("project template Work identities are invalid")
        checks = initial_work["acceptanceChecks"]
        if not isinstance(checks, list) or not all(
            isinstance(check, str) and check for check in checks
        ):
            raise ProjectTemplateError(
                "project template acceptanceChecks must be non-empty strings"
            )
        return payload, candidate.resolve(), assignment_canonical.semantic_root(payload)
    raise ProjectTemplateError(
        f"project template is unavailable: {template_id}; install its KFX Suite"
    )


def _file_plan(payload: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "path": _safe_relative_path(row["path"]).as_posix(),
            "contentRoot": "sha256:"
            + hashlib.sha256(row["content"].encode("utf-8")).hexdigest(),
        }
        for row in payload["files"]
    ]


def default_project_destination(
    payload: dict[str, Any],
    *,
    parent: str | Path | None = None,
) -> Path:
    root = (
        Path(parent).expanduser()
        if parent is not None
        else Path.home() / "Kungfu Projects"
    ).resolve()
    name = str(payload.get("suggestedDirectoryName") or "kungfu-project")
    candidate = root / name
    index = 2
    while candidate.exists():
        candidate = root / f"{name}-{index}"
        index += 1
    return candidate


def plan_project_template(
    template_id: str,
    destination: str | Path | None = None,
    *,
    parent: str | Path | None = None,
    template_path: Path | None = None,
) -> dict[str, Any]:
    payload, source_path, template_root = load_project_template(
        template_id, template_path=template_path
    )
    target = (
        Path(destination).expanduser().resolve()
        if destination is not None
        else default_project_destination(payload, parent=parent)
    )
    if target.exists():
        raise ProjectTemplateError(f"destination already exists: {target}")
    if target == target.parent:
        raise ProjectTemplateError("destination cannot be a filesystem root")
    preimage = {
        "schema": PLAN_SCHEMA,
        "templateId": template_id,
        "templateVersion": payload["version"],
        "templateRoot": template_root,
        "templateSource": str(source_path),
        "destination": str(target),
        "files": _file_plan(payload),
        "initialWork": {
            "state": "capture-pending",
            "initiativeId": payload["initialWork"]["initiativeId"],
            "assignmentId": payload["initialWork"]["assignmentId"],
            "title": payload["initialWork"]["title"],
            "acceptanceChecks": payload["initialWork"]["acceptanceChecks"],
        },
        "effects": [
            f"Create {len(payload['files'])} project files under {target}",
            "Capture one content-addressed initial Work request under the project "
            "workspace",
        ],
        "skippedEffects": [
            "No existing path will be overwritten",
            "No Work is admitted, assigned, executed, or completed",
            "No Git repository, ignore rule, commit, remote, push, or publication "
            "is created",
        ],
        "confirmationRequired": True,
        "writeOccurred": False,
    }
    return {**preimage, "planRoot": assignment_canonical.semantic_root(preimage)}


def _assignment_request(payload: dict[str, Any], template_root: str) -> dict[str, Any]:
    work = payload["initialWork"]
    return {
        "schema": "kungfu.assignment-request/v1",
        "source": {
            "kind": "kungfu-project-template",
            "templateId": payload["id"],
            "templateRoot": template_root,
        },
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {
            "goal_id": work["assignmentId"],
            "mission_id": work["initiativeId"],
            "title": work["title"],
            "objective": work["objective"],
            "acceptance_criteria": work["acceptanceChecks"],
            "project_template_id": payload["id"],
            "project_template_root": template_root,
        },
    }


def _verify_created_files(
    destination: Path, files: list[dict[str, str]]
) -> dict[str, Any]:
    checks = []
    for row in files:
        candidate = destination.joinpath(*PurePosixPath(row["path"]).parts)
        observed = (
            "sha256:" + hashlib.sha256(candidate.read_bytes()).hexdigest()
            if candidate.is_file()
            else None
        )
        checks.append(
            {
                "path": row["path"],
                "expectedRoot": row["contentRoot"],
                "observedRoot": observed,
                "passed": observed == row["contentRoot"],
            }
        )
    return {"ok": all(row["passed"] for row in checks), "checks": checks}


def create_project_template(
    template_id: str,
    destination: str | Path,
    *,
    expected_plan_root: str,
    actor: str,
    template_path: Path | None = None,
) -> dict[str, Any]:
    if not actor.strip():
        raise ProjectTemplateError("actor is required")
    plan = plan_project_template(template_id, destination, template_path=template_path)
    if plan["planRoot"] != expected_plan_root:
        raise ProjectTemplateError("project template plan is stale or mismatched")
    payload, _, template_root = load_project_template(
        template_id, template_path=template_path
    )
    target = Path(plan["destination"])
    created = False
    try:
        target.mkdir(parents=True, exist_ok=False)
        created = True
        for row in payload["files"]:
            relative = _safe_relative_path(row["path"])
            output = target.joinpath(*relative.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("x", encoding="utf-8", newline="") as stream:
                stream.write(row["content"])
        verification = _verify_created_files(target, plan["files"])
        if not verification["ok"]:
            raise ProjectTemplateError(
                "created project files failed exact verification"
            )
        workspace_target = resolve_workspace_target(
            "capture-only",
            str(target),
            cwd=str(target),
        )
        capture = orchestration.capture_assignment_request(
            _assignment_request(payload, template_root), workspace_target
        )
        if capture.get("status") not in {"captured", "already-present"}:
            raise ProjectTemplateError("initial Work request capture failed")
    except Exception:
        if created and target.exists():
            shutil.rmtree(target)
        raise
    receipt_preimage = {
        "schema": RECEIPT_SCHEMA,
        "status": "created",
        "templateId": template_id,
        "templateRoot": template_root,
        "planRoot": plan["planRoot"],
        "destination": str(target),
        "actor": actor,
        "files": plan["files"],
        "verification": verification,
        "initialWork": {
            "state": "captured-pending-admission",
            "initiativeId": payload["initialWork"]["initiativeId"],
            "assignmentId": payload["initialWork"]["assignmentId"],
            "requestRoot": capture["requestRoot"],
            "receiptRoot": capture["receiptRoot"],
            "requestPath": capture["requestPath"],
        },
        "openAction": payload["openAction"],
        "nonClaims": payload["nonClaims"],
        "writeOccurred": True,
    }
    return {
        **receipt_preimage,
        "receiptRoot": assignment_canonical.semantic_root(receipt_preimage),
    }
