# SPDX-License-Identifier: Apache-2.0

"""Public Core adapters for the recoverable Action Loop coordinator.

The JavaScript coordinator owns ordering and recovery classification. This
module is the outer-ring bridge that performs authority mutations through the
existing KFD-7 Work Profile, native Fact ref CAS, and Episode lifecycle APIs.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from kungfu.agent import work_profile
from kungfu.storage import service
from kungfu.storage.episode_lifecycle import (
    RuntimeEpisodeLifecycle,
    find_open_episode_id,
)


STEP_RECEIPT_SCHEMA = "kungfu.action-loop.step-receipt/v0"
CHECKPOINT_SCHEMA = "kungfu.action-loop.checkpoint/v0"


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _root(value: Any) -> str:
    raw = value if isinstance(value, str) else _canonical(value)
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


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


def _step_receipt(
    payload: dict[str, Any], step_id: str, receipt_root: str, result_roots: list[str]
) -> dict[str, Any]:
    return {
        "schema": STEP_RECEIPT_SCHEMA,
        "loopId": payload["loopId"],
        "stepId": step_id,
        "idempotencyKey": payload["idempotencyKey"],
        "receiptRoot": receipt_root,
        "status": "accepted",
        "preconditionRoots": [payload["loopRoot"]],
        "resultRoots": result_roots,
    }


def _fact_ref(ref_name: str, inspection: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": ref_name,
        "cutRoot": inspection["cutRoot"],
        "revision": inspection["revision"],
    }


def bind_work_profile(
    runtime_dir: str | Path, payload: dict[str, Any]
) -> dict[str, Any]:
    roles = payload["roles"]
    ref_name = payload["factRef"]["name"]
    if ref_name != payload["loopRef"]:
        return {
            "status": "denied",
            "code": "invalid-request",
            "message": "loopRef and native Fact ref name must be identical",
            "writeOccurred": False,
        }
    episode_identity = roles["episode"]["id"]
    request = {
        "schema": work_profile.ACTION_SCHEMA,
        "actionId": f"action-loop-bind:{_root(payload['idempotencyKey'])[7:23]}",
        "refName": ref_name,
        "basis": {"cutRoot": None, "revision": 0},
        "ref": {"cutRoot": None, "revision": 0},
        "subject": {
            "role": "fact",
            "operation": "create",
            "fromState": "absent",
            "toState": "declared",
        },
        "responsibilities": {
            role: {
                "objectId": _object_id(payload["loopId"], role),
                "expectedVersionRoot": None,
            }
            for role in work_profile.ROLES
        },
        "roleInputs": {
            "fact": {
                "state": "declared",
                "details": {
                    "loopId": payload["loopId"],
                    "loopRef": payload["loopRef"],
                },
            },
            "episode": {
                "state": "open",
                "details": {
                    "episodeId": episode_identity,
                    "runtimeEpisodeId": _episode_number(episode_identity),
                },
            },
            "pursuit": {
                "state": "active",
                "details": {
                    "identity": roles["pursuit"]["id"],
                    "root": roles["pursuit"]["root"],
                },
            },
            "atlas": {
                "state": "current",
                "details": {
                    "identity": roles["atlas"]["id"],
                    "root": roles["atlas"]["root"],
                    "validThroughRevision": 1_000_000,
                },
            },
            "warrant": {
                "state": "issued",
                "details": {
                    "identity": roles["warrant"]["id"],
                    "root": roles["warrant"]["root"],
                    "validThroughRevision": 1_000_000,
                    "allowedOperations": ["*"],
                },
            },
        },
        "relations": [],
        "support": _support(payload["loopRoot"], "bind-roles"),
    }
    accepted = work_profile.apply_action(runtime_dir, request, execute=True)
    if accepted.get("status") != "accepted":
        return {
            "status": "denied",
            "code": accepted.get("failureCode") or "work-profile-denied",
            "message": "KFD-7 Work Profile rejected Action Loop role binding",
            "writeOccurred": accepted.get("writeOccurred") is True,
            "details": accepted,
        }
    result = accepted["result"]
    fact_ref = {
        "name": ref_name,
        "cutRoot": result["cutRoot"],
        "revision": result["revision"],
    }
    bound_roles = copy.deepcopy(roles)
    bound_roles["fact"] = {
        **bound_roles["fact"],
        "root": result["cutRoot"],
        "state": "declared",
    }
    return {
        "status": "accepted",
        "roles": bound_roles,
        "factRef": fact_ref,
        "receipt": _step_receipt(
            payload,
            "bind-roles",
            accepted["kernelReceiptRoot"],
            [result["cutRoot"]],
        ),
        "authorityReceipt": accepted,
    }


def resume_or_begin_episode(
    runtime_dir: str | Path, payload: dict[str, Any]
) -> dict[str, Any]:
    episode = payload["episode"]
    source = episode["source"]
    existing = find_open_episode_id(str(runtime_dir), source=source)
    if existing is None:
        lifecycle = RuntimeEpisodeLifecycle(
            runtime_dir=str(runtime_dir),
            namespace="action-loop",
            name=payload["loopId"],
            title=episode.get("title") or f"Action Loop {payload['loopId']}",
            actor=episode.get("actor") or "agent",
            source=source,
            episode_id=_episode_number(episode["id"]),
            begin=True,
        )
    else:
        lifecycle = RuntimeEpisodeLifecycle(
            runtime_dir=str(runtime_dir),
            namespace="action-loop",
            name=payload["loopId"],
            title=episode.get("title") or f"Action Loop {payload['loopId']}",
            actor=episode.get("actor") or "agent",
            source=source,
            episode_id=existing,
            begin=False,
        )
    inspected = service.episode_inspect(runtime_dir, episode_id=lifecycle.episode_id)
    receipt_root = _root(
        {
            "authority": "RuntimeEpisodeLifecycle",
            "episodeId": lifecycle.episode_id,
            "source": source,
            "records": inspected["records"],
        }
    )
    return {
        "status": "accepted",
        "binding": {"id": episode["id"], "root": None, "state": "open"},
        "receipt": _step_receipt(payload, "open-episode", receipt_root, [receipt_root]),
        "episodeId": lifecycle.episode_id,
        "writeOccurred": existing is None,
    }


def inspect_episode(runtime_dir: str | Path, binding: dict[str, Any]) -> dict[str, Any]:
    try:
        inspected = service.episode_inspect(
            runtime_dir, episode_id=_episode_number(binding["id"])
        )["episode"]
    except Exception as error:  # public adapter returns uncertainty, not false success
        return {
            "state": "unavailable",
            "externalEffect": "unknown",
            "error": str(error),
        }
    closed = bool(inspected.get("closed"))
    close = inspected.get("close") or {}
    return {
        "state": "aborted"
        if closed and close.get("aborted")
        else "sealed"
        if closed
        else "open",
        "externalEffect": "accepted",
    }


def save_checkpoint(runtime_dir: str | Path, payload: dict[str, Any]) -> dict[str, Any]:
    ref_name = payload["expectedOld"]["name"]
    inspected = work_profile.inspect(runtime_dir, ref_name)
    if inspected.get("status") != "current":
        return {
            "status": "denied",
            "code": "loop-not-found",
            "message": "Work Profile ref is not current",
            "writeOccurred": False,
        }
    actual = _fact_ref(ref_name, inspected)
    if actual != payload["expectedOld"]:
        return {
            "status": "denied",
            "code": "stale-ref",
            "message": "Fact ref differs from expected-old",
            "writeOccurred": False,
        }
    material = {
        "schema": CHECKPOINT_SCHEMA,
        "loopRef": payload["loopRef"],
        "envelope": payload["envelope"],
        "receipts": payload["receipts"],
    }
    checkpoint_root = _root(material)
    request = {
        "schema": work_profile.ACTION_SCHEMA,
        "actionId": f"action-loop-checkpoint:{checkpoint_root[7:23]}",
        "refName": ref_name,
        "basis": {"cutRoot": actual["cutRoot"], "revision": actual["revision"]},
        "ref": {"cutRoot": actual["cutRoot"], "revision": actual["revision"]},
        "subject": {
            "role": "pursuit",
            "operation": "continue",
            "fromState": inspected["roles"]["pursuit"]["body"]["state"],
            "toState": "active",
        },
        "responsibilities": {
            role: {
                "objectId": inspected["roles"][role]["objectId"],
                "expectedVersionRoot": inspected["roles"][role]["versionRoot"],
            }
            for role in work_profile.ROLES
        },
        "payload": {
            "actionLoopCheckpoint": material,
            "actionLoopCheckpointRoot": checkpoint_root,
        },
        "relations": [],
        "support": _support(payload["envelope"]["loopRoot"], "checkpoint"),
    }
    accepted = work_profile.apply_action(runtime_dir, request, execute=True)
    if accepted.get("status") != "accepted":
        return {
            "status": "denied",
            "code": accepted.get("failureCode") or "checkpoint-denied",
            "message": "native Fact ref rejected Action Loop checkpoint",
            "writeOccurred": accepted.get("writeOccurred") is True,
            "details": accepted,
        }
    result = accepted["result"]
    fact_ref = {
        "name": ref_name,
        "cutRoot": result["cutRoot"],
        "revision": result["revision"],
    }
    envelope = copy.deepcopy(payload["envelope"])
    envelope["factRef"] = fact_ref
    envelope["roles"]["fact"]["root"] = result["cutRoot"]
    return {
        "status": "accepted",
        "checkpointRoot": checkpoint_root,
        "envelope": envelope,
        "receipts": copy.deepcopy(payload["receipts"]),
        "factRef": fact_ref,
        "writeOccurred": accepted.get("refWriteOccurred") is True,
        "authorityReceipt": accepted,
    }


def load_checkpoint(runtime_dir: str | Path, loop_ref: str) -> dict[str, Any]:
    inspected = work_profile.inspect(runtime_dir, loop_ref)
    if inspected.get("status") == "absent":
        return {"status": "absent"}
    if inspected.get("status") != "current":
        return {
            "status": "denied",
            "code": "checkpoint-unavailable",
            "message": "Work Profile checkpoint is not current",
        }
    details = inspected["roles"]["pursuit"]["body"].get("details") or {}
    material = details.get("actionLoopCheckpoint")
    checkpoint_root = details.get("actionLoopCheckpointRoot")
    if not isinstance(material, dict) or not isinstance(checkpoint_root, str):
        return {"status": "absent"}
    envelope = copy.deepcopy(material["envelope"])
    fact_ref = _fact_ref(loop_ref, inspected)
    envelope["factRef"] = fact_ref
    envelope["roles"]["fact"]["root"] = fact_ref["cutRoot"]
    return {
        "status": "current",
        "checkpointRoot": checkpoint_root,
        "envelope": envelope,
        "receipts": copy.deepcopy(material["receipts"]),
    }


def resolve_fact_ref(runtime_dir: str | Path, loop_ref: str) -> dict[str, Any] | None:
    inspected = work_profile.inspect(runtime_dir, loop_ref)
    if inspected.get("status") != "current":
        return None
    return _fact_ref(loop_ref, inspected)


def dispatch(runtime_dir: str | Path, operation: str, payload: Any) -> Any:
    if operation == "work-profile-bind":
        return bind_work_profile(runtime_dir, payload)
    if operation == "episode-resume-or-begin":
        return resume_or_begin_episode(runtime_dir, payload)
    if operation == "episode-inspect":
        return inspect_episode(runtime_dir, payload)
    if operation == "checkpoint-save":
        return save_checkpoint(runtime_dir, payload)
    if operation == "checkpoint-load":
        return load_checkpoint(runtime_dir, payload)
    if operation == "checkpoint-resolve":
        return resolve_fact_ref(runtime_dir, payload)
    raise ValueError(f"unsupported Action Loop adapter operation: {operation}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("operation")
    args = parser.parse_args(argv)
    try:
        payload = json.load(sys.stdin)
        result = dispatch(args.runtime_dir, args.operation, payload)
    except Exception as error:
        result = {
            "status": "denied",
            "code": "adapter-error",
            "message": str(error),
            "writeOccurred": False,
        }
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
