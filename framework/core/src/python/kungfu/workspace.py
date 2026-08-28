# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal, Mapping, cast
from uuid import uuid4

from kungfu.config import (
    machine_runtime_home,
    workspace_data_home,
)
from kungfu._workspace.continuation import (
    _episode_bundle_root as _episode_bundle_root,
    _full_evidence_receipts as _full_evidence_receipts,
    inspect_workspace_continuation as inspect_workspace_continuation,
    request_full_evidence as request_full_evidence,
    import_full_evidence as _import_full_evidence,
)
from kungfu._workspace.io import (
    _canonical_json as _canonical_json,
    _canonical_path as _canonical_path,
    _now as _now,
    _semantic_root as _semantic_root,
    _workspace_available as _workspace_available,
    _workspace_config_home as _workspace_config_home,
    _write_json_atomic as _write_json_atomic,
)
from kungfu._workspace.catalog import (
    _CATALOG_EXCLUSION_POLICY as _CATALOG_EXCLUSION_POLICY,
    _catalog_cut as _catalog_cut,
    _catalog_entry as _catalog_entry,
    _catalog_entry_key as _catalog_entry_key,
    _catalog_lifecycle as _catalog_lifecycle,
    _catalog_provenance as _catalog_provenance,
    _loaded_catalog as _loaded_catalog,
    _persisted_catalog_entry as _persisted_catalog_entry,
    CATALOG_SCHEMA as CATALOG_SCHEMA,
    CATALOG_ENTRY_SCHEMA as CATALOG_ENTRY_SCHEMA,
    CATALOG_VERIFICATION_SCHEMA as CATALOG_VERIFICATION_SCHEMA,
    CATALOG_CUT_SCHEMA as CATALOG_CUT_SCHEMA,
    CATALOG_LIFECYCLE_PLAN_SCHEMA as CATALOG_LIFECYCLE_PLAN_SCHEMA,
    CATALOG_LIFECYCLE_RECEIPT_SCHEMA as CATALOG_LIFECYCLE_RECEIPT_SCHEMA,
    CatalogLifecycleState as CatalogLifecycleState,
    load_workspace_catalog as load_workspace_catalog,
    maintain_workspace_catalog as maintain_workspace_catalog,
    observe_workspace_locator as observe_workspace_locator,
    rebuild_workspace_catalog as _rebuild_workspace_catalog,
    rebind_workspace_locator as _rebind_workspace_locator,
    verify_workspace_catalog as _verify_workspace_catalog,
    workspace_catalog_path as workspace_catalog_path,
)


WORKSPACE_SCHEMA = "kungfu.workspace.identity/v1"
WORKSPACE_IDENTITY_MATERIAL_SCHEMA = "kungfu.workspace.identity-material/v1"
REGISTRY_SCHEMA = "kungfu.workspace.registry/v1"
ENSURE_RECEIPT_SCHEMA = "kungfu.workspace.ensure-receipt/v1"
TARGET_RECEIPT_SCHEMA = "kungfu.workspace.target-receipt/v1"
CONTINUATION_STATUS_SCHEMA = "kungfu.workspace.continuation-status/v1"
EVIDENCE_REQUEST_SCHEMA = "kungfu.workspace.full-evidence-request/v1"
EVIDENCE_IMPORT_PLAN_SCHEMA = "kungfu.workspace.full-evidence-import-plan/v1"
EVIDENCE_IMPORT_RECEIPT_SCHEMA = "kungfu.workspace.full-evidence-import-receipt/v1"

