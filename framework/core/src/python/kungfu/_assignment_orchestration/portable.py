# SPDX-License-Identifier: Apache-2.0

"""Portable Assignment seal and cross-workspace binding owner."""

from __future__ import annotations

import json
import importlib
import re
from pathlib import Path
from typing import Any, Mapping

from kungfu.initiative_family import canonical as assignment_canonical

_facade = importlib.import_module("kungfu.assignment_orchestration")
STATE_SCHEMA = _facade.STATE_SCHEMA
CROSS_WORKSPACE_BINDING_SCHEMA = _facade.CROSS_WORKSPACE_BINDING_SCHEMA


def _git_common_dir(workspace_root: Path) -> Path | None:
    marker = workspace_root / ".git"
    if marker.is_dir():
        git_dir = marker.resolve()
    elif marker.is_file():
        declaration = marker.read_text(encoding="utf-8").strip()
        if not declaration.startswith("gitdir:"):
            return None
        declared = Path(declaration.removeprefix("gitdir:").strip())
        git_dir = (
            declared if declared.is_absolute() else workspace_root / declared
        ).resolve()
    else:
        return None
    common_marker = git_dir / "commondir"
    if not common_marker.is_file():
        return git_dir
    declared = Path(common_marker.read_text(encoding="utf-8").strip())
    return (declared if declared.is_absolute() else git_dir / declared).resolve()


def _sealed_state_storage(workspace_root: Path) -> tuple[Path, str]:
    common = _git_common_dir(workspace_root)
    if common is not None:
        return common / "kungfu", "git-common-dir"
    return workspace_root / ".kungfu", "workspace-fallback"


