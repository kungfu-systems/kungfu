# SPDX-License-Identifier: Apache-2.0

"""A small Projects projection over Kungfu Workspace identity.

Projects own ordinary files. Kungfu only retains machine-local locators and
content-bound creation receipts; importing an existing directory never writes
inside that directory.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from kungfu import assignment_orchestration as orchestration
from kungfu.initiative_family.canonical import semantic_root
from kungfu.project_template import (
    BLANK_TEMPLATE_ID,
    DEFAULT_TEMPLATE_ID,
    create_project_template,
    load_project_template,
    plan_project_template,
)
from kungfu.workspace import (
    forget_workspace,
    inspect_workspace,
    load_workspace_catalog,
    load_workspace_registry,
    select_workspace,
)

CATALOG_SCHEMA = "kungfu.projects.catalog/v1"
LIBRARY_SCHEMA = "kungfu.project-library/v1"
TEMPLATES_SCHEMA = "kungfu.projects.templates/v1"
IMPORT_PLAN_SCHEMA = "kungfu.project.import-plan/v1"
IMPORT_RECEIPT_SCHEMA = "kungfu.project.import-receipt/v1"
SELECTION_RECEIPT_SCHEMA = "kungfu.project.selection-receipt/v1"
REMOVE_PLAN_SCHEMA = "kungfu.project.remove-plan/v1"
REMOVE_RECEIPT_SCHEMA = "kungfu.project.remove-receipt/v1"
WORK_INVENTORY_SCHEMA = "kungfu.project-work.inventory/v1"


def _root(value: Any) -> str:
    return semantic_root(value)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _library_path(config_home: str | None = None) -> Path:
    registry_path = Path(load_workspace_registry(config_home)["registry_path"])
    return registry_path.parent.parent / "projects" / "library.json"


def _load_library(config_home: str | None = None) -> dict[str, Any]:
    path = _library_path(config_home)
    if not path.is_file():
        return {
            "schema": LIBRARY_SCHEMA,
            "projects": [],
            "hidden": [],
            "libraryPath": str(path),
        }
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid Kungfu Project Library: {path}") from error
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != LIBRARY_SCHEMA
        or not isinstance(payload.get("projects"), list)
        or not isinstance(payload.get("hidden"), list)
    ):
        raise ValueError(f"unsupported Kungfu Project Library: {path}")
    return {**payload, "libraryPath": str(path)}


def _write_library(config_home: str | None, payload: dict[str, Any]) -> None:
    path = _library_path(config_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    persisted = {key: value for key, value in payload.items() if key != "libraryPath"}
    fd, temporary = tempfile.mkstemp(
        prefix=".project-library-", suffix=".json", dir=path.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(persisted, stream, indent=2, sort_keys=True)
            stream.write("\n")
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def _canonical_project_path(value: Any) -> str:
    return str(Path(str(value)).expanduser().resolve())


def _remember_project(
    path: str | Path,
    *,
    source: str,
    config_home: str | None = None,
) -> None:
    canonical = _canonical_project_path(path)
    library = _load_library(config_home)
    remembered_at = _now()
    projects = [
        row
        for row in library["projects"]
        if _canonical_project_path(row.get("path")) != canonical
    ]
    projects.insert(
        0,
        {
            "path": canonical,
            "source": source,
            "rememberedAt": remembered_at,
        },
    )
    hidden = [
        row
        for row in library["hidden"]
        if _canonical_project_path(row.get("path")) != canonical
    ]
    _write_library(
        config_home,
        {
            "schema": LIBRARY_SCHEMA,
            "projects": projects,
            "hidden": hidden,
            "updatedAt": remembered_at,
        },
    )


def _hide_project(path: str | Path, *, config_home: str | None = None) -> None:
    canonical = _canonical_project_path(path)
    library = _load_library(config_home)
    hidden_at = _now()
    projects = [
        row
        for row in library["projects"]
        if _canonical_project_path(row.get("path")) != canonical
    ]
    hidden = [
        row
        for row in library["hidden"]
        if _canonical_project_path(row.get("path")) != canonical
    ]
    hidden.insert(0, {"path": canonical, "hiddenAt": hidden_at})
    _write_library(
        config_home,
        {
            "schema": LIBRARY_SCHEMA,
            "projects": projects,
            "hidden": hidden,
            "updatedAt": hidden_at,
        },
    )


def _project_row(value: dict[str, Any], selected_id: str | None) -> dict[str, Any]:
    locator = value.get("workspace_root") or value.get("display_path")
    path = Path(str(locator)).expanduser() if locator else None
    available = bool(path and path.is_dir())
    return {
        "schema": "kungfu.project/v1",
        "id": value.get("workspace_id"),
        "name": path.name if path else "Project",
        "path": str(path.resolve()) if path and available else str(locator or ""),
        "available": available,
        "selected": value.get("workspace_id") == selected_id,
        "initialized": bool(value.get("initialized")),
        "state": value.get("state") or ("available" if available else "unavailable"),
        "identityRoot": value.get("identity_root"),
    }


def _project_summary(path: Path, known_activity: list[str]) -> dict[str, Any]:
    activity = [value for value in known_activity if value]
    try:
        activity.append(
            datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
    except OSError:
        pass
    work_count = 0
    for candidate in (path / ".kungfu" / "inbox" / "assignment-requests").glob(
        "sha256/*/*/request.json"
    ):
        if _captured_work(candidate) is None:
            continue
        work_count += 1
        try:
            activity.append(
                datetime.fromtimestamp(candidate.stat().st_mtime, timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
        except OSError:
            pass
    return {
        "workCount": work_count,
        "updatedAt": max(activity) if activity else None,
    }


def catalog(*, config_home: str | None = None) -> dict[str, Any]:
    registry = load_workspace_registry(config_home)
    library = _load_library(config_home)
    locator_catalog = load_workspace_catalog(config_home)
    activity_by_path: dict[str, list[str]] = {}

    def remember_activity(path_value: Any, updated_at: Any) -> None:
        if not path_value or not isinstance(updated_at, str) or not updated_at:
            return
        activity_by_path.setdefault(_canonical_project_path(path_value), []).append(
            updated_at
        )

    for library_row in library["projects"]:
        remember_activity(library_row.get("path"), library_row.get("rememberedAt"))
    for recent_row in registry["recent"]:
        remember_activity(
            recent_row.get("workspace_root") or recent_row.get("display_path"),
            recent_row.get("selected_at"),
        )
    for locator_row in locator_catalog["entries"]:
        remember_activity(locator_row.get("locator"), locator_row.get("updated_at"))
    hidden = {
        _canonical_project_path(row.get("path"))
        for row in library["hidden"]
        if row.get("path")
    }
    candidates: list[tuple[str, str]] = []
    candidates.extend(
        (_canonical_project_path(row["path"]), "library")
        for row in library["projects"]
        if row.get("path")
    )
    candidates.extend(
        (
            _canonical_project_path(
                row.get("workspace_root") or row.get("display_path")
            ),
            "recent",
        )
        for row in registry["recent"]
        if row.get("workspace_kind") == "project"
        and (row.get("workspace_root") or row.get("display_path"))
    )
    candidates.extend(
        (_canonical_project_path(row["locator"]), "workspace-catalog")
        for row in locator_catalog["entries"]
        if row.get("workspace_kind") == "project"
        and row.get("locator")
        and (row.get("lifecycle") or {}).get("state") == "active"
        and row.get("available") is not False
        and Path(str(row.get("data_home") or "")).is_dir()
    )
    seen: set[str] = set()
    projects: list[dict[str, Any]] = []
    sources: dict[str, int] = {}
    selected_id = registry.get("last_workspace_id")
    selected_path = next(
        (
            _canonical_project_path(
                row.get("workspace_root") or row.get("display_path")
            )
            for row in registry["recent"]
            if row.get("workspace_id") == selected_id
            and row.get("workspace_kind") == "project"
        ),
        None,
    )
    for path, source in candidates:
        if path in seen or (path in hidden and source == "workspace-catalog"):
            continue
        seen.add(path)
        identity = inspect_workspace(path)
        if identity is None or identity.workspace_kind != "project":
            value = {
                "workspace_id": f"unavailable:{_root({'path': path})[-16:]}",
                "workspace_root": path,
                "display_path": path,
                "workspace_kind": "project",
                "initialized": False,
                "state": "unavailable",
                "identity_root": None,
            }
        else:
            value = identity.as_dict()
        row = _project_row(value, selected_id)
        if selected_path == path:
            row["selected"] = True
        row["source"] = source
        if row["available"]:
            row.update(_project_summary(Path(path), activity_by_path.get(path, [])))
        else:
            row.update(workCount=0, updatedAt=None)
        projects.append(row)
        sources[source] = sources.get(source, 0) + 1
    body = {
        "schema": CATALOG_SCHEMA,
        "projects": projects,
        "selectedProjectId": registry.get("last_workspace_id"),
        "registryPath": registry["registry_path"],
        "libraryPath": library["libraryPath"],
        "sources": sources,
        "hiddenProjectCount": len(hidden),
        "writeOccurred": False,
    }
    return {**body, "catalogRoot": _root(body)}


def templates() -> dict[str, Any]:
    rows = []
    for template_id in (DEFAULT_TEMPLATE_ID, BLANK_TEMPLATE_ID):
        payload, source_path, template_root = load_project_template(template_id)
        rows.append(
            {
                "id": payload["id"],
                "version": payload["version"],
                "title": payload["title"],
                "description": payload["description"],
                "suggestedDirectoryName": payload["suggestedDirectoryName"],
                "sourcePath": str(source_path),
                "templateRoot": template_root,
                "initialWorkTitle": (payload.get("initialWork") or {}).get("title"),
            }
        )
    body = {
        "schema": TEMPLATES_SCHEMA,
        "templates": rows,
        "writeOccurred": False,
    }
    return {**body, "catalogRoot": _root(body)}


def _captured_work(candidate: Path) -> dict[str, Any] | None:
    try:
        captured = orchestration.load_captured_request(candidate)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    request = captured["request"]
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
        "capturedAt": candidate.stat().st_mtime_ns,
    }


def _live_work_phase(target: Path, work: dict[str, Any]) -> str | None:
    runtime_dir = target / ".kungfu" / "runtime"
    if not runtime_dir.is_dir():
        return None
    try:
        from kungfu.cli.commands import assignment as assignment_commands

        status = assignment_commands._status(
            str(runtime_dir),
            work["initiativeId"],
            work["assignmentId"],
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
        return None
    phase = str(status.get("phase") or "").strip()
    return phase if phase in orchestration.PHASES else None


def work_inventory(path: str | Path) -> dict[str, Any]:
    target = Path(path).expanduser().resolve()
    if not target.is_dir():
        raise ValueError(f"project directory is unavailable: {target}")
    candidates = sorted(
        (target / ".kungfu" / "inbox" / "assignment-requests").glob(
            "sha256/*/*/request.json"
        ),
        key=lambda candidate: (candidate.stat().st_mtime_ns, str(candidate)),
    )
    works = [work for candidate in candidates if (work := _captured_work(candidate))]
    sealed = orchestration.list_sealed_assignment_states(target)
    by_subject: dict[str, list[dict[str, Any]]] = {}
    for state in sealed["states"]:
        by_subject.setdefault(str(state["assignment_subject"]), []).append(state)
    projected = []
    for work in works:
        states = by_subject.get(f"kungfu:{work['assignmentId']}", [])
        settled = [state for state in states if state["settled"]]
        retained = settled or states
        next_work = {key: value for key, value in work.items() if key != "capturedAt"}
        if retained:
            selected = sorted(
                retained,
                key=lambda state: (str(state["phase"]), str(state["state_root"])),
            )[-1]
            next_work.update(
                phase=selected["phase"],
                settled=bool(settled),
                stateRoot=selected["state_root"],
            )
        elif phase := _live_work_phase(target, work):
            next_work.update(phase=phase, settled=False)
        projected.append(next_work)
    body = {
        "schema": WORK_INVENTORY_SCHEMA,
        "projectPath": str(target),
        "works": projected,
        "activeWork": projected[-1] if projected else None,
        "writeOccurred": False,
    }
    return {**body, "inventoryRoot": _root(body)}


def plan_import(path: str | Path) -> dict[str, Any]:
    candidate = Path(path).expanduser().resolve()
    if not candidate.is_dir():
        raise ValueError(f"project directory is unavailable: {candidate}")
    identity = inspect_workspace(str(candidate))
    if identity is None or identity.workspace_kind != "project":
        raise ValueError("opening a Project requires an existing directory")
    body = {
        "schema": IMPORT_PLAN_SCHEMA,
        "project": _project_row(identity.as_dict(), None),
        "effects": ["Remember this Project on this machine", "Open this Project"],
        "skippedEffects": [
            "No file is created or changed inside the project",
            "No .kungfu directory is created",
            "No Git repository, commit, push, or publication is created",
        ],
        "confirmationRequired": True,
        "writeOccurred": False,
    }
    return {**body, "planRoot": _root(body)}


def import_project(
    path: str | Path, *, expected_plan_root: str, config_home: str | None = None
) -> dict[str, Any]:
    plan = plan_import(path)
    if plan["planRoot"] != expected_plan_root:
        raise ValueError("Project open plan is stale or mismatched")
    identity = inspect_workspace(plan["project"]["path"])
    if identity is None:
        raise ValueError("project directory became unavailable")
    selected = select_workspace(identity, config_home=config_home)
    _remember_project(
        selected["selected"]["workspace_root"],
        source="open",
        config_home=config_home,
    )
    body = {
        "schema": IMPORT_RECEIPT_SCHEMA,
        "status": "imported",
        "planRoot": plan["planRoot"],
        "project": _project_row(selected["selected"], selected["last_workspace_id"]),
        "workspace": selected["selected"],
        "registryPath": selected["registry_path"],
        "projectFilesChanged": False,
        "writeOccurred": True,
    }
    return {**body, "receiptRoot": _root(body)}


def select_project(
    path: str | Path, *, config_home: str | None = None
) -> dict[str, Any]:
    plan = plan_import(path)
    identity = inspect_workspace(plan["project"]["path"])
    if identity is None:
        raise ValueError("project directory became unavailable")
    selected = select_workspace(identity, config_home=config_home)
    _remember_project(
        selected["selected"]["workspace_root"],
        source="select",
        config_home=config_home,
    )
    body = {
        "schema": SELECTION_RECEIPT_SCHEMA,
        "status": "selected",
        "project": _project_row(selected["selected"], selected["last_workspace_id"]),
        "workspace": selected["selected"],
        "registryPath": selected["registry_path"],
        "projectFilesChanged": False,
        "writeOccurred": True,
    }
    return {**body, "receiptRoot": _root(body)}


def plan_remove(project_id: str, *, config_home: str | None = None) -> dict[str, Any]:
    project_catalog = catalog(config_home=config_home)
    remembered = next(
        (row for row in project_catalog["projects"] if row.get("id") == project_id),
        None,
    )
    if remembered is None:
        raise ValueError("project is not remembered on this machine")
    project = remembered
    body = {
        "schema": REMOVE_PLAN_SCHEMA,
        "project": project,
        "effects": ["Remove this project from Kungfu Projects on this machine"],
        "skippedEffects": [
            "The project directory and every file inside it remain untouched",
            "The project .kungfu data home and retained evidence remain untouched",
            "No Git commit, push, or publication is performed",
        ],
        "confirmationRequired": True,
        "writeOccurred": False,
    }
    return {**body, "planRoot": _root(body)}


def remove(
    project_id: str,
    *,
    expected_plan_root: str,
    config_home: str | None = None,
) -> dict[str, Any]:
    plan = plan_remove(project_id, config_home=config_home)
    if plan["planRoot"] != expected_plan_root:
        raise ValueError("project removal plan is stale or mismatched")
    registry = load_workspace_registry(config_home)
    recent = next(
        (
            row
            for row in registry["recent"]
            if row.get("workspace_kind") == "project"
            and (
                row.get("workspace_id") == project_id
                or _canonical_project_path(
                    row.get("workspace_root") or row.get("display_path")
                )
                == _canonical_project_path(plan["project"]["path"])
            )
        ),
        None,
    )
    if recent is not None:
        forgotten = forget_workspace(
            str(recent["workspace_id"]),
            config_home=config_home,
        )
    else:
        forgotten = registry
    _hide_project(plan["project"]["path"], config_home=config_home)
    body = {
        "schema": REMOVE_RECEIPT_SCHEMA,
        "status": "removed",
        "planRoot": plan["planRoot"],
        "project": plan["project"],
        "registryPath": forgotten["registry_path"],
        "selectedProjectId": forgotten["last_workspace_id"],
        "projectFilesChanged": False,
        "projectDirectoryDeleted": False,
        "writeOccurred": True,
    }
    return {**body, "receiptRoot": _root(body)}


def plan_create(
    *,
    destination: str | Path | None = None,
    parent: str | Path | None = None,
    template_id: str = DEFAULT_TEMPLATE_ID,
) -> dict[str, Any]:
    return plan_project_template(template_id, destination, parent=parent)


def create(
    *,
    destination: str | Path,
    expected_plan_root: str,
    actor: str,
    template_id: str = DEFAULT_TEMPLATE_ID,
    config_home: str | None = None,
) -> dict[str, Any]:
    created = create_project_template(
        template_id,
        destination,
        expected_plan_root=expected_plan_root,
        actor=actor,
    )
    identity = inspect_workspace(created["destination"])
    if identity is None:
        raise RuntimeError("created project identity is unavailable")
    selected = select_workspace(identity, config_home=config_home)
    _remember_project(
        selected["selected"]["workspace_root"],
        source="create",
        config_home=config_home,
    )
    body = {
        **created,
        "project": _project_row(selected["selected"], selected["last_workspace_id"]),
        "workspace": selected["selected"],
        "registryPath": selected["registry_path"],
    }
    body["receiptRoot"] = _root(
        {key: value for key, value in body.items() if key != "receiptRoot"}
    )
    return body
