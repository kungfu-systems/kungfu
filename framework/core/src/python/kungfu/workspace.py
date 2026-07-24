# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Mapping
from uuid import uuid4

from kungfu.config import (
    load_contract as load_config_contract,
    machine_runtime_home,
    workspace_data_home,
)
from kungfu.canonical_json import (
    WORKSPACE_CANONICAL_JSON_V1,
    canonical_json_text,
)


WORKSPACE_SCHEMA = "kungfu.workspace.identity/v1"
WORKSPACE_IDENTITY_MATERIAL_SCHEMA = "kungfu.workspace.identity-material/v1"
REGISTRY_SCHEMA = "kungfu.workspace.registry/v1"
CATALOG_SCHEMA = "kungfu.workspace.locator-catalog/v1"
CATALOG_ENTRY_SCHEMA = "kungfu.workspace.locator-entry/v1"
CATALOG_VERIFICATION_SCHEMA = "kungfu.workspace.locator-verification/v1"
CATALOG_CUT_SCHEMA = "kungfu.workspace.locator-catalog-cut/v1"
CATALOG_LIFECYCLE_PLAN_SCHEMA = "kungfu.workspace.catalog-lifecycle-plan/v1"
CATALOG_LIFECYCLE_RECEIPT_SCHEMA = "kungfu.workspace.catalog-lifecycle-receipt/v1"
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
CatalogLifecycleState = Literal["active", "retired", "test-only", "quarantined"]

_CATALOG_EXCLUSION_POLICY = {
    "retired": "explicit-retirement",
    "test-only": "isolated-test-fixture",
    "quarantined": "explicit-quarantine",
}


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
        continuation = inspect_workspace_continuation(self)
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


def _canonical_json(value: Any) -> str:
    return canonical_json_text(value, protocol=WORKSPACE_CANONICAL_JSON_V1)


def _semantic_root(value: Any) -> str:
    digest = hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def semantic_root(value: Any) -> str:
    """Return the canonical content root used by Workspace contracts."""

    return _semantic_root(value)


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
        config_home or _workspace_config_home(env), "gui", "workspaces.json"
    )


