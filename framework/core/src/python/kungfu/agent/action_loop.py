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
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from kungfu.agent import work_profile
from kungfu.agent.native_authority import inspect_native_authority
from kungfu.storage import service
from kungfu.storage.episode_lifecycle import (
    RuntimeEpisodeLifecycle,
    find_open_episode_id,
)


CHECKPOINT_SCHEMA = "kungfu.action-loop.checkpoint/v0"


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


def _verified_episode_root(runtime_dir: str | Path, episode_id: int) -> str:
    verified = service.fsck(runtime_dir, episode_id=episode_id, verify_frames=True)
    if verified.get("ok") is not True:
        raise RuntimeError("sealed Episode failed Core frame verification")
    inspected = service.episode_inspect(runtime_dir, episode_id=episode_id)
    candidates = [
        inspected.get("content_root") or {},
        ((inspected.get("episode") or {}).get("root") or {}),
    ]
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        raw = str(
            candidate.get("computed")
            or candidate.get("root_value")
            or candidate.get("value")
            or ""
        )
        if raw.startswith("sha256:") and len(raw) == 71:
            return raw
        if len(raw) == 64:
            return "sha256:" + raw
    raise RuntimeError("sealed Episode has no verified content root")


def _current_profile(runtime_dir: str | Path, ref_name: str) -> dict[str, Any]:
    inspected = work_profile.inspect(runtime_dir, ref_name)
    if inspected.get("status") != "current":
        raise RuntimeError("Work Profile ref is not current")
    return inspected


def _profile_action_request(
    inspected: dict[str, Any],
    *,
    action_id: str,
    ref_name: str,
    role: str,
    operation: str,
    to_state: str,
    payload: dict[str, Any],
    loop_root: str,
) -> dict[str, Any]:
    current = _fact_ref(ref_name, inspected)
    current_state = inspected["roles"][role]["body"]["state"]
    return {
        "schema": work_profile.ACTION_SCHEMA,
        "actionId": action_id,
        "refName": ref_name,
        "basis": {"cutRoot": current["cutRoot"], "revision": current["revision"]},
        "ref": {"cutRoot": current["cutRoot"], "revision": current["revision"]},
        "subject": {
            "role": role,
            "operation": operation,
            "fromState": current_state,
            "toState": to_state,
        },
        "responsibilities": {
            item: {
                "objectId": inspected["roles"][item]["objectId"],
                "expectedVersionRoot": inspected["roles"][item]["versionRoot"],
            }
            for item in work_profile.ROLES
        },
        "payload": payload,
        "relations": [],
        "support": _support(loop_root, operation),
    }


