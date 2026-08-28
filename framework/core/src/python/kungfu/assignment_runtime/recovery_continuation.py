# SPDX-License-Identifier: Apache-2.0

"""Verified, non-authoritative continuation after fresh Work recovery."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from kungfu import initiative_family
from kungfu.agent import session_contract
from kungfu.coordination import locks

JsonObject = dict[str, Any]
CONTINUATION_SCHEMA = "kungfu.work.fresh-recovery-continuation/v1"
CONTINUATION_INDEX_SCHEMA = "kungfu.work.fresh-recovery-continuation-index/v1"
CONTINUATION_MODE = "resume/new-attempt"
RECEIPT_SCHEMA = "kungfu.work.fresh-recovery-receipt/v1"
_PROJECTION_KEYS = frozenset({"query_proof_root", "work_semantics"})


def _root(value: Any) -> str:
    return initiative_family.semantic_root(value)


def _preserved_state(status: Mapping[str, Any]) -> JsonObject:
    return {key: value for key, value in status.items() if key not in _PROJECTION_KEYS}


def _storage_root(runtime_dir: str | Path) -> Path:
    return (
        Path(runtime_dir).expanduser().resolve()
        / "assignment-runtime"
        / "fresh-recovery-v1"
        / "continuations"
    )


def _target_key(initiative_id: str, assignment_id: str) -> str:
    return _root(
        {"initiativeId": initiative_id, "assignmentId": assignment_id}
    ).removeprefix("sha256:")


def _write_exact_json(path: Path, value: Mapping[str, Any]) -> None:
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if existing != dict(value):
            raise ValueError("fresh recovery continuation history is immutable")
        return
    locks.write_json(path, value)


def _body(plan: Mapping[str, Any], receipt: Mapping[str, Any]) -> JsonObject:
    return {
        "schema": CONTINUATION_SCHEMA,
        "state": "available",
        "continuationMode": CONTINUATION_MODE,
        "freshRecoveryPlanRoot": str(plan.get("planRoot") or ""),
        "freshRecoveryReceiptRoot": str(receipt.get("receiptRoot") or ""),
        "freshRecoveryReceipt": dict(receipt),
        "workRef": session_contract.validate_work_ref(dict(plan.get("workRef", {}))),
        "attempt": dict(plan.get("attempt") or {}),
        "work": dict(plan.get("work") or {}),
        "writeAuthority": "none",
        "assignmentWrites": [],
        "allowedNextActions": ["claim-completion"],
        "forbiddenEffects": ["admit", "claim", "kickoff"],
    }


def _index(continuation: Mapping[str, Any]) -> JsonObject:
    work = dict(continuation.get("work", {}))
    body = {
        "schema": CONTINUATION_INDEX_SCHEMA,
        "initiativeId": str(work.get("initiativeId") or ""),
        "assignmentId": str(work.get("assignmentId") or ""),
        "continuationRoot": continuation["continuationRoot"],
    }
    return {**body, "indexRoot": _root(body)}


def register(
    runtime_dir: str | Path, plan: Mapping[str, Any], receipt: Mapping[str, Any]
) -> JsonObject | None:
    stages = [str(row.get("stage") or "") for row in plan.get("effects") or []]
    if "record-recovery-continuation" not in stages:
        return None
    body = _body(plan, receipt)
    continuation = {**body, "continuationRoot": _root(body)}
    root = _storage_root(runtime_dir)
    history = root / "history" / f"{continuation['continuationRoot'][7:]}.json"
    _write_exact_json(history, continuation)
    index = _index(continuation)
    index_path = (
        root
        / "active"
        / (_target_key(index["initiativeId"], index["assignmentId"]) + ".json")
    )
    locks.write_json(index_path, index)
    return continuation


def _read(
    runtime_dir: str | Path, initiative_id: str, assignment_id: str
) -> JsonObject | None:
    root = _storage_root(runtime_dir)
    index_path = root / "active" / (_target_key(initiative_id, assignment_id) + ".json")
    if not index_path.is_file():
        return None
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index_body = {key: value for key, value in index.items() if key != "indexRoot"}
    if (
        index.get("schema") != CONTINUATION_INDEX_SCHEMA
        or index.get("indexRoot") != _root(index_body)
        or index.get("initiativeId") != initiative_id
        or index.get("assignmentId") != assignment_id
    ):
        raise ValueError("fresh recovery continuation index does not verify")
    continuation_root = str(index.get("continuationRoot") or "")
    history_path = (
        root / "history" / f"{continuation_root.removeprefix('sha256:')}.json"
    )
    if not history_path.is_file():
        raise ValueError("fresh recovery continuation history is unavailable")
    continuation = json.loads(history_path.read_text(encoding="utf-8"))
    if continuation.get("continuationRoot") != continuation_root:
        raise ValueError("fresh recovery continuation history does not verify")
    return continuation


def _identity_checks(
    continuation: Mapping[str, Any],
    initiative_id: str,
    assignment_id: str,
    lifecycle: Mapping[str, Any],
) -> tuple[bool, ...]:
    body = {
        key: value for key, value in continuation.items() if key != "continuationRoot"
    }
    work = dict(continuation.get("work", {}))
    work_ref = session_contract.validate_work_ref(dict(continuation.get("workRef", {})))
    assignment = dict(lifecycle.get("assignment", {}))
    return (
        continuation.get("schema") == CONTINUATION_SCHEMA,
        continuation.get("state") == "available",
        continuation.get("continuationMode") == CONTINUATION_MODE,
        continuation.get("continuationRoot") == _root(body),
        continuation.get("writeAuthority") == "none",
        continuation.get("assignmentWrites") == [],
        continuation.get("allowedNextActions") == ["claim-completion"],
        set(continuation.get("forbiddenEffects") or [])
        == {"admit", "claim", "kickoff"},
        not lifecycle.get("active_lease"),
        work.get("initiativeId") == initiative_id,
        work.get("assignmentId") == assignment_id,
        work.get("phase") == lifecycle.get("phase") == "executing",
        work.get("assignmentRoot") == _root(assignment),
        work.get("lifecycleStateRoot") == _root(_preserved_state(lifecycle)),
        work_ref.get("initiativeId") == initiative_id,
        work_ref.get("entityId") == assignment_id,
        work_ref.get("entityRoot") == work.get("assignmentRoot"),
        work_ref.get("systemTimeCut") == work.get("systemTimeCut"),
        str(continuation.get("freshRecoveryPlanRoot") or "").startswith("sha256:"),
    )


def _receipt_checks(continuation: Mapping[str, Any]) -> tuple[bool, ...]:
    work = dict(continuation.get("work", {}))
    work_ref = session_contract.validate_work_ref(dict(continuation.get("workRef", {})))
    receipt = dict(continuation.get("freshRecoveryReceipt", {}))
    receipt_body = {
        key: value for key, value in receipt.items() if key != "receiptRoot"
    }
    preservation = dict(receipt.get("preservation", {}))
    binding_receipt = dict((receipt.get("binding") or {}).get("receipt", {}))
    return (
        continuation.get("freshRecoveryReceiptRoot")
        == receipt.get("receiptRoot")
        == _root(receipt_body),
        receipt.get("schema") == RECEIPT_SCHEMA,
        receipt.get("status") == "recovered",
        receipt.get("continuationMode") == CONTINUATION_MODE,
        receipt.get("planRoot") == continuation.get("freshRecoveryPlanRoot"),
        receipt.get("assignmentWrites") == [],
        receipt.get("workRef") == work_ref,
        receipt.get("attempt") == continuation.get("attempt"),
        preservation.get("assignmentRoot") == work.get("assignmentRoot"),
        preservation.get("lifecycleStateRoot") == work.get("lifecycleStateRoot"),
        str(binding_receipt.get("receiptRoot") or "").startswith("sha256:"),
    )


def resolve(
    runtime_dir: str | Path,
    initiative_id: str,
    assignment_id: str,
    lifecycle: Mapping[str, Any],
) -> JsonObject | None:
    """Return one exact, non-authoritative recovery continuation or fail closed."""

    continuation = _read(runtime_dir, initiative_id, assignment_id)
    if continuation is None:
        return None
    attempt = dict(continuation.get("attempt", {}))
    checks = (
        *_identity_checks(continuation, initiative_id, assignment_id, lifecycle),
        *_receipt_checks(continuation),
        bool(attempt.get("newSessionAttemptId")),
        attempt.get("newSessionAttemptId") != attempt.get("previousSessionAttemptId"),
    )
    if not all(checks):
        raise ValueError("fresh recovery continuation does not match retained Work")
    return dict(continuation)
