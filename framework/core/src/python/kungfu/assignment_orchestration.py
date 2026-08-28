# SPDX-License-Identifier: Apache-2.0

"""Pure boundaries for captured Assignment admission and sealed work state."""

from __future__ import annotations

import json
import ntpath
import os
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from kungfu import assignment_outcome, assignment_provenance
from kungfu.initiative_family import canonical as assignment_canonical

REQUEST_SCHEMA = "kungfu.assignment-request/v1"
CAPTURE_RECEIPT_SCHEMA = "kungfu.assignment-capture.receipt/v1"
CAPTURE_RESPONSE_SCHEMA = "kungfu.assignment-capture.response/v1"
INITIATIVE_ADMISSION_SCHEMA = "kungfu.work-control.initiative-admission/v1"
INITIATIVE_SOURCE_SCHEMA = "kungfu.work-control.exact-source/v1"
RETENTION_POLICY = "explicit-expiry-retain-bytes-v1"
STATE_SCHEMA = "kungfu.assignment-orchestration.sealed-state/v1"
OUTCOME_SCHEMA = assignment_outcome.OutcomeBindings.OUTCOME_SCHEMA
OUTCOME_BINDING_SCHEMA = assignment_outcome.OutcomeBindings.BINDING_SCHEMA
OUTCOME_INDEX_SCHEMA = assignment_outcome.OutcomeBindings.INDEX_SCHEMA
CROSS_WORKSPACE_BINDING_SCHEMA = (
    "kungfu.assignment-orchestration.cross-workspace-binding/v1"
)
PHASES = (
    "admitted",
    "claimed",
    "executing",
    "stage-ready",
    "completion-claimed",
    "independently-reviewed",
    "continuation-decided",
)


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


def _same_or_descendant(path: Path, root: Path) -> bool:
    """Accept filesystem aliases without weakening the runtime-root boundary."""

    if path == root or root in path.parents:
        return True
    for candidate in (path, *path.parents):
        try:
            if candidate.samefile(root):
                return True
        except OSError:
            continue
    return False


def binding_provenance(*, allow_foreign: bool = False) -> dict[str, Any]:
    """Fail closed unless pykungfu belongs to this source or installed product.

    Source admission binds the native extension to the exact Git checkout and
    build-info revision.  Installed admission instead binds the extension,
    packaged runtime, release manifest, and source revision without requiring a
    source checkout.  The two paths are explicit peers; a foreign binding is
    never silently upgraded to either authority.
    """

    return assignment_provenance.inspect_binding(
        allow_foreign=allow_foreign,
        source_resolver=source_root,
        descendant_check=_same_or_descendant,
        entrypoint_resolver=assignment_provenance.installed_runtime_entrypoint,
    )