_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
_PROJECT_CUT_ROOT_FIELDS = (
    "project",
    "parentCutRoots",
    "sourceProjection",
    "atlas",
    "episodeDelta",
    "interpretation",
    "visibility",
    "omissions",
    "conflicts",
    "unknowns",
    "compatibility",
)

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
    identity_root: str
    identity_state: Literal["qualified", "locator-candidate"]
    config_home: str

    def as_dict(self) -> dict[str, Any]:
        continuation = inspect_workspace_continuation(cast(Any, self))
        return {
            "schema": WORKSPACE_SCHEMA,
            "workspace_id": self.workspace_id,
            "identity_root": self.identity_root,
            "identity_state": self.identity_state,
            "workspace_kind": self.workspace_kind,
            "workspace_root": self.workspace_root,
            "display_path": self.display_path,
            "data_home": self.data_home,
            "runtime_dir": os.path.join(self.data_home, "runtime"),
            "initialized": self.initialized,
            "state": continuation["state"],
            "resolution_reason": self.resolution_reason,
            "continuation": continuation,
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


def semantic_root(value: Any) -> str:
    """Return the canonical content root used by Workspace contracts."""

    return _semantic_root(value)


def import_full_evidence(
    identity: WorkspaceIdentity,
    bundle_path: str,
    *,
    execute: bool = False,
) -> dict[str, Any]:
    """Validate or import evidence through the workspace write boundary."""

    return _import_full_evidence(
        cast(Any, identity),
        bundle_path,
        execute=execute,
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
        config_home or _workspace_config_home(env), "gui", "workspaces.json"
    )


def rebuild_workspace_catalog(
    workspace_roots: list[str] | None = None,
    *,
    include_recents: bool = True,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return _rebuild_workspace_catalog(
        workspace_roots,
        include_recents=include_recents,
        config_home=config_home,
        env=env,
    )


def verify_workspace_catalog(
    config_home: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return _verify_workspace_catalog(
        config_home,
        env=env,
    )


def rebind_workspace_locator(
    identity_root: str,
    workspace_root: str,
    *,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return _rebind_workspace_locator(
        identity_root,
        workspace_root,
        config_home=config_home,
        env=env,
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
        return _project_identity(workspace_root, "explicit-workspace", env=env)

    explicit_root = env.get("KF_WORKSPACE_ROOT")
    if explicit_root:
        return _project_identity(explicit_root, "environment-workspace-root", env=env)

    explicit_home = env.get("KF_HOME")
    if explicit_home:
        data_home = _canonical_path(explicit_home)
        if data_home == home_data_home(env):
            return _home_identity(env, "environment-home")
        if os.path.basename(data_home) == ".kungfu":
            return _project_identity(
                os.path.dirname(data_home), "environment-data-home", env=env
            )
        return _machine_identity(data_home, "environment-data-home", env=env)

    discovered = workspace_data_home(cwd, env=env)
    if discovered:
        return _project_identity(
            os.path.dirname(discovered), "discovered-project-workspace", env=env
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
        "workspace_id": ensure_receipt["workspace_id"],
        "workspace_identity_root": ensure_receipt["workspace_identity_root"],
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
) -> dict[str, Any]:
    """Persist a capture receipt without creating a second Work authority."""
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

    receipt_name = recorded["receipt_id"].replace(":", "-") + ".json"
    receipt_path = os.path.join(
        target.identity.data_home,
        "inbox",
        "receipts",
        receipt_name,
    )
    recorded["receipt_path"] = receipt_path
    _write_json_atomic(receipt_path, recorded)
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
    selected["available"] = _workspace_available(cast(Any, identity))
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
    observe_workspace_locator(
        cast(Any, identity),
        config_home=config_home,
        env=env,
    )
    return {**payload, "registry_path": path, "selected": selected}


def forget_workspace(
    workspace_id: str,
    *,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Forget one project locator without touching the project or its data home."""

    registry = load_workspace_registry(config_home, env=env)
    forgotten = next(
        (
            item
            for item in registry["recent"]
            if item.get("workspace_id") == workspace_id
        ),
        None,
    )
    if forgotten is None:
        raise ValueError("project is not remembered on this machine")
    if forgotten.get("workspace_kind") != "project":
        raise ValueError("only project workspaces can be forgotten")

    recent = [
        item for item in registry["recent"] if item.get("workspace_id") != workspace_id
    ]
    last_workspace_id = registry.get("last_workspace_id")
    if last_workspace_id == workspace_id:
        home = next(
            (item for item in recent if item.get("workspace_kind") == "home"),
            None,
        )
        last_workspace_id = home.get("workspace_id") if home else None
    payload = {
        "schema": REGISTRY_SCHEMA,
        "last_workspace_id": last_workspace_id,
        "recent": recent,
        "updated_at": _now(),
    }
    path = workspace_registry_path(config_home, env=env)
    _write_json_atomic(path, payload)
    return {
        **payload,
        "registry_path": path,
        "forgotten": forgotten,
        "project_files_changed": False,
        "project_directory_deleted": False,
    }


def ensure_workspace_data_home(
    identity: WorkspaceIdentity,
    reason: str,
    *,
    catalog_lifecycle: CatalogLifecycleState | None = None,
) -> dict[str, Any]:
    reason = reason.strip()
    if not reason:
        raise ValueError("workspace initialization requires a non-empty write intent")
    requested_catalog_lifecycle = str(
        catalog_lifecycle
        or os.environ.get("KF_WORKSPACE_CATALOG_LIFECYCLE")
        or "active"
    )
    if requested_catalog_lifecycle not in {"active", "test-only"}:
        raise ValueError(
            "initial Catalog observation supports only active or test-only; "
            "use catalog-maintain for other lifecycle states"
        )
    continuation = inspect_workspace_continuation(cast(Any, identity))
    previous_state = continuation["state"]
    if previous_state == "evidence-degraded":
        raise ValueError(
            "workspace continuation is blocked by degraded settled evidence"
        )
    data_home_existed = os.path.isdir(identity.data_home)
    runtime_dir = os.path.join(identity.data_home, "runtime")
    runtime_existed = os.path.isdir(runtime_dir)
    created_paths: list[str] = []
    if not data_home_existed:
        os.makedirs(identity.data_home, exist_ok=True)
        created_paths.append(identity.data_home)
    identity_path = _workspace_identity_material_path(identity.data_home)
    if not os.path.exists(identity_path):
        material = _new_workspace_identity_material(identity.workspace_kind)
        _write_json_atomic(identity_path, material)
        created_paths.append(identity_path)
    qualified = _qualified_identity(identity)
    if not runtime_existed:
        os.makedirs(runtime_dir, exist_ok=True)
        created_paths.append(runtime_dir)
    try:
        catalog_observation = observe_workspace_locator(
            cast(Any, qualified),
            lifecycle=cast(CatalogLifecycleState, requested_catalog_lifecycle),
            lifecycle_reason=(
                reason if requested_catalog_lifecycle != "active" else None
            ),
            config_home=qualified.config_home,
        )
        catalog_status = {
            "status": "observed",
            "catalog_path": catalog_observation["catalog_path"],
            "lifecycle": requested_catalog_lifecycle,
        }
    except (OSError, ValueError) as error:
        catalog_status = {
            "status": "degraded",
            "message": str(error),
            "authority_affected": False,
        }
    return {
        "schema": ENSURE_RECEIPT_SCHEMA,
        "receipt_id": f"workspace-ensure:{uuid4()}",
        "recorded_at": _now(),
        "workspace_id": qualified.workspace_id,
        "workspace_identity_root": qualified.identity_root,
        "workspace_kind": qualified.workspace_kind,
        "workspace_root": qualified.workspace_root,
        "data_home": qualified.data_home,
        "runtime_dir": runtime_dir,
        "reason": reason,
        "initialized": not runtime_existed,
        "previous_state": previous_state,
        "resulting_state": "live-runtime",
        "parent_episode_roots": continuation["episode_roots"],
        "parent_project_cut_roots": continuation["project_cut_roots"],
        "created_paths": created_paths,
        "catalog_observation": catalog_status,
        "git_effects": [],
        "coordinator_action": "deferred",
    }


def _home_identity(env: Mapping[str, str], resolution_reason: str) -> WorkspaceIdentity:
    data_home = home_data_home(env)
    material = _home_identity_material()
    return WorkspaceIdentity(
        workspace_id="home",
        workspace_kind="home",
        workspace_root=None,
        display_path="~/.kungfu",
        data_home=data_home,
        initialized=os.path.isdir(os.path.join(data_home, "runtime")),
        resolution_reason=resolution_reason,
        identity_root=material["identityRoot"],
        identity_state="qualified",
        config_home=_workspace_config_home(env),
    )


def _project_identity(
    workspace_root: str,
    resolution_reason: str,
    *,
    env: Mapping[str, str] | None = None,
) -> WorkspaceIdentity:
    env = os.environ if env is None else env
    display_path = os.path.abspath(os.path.expanduser(workspace_root))
    canonical_root = _canonical_path(workspace_root)
    data_home = os.path.join(canonical_root, ".kungfu")
    material = _load_workspace_identity_material(data_home, "project")
    identity_root = str(material.get("identityRoot") or "") if material else ""
    digest = (
        identity_root.removeprefix("sha256:")[:16]
        if identity_root
        else hashlib.sha256(canonical_root.encode("utf-8")).hexdigest()[:16]
    )
    return WorkspaceIdentity(
        workspace_id=(
            f"project:{digest}" if identity_root else f"candidate:project:{digest}"
        ),
        workspace_kind="project",
        workspace_root=canonical_root,
        display_path=display_path,
        data_home=data_home,
        initialized=os.path.isdir(os.path.join(data_home, "runtime")),
        resolution_reason=resolution_reason,
        identity_root=identity_root,
        identity_state="qualified" if identity_root else "locator-candidate",
        config_home=_workspace_config_home(env),
    )


def _machine_identity(
    data_home: str,
    resolution_reason: str,
    *,
    env: Mapping[str, str] | None = None,
) -> WorkspaceIdentity:
    env = os.environ if env is None else env
    digest = hashlib.sha256(data_home.encode("utf-8")).hexdigest()[:16]
    return WorkspaceIdentity(
        workspace_id=f"machine:{digest}",
        workspace_kind="machine",
        workspace_root=None,
        display_path=data_home,
        data_home=data_home,
        initialized=os.path.isdir(os.path.join(data_home, "runtime")),
        resolution_reason=resolution_reason,
        identity_root=_semantic_root(
            {
                "schema": WORKSPACE_IDENTITY_MATERIAL_SCHEMA,
                "workspaceKind": "machine",
                "workspaceKey": digest,
            }
        ),
        identity_state="qualified",
        config_home=_workspace_config_home(env),
    )


def _workspace_identity_material_path(data_home: str) -> str:
    return os.path.join(data_home, "workspace-identity.json")


def _home_identity_material() -> dict[str, Any]:
    semantic = {
        "schema": WORKSPACE_IDENTITY_MATERIAL_SCHEMA,
        "workspaceKind": "home",
        "workspaceKey": "home",
    }
    return {**semantic, "identityRoot": _semantic_root(semantic)}


def _new_workspace_identity_material(kind: WorkspaceKind) -> dict[str, Any]:
    if kind == "home":
        return _home_identity_material()
    semantic = {
        "schema": WORKSPACE_IDENTITY_MATERIAL_SCHEMA,
        "workspaceKind": kind,
        "workspaceKey": f"workspace:{uuid4()}",
    }
    return {**semantic, "identityRoot": _semantic_root(semantic)}


def _load_workspace_identity_material(
    data_home: str,
    expected_kind: WorkspaceKind,
) -> dict[str, Any] | None:
    path = _workspace_identity_material_path(data_home)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as stream:
            material = json.load(stream)
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid workspace identity material: {path}") from error
    if not isinstance(material, dict) or set(material) != {
        "schema",
        "workspaceKind",
        "workspaceKey",
        "identityRoot",
    }:
        raise ValueError(f"workspace identity material field mismatch: {path}")
    if (
        material.get("schema") != WORKSPACE_IDENTITY_MATERIAL_SCHEMA
        or material.get("workspaceKind") != expected_kind
        or not str(material.get("workspaceKey") or "").strip()
    ):
        raise ValueError(f"workspace identity material contract mismatch: {path}")
    semantic = {key: value for key, value in material.items() if key != "identityRoot"}
    if material["identityRoot"] != _semantic_root(semantic):
        raise ValueError(f"workspace identity material root mismatch: {path}")
    return material


def _qualified_identity(identity: WorkspaceIdentity) -> WorkspaceIdentity:
    if identity.identity_state == "qualified":
        return identity
    if identity.workspace_kind == "project" and identity.workspace_root:
        return replace(
            _project_identity(identity.workspace_root, identity.resolution_reason),
            config_home=identity.config_home,
        )
    return identity