def sealed_state_plan(
    workspace_root: str | Path,
    status: Mapping[str, Any],
    *,
    workspace_identity: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    root = Path(workspace_root).expanduser().resolve()
    identity = dict(workspace_identity or {})
    portable_identity = {
        "workspace_id": identity.get("workspace_id"),
        "workspace_kind": identity.get("workspace_kind"),
    }
    portable_identity = {
        key: value for key, value in portable_identity.items() if value is not None
    }
    snapshot = {
        "schema": STATE_SCHEMA,
        "workspace": portable_identity,
        "initiative_subject": status.get("initiative_subject"),
        "assignment_subject": status.get("assignment_subject"),
        "assignment": status.get("assignment"),
        "phase": status.get("phase"),
        "active_lease": status.get("active_lease"),
        "query_proof_root": status.get("query_proof_root"),
        "counts": {
            "execution_claims": len(status.get("execution_claims") or []),
            "phase_transitions": len(status.get("phase_transitions") or []),
            "completion_claims": int(status.get("completion_claim_count") or 0),
            "independent_reviews": int(status.get("independent_review_count") or 0),
            "continuation_decisions": int(
                status.get("continuation_decision_count") or 0
            ),
        },
    }
    state_root = assignment_canonical.semantic_root(snapshot)
    digest = state_root.removeprefix(assignment_canonical.ROOT)
    if identity.get("workspace_kind") == "home":
        storage_root, storage_kind = root, "home-workspace"
    else:
        storage_root, storage_kind = _sealed_state_storage(root)
    relative = Path("assignment-states") / "sha256" / digest[:2] / digest
    return {
        "schema": "kungfu.assignment-orchestration.seal-plan/v1",
        "state_root": state_root,
        "state_path": str(relative / "state.json"),
        "receipt_path": str(relative / "receipt.json"),
        "storage_kind": storage_kind,
        "storage_root": str(storage_root),
        "workspace_root": str(root),
        "snapshot": snapshot,
    }


def apply_sealed_state(
    plan: Mapping[str, Any], expected_state_root: str
) -> dict[str, Any]:
    if plan.get("state_root") != expected_state_root:
        raise ValueError("sealed state changed before execution")
    storage_root = Path(str(plan["storage_root"]))
    state_path = storage_root / str(plan["state_path"])
    receipt_path = storage_root / str(plan["receipt_path"])
    state_bytes = (assignment_canonical.canonical_json(plan["snapshot"]) + "\n").encode(
        "utf-8"
    )
    receipt = {
        "schema": "kungfu.assignment-orchestration.seal-receipt/v1",
        "stateRoot": expected_state_root,
        "statePath": str(state_path),
        "storageKind": str(plan["storage_kind"]),
        "portable": True,
        "runtimeIndependentVerification": True,
        "worktreeDeletionSafe": plan["storage_kind"]
        in {
            "git-common-dir",
            "home-workspace",
        },
    }
    receipt_bytes = (assignment_canonical.canonical_json(receipt) + "\n").encode(
        "utf-8"
    )
    for path, content in ((state_path, state_bytes), (receipt_path, receipt_bytes)):
        if path.exists() and path.read_bytes() != content:
            raise ValueError(f"immutable sealed-state collision: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(content)
    return {**receipt, "next_actions": []}


def verify_sealed_state(state_file: str | Path) -> dict[str, Any]:
    path = Path(state_file).expanduser().resolve()
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    root = assignment_canonical.semantic_root(snapshot)
    receipt_path = path.with_name("receipt.json")
    receipt = (
        json.loads(receipt_path.read_text(encoding="utf-8"))
        if receipt_path.is_file()
        else {}
    )
    return {
        "schema": "kungfu.assignment-orchestration.seal-verification/v1",
        "ok": snapshot.get("schema") == STATE_SCHEMA
        and receipt.get("schema") == "kungfu.assignment-orchestration.seal-receipt/v1"
        and receipt.get("stateRoot") == root,
        "state_root": root,
        "phase": snapshot.get("phase"),
        "next_actions": [],
    }


def list_sealed_assignment_states(
    workspace_root: str | Path,
) -> dict[str, Any]:
    """Read the bounded worktree-deletion-safe Assignment seal index."""

    root = Path(workspace_root).expanduser().resolve()
    storage_root, storage_kind = _sealed_state_storage(root)
    index_root = storage_root / "assignment-states" / "sha256"
    states: list[dict[str, Any]] = []
    unqualified: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for state_path in sorted(index_root.glob("*/*/state.json")):
        try:
            snapshot = json.loads(state_path.read_text(encoding="utf-8"))
            verification = verify_sealed_state(state_path)
            assignment = snapshot.get("assignment") or {}
            subject = str(snapshot.get("assignment_subject") or "")
            owning_root = str(assignment.get("owning_workspace_identity_root") or "")
            query_root = str(snapshot.get("query_proof_root") or "")
            if not verification["ok"]:
                raise ValueError("sealed Assignment state does not verify")
            if (
                not subject
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", owning_root)
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", query_root)
            ):
                unqualified.append(
                    {
                        "assignment_subject": subject,
                        "state_root": verification["state_root"],
                        "phase": snapshot.get("phase"),
                        "reason": "legacy-seal-lacks-portable-work-coordinate",
                    }
                )
                continue
            event_counts = dict(snapshot.get("counts") or {})
            assignment_state = {
                "schema": "kungfu.assignment-orchestration.retained-assignment-state/v1",
                "workspace": dict(snapshot.get("workspace") or {}),
                "initiative_subject": snapshot.get("initiative_subject"),
                "assignment_subject": subject,
                "assignment": assignment,
                "phase": snapshot.get("phase"),
                "active_lease": snapshot.get("active_lease"),
                "event_counts": event_counts,
            }
            states.append(
                {
                    "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
                    "assignment_subject": subject,
                    "workspace_identity_root": owning_root,
                    "assignment_state_root": assignment_canonical.semantic_root(
                        assignment_state
                    ),
                    "event_counts": event_counts,
                    "state_root": verification["state_root"],
                    "query_proof_root": query_root,
                    "phase": snapshot.get("phase"),
                    "settled": snapshot.get("phase") == "continuation-decided",
                    "storage_kind": storage_kind,
                }
            )
        except (OSError, ValueError, json.JSONDecodeError) as error:
            issues.append(
                {
                    "code": "sealed-assignment-state-invalid",
                    "path": str(state_path.relative_to(storage_root)),
                    "message": str(error),
                }
            )
    states.sort(
        key=lambda row: (
            str(row["assignment_subject"]),
            str(row["workspace_identity_root"]),
            str(row["state_root"]),
        )
    )
    unqualified.sort(
        key=lambda row: (
            str(row["assignment_subject"]),
            str(row["state_root"]),
        )
    )
    body = {
        "schema": "kungfu.assignment-orchestration.sealed-work-index/v1",
        "states": states,
        "unqualified_states": unqualified,
        "issues": issues,
        "storage_kind": storage_kind,
        "writes": [],
    }
    return {**body, "index_root": assignment_canonical.semantic_root(body)}


def _binding_endpoint(
    admission: Mapping[str, Any], status: Mapping[str, Any]
) -> dict[str, Any]:
    workspace = dict(admission.get("workspace") or {})
    assignment = dict(status.get("assignment") or {})
    assignment_receipt = dict(admission.get("assignment_receipt") or {})
    receipt = dict(assignment_receipt.get("receipt") or {})
    workspace_id = str(workspace.get("workspace_id") or "")
    workspace_kind = str(workspace.get("workspace_kind") or "")
    initiative_id = str(status.get("initiative_id") or "")
    assignment_id = str(status.get("assignment_id") or "")
    if workspace_kind not in {"home", "project"} or not workspace_id:
        raise ValueError(
            "admission omitted a stable Home or project workspace identity"
        )
    if not initiative_id or not assignment_id:
        raise ValueError("status omitted Initiative or Assignment identity")
    evidence = sorted(
        {
            assignment_canonical._root(row, "evidenceEpisodeRoots")
            for row in assignment.get("evidence_episode_roots") or []
        }
    )
    captures = sorted(
        {
            assignment_canonical._root(row, "captureReceiptRoots")
            for row in assignment.get("capture_receipt_roots") or []
        }
    )
    return {
        "workspaceIdentity": {
            "workspaceId": workspace_id,
            "workspaceKind": workspace_kind,
        },
        "initiativeId": initiative_id,
        "assignmentId": assignment_id,
        "stateRoot": assignment_canonical._root(
            status.get("query_proof_root"), "stateRoot"
        ),
        "projectCutRoot": assignment_canonical._root(
            assignment.get("project_cut_root"), "projectCutRoot", optional=True
        ),
        "evidenceRoots": evidence,
        "requestRoot": assignment_canonical._root(
            assignment.get("request_root"), "requestRoot"
        ),
        "captureReceiptRoots": captures,
        "admissionReceiptRoot": assignment_canonical._root(
            receipt.get("payload_hash"), "admissionReceiptRoot"
        ),
    }


def cross_workspace_binding(
    parent_admission: Mapping[str, Any],
    parent_status: Mapping[str, Any],
    child_admission: Mapping[str, Any],
    child_status: Mapping[str, Any],
) -> dict[str, Any]:
    """Build one path-free parent/child relationship from public receipts."""

    binding: dict[str, Any] = {
        "schema": CROSS_WORKSPACE_BINDING_SCHEMA,
        "relationshipType": "parent-child",
        "parent": _binding_endpoint(parent_admission, parent_status),
        "child": _binding_endpoint(child_admission, child_status),
    }
    if binding["parent"]["workspaceIdentity"] == binding["child"]["workspaceIdentity"]:
        raise ValueError(
            "cross-workspace binding endpoints must name different workspaces"
        )
    if (
        binding["parent"]["initiativeId"],
        binding["parent"]["assignmentId"],
    ) == (
        binding["child"]["initiativeId"],
        binding["child"]["assignmentId"],
    ):
        raise ValueError("cross-workspace binding endpoints must name different work")
    return {**binding, "bindingRoot": assignment_canonical.semantic_root(binding)}


def verify_cross_workspace_binding(binding: Mapping[str, Any]) -> dict[str, Any]:
    value = dict(binding)
    declared = assignment_canonical._root(value.pop("bindingRoot", ""), "bindingRoot")
    if set(value) != {"schema", "relationshipType", "parent", "child"}:
        raise ValueError("cross-workspace binding has an invalid field set")
    if (
        value.get("schema") != CROSS_WORKSPACE_BINDING_SCHEMA
        or value.get("relationshipType") != "parent-child"
    ):
        raise ValueError("cross-workspace binding contract mismatch")
    endpoint_fields = {
        "workspaceIdentity",
        "initiativeId",
        "assignmentId",
        "stateRoot",
        "projectCutRoot",
        "evidenceRoots",
        "requestRoot",
        "captureReceiptRoots",
        "admissionReceiptRoot",
    }
    for role in ("parent", "child"):
        endpoint = value.get(role)
        if not isinstance(endpoint, dict) or set(endpoint) != endpoint_fields:
            raise ValueError(f"{role} binding endpoint has an invalid field set")
        identity = endpoint.get("workspaceIdentity")
        if (
            not isinstance(identity, dict)
            or set(identity) != {"workspaceId", "workspaceKind"}
            or identity.get("workspaceKind") not in {"home", "project"}
            or not str(identity.get("workspaceId") or "")
        ):
            raise ValueError(f"{role} binding endpoint identity is invalid")
        if not endpoint.get("initiativeId") or not endpoint.get("assignmentId"):
            raise ValueError(f"{role} binding endpoint work identity is absent")
        for field in ("stateRoot", "requestRoot", "admissionReceiptRoot"):
            assignment_canonical._root(endpoint.get(field), f"{role}.{field}")
        assignment_canonical._root(
            endpoint.get("projectCutRoot"), f"{role}.projectCutRoot", optional=True
        )
        for field in ("evidenceRoots", "captureReceiptRoots"):
            roots = endpoint.get(field)
            if not isinstance(roots, list) or roots != sorted(set(roots)):
                raise ValueError(f"{role}.{field} must be sorted and unique")
            for root in roots:
                assignment_canonical._root(root, f"{role}.{field}")
    if value["parent"]["workspaceIdentity"] == value["child"]["workspaceIdentity"]:
        raise ValueError("cross-workspace binding endpoints name the same workspace")
    return {
        "schema": "kungfu.assignment-orchestration.cross-workspace-binding-verification/v1",
        "ok": assignment_canonical.semantic_root(value) == declared,
        "bindingRoot": declared,
        "parentWorkspaceId": value["parent"]["workspaceIdentity"]["workspaceId"],
        "childWorkspaceId": value["child"]["workspaceIdentity"]["workspaceId"],
        "next_actions": [],
    }


def cross_workspace_binding_plan(
    workspace_root: str | Path,
    workspace_identity: Mapping[str, Any],
    status: Mapping[str, Any],
    binding: Mapping[str, Any],
) -> dict[str, Any]:
    verification = verify_cross_workspace_binding(binding)
    if not verification["ok"]:
        raise ValueError("cross-workspace binding root did not verify")
    identity = {
        "workspaceId": str(workspace_identity.get("workspace_id") or ""),
        "workspaceKind": str(workspace_identity.get("workspace_kind") or ""),
    }
    roles = [
        role
        for role in ("parent", "child")
        if binding[role]["workspaceIdentity"] == identity
        and binding[role]["initiativeId"] == status.get("initiative_id")
        and binding[role]["assignmentId"] == status.get("assignment_id")
        and binding[role]["stateRoot"] == status.get("query_proof_root")
    ]
    if len(roles) != 1:
        raise ValueError("local Assignment state does not match one binding endpoint")
    role = roles[0]
    root = Path(workspace_root).expanduser().resolve()
    if identity["workspaceKind"] == "home":
        storage_root, storage_kind = root, "home-workspace"
    else:
        storage_root, storage_kind = _sealed_state_storage(root)
    digest = str(binding["bindingRoot"]).removeprefix(assignment_canonical.ROOT)
    relative = Path("assignment-bindings") / "sha256" / digest[:2] / digest
    receipt = {
        "schema": "kungfu.assignment-orchestration.cross-workspace-binding-receipt/v1",
        "bindingRoot": binding["bindingRoot"],
        "localRole": role,
        "localWorkspaceIdentity": identity,
        "localEndpointRoot": assignment_canonical.semantic_root(binding[role]),
        "storageKind": storage_kind,
        "portable": True,
        "pathIsIdentity": False,
    }
    receipt["receiptRoot"] = assignment_canonical.semantic_root(receipt)
    return {
        "schema": "kungfu.assignment-orchestration.cross-workspace-binding-plan/v1",
        "bindingRoot": binding["bindingRoot"],
        "storageRoot": str(storage_root),
        "bindingPath": str(relative / "binding.json"),
        "receiptPath": str(relative / f"{role}-receipt.json"),
        "receipt": receipt,
        "executed": False,
    }


def apply_cross_workspace_binding(
    plan: Mapping[str, Any],
    binding: Mapping[str, Any],
    expected_binding_root: str,
) -> dict[str, Any]:
    if (
        plan.get("bindingRoot") != expected_binding_root
        or binding.get("bindingRoot") != expected_binding_root
    ):
        raise ValueError("cross-workspace binding changed before execution")
    storage_root = Path(str(plan["storageRoot"]))
    binding_path = storage_root / str(plan["bindingPath"])
    receipt_path = storage_root / str(plan["receiptPath"])
    for path, value in (
        (binding_path, binding),
        (receipt_path, plan["receipt"]),
    ):
        content = (assignment_canonical.canonical_json(value) + "\n").encode("utf-8")
        if path.exists() and path.read_bytes() != content:
            raise ValueError(f"immutable cross-workspace binding collision: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(content)
    return {
        **dict(plan["receipt"]),
        "bindingPath": str(binding_path),
        "receiptPath": str(receipt_path),
        "next_actions": [],
    }


def verify_cross_workspace_binding_receipt(
    binding_file: str | Path, receipt_file: str | Path
) -> dict[str, Any]:
    binding = json.loads(Path(binding_file).read_text(encoding="utf-8"))
    receipt = json.loads(Path(receipt_file).read_text(encoding="utf-8"))
    binding_verification = verify_cross_workspace_binding(binding)
    declared_receipt_root = assignment_canonical._root(
        receipt.pop("receiptRoot", ""), "receiptRoot"
    )
    local_role = str(receipt.get("localRole") or "")
    ok = bool(
        binding_verification["ok"]
        and local_role in {"parent", "child"}
        and receipt.get("bindingRoot") == binding.get("bindingRoot")
        and receipt.get("localWorkspaceIdentity")
        == binding[local_role]["workspaceIdentity"]
        and receipt.get("localEndpointRoot")
        == assignment_canonical.semantic_root(binding[local_role])
        and declared_receipt_root == assignment_canonical.semantic_root(receipt)
    )
    return {
        "schema": "kungfu.assignment-orchestration.cross-workspace-binding-receipt-verification/v1",
        "ok": ok,
        "bindingRoot": binding.get("bindingRoot"),
        "receiptRoot": declared_receipt_root,
        "localRole": local_role,
        "runtimeIndependent": True,
        "next_actions": [],
    }
