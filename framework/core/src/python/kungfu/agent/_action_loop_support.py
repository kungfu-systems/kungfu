# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
from typing import Any

from kungfu.agent import work_profile


def _root(value: Any) -> str:
    if not isinstance(value, str):
        value = json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        )
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _step_receipt(
    payload: dict[str, Any], step_id: str, authority_root: str, result_roots: list[str]
) -> dict[str, Any]:
    body = {
        "schema": "kungfu.action-loop.step-receipt/v0",
        "loopId": payload["loopId"],
        "stepId": step_id,
        "idempotencyKey": payload["idempotencyKey"],
        "status": "accepted",
        "preconditionRoots": [payload["loopRoot"]],
        "resultRoots": result_roots,
        "authorityReceiptRoot": authority_root,
    }
    return {**body, "receiptRoot": _root(body)}


def _object_id(loop_id: str, role: str) -> str:
    digest = hashlib.sha256(f"{loop_id}:{role}".encode()).hexdigest()
    return f"fact:{digest[:32]}"


def _episode_number(identity: str) -> int:
    digest = hashlib.sha256(identity.encode()).hexdigest()
    return (int(digest[:15], 16) % ((1 << 63) - 1)) + 1


def _support(loop_root: str, operation: str) -> dict[str, Any]:
    return {
        "createdByReceiptRoot": _root({"loopRoot": loop_root, "kind": "creation"}),
        "schemaRoot": _root(work_profile.ACTION_SCHEMA),
        "declarationRoots": [_root({"loopRoot": loop_root, "kind": "declaration"})],
        "admissionRoots": [_root({"loopRoot": loop_root, "kind": "admission"})],
        "reasonRoot": _root({"loopRoot": loop_root, "operation": operation}),
    }


def _fact_ref(ref_name: str, inspection: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": ref_name,
        "cutRoot": inspection["cutRoot"],
        "revision": inspection["revision"],
    }
