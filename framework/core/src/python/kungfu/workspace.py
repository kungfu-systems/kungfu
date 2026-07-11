# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Mapping
from uuid import uuid4

from kungfu.config import default_config_home, machine_runtime_home, workspace_data_home


WORKSPACE_SCHEMA = "kungfu.workspace.identity/v1"
REGISTRY_SCHEMA = "kungfu.workspace.registry/v1"
ENSURE_RECEIPT_SCHEMA = "kungfu.workspace.ensure-receipt/v1"

WorkspaceKind = Literal["home", "project", "machine"]


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
