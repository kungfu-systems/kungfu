# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Mapping

from kungfu.workspace import (
    WorkspaceIdentity,
    ensure_workspace_data_home,
    inspect_workspace,
)


INSPECTION_SCHEMA = "kungfu.workspace.guidance-inspection/v1"
ADVICE_SCHEMA = "kungfu.workspace.advice/v1"
PREVIEW_SCHEMA = "kungfu.workspace.preview/v1"
AUTHORIZATION_SCHEMA = "kungfu.workspace.authorization/v1"
ACTION_RECEIPT_SCHEMA = "kungfu.workspace.action-receipt/v1"
VERIFY_SCHEMA = "kungfu.workspace.action-verification/v1"
POLICY_VERSION = "workspace-project-gravity/v1"

GuidanceIntent = Literal[
    "create-project-workspace",
    "prepare-portable-contract",
    "keep-home",
    "suppress-source",
]


class WorkspaceGuidanceError(ValueError):
    def __init__(self, code: str, message: str, **details: Any):
        self.diagnosis = {
            "schema": "kungfu.workspace.guidance-diagnosis/v1",
            "ok": False,
            "code": code,
            "message": message,
            **details,
        }
        super().__init__(message)


def inspect_guidance(
    identity: WorkspaceIdentity,
    *,
    source_path: str,
) -> dict[str, Any]:
    source = _canonical_path(source_path)
    if not os.path.isdir(source):
        raise WorkspaceGuidanceError(
            "source-unavailable",
            f"guidance source directory is unavailable: {source}",
            source_path=source,
        )
    git_root = _git_root(source)
    gravity_root = git_root or source
    receipts = [
        row
        for row in _capture_receipts(identity.data_home)
        if _is_within(str(row.get("source_working_directory") or ""), gravity_root)
    ]
    evidence = [
        {
            "receipt_id": row.get("receipt_id"),
            "source_working_directory": row.get("source_working_directory"),
            "resulting_identities": row.get("resulting_identities", []),
        }
        for row in receipts
    ]
    suppression_key = _stable_id("workspace-suppression", gravity_root)
    suppression = _read_json_if_present(
        _guidance_path(identity, "suppressions", suppression_key)
    )
    facts = {
        "workspace_id": identity.workspace_id,
        "workspace_kind": identity.workspace_kind,
        "source_root": source,
        "project_candidate_root": gravity_root,
        "git_repository_root": git_root,
        "unassigned_capture_evidence": evidence,
        "suppression": suppression,
        "policy_version": POLICY_VERSION,
    }
    cut_id = _stable_id("workspace-cut", facts)
    return {
        "schema": INSPECTION_SCHEMA,
        "workspace": identity.as_dict(),
        "cut_id": cut_id,
        "source_root": source,
        "project_candidate_root": gravity_root,
        "git_repository": {"present": git_root is not None, "root": git_root},
        "unassigned_capture_count": len(receipts),
        "evidence": evidence,
        "suppression_key": suppression_key,
        "suppression": suppression,
        "policy_version": POLICY_VERSION,
    }


def advise_workspace(inspection: Mapping[str, Any]) -> dict[str, Any]:
    _require_schema(inspection, INSPECTION_SCHEMA, "inspection")
    reasons: list[str] = []
    state = "insufficient"
    recommended_intent: str | None = None
    if inspection["workspace"]["workspace_kind"] != "home":
        reasons.append("project-workspace-already-selected")
    elif inspection.get("suppression"):
        state = "suppressed"
        reasons.append("source-guidance-suppressed")
    else:
        if inspection["git_repository"]["present"]:
            reasons.append("existing-git-repository")
        if int(inspection["unassigned_capture_count"]) >= 3:
            reasons.append("repeated-unassigned-captures")
        if reasons:
            state = "recommended"
            recommended_intent = "create-project-workspace"
        else:
            reasons.append("insufficient-project-gravity")
    identity = {
        "kind": "project-workspace-guidance",
        "cut_id": inspection["cut_id"],
        "state": state,
        "reason_codes": reasons,
        "project_candidate_root": inspection["project_candidate_root"],
        "policy_version": inspection["policy_version"],
    }
    return {
        "schema": ADVICE_SCHEMA,
        "advice_id": _stable_id("workspace-advice", identity),
        "advice_kind": "project-workspace-guidance",
        "state": state,
        "selected_cut": inspection["cut_id"],
        "workspace": inspection["workspace"],
        "source_root": inspection["source_root"],
        "project_candidate_root": inspection["project_candidate_root"],
        "reason_codes": reasons,
        "evidence_references": [
            row["receipt_id"] for row in inspection["evidence"] if row["receipt_id"]
        ],
        "recommended_intent": recommended_intent,
        "options": [
            "create-project-workspace",
            *(
                ["prepare-portable-contract"]
                if inspection["git_repository"]["present"]
                else []
            ),
            "keep-home",
            "suppress-source",
        ],
        "proposed_effects": ["create-project-data-home", "create-runtime-directory"],
        "skipped_effects": _git_effects(),
        "risk": "local-workspace-write",
        "authorization_class": "workspace-create",
        "freshness": {"cut_id": inspection["cut_id"], "state": "fresh"},
        "suppression_key": inspection["suppression_key"],
        "policy_version": inspection["policy_version"],
    }


