# SPDX-License-Identifier: Apache-2.0

"""Work Control Assignment lifecycle, evidence, and completion claims."""

import json
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from kungfu.storage import service as storage_service

from ._work_control_state import (
    AGENT_FACT_SOURCE_ID,
    ASSIGNMENT_EXECUTION_CLAIM,
    ASSIGNMENT_PHASES,
    ASSIGNMENT_PHASE_TRANSITION,
    CLAIM_SURFACE_ID,
    COMPLETION_CLAIM,
    GIT_OBJECT_ID,
    USER_FACT_SOURCE_ID,
    _ensure_contract,
    _episode_root,
    _ensure_native_write_allowed,
    _native_source,
    _put_native_fact,
    _root_id,
    _stable_id,
    query_state,
    _sha256_root,
)


def resolve_canonical_state(
    runtime_dir: str,
    initiative_id: str,
    storage_source_id: str,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Reuse one canonical projection or obtain it from its query authority."""

    if existing is not None:
        return existing
    return query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
    )


def assignment_orchestration_status(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    storage_source_id: str = "kungfu",
    now: str = "",
    canonical_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fold append-only orchestration facts into one deterministic Assignment phase."""

    from . import native_state

    state = resolve_canonical_state(
        runtime_dir, initiative_id, storage_source_id, canonical_state
    )
    assignment = native_state.assignment_row(state, assignment_id)
    assignment_subject = str(assignment["subject_key"])
    linked = [
        row
        for row in state["claims"] + state["reviews"]
        if row.get("payload", {}).get("links", {}).get("assignment_id")
        == assignment_subject
    ]
    records = [row.get("payload", {}).get("record", {}) for row in linked]
    execution_claims = [
        row for row in records if row.get("claim_type") == ASSIGNMENT_EXECUTION_CLAIM
    ]
    transitions = [
        row for row in records if row.get("claim_type") == ASSIGNMENT_PHASE_TRANSITION
    ]
    instant = (
        native_state.parse_lease_expiry(now) if now else datetime.now().astimezone()
    )
    active_leases = [
        row
        for row in execution_claims
        if (
            native_state.parse_lease_expiry(str(row.get("lease_expires_at") or ""))
            > instant
        )
    ]
    phase = "admitted"
    if execution_claims:
        phase = "claimed"
    if transitions:
        explicit = {str(row.get("to_phase") or "") for row in transitions}
        phase = max(explicit, key=ASSIGNMENT_PHASES.index)
    completion_claims, independent_reviews, decisions, completion_phase = (
        native_state.fold_completion_cycle(linked)
    )
    if completion_phase:
        phase = completion_phase
    return {
        "schema": "kungfu.assignment-orchestration.status/v1",
        "initiative_subject": state["initiative_subject"],
        "assignment_subject": assignment_subject,
        "assignment": assignment["payload"]["record"],
        "phase": phase,
        "active_lease": (
            max(active_leases, key=lambda row: str(row["lease_expires_at"]))
            if active_leases
            else None
        ),
        "execution_claims": execution_claims,
        "phase_transitions": transitions,
        "completion_claim_count": len(completion_claims),
        "completion_claims": completion_claims,
        "independent_review_count": len(independent_reviews),
        "independent_reviews": independent_reviews,
        "continuation_decision_count": len(decisions),
        "continuation_decisions": decisions,
        "query_proof_root": state["query_proof_root"],
    }


def advance_assignment_phase(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    to_phase: str,
    actor: str,
    reason: str,
    expected_phase: str = "",
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    system_time: int = 0,
) -> dict[str, Any]:
    """Advance only the explicit pre-completion orchestration states."""

    _ensure_native_write_allowed(runtime_dir)
    status = assignment_orchestration_status(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        storage_source_id=storage_source_id,
    )
    if expected_phase and status["phase"] != expected_phase:
        raise ValueError("Assignment phase changed before transition")
    allowed = {"claimed": "executing", "executing": "stage-ready"}
    if allowed.get(status["phase"]) != to_phase:
        raise ValueError(
            f"invalid Assignment phase transition: {status['phase']} -> {to_phase}"
        )
    if status["active_lease"] is None:
        raise ValueError("an active execution lease is required for phase advancement")
    actor = actor.strip()
    reason = reason.strip()
    if not actor or not reason:
        raise ValueError("actor and reason are required")
    basis = {
        "assignment_subject": status["assignment_subject"],
        "from_phase": status["phase"],
        "to_phase": to_phase,
        "lease_id": status["active_lease"]["lease_id"],
        "actor": actor,
        "reason": reason,
    }
    record = {
        "claim_id": f"phase-{_sha256_root(basis)[7:31]}",
        "claim_type": ASSIGNMENT_PHASE_TRANSITION,
        **basis,
    }
    source_id = _native_source(actor_type)
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": actor,
        },
        "links": {
            "initiative_id": status["initiative_subject"],
            "assignment_id": status["assignment_subject"],
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="assignment-phase-transition",
        surface_id=CLAIM_SURFACE_ID,
        subject_key=f"kungfu:assignment-phase:{record['claim_id']}",
        source_id=source_id,
        payload=payload,
        system_time=system_time or time.time_ns(),
    )
    return {
        "schema": "kungfu.assignment-orchestration.phase-transition/v1",
        "transition": record,
        "receipt": receipt,
    }


