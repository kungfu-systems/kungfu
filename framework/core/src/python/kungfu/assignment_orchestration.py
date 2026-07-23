# SPDX-License-Identifier: Apache-2.0

"""Pure boundaries for captured Assignment admission and sealed go state."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import unicodedata
from pathlib import Path
from typing import Any, Mapping

ROOT = "sha256:"
REQUEST_SCHEMA = "kungfu.assignment-request/v1"
CAPTURE_RECEIPT_SCHEMA = "kungfu.assignment-capture.receipt/v1"
STATE_SCHEMA = "kungfu.assignment-orchestration.sealed-state/v1"
CROSS_WORKSPACE_BINDING_SCHEMA = (
    "kungfu.assignment-orchestration.cross-workspace-binding/v1"
)
PRODUCT_MANIFEST_SCHEMA = "kungfu.product-upgrade.manifest/v1"
_GIT_REVISION = re.compile(r"^[0-9a-f]{40}$")
PHASES = (
    "admitted",
    "claimed",
    "executing",
    "stage-ready",
    "completion-claimed",
    "independently-reviewed",
    "continuation-decided",
)


def _normalized(value: Any) -> Any:
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [_normalized(row) for row in value]
    if isinstance(value, dict):
        return {
            unicodedata.normalize("NFC", str(key)): _normalized(item)
            for key, item in value.items()
        }
    if value is None or isinstance(value, (bool, int)):
        return value
    raise ValueError(f"unsupported canonical JSON value: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(
        _normalized(value),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def semantic_root(value: Any) -> str:
    return ROOT + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def source_root(*starts: str | Path) -> Path:
    """Resolve the owning Kungfu checkout in source and assembled layouts."""

    candidates = [Path(value).expanduser().resolve() for value in starts]
    candidates.extend((Path(__file__).resolve(), Path.cwd().resolve()))
    for start in candidates:
        directory = start if start.is_dir() else start.parent
        for candidate in (directory, *directory.parents):
            if (candidate / ".git").exists() and (
                candidate / "framework" / "core"
            ).is_dir():
                return candidate
    return Path(__file__).resolve().parents[5]


def binding_provenance(*, allow_foreign: bool = False) -> dict[str, Any]:
    """Fail closed unless pykungfu belongs to this source or installed product.

    Source admission binds the native extension to the exact Git checkout and
    build-info revision.  Installed admission instead binds the extension,
    packaged runtime, release manifest, and source revision without requiring a
    source checkout.  The two paths are explicit peers; a foreign binding is
    never silently upgraded to either authority.
    """

    import kungfu

    binding_file = Path(str(getattr(kungfu.__binding__, "__file__", ""))).resolve()
    checkout = source_root(binding_file)
    allowed_roots = [
        (checkout / "framework" / "core" / "build").resolve(),
        (checkout / "framework" / "core" / "dist").resolve(),
    ]
    compiled = binding_file.suffix.lower() in {".so", ".dylib", ".pyd"}
    build_info_path = binding_file.parent / "kungfubuildinfo.json"
    try:
        build_info = json.loads(build_info_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        build_info = {}
    build_revision = str(build_info.get("git", {}).get("revision") or "")
    source_layout = compiled and any(
        binding_file == root or root in binding_file.parents for root in allowed_roots
    )
    try:
        checkout_revision = subprocess.run(
            ["git", "-C", str(checkout), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        checkout_revision = ""
    current = bool(
        source_layout
        and _GIT_REVISION.fullmatch(build_revision)
        and build_revision == checkout_revision
        and build_info.get("git", {}).get("pristine") is True
    )

    install_source = os.environ.get("KUNGFU_INSTALL_SOURCE", "")
    runtime_value = os.environ.get("KUNGFU_DIR", "")
    manifest_value = os.environ.get("KUNGFU_UPGRADE_MANIFEST", "")
    runtime_root = Path(runtime_value).expanduser().resolve() if runtime_value else None
    manifest_path = (
        Path(manifest_value).expanduser().resolve() if manifest_value else None
    )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (AttributeError, OSError, json.JSONDecodeError):
        manifest = {}
    manifest_revision = str(manifest.get("sourceCommit") or "")
    installed = bool(
        compiled
        and install_source in {"archive", "desktop-companion"}
        and runtime_root is not None
        and (binding_file == runtime_root or runtime_root in binding_file.parents)
        and manifest.get("schema") == PRODUCT_MANIFEST_SCHEMA
        and _GIT_REVISION.fullmatch(manifest_revision)
        and manifest_revision == build_revision
        and str(manifest.get("runtimeEntrypoint") or "") == "kungfu"
        and str(manifest.get("runtimeArtifactDigest") or "").startswith(ROOT)
    )
    override = (
        allow_foreign
        or os.environ.get("KUNGFU_ASSIGNMENT_ADMIT_ALLOW_FOREIGN_BINDING") == "1"
    )
    result = {
        "schema": "kungfu.assignment-orchestration.binding-provenance/v1",
        "ok": bool(current or installed or override),
        "state": (
            "current-checkout"
            if current
            else "installed-product"
            if installed
            else "degraded"
        ),
        "binding_file": str(binding_file),
        "checkout": str(checkout) if current else None,
        "compiled": compiled,
        "install_source": install_source or None,
        "runtime_root": str(runtime_root) if installed else None,
        "manifest_path": str(manifest_path) if installed else None,
        "source_revision": build_revision or None,
        "manifest_root": semantic_root(manifest) if installed else None,
        "build_info_root": semantic_root(build_info) if build_info else None,
        "override": bool(override and not current and not installed),
        "fail_closed": not current and not installed and not override,
    }
    result["provenance_root"] = semantic_root(result)
    return result


def load_captured_request(request_file: str | Path) -> dict[str, Any]:
    path = Path(request_file).expanduser().resolve()
    request = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(request, dict) or request.get("schema") != REQUEST_SCHEMA:
        raise ValueError(f"request must use {REQUEST_SCHEMA}")
    if set(request) != {"schema", "source", "retention", "workDefinition"}:
        raise ValueError("captured request has an invalid top-level field set")
    if not isinstance(request.get("workDefinition"), dict):
        raise ValueError("captured request workDefinition must be an object")
    request_root = semantic_root(request)
    digest = request_root.removeprefix(ROOT)
    if path.name != "request.json" or path.parent.name != digest:
        raise ValueError("captured request path does not match its semantic root")
    receipt_dir = path.parent / "receipts" / "sha256"
    receipt_roots = []
    if not receipt_dir.is_dir():
        raise ValueError("captured request has no capture receipt")
    for receipt_path in sorted(receipt_dir.glob("*.json")):
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        declared = str(receipt.pop("receiptRoot", ""))
        if (
            receipt.get("schema") != CAPTURE_RECEIPT_SCHEMA
            or receipt.get("requestRoot") != request_root
            or declared != semantic_root(receipt)
            or receipt_path.name != f"{declared.removeprefix(ROOT)}.json"
        ):
            raise ValueError(f"capture receipt does not verify: {receipt_path}")
        receipt_roots.append(declared)
    if not receipt_roots:
        raise ValueError("captured request has no valid capture receipt")
    return {
        "request": request,
        "request_root": request_root,
        "capture_receipt_roots": receipt_roots,
        "request_path": str(path),
    }


def atlas_assignment_projection(
    captured: Mapping[str, Any],
    *,
    initiative_id: str = "",
    assignment_id: str = "",
) -> dict[str, Any]:
    work = dict(captured["request"]["workDefinition"])
    resource = work.get("resource_plan")
    resource = resource if isinstance(resource, dict) else {}
    dependencies = resource.get("depends_on") or work.get("depends_on") or []
    if not isinstance(dependencies, list):
        dependencies = []
    initiative = initiative_id or str(work.get("mission_id") or "")
    assignment = assignment_id or str(work.get("goal_id") or "")
    context_binding = work.get("context_binding") or {}
    if not isinstance(context_binding, dict):
        raise ValueError("workDefinition context_binding must be an object")
    if not initiative or not assignment:
        raise ValueError("admission requires initiative and assignment identities")
    return {
        "initiative_id": initiative,
        "initiative_title": str(work.get("mission_title") or initiative),
        "initiative_intent": str(
            work.get("mission_why_matters") or work.get("objective") or assignment
        ),
        "assignment_id": assignment,
        "title": str(work.get("title") or assignment),
        "objective": str(work.get("objective") or work.get("summary") or assignment),
        "parent_assignment_id": str(
            work.get("parent_goal") or work.get("mission_parent_goal") or ""
        ),
        "depends_on": [str(row) for row in dependencies],
        "responsibility": str(
            work.get("mission_why_matters")
            or work.get("objective")
            or work.get("owner_agent")
            or ""
        ),
        "work_definition": work,
        "context_binding": context_binding,
        "request_root": str(captured["request_root"]),
        "capture_receipt_roots": list(captured["capture_receipt_roots"]),
    }


def next_actions(status: Mapping[str, Any]) -> list[dict[str, Any]]:
    identity = {
        "initiative_id": str(status.get("initiative_id") or ""),
        "assignment_id": str(status.get("assignment_id") or ""),
    }
    phase = str(status.get("phase") or "")
    table = {
        "admitted": [("claim", "Mint a bounded owner/agent/slot lease")],
        "claimed": [("kickoff", "Enter execution under the active lease")],
        "executing": [("stage", "Record the stage-ready boundary")],
        "stage-ready": [("claim-completion", "Publish proof-backed completion")],
        "completion-claimed": [("review", "Run independent completion review")],
        "independently-reviewed": [("decide", "Bind a continuation decision")],
        "continuation-decided": [("seal", "Seal portable orchestration state")],
    }
    return [
        {"action": action, "description": description, "input": identity}
        for action, description in table.get(phase, [])
    ]


def gate(status: Mapping[str, Any], target: str) -> dict[str, Any]:
    phase = str(status.get("phase") or "")
    has_lease = bool(status.get("active_lease"))
    if target == "run":
        ok = phase in {"claimed", "executing", "stage-ready"} and has_lease
        reason = (
            "active bounded execution lease"
            if ok
            else (
                "run requires claimed/executing/stage-ready phase and an active lease"
            )
        )
    elif target == "closeout":
        ok = phase == "continuation-decided"
        reason = (
            "continuation decision is recorded"
            if ok
            else "closeout requires continuation-decided phase"
        )
    else:
        raise ValueError("gate target must be run or closeout")
    response = {
        "schema": "kungfu.assignment-orchestration.gate/v1",
        "ok": ok,
        "phase": phase,
        "policy": "required",
        "reason": reason,
        "target": target,
        "assignment_subject": status.get("assignment_subject"),
        "query_proof_root": status.get("query_proof_root"),
        "next_actions": [] if ok else next_actions(status),
    }
    response["atlas_compatibility"] = {
        "schema": "atlas.project-cut-go-gate/v1",
        "ok": ok,
        "phase": phase,
        "policy": "required",
        "reason": reason,
        "state_path": "kungfu-native-fact-library",
        "target": target,
    }
    return response


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
    state_root = semantic_root(snapshot)
    digest = state_root.removeprefix(ROOT)
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
    state_bytes = (canonical_json(plan["snapshot"]) + "\n").encode("utf-8")
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
    receipt_bytes = (canonical_json(receipt) + "\n").encode("utf-8")
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
    root = semantic_root(snapshot)
    return {
        "schema": "kungfu.assignment-orchestration.seal-verification/v1",
        "ok": snapshot.get("schema") == STATE_SCHEMA
        and path.parent.name == root.removeprefix(ROOT),
        "state_root": root,
        "phase": snapshot.get("phase"),
        "next_actions": [],
    }


def _root(value: Any, field: str, *, optional: bool = False) -> str:
    text = str(value or "")
    if optional and not text:
        return ""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", text):
        raise ValueError(f"{field} must be a sha256 root")
    return text


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
            _root(row, "evidenceEpisodeRoots")
            for row in assignment.get("evidence_episode_roots") or []
        }
    )
    captures = sorted(
        {
            _root(row, "captureReceiptRoots")
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
        "stateRoot": _root(status.get("query_proof_root"), "stateRoot"),
        "projectCutRoot": _root(
            assignment.get("project_cut_root"), "projectCutRoot", optional=True
        ),
        "evidenceRoots": evidence,
        "requestRoot": _root(assignment.get("request_root"), "requestRoot"),
        "captureReceiptRoots": captures,
        "admissionReceiptRoot": _root(
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

    binding = {
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
    return {**binding, "bindingRoot": semantic_root(binding)}


def verify_cross_workspace_binding(binding: Mapping[str, Any]) -> dict[str, Any]:
    value = dict(binding)
    declared = _root(value.pop("bindingRoot", ""), "bindingRoot")
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
            _root(endpoint.get(field), f"{role}.{field}")
        _root(endpoint.get("projectCutRoot"), f"{role}.projectCutRoot", optional=True)
        for field in ("evidenceRoots", "captureReceiptRoots"):
            roots = endpoint.get(field)
            if not isinstance(roots, list) or roots != sorted(set(roots)):
                raise ValueError(f"{role}.{field} must be sorted and unique")
            for root in roots:
                _root(root, f"{role}.{field}")
    if value["parent"]["workspaceIdentity"] == value["child"]["workspaceIdentity"]:
        raise ValueError("cross-workspace binding endpoints name the same workspace")
    return {
        "schema": "kungfu.assignment-orchestration.cross-workspace-binding-verification/v1",
        "ok": semantic_root(value) == declared,
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
    digest = str(binding["bindingRoot"]).removeprefix(ROOT)
    relative = Path("assignment-bindings") / "sha256" / digest[:2] / digest
    receipt = {
        "schema": "kungfu.assignment-orchestration.cross-workspace-binding-receipt/v1",
        "bindingRoot": binding["bindingRoot"],
        "localRole": role,
        "localWorkspaceIdentity": identity,
        "localEndpointRoot": semantic_root(binding[role]),
        "storageKind": storage_kind,
        "portable": True,
        "pathIsIdentity": False,
    }
    receipt["receiptRoot"] = semantic_root(receipt)
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
        content = (canonical_json(value) + "\n").encode("utf-8")
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
    declared_receipt_root = _root(receipt.pop("receiptRoot", ""), "receiptRoot")
    local_role = str(receipt.get("localRole") or "")
    ok = bool(
        binding_verification["ok"]
        and local_role in {"parent", "child"}
        and receipt.get("bindingRoot") == binding.get("bindingRoot")
        and receipt.get("localWorkspaceIdentity")
        == binding[local_role]["workspaceIdentity"]
        and receipt.get("localEndpointRoot") == semantic_root(binding[local_role])
        and declared_receipt_root == semantic_root(receipt)
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