def preview_workspace_action(
    advice: Mapping[str, Any],
    intent: GuidanceIntent,
) -> dict[str, Any]:
    _require_schema(advice, ADVICE_SCHEMA, "advice")
    if intent not in advice["options"]:
        raise WorkspaceGuidanceError(
            "unsupported-intent",
            f"intent is not offered by this advice: {intent}",
            advice_id=advice["advice_id"],
        )
    effects: list[dict[str, Any]] = []
    authorization_class = "guidance-decision"
    if intent in {"create-project-workspace", "prepare-portable-contract"}:
        effects = [
            {
                "effect": "create-project-data-home",
                "path": os.path.join(advice["project_candidate_root"], ".kungfu"),
            },
            {
                "effect": "create-runtime-directory",
                "path": os.path.join(
                    advice["project_candidate_root"], ".kungfu", "runtime"
                ),
            },
        ]
        authorization_class = "workspace-create"
        if intent == "prepare-portable-contract":
            effects.extend(
                [
                    {
                        "effect": "create-portable-contract-directory",
                        "path": os.path.join(
                            advice["project_candidate_root"],
                            ".kungfu",
                            "contract",
                        ),
                    },
                    {
                        "effect": "write-portable-contract-manifest",
                        "path": os.path.join(
                            advice["project_candidate_root"],
                            ".kungfu",
                            "contract",
                            "workspace.json",
                        ),
                    },
                ]
            )
            authorization_class = "portable-contract-write"
    elif intent == "keep-home":
        effects = [{"effect": "record-guidance-decision", "decision": intent}]
    else:
        effects = [
            {
                "effect": "record-guidance-suppression",
                "suppression_key": advice["suppression_key"],
            }
        ]
        authorization_class = "guidance-suppression"
    identity = {
        "advice_id": advice["advice_id"],
        "cut_id": advice["selected_cut"],
        "intent": intent,
        "effects": effects,
        "authorization_class": authorization_class,
    }
    return {
        "schema": PREVIEW_SCHEMA,
        "preview_id": _stable_id("workspace-preview", identity),
        "advice_id": advice["advice_id"],
        "selected_cut": advice["selected_cut"],
        "intent": intent,
        "workspace": advice["workspace"],
        "source_root": advice["source_root"],
        "project_candidate_root": advice["project_candidate_root"],
        "effects": effects,
        "skipped_effects": _git_effects()
        + ["attach-home-material", "change-source-authority"],
        "authorization_class": authorization_class,
        "suppression_key": advice["suppression_key"],
        "freshness": {"cut_id": advice["selected_cut"], "state": "fresh"},
    }


def authorize_workspace_action(
    identity: WorkspaceIdentity,
    preview: Mapping[str, Any],
    *,
    expected_preview_id: str,
    decision: Literal["approve", "deny"],
    authorized_by: str,
) -> dict[str, Any]:
    _require_schema(preview, PREVIEW_SCHEMA, "preview")
    if preview["preview_id"] != expected_preview_id:
        raise WorkspaceGuidanceError(
            "preview-mismatch",
            "the supplied preview identity does not match the current preview",
            expected=preview["preview_id"],
            supplied=expected_preview_id,
        )
    authorized_by = authorized_by.strip()
    if not authorized_by:
        raise WorkspaceGuidanceError(
            "authorization-actor-required", "authorized_by must not be empty"
        )
    ensure_workspace_data_home(identity, "workspace-guidance-authorization")
    payload = {
        "schema": AUTHORIZATION_SCHEMA,
        "preview_id": preview["preview_id"],
        "advice_id": preview["advice_id"],
        "selected_cut": preview["selected_cut"],
        "intent": preview["intent"],
        "authorization_class": preview["authorization_class"],
        "decision": decision,
        "authorized_by": authorized_by,
    }
    authorization_id = _stable_id("workspace-authorization", payload)
    payload.update(
        {
            "authorization_id": authorization_id,
            "recorded_at": _now(),
            "workspace_id": identity.workspace_id,
        }
    )
    path = _guidance_path(identity, "authorizations", authorization_id)
    payload["authorization_path"] = path
    _write_json_atomic(path, payload)
    return payload