def _validate_capture_value(value: Any) -> None:
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        if unicodedata.normalize("NFC", value) != value:
            raise ValueError("canonical JSON strings must be NFC-normalized")
        return
    if isinstance(value, int):
        if value < 0 or value > 9_007_199_254_740_991:
            raise ValueError("canonical JSON integers must be non-negative and safe")
        return
    if isinstance(value, list):
        for item in value:
            _validate_capture_value(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("canonical JSON object keys must be strings")
            _validate_capture_value(key)
            _validate_capture_value(item)
        return
    raise ValueError(f"unsupported canonical JSON value: {type(value).__name__}")


def validate_assignment_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Assignment request must be a JSON object")
    expected = {"retention", "schema", "source", "workDefinition"}
    unknown = sorted(set(value) - expected)
    if unknown:
        raise ValueError(f"Assignment request has an unknown field: {unknown[0]}")
    if set(value) != expected or value.get("schema") != REQUEST_SCHEMA:
        raise ValueError(f"Assignment request schema must be {REQUEST_SCHEMA}")
    if not isinstance(value.get("workDefinition"), dict):
        raise ValueError("workDefinition must be a JSON object")
    source = value.get("source")
    if (
        not isinstance(source, dict)
        or not isinstance(source.get("kind"), str)
        or not source["kind"].strip()
    ):
        raise ValueError("source.kind must be a non-empty string")
    retention = value.get("retention")
    if (
        not isinstance(retention, dict)
        or set(retention) != {"policy", "expiresAt"}
        or retention.get("policy") != RETENTION_POLICY
    ):
        raise ValueError(f"retention must declare {RETENTION_POLICY} and expiresAt")
    expires_at = retention.get("expiresAt")
    if expires_at is not None:
        if not isinstance(
            expires_at, str
        ) or not assignment_canonical._ISO_8601.fullmatch(expires_at):
            raise ValueError(
                "retention.expiresAt must be null or an ISO-8601 timestamp"
            )
        try:
            datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(
                "retention.expiresAt must be null or an ISO-8601 timestamp"
            ) from error
    _validate_capture_value(value)
    return value


def _filesystem_path(path: Path, *, platform: str = os.name) -> str:
    value = os.fspath(path)
    if platform != "nt":
        return value
    absolute = os.path.abspath(value) if os.name == "nt" else ntpath.abspath(value)
    if absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def _write_exact(path: Path, content: bytes) -> bool:
    filesystem_path = _filesystem_path(path)
    if os.path.exists(filesystem_path):
        with open(filesystem_path, "rb") as source:
            existing = source.read()
        if existing != content:
            raise ValueError(f"content-addressed file differs: {path}")
        return False
    parent = os.path.dirname(filesystem_path)
    os.makedirs(parent, exist_ok=True)
    descriptor, temporary_value = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=parent
    )
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
        try:
            os.link(temporary_value, filesystem_path)
        except FileExistsError:
            with open(filesystem_path, "rb") as source:
                existing = source.read()
            if existing != content:
                raise ValueError(f"content-addressed file differs: {path}")
            return False
        return True
    finally:
        try:
            os.unlink(temporary_value)
        except FileNotFoundError:
            pass


def _read_text_exact(path: Path) -> str:
    with open(_filesystem_path(path), encoding="utf-8") as source:
        return source.read()


def capture_assignment_request(request: Any, target: Any) -> dict[str, Any]:
    request = validate_assignment_request(request)
    request_root = assignment_canonical.semantic_root(request)
    digest = request_root.removeprefix(assignment_canonical.ROOT)
    directory = (
        Path(target.identity.data_home)
        / "inbox"
        / "assignment-requests"
        / "sha256"
        / digest[:2]
        / digest
    )
    request_path = directory / "request.json"
    receipt_core = {
        "schema": CAPTURE_RECEIPT_SCHEMA,
        "operationClass": target.operation_class,
        "requestRoot": request_root,
        "requestPath": os.path.relpath(request_path, target.identity.data_home),
        "workspaceId": target.identity.workspace_id,
        "workspaceKind": target.identity.workspace_kind,
        "workspaceRoot": target.identity.workspace_root,
        "resolutionReason": target.identity.resolution_reason,
        "association": target.association,
        "sourceWorkingDirectory": target.source_working_directory,
        "effects": ["assignment-request-captured", "capture-receipt-recorded"],
        "skippedEffects": [
            "initiative-association",
            "assignment-admission",
            "assignment-claim",
            "runtime-initialization",
            "journal-write",
            "git-init",
            "git-stage",
            "git-commit",
            "git-push",
        ],
    }
    if target.association == "unassigned":
        receipt_core["skippedEffects"].insert(0, "project-association")
    receipt_root = assignment_canonical.semantic_root(receipt_core)
    receipt = {**receipt_core, "receiptRoot": receipt_root}
    receipt_path = (
        directory
        / "receipts"
        / "sha256"
        / f"{receipt_root.removeprefix(assignment_canonical.ROOT)}.json"
    )
    request_written = _write_exact(
        request_path, (assignment_canonical.canonical_json(request) + "\n").encode()
    )
    receipt_written = _write_exact(
        receipt_path, (assignment_canonical.canonical_json(receipt) + "\n").encode()
    )
    return {
        "schema": CAPTURE_RESPONSE_SCHEMA,
        "status": (
            "captured" if request_written or receipt_written else "already-present"
        ),
        "requestRoot": request_root,
        "receiptRoot": receipt_root,
        "requestPath": str(request_path),
        "receiptPath": str(receipt_path),
        "target": {
            "operationClass": target.operation_class,
            "workspaceId": target.identity.workspace_id,
            "workspaceKind": target.identity.workspace_kind,
            "workspaceRoot": target.identity.workspace_root,
            "dataHome": target.identity.data_home,
            "resolutionReason": target.identity.resolution_reason,
            "association": target.association,
            "sourceWorkingDirectory": target.source_working_directory,
            "runtimeInitialized": Path(target.runtime_dir).is_dir(),
        },
        "authority": "capture-material-only",
        "admitted": False,
        "claimed": False,
    }


