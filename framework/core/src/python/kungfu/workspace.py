# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Mapping
from uuid import uuid4

from kungfu.config import default_config_home, machine_runtime_home, workspace_data_home


WORKSPACE_SCHEMA = "kungfu.workspace.identity/v1"
REGISTRY_SCHEMA = "kungfu.workspace.registry/v1"
ENSURE_RECEIPT_SCHEMA = "kungfu.workspace.ensure-receipt/v1"
TARGET_RECEIPT_SCHEMA = "kungfu.workspace.target-receipt/v1"

WorkspaceKind = Literal["home", "project", "machine"]
OperationClass = Literal[
    "read-only",
    "capture-only",
    "semantic-write",
    "assessment",
    "repair",
    "migration",
    "destructive",
]


@dataclass(frozen=True)
class WorkspaceIdentity:
    workspace_id: str
    workspace_kind: WorkspaceKind
    workspace_root: str | None
    display_path: str
    data_home: str
    initialized: bool
    resolution_reason: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": WORKSPACE_SCHEMA,
            "workspace_id": self.workspace_id,
            "workspace_kind": self.workspace_kind,
            "workspace_root": self.workspace_root,
            "display_path": self.display_path,
            "data_home": self.data_home,
            "runtime_dir": os.path.join(self.data_home, "runtime"),
            "initialized": self.initialized,
            "state": "ready" if self.initialized else "selected-uninitialized",
            "resolution_reason": self.resolution_reason,
        }


@dataclass(frozen=True)
class WorkspaceTarget:
    identity: WorkspaceIdentity
    operation_class: OperationClass
    source_working_directory: str
    association: Literal["unassigned", "workspace"]

    @property
    def runtime_dir(self) -> str:
        return os.path.join(self.identity.data_home, "runtime")

    def as_dict(self) -> dict[str, Any]:
        return {
            **self.identity.as_dict(),
            "operation_class": self.operation_class,
            "source_working_directory": self.source_working_directory,
            "association": self.association,
        }


class WorkspaceTargetRequired(ValueError):
    def __init__(self, operation_class: OperationClass, cwd: str):
        self.diagnosis = {
            "schema": "kungfu.workspace.target-diagnosis/v1",
            "ok": False,
            "operation_class": operation_class,
            "resolution_reason": "no-project-workspace",
            "source_working_directory": cwd,
            "required_action": "pass --workspace or explicitly select Home",
        }
        super().__init__(
            f"{operation_class} requires an explicit or discovered workspace target"
        )