def execute_workspace_action(
    identity: WorkspaceIdentity,
    *,
    source_path: str,
    authorization_id: str,
) -> dict[str, Any]:
    authorization_path = _guidance_path(identity, "authorizations", authorization_id)
    authorization = _read_required_json(authorization_path, "authorization")
    _require_schema(authorization, AUTHORIZATION_SCHEMA, "authorization")
    if authorization.get("decision") != "approve":
        raise WorkspaceGuidanceError(
            "authorization-denied",
            "this preview was not approved",
            authorization_id=authorization_id,
        )

    # A successfully executed authorization is a stable retry boundary.  Check
    # its deterministic receipt before recomputing freshness because some
    # actions (notably suppression) deliberately change the next advice cut.
    receipt_id = _stable_id(
        "workspace-action-receipt",
        {
            "authorization_id": authorization_id,
            "preview_id": authorization["preview_id"],
            "intent": authorization["intent"],
        },
    )
    receipt_path = _guidance_path(identity, "receipts", receipt_id)
    existing = _read_json_if_present(receipt_path)
    if existing:
        return {**existing, "reused": True}

    current = inspect_guidance(identity, source_path=source_path)
    advice = advise_workspace(current)
    preview = preview_workspace_action(advice, authorization["intent"])
    if preview["preview_id"] != authorization["preview_id"]:
        raise WorkspaceGuidanceError(
            "stale-preview",
            "relevant workspace facts changed after authorization",
            authorized_preview_id=authorization["preview_id"],
            current_preview_id=preview["preview_id"],
            authorized_cut=authorization["selected_cut"],
            current_cut=current["cut_id"],
        )

    applied_effects: list[dict[str, Any]] = []
    resulting_identities: list[dict[str, Any]] = []
    if preview["intent"] in {
        "create-project-workspace",
        "prepare-portable-contract",
    }:
        project = inspect_workspace(preview["project_candidate_root"])
        assert project is not None
        ensure_receipt = ensure_workspace_data_home(project, "create-project-workspace")
        applied_effects.extend(
            {"effect": "created-path", "path": path}
            for path in ensure_receipt["created_paths"]
        )
        resulting_identities.append(project.as_dict())
        if preview["intent"] == "prepare-portable-contract":
            contract_path = os.path.join(
                project.data_home, "contract", "workspace.json"
            )
            contract = {
                "schema": "kungfu.workspace.portable-contract/v1",
                "workspace_id": project.workspace_id,
                "workspace_root": project.workspace_root,
                "policy_version": POLICY_VERSION,
                "tracked_inputs": ["contract/workspace.json"],
                "eligible_classes": [
                    "policy",
                    "schema",
                    "kfx-pin",
                    "portable-query-definition",
                ],
                "excluded_paths": [
                    "runtime/**",
                    "journal/**",
                    "storage/**",
                    "inbox/**",
                    "projections/**",
                    "payloads/**",
                ],
                "git_effects_authorized": False,
            }
            _write_json_atomic(contract_path, contract)
            applied_effects.append(
                {
                    "effect": "portable-contract-manifest-written",
                    "path": contract_path,
                    "content_hash": _stable_id("portable-contract", contract),
                }
            )
    elif preview["intent"] == "keep-home":
        applied_effects.append(
            {"effect": "guidance-decision-recorded", "decision": "keep-home"}
        )
    else:
        suppression = {
            "schema": "kungfu.workspace.guidance-suppression/v1",
            "suppression_key": preview["suppression_key"],
            "source_root": preview["source_root"],
            "decision": "suppress-source",
            "authorization_id": authorization_id,
            "recorded_at": _now(),
        }
        suppression_path = _guidance_path(
            identity, "suppressions", preview["suppression_key"]
        )
        suppression["suppression_path"] = suppression_path
        _write_json_atomic(suppression_path, suppression)
        applied_effects.append(
            {
                "effect": "guidance-suppression-recorded",
                "path": suppression_path,
            }
        )
    receipt = {
        "schema": ACTION_RECEIPT_SCHEMA,
        "receipt_id": receipt_id,
        "recorded_at": _now(),
        "workspace_id": identity.workspace_id,
        "selected_cut": preview["selected_cut"],
        "advice_id": preview["advice_id"],
        "preview_id": preview["preview_id"],
        "authorization_id": authorization_id,
        "authorization_class": preview["authorization_class"],
        "intent": preview["intent"],
        "applied_effects": applied_effects,
        "skipped_effects": preview["skipped_effects"],
        "resulting_identities": resulting_identities,
        "receipt_path": receipt_path,
        "reused": False,
    }
    _write_json_atomic(receipt_path, receipt)
    return receipt