def workspace_catalog_path(
    config_home: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    """Return the machine-local locator Catalog path.

    The Catalog is deliberately separate from bounded GUI recents and from
    every workspace's semantic authority.
    """

    return os.path.join(
        config_home or _workspace_config_home(env),
        "workspaces",
        "catalog.json",
    )


def load_workspace_catalog(
    config_home: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Read the locator Catalog without creating or repairing it."""

    path = workspace_catalog_path(config_home, env=env)
    payload: dict[str, Any]
    if not os.path.exists(path):
        payload = {
            "schema": CATALOG_SCHEMA,
            "entries": [],
            "epoch": 0,
        }
        return _loaded_catalog(payload, path)
    try:
        with open(path, encoding="utf-8") as stream:
            loaded_payload = json.load(stream)
        if (
            not isinstance(loaded_payload, dict)
            or loaded_payload.get("schema") != CATALOG_SCHEMA
            or not isinstance(loaded_payload.get("entries"), list)
        ):
            raise ValueError("Catalog contract mismatch")
        payload = loaded_payload
        persisted_cut = _catalog_cut(payload)
        entries: list[dict[str, Any]] = []
        for entry in payload["entries"]:
            if (
                not isinstance(entry, dict)
                or entry.get("schema") != CATALOG_ENTRY_SCHEMA
            ):
                raise ValueError("Catalog entry contract mismatch")
            identity_state = str(entry.get("identity_state") or "qualified")
            identity_root = str(entry.get("identity_root") or "")
            locator_key = str(entry.get("locator_key") or "")
            if identity_state not in {"qualified", "locator-candidate"}:
                raise ValueError("Catalog entry identity_state is invalid")
            if identity_state == "qualified" and not _ROOT.fullmatch(identity_root):
                raise ValueError("Catalog entry identity_root is invalid")
            if identity_state == "locator-candidate" and (
                identity_root or not _ROOT.fullmatch(locator_key)
            ):
                raise ValueError("Catalog locator candidate is invalid")
            lifecycle = _catalog_lifecycle(entry)
            entries.append(
                {
                    **dict(entry),
                    "provenance": _catalog_provenance(entry),
                    "lifecycle": lifecycle,
                    "retained": True,
                    "required": lifecycle["state"] not in _CATALOG_EXCLUSION_POLICY,
                    "exclusion_policy": _CATALOG_EXCLUSION_POLICY.get(
                        lifecycle["state"]
                    ),
                }
            )
        return {
            **payload,
            "entries": entries,
            "epoch": int(payload.get("epoch") or 0),
            "issues": [],
            "catalog_path": path,
            "catalog_cut": persisted_cut,
        }
    except (OSError, ValueError, json.JSONDecodeError) as error:
        fallback = {
            "schema": CATALOG_SCHEMA,
            "entries": [],
            "epoch": 0,
        }
        return {
            **fallback,
            "issues": [
                {
                    "code": "catalog-invalid",
                    "path": path,
                    "message": str(error),
                }
            ],
            "catalog_path": path,
            "catalog_cut": _catalog_cut(fallback),
        }


def observe_workspace_locator(
    identity: WorkspaceIdentity,
    *,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Record one explicitly selected or successfully written locator."""

    catalog = load_workspace_catalog(config_home, env=env)
    if catalog["issues"]:
        raise ValueError(
            "invalid Workspace Locator Catalog must be repaired explicitly"
        )
    observed_at = _now()
    entry = _catalog_entry(
        identity,
        observed_at,
        provenance={
            "source": "explicit-observation",
            "registration_reason": identity.resolution_reason,
        },
    )
    existing = next(
        (
            row
            for row in catalog["entries"]
            if _catalog_entry_key(row) == _catalog_entry_key(entry)
        ),
        None,
    )
    if existing is not None:
        entry["lifecycle"] = _catalog_lifecycle(existing)
        entry["provenance"] = _catalog_provenance(existing)
    entries = [
        row
        for row in catalog["entries"]
        if _catalog_entry_key(row) != _catalog_entry_key(entry)
        and not (
            identity.identity_state == "qualified"
            and row.get("locator_key") == entry["locator_key"]
        )
    ]
    entries.insert(0, entry)
    payload = {
        "schema": CATALOG_SCHEMA,
        "entries": entries,
        "epoch": int(catalog.get("epoch") or 0) + 1,
        "updated_at": observed_at,
    }
    path = workspace_catalog_path(config_home, env=env)
    _write_json_atomic(path, payload)
    return {
        **payload,
        "catalog_path": path,
        "catalog_cut": _catalog_cut(payload),
        "observed": entry,
    }


def rebuild_workspace_catalog(
    workspace_roots: list[str] | None = None,
    *,
    include_recents: bool = True,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Rebuild discovery only from bounded recents and explicit locators.

    This never scans parent directories or the filesystem for ``.kungfu``.
    It can repair a missing/corrupt Catalog because workspace authority remains
    in each explicitly inspected workspace.
    """

    env = os.environ if env is None else env
    identities: list[WorkspaceIdentity] = []
    sources: list[dict[str, str]] = []
    if include_recents:
        registry = load_workspace_registry(config_home, env=env)
        for row in registry["recent"]:
            kind = str(row.get("workspace_kind") or "")
            locator = row.get("workspace_root") or row.get("locator")
            try:
                identity = (
                    _home_identity(env, "catalog-rebuild-recent")
                    if kind == "home"
                    else (
                        _project_identity(
                            str(locator),
                            "catalog-rebuild-recent",
                            env=env,
                        )
                        if kind == "project" and locator
                        else None
                    )
                )
            except (OSError, ValueError):
                identity = None
            if identity is not None:
                identities.append(identity)
                sources.append(
                    {
                        "source": "bounded-recent",
                        "workspace_id": identity.workspace_id,
                    }
                )
    for root in workspace_roots or []:
        identity = _project_identity(root, "catalog-rebuild-explicit", env=env)
        identities.append(identity)
        sources.append({"source": "explicit", "workspace_id": identity.workspace_id})

    observed_at = _now()
    by_key: dict[str, dict[str, Any]] = {}
    for identity in identities:
        entry = _catalog_entry(
            identity,
            observed_at,
            provenance={
                "source": next(
                    (
                        row["source"]
                        for row in sources
                        if row["workspace_id"] == identity.workspace_id
                    ),
                    "catalog-rebuild",
                ),
                "registration_reason": identity.resolution_reason,
            },
        )
        by_key[_catalog_entry_key(entry)] = entry
    payload = {
        "schema": CATALOG_SCHEMA,
        "entries": [by_key[key] for key in sorted(by_key)],
        "epoch": int(load_workspace_catalog(config_home, env=env).get("epoch") or 0)
        + 1,
        "updated_at": observed_at,
    }
    path = workspace_catalog_path(config_home, env=env)
    _write_json_atomic(path, payload)
    return {
        **payload,
        "catalog_path": path,
        "catalog_cut": _catalog_cut(payload),
        "sources": sources,
        "filesystem_scan": False,
        "authority": False,
    }


def verify_workspace_catalog(
    config_home: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Verify every accessible locator without changing the Catalog."""

    catalog = load_workspace_catalog(config_home, env=env)
    results: list[dict[str, Any]] = []
    for entry in catalog["entries"]:
        locator = entry.get("locator")
        if entry["workspace_kind"] == "home":
            identity = _home_identity(
                os.environ if env is None else env,
                "catalog-verification",
            )
        elif isinstance(locator, str) and locator:
            identity = _project_identity(locator, "catalog-verification", env=env)
        else:
            identity = None
        available = bool(identity and _workspace_available(identity))
        actual_root = identity.identity_root if identity else ""
        results.append(
            {
                "identity_root": entry["identity_root"],
                "workspace_id": entry["workspace_id"],
                "available": available,
                "identity_matches": bool(
                    available and actual_root == entry["identity_root"]
                ),
                "actual_identity_root": actual_root,
            }
        )
    ok = not catalog["issues"] and all(
        not row["available"] or row["identity_matches"] for row in results
    )
    return {
        "schema": CATALOG_VERIFICATION_SCHEMA,
        "ok": ok,
        "catalog_path": catalog["catalog_path"],
        "catalog_cut": catalog["catalog_cut"],
        "epoch": catalog["epoch"],
        "issues": catalog["issues"],
        "entries": results,
        "authority": False,
        "writes": [],
    }


def maintain_workspace_catalog(
    entry_keys: list[str],
    action: Literal["retire", "test-only", "quarantine", "restore"],
    reason: str,
    *,
    execute: bool = False,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Plan or execute explicit, reversible Catalog lifecycle transitions.

    The Catalog contains locators only. This operation never touches a
    workspace, its ``.kungfu`` authority, or any Work evidence. Dry-run is the
    default and the execute path is bound to the exact Catalog cut it planned.
    """

    reason = reason.strip()
    if action not in {"retire", "test-only", "quarantine", "restore"}:
        raise ValueError("unsupported Catalog lifecycle action")
    if not reason:
        raise ValueError("Catalog lifecycle maintenance requires a reason")
    requested = set(entry_keys)
    if not requested:
        raise ValueError("Catalog lifecycle maintenance requires an entry key")
    catalog = load_workspace_catalog(config_home, env=env)
    if catalog["issues"]:
        raise ValueError("invalid Workspace Locator Catalog must be repaired first")
    by_key = {_catalog_entry_key(row): row for row in catalog["entries"]}
    missing = sorted(requested - set(by_key))
    if missing:
        raise ValueError(f"Catalog entry key not found: {missing[0]}")

    target_state: CatalogLifecycleState = {
        "restore": "active",
        "retire": "retired",
        "test-only": "test-only",
        "quarantine": "quarantined",
    }[action]  # type: ignore[assignment]
    transitioned_at = _now()
    changes: list[dict[str, Any]] = []
    persisted_entries: list[dict[str, Any]] = []
    for row in catalog["entries"]:
        before = _persisted_catalog_entry(row)
        key = _catalog_entry_key(row)
        if key not in requested:
            persisted_entries.append(before)
            continue
        after = {
            **before,
            "lifecycle": {
                "state": target_state,
                "reason": reason,
                "transitioned_at": transitioned_at,
                "previous_state": _catalog_lifecycle(row)["state"],
            },
        }
        changes.append(
            {
                "entry_key": key,
                "workspace_id": row.get("workspace_id"),
                "identity_root": row.get("identity_root"),
                "locator": row.get("locator"),
                "before": before,
                "after": after,
            }
        )
        persisted_entries.append(after)

    next_payload = {
        "schema": CATALOG_SCHEMA,
        "entries": persisted_entries,
        "epoch": int(catalog.get("epoch") or 0) + 1,
        "updated_at": transitioned_at,
    }
    plan = {
        "schema": CATALOG_LIFECYCLE_PLAN_SCHEMA,
        "action": action,
        "reason": reason,
        "catalog_path": catalog["catalog_path"],
        "catalog_cut_before": catalog["catalog_cut"],
        "catalog_cut_after": _catalog_cut(next_payload),
        "epoch_before": int(catalog.get("epoch") or 0),
        "epoch_after": next_payload["epoch"],
        "changes": changes,
        "workspace_writes": 0,
        "authority_writes": 0,
        "rollback": "restore each before entry from this receipt at the recorded cut",
    }
    plan_root = _semantic_root(
        {key: value for key, value in plan.items() if key != "catalog_path"}
    )
    if not execute:
        return {
            **plan,
            "plan_root": plan_root,
            "executed": False,
            "writes": [],
        }

    current = load_workspace_catalog(config_home, env=env)
    if current["catalog_cut"] != plan["catalog_cut_before"]:
        raise ValueError("Catalog changed after planning; retry from a fresh dry-run")
    _write_json_atomic(catalog["catalog_path"], next_payload)
    receipt_body = {
        "schema": CATALOG_LIFECYCLE_RECEIPT_SCHEMA,
        "plan_root": plan_root,
        "action": action,
        "reason": reason,
        "catalog_cut_before": plan["catalog_cut_before"],
        "catalog_cut_after": plan["catalog_cut_after"],
        "epoch_before": plan["epoch_before"],
        "epoch_after": plan["epoch_after"],
        "changes": changes,
        "workspace_writes": 0,
        "authority_writes": 0,
    }
    receipt = {**receipt_body, "receipt_root": _semantic_root(receipt_body)}
    receipt_path = os.path.join(
        os.path.dirname(catalog["catalog_path"]),
        "receipts",
        receipt["receipt_root"].removeprefix("sha256:") + ".json",
    )
    _write_json_atomic(receipt_path, receipt)
    return {
        **plan,
        "plan_root": plan_root,
        "executed": True,
        "receipt": {**receipt, "receipt_path": receipt_path},
        "writes": [catalog["catalog_path"], receipt_path],
    }


def rebind_workspace_locator(
    identity_root: str,
    workspace_root: str,
    *,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Rebind one exact identity to a moved locator after verification."""

    if not _ROOT.fullmatch(identity_root):
        raise ValueError("identity_root must be a SHA-256 root")
    identity = _project_identity(workspace_root, "catalog-rebind", env=env)
    if identity.identity_root != identity_root:
        raise ValueError("new locator does not contain the expected workspace identity")
    return observe_workspace_locator(
        identity,
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
    observe_workspace_locator(
        identity,
        config_home=config_home,
        env=env,
    )
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
            qualified,
            config_home=qualified.config_home,
        )
        catalog_status = {
            "status": "observed",
            "catalog_path": catalog_observation["catalog_path"],
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


def _catalog_entry(
    identity: WorkspaceIdentity,
    observed_at: str,
    *,
    provenance: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    locator_key = _semantic_root(
        {
            "schema": "kungfu.workspace.locator-key/v1",
            "workspace_kind": identity.workspace_kind,
            "locator": identity.workspace_root or "home",
        }
    )
    return {
        "schema": CATALOG_ENTRY_SCHEMA,
        "workspace_id": identity.workspace_id,
        "identity_root": identity.identity_root,
        "identity_state": identity.identity_state,
        "locator_key": locator_key,
        "workspace_kind": identity.workspace_kind,
        "locator": identity.workspace_root,
        "data_home": identity.data_home,
        "available": _workspace_available(identity),
        "observed_at": observed_at,
        "provenance": dict(
            provenance
            or {
                "source": "explicit-observation",
                "registration_reason": identity.resolution_reason,
            }
        ),
        "lifecycle": {
            "state": "active",
            "reason": "observed",
            "transitioned_at": observed_at,
            "previous_state": None,
        },
    }


def _catalog_entry_key(entry: Mapping[str, Any]) -> str:
    return str(entry.get("identity_root") or entry.get("locator_key") or "")


def _catalog_cut(payload: Mapping[str, Any]) -> str:
    body = {
        "schema": CATALOG_CUT_SCHEMA,
        "catalog": {
            "schema": payload.get("schema"),
            "entries": list(payload.get("entries") or []),
            "epoch": int(payload.get("epoch") or 0),
            "updated_at": payload.get("updated_at"),
        },
    }
    return _semantic_root(body)


def _loaded_catalog(payload: Mapping[str, Any], path: str) -> dict[str, Any]:
    return {
        **dict(payload),
        "entries": list(payload.get("entries") or []),
        "epoch": int(payload.get("epoch") or 0),
        "issues": [],
        "catalog_path": path,
        "catalog_cut": _catalog_cut(payload),
    }


def _catalog_provenance(entry: Mapping[str, Any]) -> dict[str, str]:
    value = entry.get("provenance")
    if isinstance(value, Mapping):
        source = str(value.get("source") or "legacy")
        reason = str(value.get("registration_reason") or "legacy-observation")
    else:
        source = "legacy"
        reason = "legacy-observation"
    return {"source": source, "registration_reason": reason}


def _catalog_lifecycle(entry: Mapping[str, Any]) -> dict[str, Any]:
    value = entry.get("lifecycle")
    state = str((value or {}).get("state") or "active")
    if state not in {"active", "retired", "test-only", "quarantined"}:
        raise ValueError("Catalog entry lifecycle state is invalid")
    return {
        "state": state,
        "reason": str((value or {}).get("reason") or "legacy-default-active"),
        "transitioned_at": str(
            (value or {}).get("transitioned_at") or entry.get("observed_at") or ""
        ),
        "previous_state": (value or {}).get("previous_state"),
    }


def _persisted_catalog_entry(entry: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in entry.items()
        if key
        not in {
            "retained",
            "required",
            "exclusion_policy",
        }
    }


def _canonical_path(value: str) -> str:
    return os.path.realpath(os.path.abspath(os.path.expanduser(value)))


def _workspace_config_home(env: Mapping[str, str] | None = None) -> str:
    """Resolve config Home against the supplied environment mapping.

    ``os.path.expanduser`` only observes the process environment. Workspace
    APIs deliberately accept isolated environment mappings, so a contract
    default beginning with ``~`` must instead use that mapping's ``HOME``.
    """

    process_environment = env is None
    env = os.environ if env is None else env
    resolution = load_config_contract(env=env)["resolution"]
    config_home_env = str(resolution["configHomeEnv"])
    configured_value = env.get(config_home_env)
    if (
        process_environment
        and not configured_value
        and os.environ.get("PYTEST_CURRENT_TEST")
    ):
        configured_value = os.environ.get("KF_PYTEST_CONFIG_HOME") or os.path.join(
            tempfile.gettempdir(),
            f"kungfu-pytest-config-{os.getpid()}",
        )
    configured = str(configured_value or resolution["defaultConfigHome"])
    mapped_home = env.get("HOME")
    if mapped_home and (configured == "~" or configured.startswith("~/")):
        configured = (
            os.path.join(mapped_home, configured[2:])
            if configured != "~"
            else mapped_home
        )
    else:
        configured = os.path.expanduser(configured)
    return _canonical_path(configured)


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
