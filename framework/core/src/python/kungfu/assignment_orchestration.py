# SPDX-License-Identifier: Apache-2.0

"""Pure boundaries for captured Assignment admission and sealed go state."""

from __future__ import annotations

import hashlib
import json
import os
import unicodedata
from pathlib import Path
from typing import Any, Mapping

ROOT = "sha256:"
REQUEST_SCHEMA = "kungfu.assignment-request/v1"
CAPTURE_RECEIPT_SCHEMA = "kungfu.assignment-capture.receipt/v1"
STATE_SCHEMA = "kungfu.assignment-orchestration.sealed-state/v1"
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
    """Fail closed unless pykungfu is compiled from this checkout."""

    import kungfu

    binding_file = Path(str(getattr(kungfu.__binding__, "__file__", ""))).resolve()
    checkout = source_root(binding_file)
    allowed_roots = [
        (checkout / "framework" / "core" / "build").resolve(),
        (checkout / "framework" / "core" / "dist").resolve(),
    ]
    compiled = binding_file.suffix.lower() in {".so", ".dylib", ".pyd"}
    current = compiled and any(
        binding_file == root or root in binding_file.parents for root in allowed_roots
    )
    override = (
        allow_foreign
        or os.environ.get("KUNGFU_ASSIGNMENT_ADMIT_ALLOW_FOREIGN_BINDING") == "1"
    )
    return {
        "schema": "kungfu.assignment-orchestration.binding-provenance/v1",
        "ok": bool(current or override),
        "state": "current-checkout" if current else "degraded",
        "binding_file": str(binding_file),
        "checkout": str(checkout),
        "compiled": compiled,
        "override": bool(override and not current),
        "fail_closed": not current and not override,
    }


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
    if not initiative or not assignment:
        raise ValueError("admission requires initiative and assignment identities")
    initiative_ref = work.get("initiative_ref") or {}
    parent_assignment_ref = work.get("parent_assignment_ref") or {}
    dependency_refs = work.get("dependency_refs") or []
    if not isinstance(initiative_ref, dict):
        raise ValueError("workDefinition.initiative_ref must be an object")
    if not isinstance(parent_assignment_ref, dict):
        raise ValueError("workDefinition.parent_assignment_ref must be an object")
    if not isinstance(dependency_refs, list) or not all(
        isinstance(row, dict) for row in dependency_refs
    ):
        raise ValueError("workDefinition.dependency_refs must be an array of objects")
    if parent_assignment_ref and work.get("mission_parent_goal"):
        raise ValueError(
            "workDefinition cannot mix parent Assignment ref and local shorthand"
        )
    if dependency_refs and dependencies:
        raise ValueError(
            "workDefinition cannot mix dependency refs and local shorthand"
        )
    return {
        "initiative_id": initiative,
        "initiative_title": str(work.get("mission_title") or initiative),
        "initiative_intent": str(
            work.get("mission_why_matters") or work.get("objective") or assignment
        ),
        "assignment_id": assignment,
        "title": str(work.get("title") or assignment),
        "objective": str(work.get("objective") or work.get("summary") or assignment),
        "parent_assignment_id": str(work.get("mission_parent_goal") or ""),
        "depends_on": [str(row) for row in dependencies],
        "initiative_ref": initiative_ref,
        "parent_assignment_ref": parent_assignment_ref,
        "dependency_refs": [dict(row) for row in dependency_refs],
        "responsibility": str(
            work.get("mission_why_matters")
            or work.get("objective")
            or work.get("owner_agent")
            or ""
        ),
        "work_definition": work,
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
    workspace_root: str | Path, status: Mapping[str, Any]
) -> dict[str, Any]:
    root = Path(workspace_root).expanduser().resolve()
    snapshot = {
        "schema": STATE_SCHEMA,
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
        "worktreeDeletionSafe": plan["storage_kind"] == "git-common-dir",
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