def verify_workspace_action(
    identity: WorkspaceIdentity,
    receipt_id: str,
) -> dict[str, Any]:
    receipt_path = _guidance_path(identity, "receipts", receipt_id)
    receipt = _read_required_json(receipt_path, "receipt")
    errors: list[str] = []
    if receipt.get("schema") != ACTION_RECEIPT_SCHEMA:
        errors.append("receipt-schema-mismatch")
    authorization_path = _guidance_path(
        identity, "authorizations", str(receipt.get("authorization_id") or "")
    )
    authorization = _read_json_if_present(authorization_path)
    if not authorization:
        errors.append("authorization-missing")
    elif authorization.get("preview_id") != receipt.get("preview_id"):
        errors.append("authorization-preview-mismatch")
    for resulting in receipt.get("resulting_identities", []):
        if resulting.get("workspace_kind") == "project":
            if not os.path.isdir(str(resulting.get("data_home") or "")):
                errors.append("project-data-home-missing")
            if not os.path.isdir(str(resulting.get("runtime_dir") or "")):
                errors.append("project-runtime-directory-missing")
    for effect in receipt.get("applied_effects", []):
        if effect.get("effect") == "portable-contract-manifest-written":
            manifest = _read_json_if_present(str(effect.get("path") or ""))
            if not manifest:
                errors.append("portable-contract-manifest-missing")
            elif manifest.get("git_effects_authorized") is not False:
                errors.append("portable-contract-git-boundary-mismatch")
    return {
        "schema": VERIFY_SCHEMA,
        "ok": not errors,
        "receipt_id": receipt_id,
        "receipt_path": receipt_path,
        "authorization_id": receipt.get("authorization_id"),
        "intent": receipt.get("intent"),
        "errors": errors,
        "verified_effects": receipt.get("applied_effects", []) if not errors else [],
    }


def _capture_receipts(data_home: str) -> list[dict[str, Any]]:
    root = Path(data_home) / "inbox" / "receipts"
    if not root.is_dir():
        return []
    result = []
    for path in sorted(root.glob("*.json")):
        row = _read_json_if_present(str(path))
        if (
            row
            and row.get("schema") == "kungfu.workspace.target-receipt/v1"
            and row.get("association") == "unassigned"
        ):
            result.append(row)
    return result


def _git_root(path: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", path, "rev-parse", "--show-toplevel"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    root = result.stdout.strip()
    return _canonical_path(root) if result.returncode == 0 and root else None


def _guidance_path(identity: WorkspaceIdentity, category: str, object_id: str) -> str:
    safe_id = object_id.replace(":", "-")
    return os.path.join(
        identity.data_home, "inbox", "guidance", category, safe_id + ".json"
    )


def _read_required_json(path: str, label: str) -> dict[str, Any]:
    value = _read_json_if_present(path)
    if value is None:
        raise WorkspaceGuidanceError(
            f"{label}-not-found", f"{label} was not found: {path}", path=path
        )
    return value


def _read_json_if_present(path: str) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8") as f:
            value = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _write_json_atomic(path: str, payload: Mapping[str, Any]) -> None:
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".guidance-", suffix=".json", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def _require_schema(value: Mapping[str, Any], schema: str, label: str) -> None:
    if value.get("schema") != schema:
        raise WorkspaceGuidanceError(
            f"{label}-schema-mismatch",
            f"expected {schema} for {label}",
            actual=value.get("schema"),
        )


def _stable_id(prefix: str, value: Any) -> str:
    raw = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return f"{prefix}:sha256:{hashlib.sha256(raw).hexdigest()}"


def _canonical_path(value: str) -> str:
    return os.path.realpath(os.path.abspath(os.path.expanduser(value)))


def _is_within(path: str, root: str) -> bool:
    if not path:
        return False
    canonical = _canonical_path(path)
    try:
        return os.path.commonpath([canonical, root]) == root
    except ValueError:
        return False


def _git_effects() -> list[str]:
    return [
        "git-init",
        "gitignore-edit",
        "git-stage",
        "git-commit",
        "git-push",
        "remote-create",
        "network-publication",
    ]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
