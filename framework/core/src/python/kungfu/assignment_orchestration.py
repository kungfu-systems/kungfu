# SPDX-License-Identifier: Apache-2.0

"""Pure boundaries for captured Assignment admission and sealed work state."""

from __future__ import annotations

import json
import ntpath
import os
import re
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
OUTCOME_SCHEMA = assignment_outcome.OUTCOME_SCHEMA
OUTCOME_BINDING_SCHEMA = assignment_outcome.OUTCOME_BINDING_SCHEMA
OUTCOME_INDEX_SCHEMA = assignment_outcome.OUTCOME_INDEX_SCHEMA
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


class _CaptureFilesystem:
    @staticmethod
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

    @staticmethod
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


_filesystem_path = _CaptureFilesystem._filesystem_path
_write_exact = _CaptureFilesystem._write_exact


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
    with open(_filesystem_path(path), encoding="utf-8") as source:
        request = json.loads(source.read())
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
        with open(_filesystem_path(receipt_path), encoding="utf-8") as source:
            receipt = json.loads(source.read())
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


assignment_outcome._canonical = assignment_canonical
assignment_outcome._storage_resolver = lambda root: _sealed_state_storage(root)
_validate_outcome_artifact = assignment_outcome.validate_artifact
outcome_binding_plan = assignment_outcome.plan
verify_outcome_binding = assignment_outcome.verify
apply_outcome_binding = assignment_outcome.apply
list_outcome_bindings = assignment_outcome.list_bindings

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
