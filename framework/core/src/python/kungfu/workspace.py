# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import unicodedata
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
CONTINUATION_STATUS_SCHEMA = "kungfu.workspace.continuation-status/v1"
EVIDENCE_REQUEST_SCHEMA = "kungfu.workspace.full-evidence-request/v1"
EVIDENCE_IMPORT_PLAN_SCHEMA = "kungfu.workspace.full-evidence-import-plan/v1"
EVIDENCE_IMPORT_RECEIPT_SCHEMA = "kungfu.workspace.full-evidence-import-receipt/v1"

_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
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

    def as_dict(self) -> dict[str, Any]:
        continuation = inspect_workspace_continuation(self)
        return {
            "schema": WORKSPACE_SCHEMA,
            "workspace_id": self.workspace_id,
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


def _canonical_json(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return json.dumps(value, separators=(",", ":"))
    if isinstance(value, str):
        if unicodedata.normalize("NFC", value) != value:
            raise ValueError("canonical JSON strings must be NFC-normalized")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        if value < 0 or value > _MAX_SAFE_INTEGER:
            raise ValueError("canonical JSON integers must be non-negative and safe")
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("canonical JSON object keys must be strings")
        keys = sorted(value, key=lambda key: key.encode("utf-8"))
        return (
            "{"
            + ",".join(
                f"{_canonical_json(key)}:{_canonical_json(value[key])}" for key in keys
            )
            + "}"
        )
    raise ValueError("unsupported canonical JSON value")


def _semantic_root(value: Any) -> str:
    digest = hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def inspect_workspace_continuation(identity: WorkspaceIdentity) -> dict[str, Any]:
    """Inspect settled Git material without creating or repairing local state.

    This is deliberately a bounded read model.  It can establish that tracked
    Project Cut and Episode shadow material is present and structurally usable;
    it never promotes that material into yijinjing authority or claims raw
    replay/requalification evidence.
    """

    runtime_dir = Path(identity.data_home) / "runtime"
    runtime_present = runtime_dir.is_dir()
    episode_root = Path(identity.data_home) / "episodes" / "sealed"
    cut_root = Path(identity.data_home) / "project-cuts"
    issues: list[dict[str, str]] = []
    episode_roots: list[str] = []
    cut_roots: list[str] = []

    if episode_root.is_dir():
        for manifest_path in sorted(episode_root.rglob("manifest.json")):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                semantic_root = str(manifest.get("semanticRoot") or "")
                provider_root = str(manifest.get("providerRoot") or "")
                if (
                    manifest.get("schema") != "kungfu.episode.git-workspace-manifest/v1"
                    or manifest.get("authority") != "shadow-of-yijinjing-journal"
                    or not _ROOT.fullmatch(semantic_root)
                    or not _ROOT.fullmatch(provider_root)
                ):
                    raise ValueError("manifest contract mismatch")
                provider_root_value = manifest.pop("providerRoot")
                if _semantic_root(manifest) != provider_root_value:
                    raise ValueError("Episode provider root mismatch")
                episode_roots.append(semantic_root)
            except (OSError, ValueError, json.JSONDecodeError) as error:
                issues.append(
                    {
                        "code": "episode-shadow-invalid",
                        "path": str(manifest_path.relative_to(identity.data_home)),
                        "message": str(error),
                    }
                )

    if cut_root.is_dir():
        for cut_path in sorted(cut_root.rglob("*.json")):
            if cut_path.name == "receipt.json" or cut_path.name.endswith(
                ".receipt.json"
            ):
                continue
            try:
                cut = json.loads(cut_path.read_text(encoding="utf-8"))
                cut_root_value = str(cut.get("cutRoot") or "")
                if cut.get("schema") != "project.cut/v1" or not _ROOT.fullmatch(
                    cut_root_value
                ):
                    raise ValueError("Project Cut contract mismatch")
                root_input = {
                    "schema": "project.cut.root-input/v1",
                    **{field: cut[field] for field in _PROJECT_CUT_ROOT_FIELDS},
                }
                if _semantic_root(root_input) != cut_root_value:
                    raise ValueError("Project Cut root mismatch")
                cut_roots.append(cut_root_value)
            except (OSError, ValueError, json.JSONDecodeError) as error:
                issues.append(
                    {
                        "code": "project-cut-invalid",
                        "path": str(cut_path.relative_to(identity.data_home)),
                        "message": str(error),
                    }
                )

    full_evidence_roots, full_evidence_issues = _full_evidence_receipts(
        identity.data_home, identity.workspace_id, episode_roots
    )
    shadow_present = bool(episode_roots or cut_roots)
    historical_evidence_complete = bool(episode_roots) and set(episode_roots).issubset(
        full_evidence_roots
    )
    if issues:
        state = "evidence-degraded"
        evidence_level = "degraded"
    elif runtime_present:
        state = "live-runtime"
        evidence_level = "live-local"
    elif shadow_present:
        state = "shadow-only"
        evidence_level = "settled-review"
    else:
        state = "uninitialized"
        evidence_level = "none"

    return {
        "schema": CONTINUATION_STATUS_SCHEMA,
        "state": state,
        "runtime_authority": "yijinjing-journal" if runtime_present else None,
        "settled_history_authority": (
            "qualified-git-shadow" if shadow_present else None
        ),
        "evidence_level": evidence_level,
        "episode_roots": sorted(set(episode_roots)),
        "project_cut_roots": sorted(set(cut_roots)),
        "issues": issues,
        "full_evidence_episode_roots": sorted(full_evidence_roots),
        "full_evidence_issues": full_evidence_issues,
        "capability_contractions": (
            []
            if not shadow_present or historical_evidence_complete
            else [
                "raw-replay-unavailable-for-settled-history",
                "requalification-unavailable-for-settled-history",
                "disaster-recovery-unavailable-for-settled-history",
            ]
        ),
        "capabilities": {
            "inspect_settled_history": shadow_present and not issues,
            "start_continuation": identity.workspace_kind == "project" and not issues,
            "append_facts": runtime_present and not issues,
            "raw_replay": runtime_present
            and (not episode_roots or historical_evidence_complete),
            "requalify": runtime_present
            and (not episode_roots or historical_evidence_complete),
            "disaster_recovery": runtime_present
            and (not episode_roots or historical_evidence_complete),
            "request_full_evidence": shadow_present and not runtime_present,
            "settle_project_cut": runtime_present and not issues,
        },
        "non_claims": [
            "git-shadow-is-not-episode-authority",
            "settled-review-does-not-prove-raw-replay",
            "inspection-does-not-initialize-runtime",
        ],
    }


def request_full_evidence(
    identity: WorkspaceIdentity,
    *,
    episode_roots: list[str] | None = None,
    project_cut_roots: list[str] | None = None,
) -> dict[str, Any]:
    """Create one exact, read-only request for missing local Episode evidence."""

    continuation = inspect_workspace_continuation(identity)
    if continuation["issues"]:
        raise ValueError("full evidence cannot be requested from degraded shadow state")
    available_episodes = set(continuation["episode_roots"])
    available_cuts = set(continuation["project_cut_roots"])
    if not available_episodes:
        raise ValueError("full evidence request requires a settled Episode shadow")
    requested_episodes = sorted(set(episode_roots or available_episodes))
    requested_cuts = sorted(set(project_cut_roots or available_cuts))
    if not set(requested_episodes).issubset(available_episodes):
        raise ValueError("requested Episode root is not present in settled history")
    if not set(requested_cuts).issubset(available_cuts):
        raise ValueError("requested Project Cut root is not present in settled history")
    missing = sorted(
        set(requested_episodes) - set(continuation["full_evidence_episode_roots"])
    )
    plan = {
        "schema": EVIDENCE_REQUEST_SCHEMA,
        "workspace_id": identity.workspace_id,
        "workspace_root": identity.workspace_root,
        "episode_roots": requested_episodes,
        "project_cut_roots": requested_cuts,
        "missing_episode_roots": missing,
        "required_bundle_schema": "kungfu.storage.episode-bundle/v1",
        "authority": "yijinjing-journal",
        "settled_history_authority": "qualified-git-shadow",
        "creates_runtime": False,
        "next_action": "obtain and validate one full Episode bundle per missing root",
    }
    return {**plan, "plan_root": _semantic_root(plan)}


def import_full_evidence(
    identity: WorkspaceIdentity,
    bundle_path: str,
    *,
    execute: bool = False,
) -> dict[str, Any]:
    """Validate or import a full Episode bundle bound to one settled shadow root."""

    from kungfu.storage import service

    continuation = inspect_workspace_continuation(identity)
    if continuation["issues"]:
        raise ValueError("full evidence import is blocked by degraded shadow state")
    with open(bundle_path, encoding="utf-8") as stream:
        bundle = json.load(stream)
    episode_root = _episode_bundle_root(bundle)
    if episode_root not in continuation["episode_roots"]:
        raise ValueError("Episode bundle root is not present in settled history")
    with tempfile.TemporaryDirectory(prefix="kungfu-full-evidence-validate-") as root:
        validation = service.import_bundle(root, bundle, verify=True, execute=False)
    if not validation.get("ok"):
        raise ValueError("full Episode bundle validation failed")
    bundle_hash = (
        "sha256:"
        + hashlib.sha256(
            json.dumps(
                bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
        ).hexdigest()
    )
    plan = {
        "schema": EVIDENCE_IMPORT_PLAN_SCHEMA,
        "workspace_id": identity.workspace_id,
        "episode_root": episode_root,
        "bundle_hash": bundle_hash,
        "bundle_schema": bundle["schema"],
        "would_create_runtime": not os.path.isdir(
            os.path.join(identity.data_home, "runtime")
        ),
    }
    plan_root = _semantic_root(plan)
    if not execute:
        return {
            **plan,
            "plan_root": plan_root,
            "executed": False,
            "validation": validation,
        }

    ensure_receipt = ensure_workspace_data_home(identity, "import-full-evidence")
    imported = service.import_bundle(
        os.path.join(identity.data_home, "runtime"),
        bundle,
        verify=True,
        execute=True,
    )
    if not imported.get("ok"):
        raise ValueError("full Episode bundle import failed")
    receipt = {
        "schema": EVIDENCE_IMPORT_RECEIPT_SCHEMA,
        "plan_root": plan_root,
        "workspace_id": identity.workspace_id,
        "episode_root": episode_root,
        "bundle_hash": bundle_hash,
        "import_status": str(imported.get("status") or "ok"),
        "workspace_ensure_receipt_id": ensure_receipt["receipt_id"],
    }
    receipt["receipt_root"] = _semantic_root(receipt)
    receipt_path = os.path.join(
        identity.data_home,
        "runtime",
        "full-evidence",
        episode_root.removeprefix("sha256:") + ".receipt.json",
    )
    _write_json_atomic(receipt_path, receipt)
    return {
        "schema": EVIDENCE_IMPORT_RECEIPT_SCHEMA,
        "executed": True,
        "plan": {**plan, "plan_root": plan_root},
        "receipt": {**receipt, "receipt_path": receipt_path},
        "validation": validation,
        "import": imported,
        "continuation": inspect_workspace_continuation(identity),
    }


def _episode_bundle_root(bundle: dict[str, Any]) -> str:
    if bundle.get("schema") != "kungfu.storage.episode-bundle/v1":
        raise ValueError("full evidence must use the Episode bundle schema")
    content_root = str((bundle.get("manifest") or {}).get("content_root") or "")
    if re.fullmatch(r"[0-9a-f]{64}", content_root):
        content_root = f"sha256:{content_root}"
    if not _ROOT.fullmatch(content_root):
        raise ValueError("Episode bundle has no valid semantic root")
    return content_root


def _full_evidence_receipts(
    data_home: str, workspace_id: str, episode_roots: list[str]
) -> tuple[set[str], list[dict[str, str]]]:
    root = Path(data_home) / "runtime" / "full-evidence"
    admitted: set[str] = set()
    issues: list[dict[str, str]] = []
    if not root.is_dir():
        return admitted, issues
    for path in sorted(root.glob("*.receipt.json")):
        try:
            receipt = json.loads(path.read_text(encoding="utf-8"))
            receipt_root = str(receipt.pop("receipt_root", ""))
            episode_root = str(receipt.get("episode_root") or "")
            if (
                receipt.get("schema") != EVIDENCE_IMPORT_RECEIPT_SCHEMA
                or receipt.get("workspace_id") != workspace_id
                or episode_root not in episode_roots
                or _semantic_root(receipt) != receipt_root
            ):
                raise ValueError("full evidence receipt contract mismatch")
            admitted.add(episode_root)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            issues.append(
                {
                    "code": "full-evidence-invalid",
                    "path": str(path.relative_to(data_home)),
                    "message": str(error),
                }
            )
    return admitted, issues


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
    continuation = inspect_workspace_continuation(identity)
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
    if not runtime_existed:
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
        "initialized": not runtime_existed,
        "previous_state": previous_state,
        "resulting_state": "live-runtime",
        "parent_episode_roots": continuation["episode_roots"],
        "parent_project_cut_roots": continuation["project_cut_roots"],
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
        initialized=os.path.isdir(os.path.join(data_home, "runtime")),
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
        initialized=os.path.isdir(os.path.join(data_home, "runtime")),
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
        initialized=os.path.isdir(os.path.join(data_home, "runtime")),
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