def load_captured_request(request_file: str | Path) -> dict[str, Any]:
    path = Path(request_file).expanduser().resolve()
    request = json.loads(_read_text_exact(path))
    if not isinstance(request, dict) or request.get("schema") != REQUEST_SCHEMA:
        raise ValueError(f"request must use {REQUEST_SCHEMA}")
    if set(request) != {"schema", "source", "retention", "workDefinition"}:
        raise ValueError("captured request has an invalid top-level field set")
    if not isinstance(request.get("workDefinition"), dict):
        raise ValueError("captured request workDefinition must be an object")
    request_root = assignment_canonical.semantic_root(request)
    digest = request_root.removeprefix(assignment_canonical.ROOT)
    if path.name != "request.json" or path.parent.name != digest:
        raise ValueError("captured request path does not match its semantic root")
    receipt_dir = path.parent / "receipts" / "sha256"
    receipt_roots = []
    filesystem_receipt_dir = _filesystem_path(receipt_dir)
    if not os.path.isdir(filesystem_receipt_dir):
        raise ValueError("captured request has no capture receipt")
    receipt_names = sorted(
        entry.name
        for entry in os.scandir(filesystem_receipt_dir)
        if entry.name.endswith(".json")
    )
    for receipt_name in receipt_names:
        receipt_path = receipt_dir / receipt_name
        receipt = json.loads(_read_text_exact(receipt_path))
        declared = str(receipt.pop("receiptRoot", ""))
        if (
            receipt.get("schema") != CAPTURE_RECEIPT_SCHEMA
            or receipt.get("requestRoot") != request_root
            or declared != assignment_canonical.semantic_root(receipt)
            or receipt_path.name
            != f"{declared.removeprefix(assignment_canonical.ROOT)}.json"
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


def load_initiative_admission(
    admission_file: str | Path, *, stdin_text: str = ""
) -> dict[str, Any]:
    """Verify one explicit exact-source promotion into a native Initiative."""

    if str(admission_file) == "-":
        value = json.loads(stdin_text)
    else:
        value = json.loads(
            Path(admission_file).expanduser().read_text(encoding="utf-8")
        )
    if not isinstance(value, dict):
        raise ValueError("Initiative admission must be a JSON object")
    declared_root = assignment_canonical._root(
        value.pop("admissionRoot", ""), "admissionRoot"
    )
    source = value.get("source")
    if value.get("schema") != INITIATIVE_ADMISSION_SCHEMA:
        raise ValueError("Initiative admission schema is unsupported")
    if not isinstance(source, dict) or source.get("schema") != INITIATIVE_SOURCE_SCHEMA:
        raise ValueError("Initiative admission requires one exact source identity")
    allowed_source = {
        "schema",
        "authority",
        "kind",
        "sourceId",
        "versionRoot",
    }
    if set(source) != allowed_source:
        raise ValueError("Initiative source identity has unsupported fields")
    if not all(
        str(source.get(field) or "").strip()
        for field in ("authority", "kind", "sourceId")
    ):
        raise ValueError("Initiative source authority, kind, and id are required")
    assignment_canonical._root(source.get("versionRoot"), "source.versionRoot")
    if not all(
        str(value.get(field) or "").strip()
        for field in ("initiativeId", "title", "intent")
    ):
        raise ValueError("Initiative id, title, and intent are required")
    if assignment_canonical.semantic_root(value) != declared_root:
        raise ValueError("Initiative admission root does not verify")
    return {
        **value,
        "source": dict(source),
        "admissionRoot": declared_root,
    }


def assignment_projection(
    captured: Mapping[str, Any],
    *,
    initiative_id: str = "",
    assignment_id: str = "",
    initiative_admission: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    work = dict(captured["request"]["workDefinition"])
    request_source = captured["request"].get("source") or {}
    hierarchy = work.get("hierarchy") or {}
    family_initiative_child = bool(
        isinstance(request_source, dict)
        and request_source.get("kind") == "kungfu-assignment-family-child"
        and isinstance(hierarchy, dict)
        and hierarchy.get("role") == "initiative-child"
        and str(hierarchy.get("parent_assignment_id") or "")
        == str(work.get("initiative_id") or "")
    )
    resource = work.get("resource_plan")
    resource = resource if isinstance(resource, dict) else {}
    dependencies = resource.get("depends_on") or work.get("depends_on") or []
    if not isinstance(dependencies, list):
        dependencies = []
    initiative = initiative_id or str(work.get("initiative_id") or "")
    assignment = assignment_id or str(work.get("assignment_id") or "")
    context_binding = work.get("context_binding") or {}
    if not isinstance(context_binding, dict):
        raise ValueError("workDefinition context_binding must be an object")
    evidence_episode_roots = work.get("evidence_episode_roots") or []
    if not isinstance(evidence_episode_roots, list):
        raise ValueError("workDefinition evidence_episode_roots must be an array")
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
    if parent_assignment_ref and work.get("parent_assignment_id"):
        raise ValueError(
            "workDefinition cannot mix parent Assignment ref and local shorthand"
        )
    if dependency_refs and dependencies:
        raise ValueError(
            "workDefinition cannot mix dependency refs and local shorthand"
        )
    explicit_initiative = dict(initiative_admission or {})
    if initiative_ref and explicit_initiative:
        raise ValueError(
            "admission cannot mix an exact Initiative WorkRef and source promotion"
        )
    if explicit_initiative:
        promoted_id = str(explicit_initiative.get("initiativeId") or "")
        source = explicit_initiative.get("source") or {}
        if promoted_id != initiative:
            raise ValueError(
                "explicit Initiative admission does not match requested identity"
            )
        if str(source.get("sourceId") or "") != initiative:
            raise ValueError(
                "Initiative source identity does not match requested identity"
            )
    return {
        "initiative_id": initiative,
        "initiative_title": str(
            explicit_initiative.get("title")
            or work.get("initiative_title")
            or initiative
        ),
        "initiative_intent": str(
            explicit_initiative.get("intent")
            or work.get("initiative_intent")
            or work.get("objective")
            or assignment
        ),
        "initiative_source_identity": (
            {
                **dict(explicit_initiative.get("source") or {}),
                "admissionRoot": str(explicit_initiative.get("admissionRoot") or ""),
            }
            if explicit_initiative
            else {}
        ),
        "assignment_id": assignment,
        "title": str(work.get("title") or assignment),
        "objective": str(work.get("objective") or work.get("summary") or assignment),
        # Family child cards retain the inert Initiative parent in their
        # lossless work definition. It is not a workspace-local Assignment
        # shorthand; only an exact parent_assignment_ref may add that edge.
        "parent_assignment_id": (
            ""
            if family_initiative_child
            else str(work.get("parent_assignment_id") or "")
        ),
        "depends_on": [str(row) for row in dependencies],
        "initiative_ref": initiative_ref,
        "parent_assignment_ref": parent_assignment_ref,
        "dependency_refs": [dict(row) for row in dependency_refs],
        "responsibility": str(
            work.get("responsibility")
            or work.get("objective")
            or work.get("owner_agent")
            or ""
        ),
        "work_definition": work,
        "context_binding": context_binding,
        "project_cut_root": assignment_canonical._root(
            work.get("project_cut_root"), "projectCutRoot", optional=True
        ),
        "evidence_episode_roots": sorted(
            {
                assignment_canonical._root(value, "evidenceEpisodeRoots")
                for value in evidence_episode_roots
            }
        ),
        "request_root": str(captured["request_root"]),
        "capture_receipt_roots": list(captured["capture_receipt_roots"]),
    }


_NEXT_ACTIONS_BY_PHASE = {
    "admitted": [("claim", "Mint a bounded owner/agent/slot lease")],
    "claimed": [("kickoff", "Enter execution under the active lease")],
    "executing": [("stage", "Record the stage-ready boundary")],
    "recovery-required": [("fresh-recovery-plan", "Recover a fresh attempt")],
    "recovered-closeout": [("claim-completion", "Publish proof-backed completion")],
    "stage-ready": [("claim-completion", "Publish proof-backed completion")],
    "completion-claimed": [("review", "Run independent completion review")],
    "independently-reviewed": [("decide", "Bind a continuation decision")],
    "continuation-decided": [("seal", "Seal portable orchestration state")],
}


class _NextActionProjection:
    @staticmethod
    def semantic_actions(
        status: Mapping[str, Any], phase: str, identity: Mapping[str, str]
    ) -> list[dict[str, Any]] | None:
        work_semantics = status.get("work_semantics")
        if not isinstance(work_semantics, Mapping):
            return None
        semantic_state = (
            phase,
            bool(work_semantics.get("current_input_snapshot")),
            work_semantics.get("completion_eligible") is True,
        )
        if semantic_state not in {
            ("executing", True, False),
            ("recovered-closeout", True, False),
            ("stage-ready", True, False),
        }:
            return None
        return [
            {
                "action": str(row["action"]),
                "description": (
                    "Complete current Work semantics before publishing completion"
                ),
                "input": dict(identity),
                **({"reason": str(row["reason"])} if row.get("reason") else {}),
            }
            for row in work_semantics.get("next_actions", [])
        ]

    @staticmethod
    def project(status: Mapping[str, Any]) -> list[dict[str, Any]]:
        identity = {
            "initiative_id": str(status.get("initiative_id", "")),
            "assignment_id": str(status.get("assignment_id", "")),
        }
        phase = str(status.get("phase", ""))
        if phase == "executing" and not status.get("active_lease"):
            recovered = status.get("recovery_continuation")
            phase = "recovered-closeout" if recovered else "recovery-required"
        semantic_actions = _NextActionProjection.semantic_actions(
            status, phase, identity
        )
        if semantic_actions is not None:
            return semantic_actions
        return [
            {"action": action, "description": description, "input": identity}
            for action, description in _NEXT_ACTIONS_BY_PHASE.get(phase, [])
        ]


def next_actions(status: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Preserve the public facade seam while delegating projection ownership."""

    return _NextActionProjection.project(status)


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
    return response


from kungfu._assignment_orchestration.portable import (  # noqa: E402
    _git_common_dir as _git_common_dir,
    _sealed_state_storage as _sealed_state_storage,
    sealed_state_plan as _sealed_state_plan_impl,
    apply_sealed_state as apply_sealed_state,
    verify_sealed_state as verify_sealed_state,
    list_sealed_assignment_states as list_sealed_assignment_states,
    _binding_endpoint as _binding_endpoint,
    cross_workspace_binding as cross_workspace_binding,
    verify_cross_workspace_binding as verify_cross_workspace_binding,
    cross_workspace_binding_plan as cross_workspace_binding_plan,
    apply_cross_workspace_binding as apply_cross_workspace_binding,
    verify_cross_workspace_binding_receipt as verify_cross_workspace_binding_receipt,
)


def sealed_state_plan(
    workspace_root: str | Path,
    status: Mapping[str, Any],
    *,
    workspace_identity: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Preserve the welded authority witness while delegating portable storage."""

    return _sealed_state_plan_impl(
        workspace_root,
        status,
        workspace_identity=workspace_identity,
    )


assignment_outcome._canonical = assignment_canonical
assignment_outcome._storage_resolver = lambda root: _sealed_state_storage(root)
_validate_outcome_artifact = assignment_outcome.OutcomeBindings.validate_artifact
outcome_binding_plan = assignment_outcome.OutcomeBindings.plan
verify_outcome_binding = assignment_outcome.OutcomeBindings.verify
apply_outcome_binding = assignment_outcome.OutcomeBindings.apply
list_outcome_bindings = assignment_outcome.OutcomeBindings.list

for _public_name, _public_function in (
    ("_validate_outcome_artifact", _validate_outcome_artifact),
    ("outcome_binding_plan", outcome_binding_plan),
    ("verify_outcome_binding", verify_outcome_binding),
    ("apply_outcome_binding", apply_outcome_binding),
    ("list_outcome_bindings", list_outcome_bindings),
):
    _public_function.__name__ = _public_name
    _public_function.__qualname__ = _public_name
    _public_function.__module__ = __name__
