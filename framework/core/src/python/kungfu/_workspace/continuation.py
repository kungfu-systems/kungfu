# SPDX-License-Identifier: Apache-2.0

"""Own continuation and full-evidence contracts for a qualified workspace."""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Protocol

from kungfu._workspace.io import _semantic_root, _write_json_atomic


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


class WorkspaceIdentityView(Protocol):
    workspace_id: str
    workspace_kind: str
    workspace_root: str | None
    data_home: str


WorkspaceIdentity = WorkspaceIdentityView


def ensure_workspace_data_home(
    identity: WorkspaceIdentityView, reason: str
) -> dict[str, Any]:
    workspace = importlib.import_module("kungfu.workspace")
    return workspace.ensure_workspace_data_home(identity, reason)


def inspect_workspace_continuation(identity: WorkspaceIdentityView) -> dict[str, Any]:
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
    identity: WorkspaceIdentityView,
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