def _apply_profile_transition(
    runtime_dir: str | Path,
    *,
    action_id: str,
    ref_name: str,
    role: str,
    operation: str,
    to_state: str,
    payload: dict[str, Any],
    loop_root: str,
    expected_details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    inspected = _current_profile(runtime_dir, ref_name)
    current_state = inspected["roles"][role]["body"]["state"]
    if current_state == to_state:
        details = inspected["roles"][role]["body"].get("details") or {}
        if expected_details is not None and any(
            details.get(key) != value for key, value in expected_details.items()
        ):
            return {
                "status": "denied",
                "code": "replay-mismatch",
                "message": f"current {role} state belongs to a different transition",
                "writeOccurred": False,
            }
        return {"status": "current", "inspection": inspected}
    request = _profile_action_request(
        inspected,
        action_id=action_id,
        ref_name=ref_name,
        role=role,
        operation=operation,
        to_state=to_state,
        payload=payload,
        loop_root=loop_root,
    )
    accepted = work_profile.apply_action(runtime_dir, request, execute=True)
    if accepted.get("status") != "accepted":
        return {
            "status": "denied",
            "code": accepted.get("failureCode") or "work-profile-denied",
            "message": f"KFD-7 Work Profile rejected {role}:{operation}",
            "writeOccurred": accepted.get("writeOccurred") is True,
            "details": accepted,
        }
    return {
        "status": "accepted",
        "inspection": _current_profile(runtime_dir, ref_name),
        "authorityReceipt": accepted,
    }


def seal_episode(runtime_dir: str | Path, payload: dict[str, Any]) -> dict[str, Any]:
    episode_binding = payload["episode"]
    episode_id = _episode_number(episode_binding["id"])
    inspected_episode = service.episode_inspect(runtime_dir, episode_id=episode_id)[
        "episode"
    ]
    if not bool(inspected_episode.get("closed")):
        lifecycle = RuntimeEpisodeLifecycle(
            runtime_dir=str(runtime_dir),
            namespace="action-loop",
            name=payload["loopId"],
            title=f"Action Loop {payload['loopId']}",
            actor="agent",
            source=str((inspected_episode.get("open") or {}).get("source") or ""),
            episode_id=episode_id,
            begin=False,
        )
        lifecycle.close(
            ok=True,
            reason=str((payload.get("result") or {}).get("reason") or "settled"),
        )
    else:
        close = inspected_episode.get("close") or {}
        if close.get("aborted"):
            return {
                "status": "denied",
                "code": "episode-state-mismatch",
                "message": "aborted Episode cannot be settled",
                "writeOccurred": False,
            }
    episode_root = _verified_episode_root(runtime_dir, episode_id)
    step_receipt = _step_receipt(payload, "seal-episode", episode_root, [episode_root])
    ref_name = payload["loopRef"]
    current = _current_profile(runtime_dir, ref_name)
    role_details = current["roles"]["episode"]["body"].get("details") or {}
    accepted: dict[str, Any]
    if current["roles"]["episode"]["body"]["state"] == "sealed":
        stored = role_details.get("actionLoopStepReceipt")
        if stored != step_receipt:
            return {
                "status": "denied",
                "code": "replay-mismatch",
                "message": "sealed Episode receipt differs from the requested loop",
                "writeOccurred": False,
            }
        accepted = {"status": "current", "inspection": current}
    else:
        cut_root = current["cutRoot"]
        accepted = _apply_profile_transition(
            runtime_dir,
            action_id=f"action-loop-seal:{_root(payload['idempotencyKey'])[7:23]}",
            ref_name=ref_name,
            role="episode",
            operation="seal",
            to_state="sealed",
            payload={
                "episodeId": episode_binding["id"],
                "beforeCutRoot": cut_root,
                "afterCutRoot": cut_root,
                "causalRoot": episode_root,
                "sealedContentRoot": episode_root,
                "actionLoopStepReceipt": step_receipt,
            },
            loop_root=payload["loopRoot"],
        )
    if accepted.get("status") == "denied":
        return accepted
    profile = accepted["inspection"]
    return {
        "status": "accepted",
        "binding": {
            "id": episode_binding["id"],
            "root": episode_root,
            "state": "sealed",
        },
        "factRef": _fact_ref(ref_name, profile),
        "receipt": step_receipt,
        "episodeId": episode_id,
        "authorityReceipt": accepted.get("authorityReceipt"),
        "writeOccurred": accepted.get("status") == "accepted",
    }


def refresh_atlas(runtime_dir: str | Path, payload: dict[str, Any]) -> dict[str, Any]:
    successor = payload.get("successor") or {}
    binding = successor.get("binding") or {}
    verification = successor.get("verification") or {}
    if (
        verification.get("valid") is not True
        or verification.get("atlasRoot") != binding.get("root")
        or not isinstance(verification.get("receiptRoot"), str)
        or (verification.get("diagnostics") or [])
    ):
        return {
            "status": "blocked",
            "code": "stale-atlas",
            "message": "successor Atlas requires an exact clean verification receipt",
            "diagnostics": verification.get("diagnostics") or [],
            "writeOccurred": False,
        }
    step_receipt = _step_receipt(
        payload,
        "refresh-atlas",
        verification["receiptRoot"],
        [binding["root"], verification["receiptRoot"]],
    )
    ref_name = payload["loopRef"]
    current = _current_profile(runtime_dir, ref_name)
    details = current["roles"]["atlas"]["body"].get("details") or {}
    accepted: dict[str, Any]
    existing_step_receipt = details.get("actionLoopStepReceipt")
    if details.get("root") == binding.get("root") and existing_step_receipt is not None:
        if existing_step_receipt != step_receipt:
            return {
                "status": "denied",
                "code": "replay-mismatch",
                "message": "current Atlas binding has a different settlement receipt",
                "writeOccurred": False,
            }
        accepted = {"status": "current", "inspection": current}
    else:
        accepted = _apply_profile_transition(
            runtime_dir,
            action_id=f"action-loop-atlas:{_root(payload['idempotencyKey'])[7:23]}",
            ref_name=ref_name,
            role="atlas",
            operation="refresh",
            to_state="current",
            payload={
                "identity": binding.get("id"),
                "root": binding.get("root"),
                "sourceRoots": list(successor.get("sourceRoots") or [binding["root"]]),
                "lossRoots": list(successor.get("lossRoots") or []),
                "validThroughRevision": int(
                    successor.get("validThroughRevision") or 1_000_000
                ),
                "predecessorRoot": payload["predecessor"]["root"],
                "episodeRoot": payload["episode"]["root"],
                "actionLoopStepReceipt": step_receipt,
            },
            loop_root=payload["loopRoot"],
        )
    if accepted.get("status") == "denied":
        return accepted
    profile = accepted["inspection"]
    return {
        "status": "accepted",
        "binding": {"id": binding["id"], "root": binding["root"], "state": "current"},
        "factRef": _fact_ref(ref_name, profile),
        "receipt": step_receipt,
        "authorityReceipt": accepted.get("authorityReceipt"),
        "writeOccurred": accepted.get("status") == "accepted",
    }


def _mission_action(
    runtime_dir: str | Path, intent_id: str, values: dict[str, Any]
) -> dict[str, Any]:
    from kungfu.assignment_runtime import LocalAssignmentRuntimeApplication

    return LocalAssignmentRuntimeApplication(
        runtime_dir,
        client_id="kungfu.action-loop.agent",
        kind="agent",
    ).authorize(intent_id, values, "action-loop")


def _completion_input_context_root(completion: dict[str, Any]) -> Any:
    if (
        "inputContextRoot" in completion
        and "inputAtlasRoot" in completion
        and completion["inputContextRoot"] != completion["inputAtlasRoot"]
    ):
        raise ValueError(
            "completion inputContextRoot conflicts with legacy inputAtlasRoot"
        )
    if "inputContextRoot" in completion:
        return completion["inputContextRoot"] or ""
    return completion.get("inputAtlasRoot") or ""


def review_completion(
    runtime_dir: str | Path, payload: dict[str, Any]
) -> dict[str, Any]:
    completion = payload.get("completion") or {}
    input_context_root = _completion_input_context_root(completion)
    common = {
        "missionId": completion["missionId"],
        "goalId": completion["goalId"],
        "source": completion.get("source") or "atlas",
    }
    claim = _mission_action(
        runtime_dir,
        "claim-completion",
        {
            **common,
            "statement": completion["statement"],
            "actor": completion.get("actor") or "agent",
            "actorType": completion.get("actorType") or "agent",
            "evidenceEpisodeIds": list(completion.get("evidenceEpisodeIds") or []),
            "goSet": list(completion.get("goSet") or [completion["goalId"]]),
            "acceptanceRoot": completion.get("acceptanceRoot") or "",
            "inputContextRoot": input_context_root,
            "resultContextRoot": payload["envelope"]["roles"]["atlas"]["root"],
            "projectCutRoot": completion.get("projectCutRoot") or "",
            "projectCutReceiptRoot": completion.get("projectCutReceiptRoot") or "",
            "gitCommit": completion.get("gitCommit") or "",
            "gitTreeRoot": completion.get("gitTreeRoot") or "",
            "proofRoots": list(completion.get("proofRoots") or []),
            "knownGaps": list(completion.get("knownGaps") or []),
            "evidenceAvailability": list(completion.get("evidenceAvailability") or []),
        },
    )
    reviewed = _mission_action(
        runtime_dir,
        "review-completion",
        {
            **common,
            "reviewer": completion["reviewer"],
            "reviewerSource": completion["reviewerSource"],
            "checkoutPath": completion.get("checkoutPath") or "",
            "purpose": completion.get("purpose") or "handoff",
            "cutSystemTime": int(completion.get("cutSystemTime") or 0),
            "executorProfile": completion.get("executorProfile") or "inline",
            "proposedFollowups": list(completion.get("proposedFollowups") or []),
        },
    )
    verdict = reviewed["review"]["verdict"]
    if verdict != "fit":
        return {
            "status": "pending",
            "code": "review-pending",
            "verdict": verdict,
            "evidenceRequests": reviewed["review"]["continuation_plan"].get(
                "evidence_requests", []
            ),
            "claim": claim,
            "review": reviewed,
            "writeOccurred": True,
        }
    decision_action = completion.get("decisionAction") or "close"
    decided = _mission_action(
        runtime_dir,
        "decide-continuation",
        {
            **common,
            "reviewId": reviewed["review"]["review_id"],
            "expectedReviewRoot": reviewed["review_root"],
            "expectedPlanRoot": reviewed["continuation_plan_root"],
            "action": decision_action,
            "actor": completion.get("actor") or "agent",
            "actorType": completion.get("actorType") or "agent",
            "changeClass": completion.get("changeClass") or "mechanical",
            "reason": completion.get("decisionReason")
            or "Action Loop exact-root completion review is fit",
        },
    )
    claim_root = claim["receipt"]["payload_hash"]
    decision_root = decided["receipt"]["payload_hash"]
    result_roots = [
        claim_root,
        reviewed["review_root"],
        reviewed["continuation_plan_root"],
        decision_root,
    ]
    return {
        "status": "accepted",
        "verdict": verdict,
        "completionClaimRoot": claim_root,
        "independentReviewRoot": reviewed["review_root"],
        "continuationPlanRoot": reviewed["continuation_plan_root"],
        "decisionRoot": decision_root,
        "decisionAction": decision_action,
        "receipt": _step_receipt(
            payload, "review-completion", decision_root, result_roots
        ),
        "claim": claim,
        "review": reviewed,
        "decision": decided,
        "writeOccurred": True,
    }


def settle_fact(runtime_dir: str | Path, payload: dict[str, Any]) -> dict[str, Any]:
    settlement = payload.get("settlement") or {}
    settlement_root = settlement.get("settlementRoot")
    if not isinstance(settlement_root, str) or not settlement_root.startswith(
        "sha256:"
    ):
        return {
            "status": "denied",
            "code": "invalid-root",
            "message": "settlementRoot is required",
            "writeOccurred": False,
        }
    ref_name = payload["loopRef"]
    token = _root(payload["idempotencyKey"])[7:23]
    step_receipt = _step_receipt(
        payload,
        "settle-fact-ref",
        settlement_root,
        [
            settlement_root,
            payload["envelope"]["roles"]["episode"]["root"],
            payload["envelope"]["roles"]["atlas"]["root"],
        ],
    )
    pursuit_payload = {
        "settlementRoot": settlement_root,
        "outcome": settlement.get("outcome") or "completed",
        "actionLoopStepReceipt": step_receipt,
    }
    fact_payload = {
        "settlementRoot": settlement_root,
        "actionLoopStepReceipt": step_receipt,
    }
    current = _current_profile(runtime_dir, ref_name)
    expected_ref = payload["envelope"]["factRef"]
    current_ref = _fact_ref(ref_name, current)
    pursuit_body = current["roles"]["pursuit"]["body"]
    fact_body = current["roles"]["fact"]["body"]
    warrant_body = current["roles"]["warrant"]["body"]

    def owns_target(body: dict[str, Any], state: str) -> bool:
        return body["state"] == state and (
            (body.get("details") or {}).get("actionLoopStepReceipt") == step_receipt
        )

    pursuit_done = owns_target(pursuit_body, "completed")
    fact_done = owns_target(fact_body, "superseded")
    warrant_done = owns_target(warrant_body, "expired")
    if pursuit_body["state"] not in {"active", "completed"} or (
        pursuit_body["state"] == "completed" and not pursuit_done
    ):
        return {
            "status": "denied",
            "code": "replay-mismatch",
            "message": "Pursuit settlement state belongs to a different transition",
            "writeOccurred": False,
        }
    if fact_body["state"] not in {"declared", "superseded"} or (
        fact_body["state"] == "superseded" and not fact_done
    ):
        return {
            "status": "denied",
            "code": "replay-mismatch",
            "message": "Fact settlement state belongs to a different transition",
            "writeOccurred": False,
        }
    if warrant_body["state"] not in {"issued", "expired"} or (
        warrant_body["state"] == "expired" and not warrant_done
    ):
        return {
            "status": "denied",
            "code": "replay-mismatch",
            "message": "Warrant settlement state belongs to a different transition",
            "writeOccurred": False,
        }
    if fact_done and not pursuit_done or warrant_done and not fact_done:
        return {
            "status": "denied",
            "code": "replay-mismatch",
            "message": "Action Loop settlement prefix is out of order",
            "writeOccurred": False,
        }
    if current_ref != expected_ref and not pursuit_done:
        return {
            "status": "denied",
            "code": "stale-ref",
            "message": "final Action Loop Fact ref changed before settlement",
            "writeOccurred": False,
        }
    pursuit = _apply_profile_transition(
        runtime_dir,
        action_id=f"action-loop-settle:{token}:pursuit",
        ref_name=ref_name,
        role="pursuit",
        operation="complete",
        to_state="completed",
        payload=pursuit_payload,
        loop_root=payload["loopRoot"],
        expected_details=pursuit_payload,
    )
    if pursuit.get("status") == "denied":
        return pursuit
    fact = _apply_profile_transition(
        runtime_dir,
        action_id=f"action-loop-settle:{token}:fact",
        ref_name=ref_name,
        role="fact",
        operation="successor",
        to_state="superseded",
        payload=fact_payload,
        loop_root=payload["loopRoot"],
        expected_details=fact_payload,
    )
    if fact.get("status") == "denied":
        return {
            **fact,
            "writeOccurred": pursuit.get("status") == "accepted"
            or fact.get("writeOccurred") is True,
        }
    current = _current_profile(runtime_dir, ref_name)
    provisional_ref = _fact_ref(ref_name, current)
    final_envelope = copy.deepcopy(payload["envelope"])
    final_envelope["state"] = "settled"
    final_envelope["acceptedSteps"] = [
        *final_envelope["acceptedSteps"],
        "settle-fact-ref",
    ]
    final_envelope["factRef"] = provisional_ref
    final_envelope["roles"]["fact"] = {
        **final_envelope["roles"]["fact"],
        "root": provisional_ref["cutRoot"],
        "state": "superseded",
    }
    final_envelope["roles"]["pursuit"] = {
        **final_envelope["roles"]["pursuit"],
        "state": "completed",
    }
    final_envelope["roles"]["warrant"] = {
        **final_envelope["roles"]["warrant"],
        "state": "expired",
    }
    final_receipts = [*payload["receipts"], step_receipt]
    checkpoint = {
        "schema": CHECKPOINT_SCHEMA,
        "loopRef": ref_name,
        "envelope": final_envelope,
        "receipts": final_receipts,
    }
    checkpoint_root = _root(checkpoint)
    warrant_payload = {
        "reasonRoot": settlement_root,
        "reason": settlement.get("warrantReason") or "Action Loop settled",
        "actionLoopCheckpoint": checkpoint,
        "actionLoopCheckpointRoot": checkpoint_root,
        "actionLoopStepReceipt": step_receipt,
    }
    warrant = _apply_profile_transition(
        runtime_dir,
        action_id=f"action-loop-settle:{token}:warrant",
        ref_name=ref_name,
        role="warrant",
        operation="expire",
        to_state="expired",
        payload=warrant_payload,
        loop_root=payload["loopRoot"],
        expected_details=warrant_payload,
    )
    if warrant.get("status") == "denied":
        return {
            **warrant,
            "writeOccurred": pursuit.get("status") == "accepted"
            or fact.get("status") == "accepted"
            or warrant.get("writeOccurred") is True,
        }
    loaded = load_checkpoint(runtime_dir, ref_name)
    if loaded.get("status") != "current":
        raise RuntimeError("final Action Loop checkpoint is unavailable")
    return {
        "status": "accepted",
        "envelope": loaded["envelope"],
        "factRef": loaded["envelope"]["factRef"],
        "checkpointRoot": loaded["checkpointRoot"],
        "receipt": step_receipt,
        "authorityReceipts": [
            pursuit.get("authorityReceipt"),
            fact.get("authorityReceipt"),
            warrant.get("authorityReceipt"),
        ],
        "writeOccurred": any(
            item.get("status") == "accepted" for item in (pursuit, fact, warrant)
        ),
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
    material = None
    checkpoint_root = None
    for role in work_profile.ROLES:
        details = inspected["roles"][role]["body"].get("details") or {}
        candidate = details.get("actionLoopCheckpoint")
        candidate_root = details.get("actionLoopCheckpointRoot")
        if isinstance(candidate, dict) and isinstance(candidate_root, str):
            material = candidate
            checkpoint_root = candidate_root
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
    if operation == "authority-inspect":
        expected = payload if isinstance(payload, Mapping) else None
        return inspect_native_authority(runtime_dir, expected)
    if isinstance(payload, Mapping):
        expected_authority = payload.get("nativeAuthority")
        envelope = payload.get("envelope")
        if expected_authority is None and isinstance(envelope, Mapping):
            expected_authority = envelope.get("nativeAuthority")
        if isinstance(expected_authority, Mapping):
            authority = inspect_native_authority(runtime_dir, expected_authority)
            if authority.get("status") != "current":
                return authority
    if operation == "work-profile-bind":
        return bind_work_profile(runtime_dir, payload)
    if operation == "episode-resume-or-begin":
        return resume_or_begin_episode(runtime_dir, payload)
    if operation == "episode-inspect":
        return inspect_episode(runtime_dir, payload)
    if operation == "episode-seal":
        return seal_episode(runtime_dir, payload)
    if operation == "work-profile-atlas-refresh":
        return refresh_atlas(runtime_dir, payload)
    if operation == "completion-review":
        return review_completion(runtime_dir, payload)
    if operation == "fact-settle":
        return settle_fact(runtime_dir, payload)
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