def home_data_home(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    home = env.get("HOME") or str(Path.home())
    return os.path.realpath(os.path.abspath(os.path.join(home, ".kungfu")))


def workspace_registry_path(
    config_home: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    return os.path.join(
        config_home or default_config_home(env), "gui", "workspaces.json"
    )


def inspect_workspace(
    workspace_root: str | None = None,
    *,
    home: bool = False,
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
) -> WorkspaceIdentity | None:
    env = os.environ if env is None else env
    if home:
        return _home_identity(env, "explicit-home")
    if workspace_root:
        return _project_identity(workspace_root, "explicit-workspace")

    explicit_root = env.get("KF_WORKSPACE_ROOT")
    if explicit_root:
        return _project_identity(explicit_root, "environment-workspace-root")

    explicit_home = env.get("KF_HOME")
    if explicit_home:
        data_home = _canonical_path(explicit_home)
        if data_home == home_data_home(env):
            return _home_identity(env, "environment-home")
        if os.path.basename(data_home) == ".kungfu":
            return _project_identity(
                os.path.dirname(data_home), "environment-data-home"
            )
        return _machine_identity(data_home, "environment-data-home")

    discovered = workspace_data_home(cwd, env=env)
    if discovered:
        return _project_identity(
            os.path.dirname(discovered), "discovered-project-workspace"
        )
    return None


def current_workspace(
    *,
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    env = os.environ if env is None else env
    identity = inspect_workspace(cwd=cwd, env=env)
    if identity:
        return {"selected": True, **identity.as_dict()}
    return {
        "schema": WORKSPACE_SCHEMA,
        "selected": False,
        "state": "unselected",
        "resolution_reason": "no-project-workspace",
        "machine_data_home": machine_runtime_home(env),
        "home_data_home": home_data_home(env),
    }


def resolve_workspace_target(
    operation_class: OperationClass,
    workspace_root: str | None = None,
    *,
    home: bool = False,
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
) -> WorkspaceTarget:
    """Resolve one operation target without creating any workspace state.

    Only the declared ``capture-only`` class may use Home when no project
    workspace is explicit or discoverable. Every other write class fails
    closed instead of turning Home into a silent global fallback.
    """
    if workspace_root and home:
        raise ValueError("pass either workspace_root or home, not both")
    env = os.environ if env is None else env
    source_cwd = _canonical_path(cwd or env.get("PWD") or os.getcwd())
    identity = inspect_workspace(
        workspace_root,
        home=home,
        cwd=source_cwd,
        env=env,
    )
    if identity is None:
        if operation_class != "capture-only":
            raise WorkspaceTargetRequired(operation_class, source_cwd)
        identity = _home_identity(env, "no-project-workspace")

    association: Literal["unassigned", "workspace"] = "workspace"
    if (
        operation_class == "capture-only"
        and identity.workspace_kind == "home"
        and identity.resolution_reason == "no-project-workspace"
    ):
        association = "unassigned"
    return WorkspaceTarget(
        identity=identity,
        operation_class=operation_class,
        source_working_directory=source_cwd,
        association=association,
    )


def prepare_workspace_write(
    target: WorkspaceTarget,
    reason: str,
) -> dict[str, Any]:
    """Initialize a resolved write target and return the shared target receipt."""
    if target.operation_class == "read-only":
        raise ValueError("read-only operations cannot prepare a workspace write")
    ensure_receipt = ensure_workspace_data_home(target.identity, reason)
    return {
        "schema": TARGET_RECEIPT_SCHEMA,
        "receipt_id": f"workspace-target:{uuid4()}",
        "recorded_at": _now(),
        "operation_class": target.operation_class,
        "workspace_id": target.identity.workspace_id,
        "workspace_kind": target.identity.workspace_kind,
        "workspace_root": target.identity.workspace_root,
        "data_home": target.identity.data_home,
        "runtime_dir": target.runtime_dir,
        "resolution_reason": target.identity.resolution_reason,
        "association": target.association,
        "source_working_directory": target.source_working_directory,
        "initialized": ensure_receipt["initialized"],
        "created_paths": ensure_receipt["created_paths"],
        "workspace_ensure_receipt_id": ensure_receipt["receipt_id"],
        "git_effects": ensure_receipt["git_effects"],
        "coordinator_action": ensure_receipt["coordinator_action"],
    }


def record_workspace_capture(
    target: WorkspaceTarget,
    receipt: Mapping[str, Any],
    resulting_identities: list[dict[str, str]],
    *,
    work_store_factory: Callable[[str], Any] | None = None,
) -> dict[str, Any]:
    """Persist a capture receipt and create a durable Home Inbox work item."""
    if target.operation_class != "capture-only":
        raise ValueError("workspace capture records require capture-only resolution")
    recorded = dict(receipt)
    recorded["resulting_identities"] = resulting_identities
    recorded["effects"] = ["capture-receipt-recorded"]
    recorded["skipped_effects"] = [
        "mission-association",
        "git-init",
        "gitignore-edit",
        "git-stage",
        "git-commit",
        "git-push",
    ]
    if target.association == "unassigned":
        recorded["skipped_effects"].insert(1, "project-association")

    if target.association == "unassigned":
        if work_store_factory is None:
            from kungfu.work.store import WorkStore

            work_store_factory = WorkStore
        store = work_store_factory(target.runtime_dir)
        identity_label = ", ".join(
            f"{item['kind']}:{item['id']}" for item in resulting_identities
        )
        work_id = store.create(
            title=f"Unassigned agent work {identity_label}",
            kind="agent-work-inbox",
            summary=(
                "Captured without a project or declared Mission purpose from "
                f"{target.source_working_directory}"
            ),
        )
        store.set_next_action(
            work_id,
            "Attach this captured work to a Mission/Go or declare its purpose.",
        )
        for item in resulting_identities:
            if item["kind"] == "run":
                store.link_run(work_id, item["id"])
        recorded["inbox_work_id"] = work_id
        recorded["effects"].append("home-agent-work-inbox-item-created")

    receipt_name = recorded["receipt_id"].replace(":", "-") + ".json"
    receipt_path = os.path.join(
        target.identity.data_home,
        "inbox",
        "receipts",
        receipt_name,
    )
    recorded["receipt_path"] = receipt_path
    _write_json_atomic(receipt_path, recorded)
    if target.association == "unassigned":
        store.artifact(recorded["inbox_work_id"], receipt_path, "workspace-capture")
    return recorded


def load_workspace_registry(
    config_home: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    path = workspace_registry_path(config_home, env=env)
    if not os.path.exists(path):
        return {
            "schema": REGISTRY_SCHEMA,
            "last_workspace_id": None,
            "recent": [],
            "registry_path": path,
        }
    with open(path, encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict) or payload.get("schema") != REGISTRY_SCHEMA:
        raise ValueError(f"Unsupported Kungfu workspace registry: {path}")
    recent = payload.get("recent")
    if not isinstance(recent, list):
        raise ValueError(f"Kungfu workspace registry recent must be an array: {path}")
    return {**payload, "registry_path": path}


def select_workspace(
    identity: WorkspaceIdentity,
    *,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    recent_limit: int = 12,
) -> dict[str, Any]:
    registry = load_workspace_registry(config_home, env=env)
    selected = identity.as_dict()
    selected["available"] = _workspace_available(identity)
    selected["selected_at"] = _now()
    recent = [
        item
        for item in registry["recent"]
        if item.get("workspace_id") != identity.workspace_id
    ]
    recent.insert(0, selected)
    payload = {
        "schema": REGISTRY_SCHEMA,
        "last_workspace_id": identity.workspace_id,
        "recent": recent[:recent_limit],
        "updated_at": selected["selected_at"],
    }
    path = workspace_registry_path(config_home, env=env)
    _write_json_atomic(path, payload)
    return {**payload, "registry_path": path, "selected": selected}


def ensure_workspace_data_home(
    identity: WorkspaceIdentity,
    reason: str,
) -> dict[str, Any]:
    reason = reason.strip()
    if not reason:
        raise ValueError("workspace initialization requires a non-empty write intent")
    existed = os.path.isdir(identity.data_home)
    created_paths: list[str] = []
    if not existed:
        os.makedirs(identity.data_home, exist_ok=True)
        created_paths.append(identity.data_home)
    runtime_dir = os.path.join(identity.data_home, "runtime")
    if not os.path.isdir(runtime_dir):
        os.makedirs(runtime_dir, exist_ok=True)
        created_paths.append(runtime_dir)
    return {
        "schema": ENSURE_RECEIPT_SCHEMA,
        "receipt_id": f"workspace-ensure:{uuid4()}",
        "recorded_at": _now(),
        "workspace_id": identity.workspace_id,
        "workspace_kind": identity.workspace_kind,
        "workspace_root": identity.workspace_root,
        "data_home": identity.data_home,
        "runtime_dir": runtime_dir,
        "reason": reason,
        "initialized": not existed,
        "created_paths": created_paths,
        "git_effects": [],
        "coordinator_action": "deferred",
    }


def _home_identity(env: Mapping[str, str], resolution_reason: str) -> WorkspaceIdentity:
    data_home = home_data_home(env)
    return WorkspaceIdentity(
        workspace_id="home",
        workspace_kind="home",
        workspace_root=None,
        display_path="~/.kungfu",
        data_home=data_home,
        initialized=os.path.isdir(data_home),
        resolution_reason=resolution_reason,
    )


def _project_identity(workspace_root: str, resolution_reason: str) -> WorkspaceIdentity:
    display_path = os.path.abspath(os.path.expanduser(workspace_root))
    canonical_root = _canonical_path(workspace_root)
    data_home = os.path.join(canonical_root, ".kungfu")
    digest = hashlib.sha256(canonical_root.encode("utf-8")).hexdigest()[:16]
    return WorkspaceIdentity(
        workspace_id=f"project:{digest}",
        workspace_kind="project",
        workspace_root=canonical_root,
        display_path=display_path,
        data_home=data_home,
        initialized=os.path.isdir(data_home),
        resolution_reason=resolution_reason,
    )


def _machine_identity(data_home: str, resolution_reason: str) -> WorkspaceIdentity:
    digest = hashlib.sha256(data_home.encode("utf-8")).hexdigest()[:16]
    return WorkspaceIdentity(
        workspace_id=f"machine:{digest}",
        workspace_kind="machine",
        workspace_root=None,
        display_path=data_home,
        data_home=data_home,
        initialized=os.path.isdir(data_home),
        resolution_reason=resolution_reason,
    )


def _canonical_path(value: str) -> str:
    return os.path.realpath(os.path.abspath(os.path.expanduser(value)))


def _workspace_available(identity: WorkspaceIdentity) -> bool:
    if identity.workspace_kind == "project":
        return bool(identity.workspace_root and os.path.isdir(identity.workspace_root))
    return os.path.isdir(os.path.dirname(identity.data_home))


def _write_json_atomic(path: str, payload: dict[str, Any]) -> None:
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".workspaces-", suffix=".json", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
