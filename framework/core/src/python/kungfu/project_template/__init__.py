# SPDX-License-Identifier: Apache-2.0

"""Safe, content-bound project templates shared by product surfaces.

Template prose is ordinary project material.  The initial Work crosses the
existing Assignment capture boundary and remains pending admission until a user
explicitly starts it.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path, PurePosixPath
from typing import Any

from kungfu import assignment_orchestration as orchestration
from kungfu.initiative_family.canonical import semantic_root
from kungfu.workspace import resolve_workspace_target

TEMPLATE_SCHEMA = "kungfu.project-template/v1"
PLAN_SCHEMA = "kungfu.project-template.plan/v1"
RECEIPT_SCHEMA = "kungfu.project-template.creation-receipt/v1"
DEFAULT_TEMPLATE_ID = "kungfu.agent-work-starter"
BLANK_TEMPLATE_ID = "kungfu.blank-project"
TEMPLATE_FILES = {
    DEFAULT_TEMPLATE_ID: "starter-project.json",
    BLANK_TEMPLATE_ID: "blank-project.json",
}
FORBIDDEN_ROOTS = {".git", ".kungfu"}


class ProjectTemplateError(ValueError):
    """A fail-closed project-template diagnosis."""


def _template_candidates(template_id: str) -> list[Path]:
    filename = TEMPLATE_FILES.get(template_id)
    if filename is None:
        return []
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
            Path(root).expanduser() / "agent-work-lab" / "experience" / filename
        )
    candidates.append(
        Path(__file__).resolve().parents[6]
        / "extensions"
        / "agent-work-lab"
        / "experience"
        / filename
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
        or any(part in FORBIDDEN_ROOTS for part in path.parts)
    ):
        raise ProjectTemplateError(f"unsafe template file path: {value}")
    return path


def load_project_template(
    template_id: str = DEFAULT_TEMPLATE_ID,
    *,
    template_path: Path | None = None,
) -> tuple[dict[str, Any], Path, str]:
    candidates = [template_path] if template_path else _template_candidates(template_id)
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
        if initial_work is None:
            return payload, candidate.resolve(), semantic_root(payload)
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
        return payload, candidate.resolve(), semantic_root(payload)
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


def _project_plan(
    payload: dict[str, Any],
    source_path: Path,
    template_root: str,
    target: Path,
) -> dict[str, Any]:
    initial_work = payload.get("initialWork")
    preimage = {
        "schema": PLAN_SCHEMA,
        "templateId": payload["id"],
        "templateVersion": payload["version"],
        "templateRoot": template_root,
        "templateSource": str(source_path),
        "destination": str(target),
        "files": _file_plan(payload),
        "initialWork": (
            {
                "state": "capture-pending",
                "initiativeId": initial_work["initiativeId"],
                "assignmentId": initial_work["assignmentId"],
                "title": initial_work["title"],
                "acceptanceChecks": initial_work["acceptanceChecks"],
            }
            if initial_work
            else {"state": "not-created"}
        ),
        "effects": [
            f"Create {len(payload['files'])} project files under {target}",
            *(
                [
                    "Capture one content-addressed initial Work request under "
                    "the project workspace"
                ]
                if initial_work
                else []
            ),
        ],
        "skippedEffects": [
            "No existing path will be overwritten",
            (
                "No Work is admitted, assigned, executed, or completed"
                if initial_work
                else "No Assignment or runtime state is created"
            ),
            "No Git repository, ignore rule, commit, remote, push, or publication is created",
        ],
        "confirmationRequired": True,
        "writeOccurred": False,
    }
    return {**preimage, "planRoot": semantic_root(preimage)}


def default_project_destination(
    payload: dict[str, Any],
    *,
    parent: str | Path | None = None,
) -> Path:
    root = (
        Path(parent).expanduser()
        if parent is not None
        else Path.home() / "Documents" / "Kungfu"
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
    return _project_plan(payload, source_path, template_root, target)


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
            "assignment_id": work["assignmentId"],
            "initiative_id": work["initiativeId"],
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


def _resume_verification(
    destination: Path,
    files: list[dict[str, str]],
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
                "matchesTemplate": observed == row["contentRoot"],
                "passed": observed is not None,
            }
        )
    return {"ok": all(row["passed"] for row in checks), "checks": checks}


def _captured_project_work(candidate: Path) -> dict[str, Any] | None:
    try:
        captured = orchestration.load_captured_request(candidate)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    request = captured["request"]
    source = request.get("source") or {}
    if (
        source.get("kind") != "kungfu-product"
        or source.get("surface") != "project-work-composer"
    ):
        return None
    work = request.get("workDefinition") or {}
    initiative_id = str(work.get("initiative_id") or "").strip()
    assignment_id = str(work.get("assignment_id") or "").strip()
    title = str(work.get("title") or "").strip()
    objective = str(work.get("objective") or "").strip()
    acceptance_checks = work.get("acceptance_criteria")
    if (
        not initiative_id
        or not assignment_id
        or not title
        or not objective
        or not isinstance(acceptance_checks, list)
        or not acceptance_checks
        or any(not isinstance(row, str) or not row.strip() for row in acceptance_checks)
    ):
        return None
    return {
        "state": "captured-pending-admission",
        "initiativeId": initiative_id,
        "assignmentId": assignment_id,
        "title": title,
        "objective": objective,
        "acceptanceChecks": [row.strip() for row in acceptance_checks],
        "requestRoot": captured["request_root"],
        "receiptRoot": captured["capture_receipt_roots"][-1],
        "requestPath": captured["request_path"],
    }


def _project_works(target: Path) -> list[dict[str, Any]]:
    works = []
    candidates = sorted(
        (target / ".kungfu" / "inbox" / "assignment-requests").glob(
            "sha256/*/*/request.json"
        ),
        key=str,
    )
    for candidate in candidates:
        if work := _captured_project_work(candidate):
            works.append(work)
    return sorted(
        works,
        key=lambda work: (work["initiativeId"], work["assignmentId"]),
    )


def _latest_project_work(target: Path) -> dict[str, Any] | None:
    candidates = sorted(
        (target / ".kungfu" / "inbox" / "assignment-requests").glob(
            "sha256/*/*/request.json"
        ),
        key=lambda path: (path.stat().st_mtime_ns, str(path)),
        reverse=True,
    )
    for candidate in candidates:
        if work := _captured_project_work(candidate):
            return work
    return None


def _with_retained_work_state(
    target: Path,
    works: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    sealed = orchestration.list_sealed_assignment_states(target)
    by_subject: dict[str, list[dict[str, Any]]] = {}
    for state in sealed["states"]:
        by_subject.setdefault(str(state["assignment_subject"]), []).append(state)
    result = []
    for work in works:
        states = by_subject.get(f"kungfu:{work['assignmentId']}", [])
        settled = [state for state in states if state["settled"]]
        retained = settled or states
        if not retained:
            result.append(work)
            continue
        selected = sorted(
            retained,
            key=lambda state: (str(state["phase"]), str(state["state_root"])),
        )[-1]
        result.append(
            {
                **work,
                "phase": selected["phase"],
                "settled": bool(settled),
                "stateRoot": selected["state_root"],
            }
        )
    return result


def resume_project_template(
    workspace: str | Path,
    *,
    template_id: str = DEFAULT_TEMPLATE_ID,
    template_path: Path | None = None,
) -> dict[str, Any]:
    target = Path(workspace).expanduser().resolve()
    if not target.is_dir():
        raise ProjectTemplateError(
            f"Starter Project workspace is unavailable: {target}"
        )
    payload, source_path, template_root = load_project_template(
        template_id, template_path=template_path
    )
    if not payload.get("initialWork"):
        raise ProjectTemplateError(
            f"workspace template has no resumable initial Work: {template_id}"
        )
    candidates = sorted(
        (target / ".kungfu" / "inbox" / "assignment-requests").glob(
            "sha256/*/*/request.json"
        )
    )
    request_path = None
    request = None
    for candidate in candidates:
        try:
            value = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        source = value.get("source") or {}
        work = value.get("workDefinition") or {}
        if (
            source.get("kind") == "kungfu-project-template"
            and source.get("templateId") == template_id
            and source.get("templateRoot") == template_root
            and work.get("initiative_id") == payload["initialWork"]["initiativeId"]
            and work.get("assignment_id") == payload["initialWork"]["assignmentId"]
        ):
            request_path = candidate
            request = value
            break
    if request_path is None or request is None:
        raise ProjectTemplateError(
            f"workspace is not the exact {template_id} Starter Project"
        )
    request_root = semantic_root(request)
    if request_path.parent.name != request_root.removeprefix("sha256:"):
        raise ProjectTemplateError(
            "Starter Project request root does not match its path"
        )
    receipt_candidates = sorted(
        (request_path.parent / "receipts" / "sha256").glob("*.json")
    )
    capture_receipt = None
    capture_receipt_path = None
    for candidate in receipt_candidates:
        try:
            value = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if value.get("requestRoot") == request_root:
            capture_receipt = value
            capture_receipt_path = candidate
            break
    if capture_receipt is None or capture_receipt_path is None:
        raise ProjectTemplateError("Starter Project capture receipt is unavailable")
    receipt_root = capture_receipt.get("receiptRoot")
    expected_receipt_root = semantic_root(
        {key: value for key, value in capture_receipt.items() if key != "receiptRoot"}
    )
    if receipt_root != expected_receipt_root or capture_receipt_path.stem != str(
        receipt_root
    ).removeprefix("sha256:"):
        raise ProjectTemplateError("Starter Project capture receipt root is invalid")
    plan = _project_plan(payload, source_path, template_root, target)
    verification = _resume_verification(target, plan["files"])
    if not verification["ok"]:
        raise ProjectTemplateError(
            "Starter Project is missing one or more retained project files"
        )
    initial_work = {
        "state": "captured-pending-admission",
        "initiativeId": payload["initialWork"]["initiativeId"],
        "assignmentId": payload["initialWork"]["assignmentId"],
        "title": payload["initialWork"]["title"],
        "objective": payload["initialWork"]["objective"],
        "acceptanceChecks": payload["initialWork"]["acceptanceChecks"],
        "requestRoot": request_root,
        "receiptRoot": receipt_root,
        "requestPath": str(request_path),
    }
    project_works = _project_works(target)
    works = [initial_work]
    seen = {(initial_work["initiativeId"], initial_work["assignmentId"])}
    for work in project_works:
        identity = (work["initiativeId"], work["assignmentId"])
        if identity not in seen:
            works.append(work)
            seen.add(identity)
    works = _with_retained_work_state(target, works)
    receipt_preimage = {
        "schema": RECEIPT_SCHEMA,
        "status": "resumed",
        "templateId": template_id,
        "templateRoot": template_root,
        "planRoot": plan["planRoot"],
        "destination": str(target),
        "actor": "retained-project",
        "files": plan["files"],
        "verification": verification,
        "initialWork": {
            "state": "captured-pending-admission",
            "initiativeId": payload["initialWork"]["initiativeId"],
            "assignmentId": payload["initialWork"]["assignmentId"],
            "requestRoot": request_root,
            "receiptRoot": receipt_root,
            "requestPath": str(request_path),
        },
        "works": works,
        **(
            {"activeWork": active_work}
            if (active_work := _latest_project_work(target)) is not None
            else {}
        ),
        "openAction": payload["openAction"],
        "nonClaims": payload["nonClaims"],
        "writeOccurred": False,
    }
    return {
        **receipt_preimage,
        "receiptRoot": semantic_root(receipt_preimage),
    }


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
        capture = None
        if payload.get("initialWork"):
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
        "initialWork": (
            {
                "state": "captured-pending-admission",
                "initiativeId": payload["initialWork"]["initiativeId"],
                "assignmentId": payload["initialWork"]["assignmentId"],
                "requestRoot": capture["requestRoot"],
                "receiptRoot": capture["receiptRoot"],
                "requestPath": capture["requestPath"],
            }
            if capture
            else {"state": "not-created"}
        ),
        "openAction": payload["openAction"],
        "nonClaims": payload["nonClaims"],
        "writeOccurred": True,
    }
    return {
        **receipt_preimage,
        "receiptRoot": semantic_root(receipt_preimage),
    }