def _verified_episode(runtime_dir: str, episode_id: int) -> dict[str, Any]:
    fsck = storage_service.fsck(runtime_dir, episode_id=episode_id, verify_frames=True)
    if not fsck.get("ok"):
        raise ValueError(f"Episode {episode_id} failed frame verification")
    root = ""
    for _ in range(2):
        inspected = storage_service.episode_inspect(runtime_dir, episode_id=episode_id)
        root = _episode_root(inspected.get("content_root", {}))
        if not root:
            recorded = inspected.get("episode", {}).get("root", {})
            root = str(recorded.get("root_value") or "")
            if root and not root.startswith("sha256:"):
                root = "sha256:" + root
        if root:
            break
    if not root:
        raise ValueError(f"Episode {episode_id} has no verified content root")
    return {"episode_id": str(episode_id), "episode_root": root}


def _tracked_completion_evidence(
    checkout_path: str,
    state: dict[str, Any],
    assignment_id: str,
    claim_record: dict[str, Any],
) -> dict[str, Any]:
    """Verify a Completion Claim against one tracked checkout and Project Cut."""

    checkout = Path(checkout_path).expanduser().resolve()
    diagnostics: list[dict[str, str]] = []

    def reject(code: str, detail: str) -> None:
        diagnostics.append({"code": code, "detail": detail})

    def git(*args: str) -> str:
        completed = subprocess.run(
            ["git", "-C", str(checkout), *args],
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()

    commit = str(claim_record.get("git_commit") or "")
    try:
        repository = Path(git("rev-parse", "--show-toplevel")).resolve()
        if repository != checkout:
            reject("checkout-root-mismatch", "checkout must name the Git worktree root")
        observed_commit = git("rev-parse", f"{commit}^{{commit}}")
        head_commit = git("rev-parse", "HEAD^{commit}")
        tree_oid = git("rev-parse", f"{commit}^{{tree}}")
    except (OSError, subprocess.CalledProcessError) as error:
        reject("git-evidence-unavailable", str(error))
        return {
            "schema": "kungfu.work-control.tracked-completion-evidence/v1",
            "valid": False,
            "checkout": str(checkout),
            "diagnostics": diagnostics,
        }

    if observed_commit != commit:
        reject("forged-claim", "claimed Git commit does not resolve exactly")
    if head_commit != commit:
        reject("post-claim-source-drift", "checkout HEAD differs from claimed commit")
    expected_tree_root = _sha256_root(tree_oid)
    if claim_record.get("git_tree_root") != expected_tree_root:
        reject(
            "git-tree-mismatch", "claimed Git tree root differs from the commit tree"
        )

    target_assignment = next(
        (
            row
            for row in state.get("assignments", [])
            if row.get("payload", {}).get("record", {}).get("assignment_id")
            == assignment_id
            or row.get("subject_key") in {assignment_id, f"kungfu:{assignment_id}"}
        ),
        None,
    )
    assignment_payload = (target_assignment or {}).get("payload", {})
    assignment_record = assignment_payload.get("record", {})
    expected_assignment_set = {assignment_id}
    expected_assignment_set.update(
        str(
            row.get("payload", {}).get("record", {}).get("assignment_id")
            or row.get("payload", {}).get("record", {}).get("assignment_id")
            or ""
        )
        for row in state.get("assignments", [])
        if (
            row.get("payload", {}).get("record", {}).get("parent_assignment_id")
            == assignment_id
            or (
                row.get("payload", {})
                .get("record", {})
                .get("parent_assignment_ref", {})
                .get("object_kind")
                == "assignment"
                and row.get("payload", {})
                .get("record", {})
                .get("parent_assignment_ref", {})
                .get("subject")
                in {assignment_id, f"kungfu:{assignment_id}"}
            )
        )
    )
    assignment_subject = str((target_assignment or {}).get("subject_key") or "")
    owning_workspace_identity_root = str(
        assignment_record.get("owning_workspace_identity_root") or ""
    )
    expected_assignment_set.update(
        str(
            row.get("payload", {}).get("record", {}).get("assignment_id")
            or row.get("payload", {}).get("record", {}).get("assignment_id")
            or ""
        )
        for row in state.get("assignments", [])
        if (
            row.get("payload", {})
            .get("record", {})
            .get("parent_assignment_ref", {})
            .get("subject")
            == assignment_subject
            and row.get("payload", {})
            .get("record", {})
            .get("parent_assignment_ref", {})
            .get("workspace_identity_root")
            == owning_workspace_identity_root
            and row.get("payload", {})
            .get("record", {})
            .get("owning_workspace_identity_root")
            == owning_workspace_identity_root
        )
    )
    expected_assignment_set.discard("")
    if set(claim_record.get("assignment_set") or []) != expected_assignment_set:
        reject(
            "incomplete-parent-acceptance",
            "completion Assignment set omits or adds a child",
        )
    request_root = str(assignment_record.get("request_root") or "")
    work_definition_root = str(assignment_record.get("work_definition_root") or "")
    work_definition = assignment_record.get("work_definition")
    source = assignment_payload.get("source", {})
    native_assignment = bool(
        assignment_subject == f"kungfu:{assignment_id}"
        and assignment_record.get("assignment_id") == assignment_id
        and (target_assignment or {}).get("source_id")
        in {USER_FACT_SOURCE_ID, AGENT_FACT_SOURCE_ID}
        and source.get("authority_mode") == "kungfu-native"
        and request_root
        and work_definition_root
        and isinstance(work_definition, dict)
        and work_definition
        and work_definition_root == _sha256_root(work_definition)
    )
    if native_assignment:
        if claim_record.get("acceptance_root") != work_definition_root:
            reject(
                "acceptance-root-mismatch",
                "claim acceptance_root differs from the Assignment work definition",
            )
        for claim_key in (
            "input_context_root",
            "result_context_root",
            "project_cut_root",
            "project_cut_receipt_root",
        ):
            if claim_record.get(claim_key):
                reject(
                    "unsupported-context-binding",
                    f"native Assignment claim must not set {claim_key}",
                )
        diagnostics.sort(key=lambda row: (row["code"], row["detail"]))
        evidence = {
            "schema": "kungfu.work-control.tracked-completion-evidence/v1",
            "authority": "kungfu-assignment-request",
            "valid": not diagnostics,
            "commit": commit,
            "head_commit": head_commit,
            "tree_oid": tree_oid,
            "git_tree_root": expected_tree_root,
            "request_root": request_root,
            "work_definition_root": work_definition_root,
            "cut": {},
            "diagnostics": diagnostics,
        }
        evidence["evidence_root"] = _sha256_root(evidence)
        return evidence
    for claim_key, assignment_key, code in (
        ("acceptance_root", "acceptance_root", "acceptance-root-mismatch"),
        ("input_context_root", "input_context_root", "stale-context"),
        ("project_cut_root", "project_cut_root", "project-cut-root-mismatch"),
    ):
        expected = str(assignment_record.get(assignment_key) or "")
        actual = str(claim_record.get(claim_key) or "")
        if not expected or actual != expected:
            reject(code, f"claim {claim_key} differs from the Assignment contract")

    project_cut_bin = (
        Path(__file__).resolve().parents[4]
        / "framework"
        / "project-cut"
        / "bin"
        / "project-cut.mjs"
    )
    reconcile = None
    try:
        completed = subprocess.run(
            [
                "node",
                str(project_cut_bin),
                "reconcile",
                "--commit",
                commit,
                "--root",
                str(checkout),
                "--json",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        reconcile = json.loads(completed.stdout)
    except (OSError, json.JSONDecodeError) as error:
        reject("project-cut-verifier-failed", str(error))

    cuts = list((reconcile or {}).get("cuts") or [])
    claimed_cut_root = str(claim_record.get("project_cut_root") or "")
    matching_cuts = [row for row in cuts if row.get("cutRoot") == claimed_cut_root]
    if len(matching_cuts) != 1:
        reject(
            "project-cut-count-mismatch",
            "claimed commit must contain exactly one matching Project Cut",
        )
        cut: dict[str, Any] = {}
    else:
        cut = matching_cuts[0]
        cut_digest = claimed_cut_root.removeprefix("sha256:")
        cut_path = str(
            cut.get("path")
            or (
                f".kungfu/project-cuts/sha256/{cut_digest[:2]}/"
                f"{cut_digest}/manifest.json"
            )
        )
        receipt_path = str(Path(cut_path).parent / "receipt.json")
        promotion_path = (
            ".xinfa/manifests/project-cuts/"
            + str(cut.get("contextRoot") or "").removeprefix("sha256:")
            + ".json"
        )
        episode_paths = {
            ".kungfu/episodes/sealed/sha256/"
            + semantic_root.removeprefix("sha256:")[:2]
            + "/"
            + semantic_root.removeprefix("sha256:")
            for semantic_root in (
                str(row.get("semanticRoot") or "") for row in cut.get("episodes", [])
            )
            if semantic_root.startswith("sha256:")
        }
        scoped_paths = {cut_path, receipt_path, promotion_path, *episode_paths}
        for row in (reconcile or {}).get("diagnostics", []):
            path = str(row.get("path") or "")
            if path in {"", "$"} or any(
                path == prefix or path.startswith((prefix + ":", prefix + "/"))
                for prefix in scoped_paths
                if prefix
            ):
                reject(
                    str(row.get("code") or "project-cut-invalid"),
                    str(row.get("detail") or row),
                )
        comparisons = (
            ("cutRoot", "project_cut_root", "project-cut-root-mismatch"),
            ("contextRoot", "result_context_root", "stale-context"),
            ("receiptRoot", "project_cut_receipt_root", "receipt-cut-mismatch"),
        )
        for cut_key, claim_key, code in comparisons:
            if not claim_record.get(claim_key) or cut.get(cut_key) != claim_record.get(
                claim_key
            ):
                reject(code, f"Project Cut {cut_key} differs from the claim")
        sealed_episode_roots = {
            str(row.get("semanticRoot") or "") for row in cut.get("episodes", [])
        }
        claimed_episode_roots = {
            str(row.get("episode_root") or "")
            for row in claim_record.get("evidence_episodes", [])
        }
        if (
            claimed_episode_roots
            and not claimed_episode_roots.issubset(sealed_episode_roots)
        ) or (sealed_episode_roots and not claimed_episode_roots):
            reject(
                "missing-episode",
                "claimed Episode set does not match the Project Cut Episode delta",
            )

    diagnostics.sort(key=lambda row: (row["code"], row["detail"]))
    evidence = {
        "schema": "kungfu.work-control.tracked-completion-evidence/v1",
        "valid": not diagnostics,
        "commit": commit,
        "head_commit": head_commit,
        "tree_oid": tree_oid,
        "git_tree_root": expected_tree_root,
        "cut": cut,
        "diagnostics": diagnostics,
    }
    # A tracked checkout is an observation location, not protocol identity.
    # Excluding its host-local absolute path keeps the evidence and review roots
    # stable when another reviewer verifies the same commit on another machine.
    evidence["evidence_root"] = _sha256_root(evidence)
    return evidence


def _require_semantic_completion(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    storage_source_id: str,
    proof_roots: list[str] | None,
) -> None:
    from . import work_semantics

    semantics = work_semantics.status(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        storage_source_id=storage_source_id,
    )
    if not semantics["current_input_snapshot"]:
        return
    if not semantics["completion_eligible"]:
        raise ValueError(
            "Work semantics effects must be settled before completion can be claimed"
        )
    required = {
        semantics["current_input_snapshot"]["record_root"],
        semantics["managed_runs"][-1]["record_root"],
        *[row["record_root"] for row in semantics["effect_outcomes"]],
    }
    if not required.issubset(set(proof_roots or [])):
        raise ValueError(
            "completion proof_roots must bind the current Work semantics evidence"
        )


def claim_completion(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    statement: str,
    actor: str,
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    evidence_episode_ids: list[int] | None = None,
    assignment_set: list[str] | None = None,
    acceptance_root: str = "",
    input_context_root: str = "",
    result_context_root: str = "",
    project_cut_root: str = "",
    project_cut_receipt_root: str = "",
    git_commit: str = "",
    git_tree_root: str = "",
    proof_roots: list[str] | None = None,
    known_gaps: list[str] | None = None,
    evidence_availability: list[dict[str, Any]] | None = None,
    system_time: int = 0,
) -> dict[str, Any]:
    """Record a visible completion claim without treating it as authority."""

    _ensure_native_write_allowed(runtime_dir)
    system_time = system_time or time.time_ns()
    _ensure_contract(runtime_dir, system_time)
    state = query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
    )
    assignment_id = _stable_id(assignment_id, "assignment_id")
    assignment = next(
        (
            row
            for row in state["assignments"]
            if row.get("subject_key") == assignment_id
            or row.get("subject_key") == f"kungfu:{assignment_id}"
            or row.get("payload", {}).get("record", {}).get("assignment_id")
            == assignment_id
        ),
        None,
    )
    if assignment is None:
        raise ValueError(f"Assignment not found under Initiative: {assignment_id}")
    if not statement.strip() or not actor.strip():
        raise ValueError("statement and actor are required")
    _require_semantic_completion(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        storage_source_id=storage_source_id,
        proof_roots=proof_roots,
    )
    evidence = [
        _verified_episode(runtime_dir, int(episode_id))
        for episode_id in (evidence_episode_ids or [])
    ]
    assignment_set = [
        _stable_id(row, "assignment_set") for row in (assignment_set or [assignment_id])
    ]
    if assignment_id not in assignment_set:
        raise ValueError("assignment_set must contain the claimed assignment_id")
    if len(set(assignment_set)) != len(assignment_set):
        raise ValueError("assignment_set must not contain duplicates")
    roots = {
        "acceptance_root": _root_id(acceptance_root, "acceptance_root"),
        "input_context_root": _root_id(input_context_root, "input_context_root"),
        "result_context_root": _root_id(result_context_root, "result_context_root"),
        "project_cut_root": _root_id(project_cut_root, "project_cut_root"),
        "project_cut_receipt_root": _root_id(
            project_cut_receipt_root, "project_cut_receipt_root"
        ),
        "git_tree_root": _root_id(git_tree_root, "git_tree_root"),
        "proof_roots": sorted(
            {_root_id(row, "proof_roots", required=True) for row in proof_roots or []}
        ),
    }
    git_commit = git_commit.strip()
    if git_commit and not GIT_OBJECT_ID.fullmatch(git_commit):
        raise ValueError("git_commit must be a full lowercase Git object id")
    gaps = [row.strip() for row in (known_gaps or []) if row.strip()]
    availability = []
    for row in evidence_availability or []:
        if not isinstance(row, dict):
            raise ValueError(  # noqa: TRY004 - stable public validation surface
                "evidence_availability rows must be objects"
            )
        acceptance = str(row.get("acceptance") or "").strip()
        level = str(row.get("level") or "").strip()
        availability_state = str(row.get("state") or "").strip()
        if (
            not acceptance
            or level not in {"thin", "full"}
            or availability_state
            not in {
                "available",
                "unavailable",
                "missing",
            }
        ):
            raise ValueError(
                "evidence_availability requires acceptance, thin/full level, "
                "and available/unavailable/missing state"
            )
        availability.append(
            {
                "acceptance": acceptance,
                "level": level,
                "state": availability_state,
            }
        )
    availability.sort(key=lambda row: (row["acceptance"], row["level"], row["state"]))
    claim_basis = {
        "initiative_subject": state["initiative_subject"],
        "assignment_subject": str(assignment["subject_key"]),
        "statement": statement.strip(),
        "actor": actor.strip(),
        "evidence": evidence,
        "assignment_set": sorted(assignment_set),
        "roots": roots,
        "git_commit": git_commit,
        "known_gaps": gaps,
        "evidence_availability": availability,
    }
    claim_id = f"completion-{_sha256_root(claim_basis)[7:31]}"
    source_id = _native_source(actor_type)
    subject_key = f"kungfu:claim:{claim_id}"
    record = {
        "claim_id": claim_id,
        "claim_type": COMPLETION_CLAIM,
        "status": "claimed-complete",
        "statement": statement.strip(),
        "asserted_by": actor.strip(),
        "actor_type": actor_type,
        "evidence_episodes": evidence,
        "assignment_set": sorted(assignment_set),
        **roots,
        "git_commit": git_commit,
        "known_gaps": gaps,
        "evidence_availability": availability,
    }
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": actor.strip(),
        },
        "links": {
            "initiative_id": state["initiative_subject"],
            "assignment_id": str(assignment["subject_key"]),
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="completion-claim",
        surface_id=CLAIM_SURFACE_ID,
        subject_key=subject_key,
        source_id=source_id,
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.initiative-assignment.completion-claim-write/v1",
        "authority_mode": "kungfu-native",
        "initiative_subject": state["initiative_subject"],
        "assignment_subject": str(assignment["subject_key"]),
        "claim": record,
        "receipt": receipt,
    }
