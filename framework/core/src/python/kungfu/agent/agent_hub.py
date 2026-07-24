# SPDX-License-Identifier: Apache-2.0

"""Product-owned KFD Agent Hub profile projection.

The JSONL adapter is deliberately outside this module.  This module owns the
Hub observations and verdicts, while the native Fact/KFD-7 surfaces remain the
authority for durable product state.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any


PROFILE_VERSION = "0.1.0-alpha.1"
PROTOCOL_ID = "kfd-agent-hub"
ADAPTER = {
    "id": "kungfu-work-agent-hub",
    "version": "0.1.0-alpha.1",
    "topology": "local-peer",
}
REQUEST_CONTRACT = "kfd.agent-hub-adapter-request/v1"
RESPONSE_CONTRACT = "kfd.agent-hub-adapter-response/v1"
CAPABILITY_SCHEMA = (
    "https://kfd.libkungfu.dev/schemas/kfd-agent-hub/capabilities.schema.json"
)
SUPPORTED_FEATURES = {"transport-receipts", "offline-reconnect"}
FAILURE_CODES = [
    "profile-version-unsupported",
    "profile-root-mismatch",
    "required-feature-unsupported",
    "identity-unresolved",
    "authority-unresolved",
    "authority-expired",
    "authority-revoked",
    "authority-amplification",
    "fact-cut-unavailable",
    "causal-gap",
    "payload-digest-mismatch",
    "idempotency-conflict",
    "conflict-visible",
    "disclosure-insufficient",
    "required-field-withheld",
    "completion-unproved",
    "local-policy-rejected",
]


def canonical(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int) and value >= 0:
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                f"{json.dumps(key)}:{canonical(value[key])}" for key in sorted(value)
            )
            + "}"
        )
    raise ValueError(f"unsupported canonical value: {type(value).__name__}")


def semantic_root(value: Any) -> str:
    digest = hashlib.sha256((canonical(value) + "\n").encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _domain_identity(hub_id: str, runtime_home: str | Path) -> dict[str, str]:
    home = Path(runtime_home).resolve()
    identity_path = home / "workspace-identity.json"
    if identity_path.is_file():
        material = json.loads(identity_path.read_text(encoding="utf-8"))
        workspace_id = str(material["workspaceKey"])
        identity_root = str(material["identityRoot"])
    else:
        identity_root = semantic_root({"hubId": hub_id, "runtimeHome": str(home)})
        workspace_id = (
            f"candidate:workspace:{identity_root.removeprefix('sha256:')[:32]}"
        )
    return {
        "hubId": hub_id,
        "nodeId": f"{hub_id}-node",
        "actorId": f"{hub_id}-actor",
        "workspaceId": workspace_id,
        "_identityRoot": identity_root,
    }


def capabilities(hub_id: str, runtime_home: str | Path) -> dict[str, Any]:
    identity = _domain_identity(hub_id, runtime_home)
    identity_root = identity.pop("_identityRoot")
    return {
        "$schema": CAPABILITY_SCHEMA,
        "schemaVersion": 1,
        "contract": "kfd-agent-hub-capabilities",
        "identity": identity,
        "profileVersions": [PROFILE_VERSION],
        "requiredFeatures": ["transport-receipts"],
        "optionalFeatures": ["offline-reconnect"],
        "operations": [
            "capability-advertisement",
            "responsibility-proposal",
            "fact-admission",
            "supersession",
            "completion-assessment",
            "warrant-revocation",
        ],
        "topologies": ["local-peer"],
        "disclosureModes": [
            "full",
            "partial",
            "redacted",
            "reference-only",
            "intentionally-withheld",
        ],
        "failureCodes": FAILURE_CODES,
        "bindings": [
            {
                "id": "jsonl-stdio",
                "mediaTypes": ["application/json"],
                "authentication": "local-process",
                "transportReceipts": True,
                "duplicateDelivery": "at-least-once",
            }
        ],
        "limits": {"maxInlineBytes": 65536, "maxEnvelopeBytes": 1048576},
        "authorityRoots": [
            semantic_root(
                {
                    "authority": "kungfu-agent-hub-local-domain",
                    "identity": identity,
                    "workspaceIdentityRoot": identity_root,
                }
            )
        ],
        "issuedAt": "2026-07-24T00:00:00.000Z",
    }


def _assert_isolated(
    source_home: str | Path,
    target_home: str | Path,
    qualification_root: str | Path | None,
) -> tuple[Path, Path]:
    source = Path(source_home).resolve()
    target = Path(target_home).resolve()
    if source == target:
        raise ValueError("source and target Hub homes must be distinct")
    real_home = (Path.home() / ".kungfu").resolve()
    if source == real_home or target == real_home:
        raise ValueError("qualification cannot use the real ~/.kungfu")
    if qualification_root is not None:
        root = Path(qualification_root).resolve()
        for current in (source, target):
            if root != current and root not in current.parents:
                raise ValueError("Hub home escaped the qualification root")
    return source, target


def _ensure_workspace_domain(runtime_home: Path) -> dict[str, Any]:
    from kungfu.workspace import ensure_workspace_data_home, inspect_workspace

    isolated_env = {
        **os.environ,
        "HOME": str(runtime_home.parent),
        "KF_HOME": str(runtime_home),
        "KF_WORKSPACE_ROOT": str(runtime_home.parent),
    }
    identity = inspect_workspace(
        str(runtime_home.parent),
        env=isolated_env,
    )
    if identity is None or Path(identity.data_home).resolve() != runtime_home:
        raise ValueError("failed to resolve the isolated Hub workspace")
    receipt = ensure_workspace_data_home(identity, "kfd-agent-hub-local-domain")
    return {
        "workspaceId": receipt["workspace_id"],
        "workspaceIdentityRoot": receipt["workspace_identity_root"],
        "workspaceKind": receipt["workspace_kind"],
        "resultingState": receipt["resulting_state"],
    }


def _store_path(runtime_home: Path) -> Path:
    return runtime_home / "runtime" / "agent-hub" / "exchange-store.json"


def _load_store(runtime_home: Path) -> dict[str, Any]:
    path = _store_path(runtime_home)
    if not path.is_file():
        return {
            "schema": "kungfu.agent-hub-exchange-store/v1",
            "deliveries": {},
            "events": [],
        }
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != "kungfu.agent-hub-exchange-store/v1":
        raise ValueError("unsupported Agent Hub exchange store")
    return value


def _save_store(runtime_home: Path, store: dict[str, Any]) -> str:
    path = _store_path(runtime_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(store, indent=2, sort_keys=True) + "\n"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(payload, encoding="utf-8")
    os.replace(temporary, path)
    return semantic_root(store)


def _record(
    runtime_home: Path, request_id: str, operation: str, evidence: dict[str, Any]
) -> str:
    store = _load_store(runtime_home)
    store["events"].append(
        {
            "requestId": request_id,
            "operation": operation,
            "evidence": evidence,
        }
    )
    return _save_store(runtime_home, store)


def _vector_clock_relation(left: dict[str, int], right: dict[str, int]) -> str:
    actors = set(left) | set(right)
    left_le_right = all(left.get(actor, 0) <= right.get(actor, 0) for actor in actors)
    right_le_left = all(right.get(actor, 0) <= left.get(actor, 0) for actor in actors)
    if left_le_right and right_le_left:
        return "equal"
    if left_le_right:
        return "left-before-right"
    if right_le_left:
        return "right-before-left"
    return "concurrent"


def _outcome(
    status: str, code: str, verdict: str, **observations: Any
) -> dict[str, Any]:
    return {
        "status": status,
        "code": code,
        "verdict": verdict,
        "observations": observations,
    }


def _evaluate_negotiation(input_value: dict[str, Any]) -> dict[str, Any]:
    required = set(input_value.get("requiredFeatures", []))
    unsupported = sorted(required - SUPPORTED_FEATURES)
    if unsupported:
        return _outcome(
            "rejected",
            "required-feature-unsupported",
            "rejected",
            unsupportedFeatures=unsupported,
        )
    profile = input_value.get("profile")
    if profile is not None and profile != PROFILE_VERSION:
        return _outcome(
            "rejected",
            "profile-version-unsupported",
            "rejected",
            requestedProfile=profile,
        )
    local_root = input_value.get("localProfileRoot")
    remote_root = input_value.get("remoteProfileRoot")
    if local_root is not None and remote_root is not None and local_root != remote_root:
        return _outcome(
            "rejected",
            "profile-root-mismatch",
            "rejected",
            localProfileRoot=local_root,
            remoteProfileRoot=remote_root,
        )
    return _outcome(
        "accepted",
        "capability-negotiated",
        "admitted",
        profile=profile or PROFILE_VERSION,
        negotiatedFeatures=sorted(required),
        profileRoot=input_value.get("profileRoot"),
    )


def _evaluate_delivery(
    source_home: Path,
    runtime_home: Path,
    request_id: str,
    input_value: dict[str, Any],
) -> dict[str, Any]:
    first = input_value.get("firstPayloadRoot")
    duplicate = input_value.get("duplicatePayloadRoot")
    key = input_value.get("idempotencyKey")
    if key and first and duplicate:
        store = _load_store(runtime_home)
        source_scope = _domain_identity("kungfu-work/hub-alpha", source_home)[
            "_identityRoot"
        ]
        scoped_key = f"{source_scope}:{key}"
        existing = store["deliveries"].get(scoped_key)
        if existing is not None and existing != first:
            return _outcome(
                "rejected",
                "idempotency-conflict",
                "rejected",
                idempotencyKey=key,
                retainedPayloadRoot=existing,
                proposedPayloadRoot=first,
            )
        store["deliveries"][scoped_key] = first
        store_root = _save_store(runtime_home, store)
        if first != duplicate:
            return _outcome(
                "rejected",
                "idempotency-conflict",
                "rejected",
                idempotencyKey=key,
                retainedPayloadRoot=first,
                proposedPayloadRoot=duplicate,
                sourceAuthorityRoot=source_scope,
                storeRoot=store_root,
            )
        return _outcome(
            "accepted",
            "duplicate-preserved",
            "not-applicable",
            idempotencyKey=key,
            payloadRoot=first,
            sourceAuthorityRoot=source_scope,
            storeRoot=store_root,
        )
    if (
        input_value.get("delivered") is True
        and input_value.get("localPolicy") == "allow"
        and input_value.get("decisionAuthorityRoots")
    ):
        store_root = _record(
            runtime_home,
            request_id,
            "fact-admission",
            {
                "delivery": True,
                "decisionAuthorityRoots": input_value["decisionAuthorityRoots"],
            },
        )
        return _outcome(
            "accepted",
            "admission-accepted",
            "admitted",
            delivery=True,
            semanticAdmission=True,
            storeRoot=store_root,
        )
    if input_value.get("delivered") is True or input_value.get("delayed") is True:
        store_root = _record(
            runtime_home,
            request_id,
            "transport-delivery",
            {
                "delivered": input_value.get("delivered", False),
                "delayed": input_value.get("delayed", False),
                "receiptRoot": input_value.get("receiptRoot"),
            },
        )
        return _outcome(
            "accepted",
            "delivery-recorded",
            "not-applicable",
            deliveryRecorded=True,
            semanticAdmission=False,
            storeRoot=store_root,
        )
    return _outcome(
        "rejected",
        "local-policy-rejected",
        "rejected",
        reason="delivery input did not establish a supported observation",
    )


def _evaluate_authority(
    runtime_home: Path, request_id: str, input_value: dict[str, Any]
) -> dict[str, Any]:
    if input_value.get("warrantStatus") == "revoked":
        store_root = _record(
            runtime_home,
            request_id,
            "warrant-revocation",
            {
                "status": "revoked",
                "requestedAction": input_value.get("requestedAction"),
            },
        )
        return _outcome(
            "rejected",
            "authority-revoked",
            "rejected",
            warrantStatus="revoked",
            storeRoot=store_root,
        )
    parent_actions = set(input_value.get("parentActions", []))
    child_actions = set(input_value.get("childActions", []))
    parent_expiry = input_value.get("parentExpiresAt")
    child_expiry = input_value.get("childExpiresAt")
    actions_narrowed = child_actions <= parent_actions
    time_narrowed = (
        isinstance(parent_expiry, int)
        and isinstance(child_expiry, int)
        and child_expiry <= parent_expiry
    )
    if not actions_narrowed or not time_narrowed:
        return _outcome(
            "rejected",
            "authority-amplification",
            "rejected",
            addedActions=sorted(child_actions - parent_actions),
            parentExpiresAt=parent_expiry,
            childExpiresAt=child_expiry,
        )
    store_root = _record(
        runtime_home,
        request_id,
        "warrant-attenuation",
        {
            "parentActions": sorted(parent_actions),
            "childActions": sorted(child_actions),
            "parentExpiresAt": parent_expiry,
            "childExpiresAt": child_expiry,
        },
    )
    return _outcome(
        "accepted",
        "authority-attenuated",
        "admitted",
        actionsNarrowed=True,
        timeNarrowed=True,
        storeRoot=store_root,
    )


def _evaluate_conflict(input_value: dict[str, Any]) -> dict[str, Any]:
    if input_value.get("concurrent") is True and input_value.get("conflictRoots"):
        return _outcome(
            "rejected",
            "conflict-visible",
            "rejected",
            rejectedPolicy=input_value.get("policy"),
            conflictRoots=input_value["conflictRoots"],
        )
    relation = _vector_clock_relation(
        input_value.get("leftClock", {}), input_value.get("rightClock", {})
    )
    if relation == "concurrent":
        return _outcome(
            "conflicted",
            "conflict-visible",
            "conflicted",
            clockRelation=relation,
            resolutionPolicy=input_value.get("policy"),
        )
    return _outcome(
        "accepted",
        "conflict-absent",
        "not-applicable",
        clockRelation=relation,
    )


def _evaluate_knowledge(input_value: dict[str, Any]) -> dict[str, Any]:
    disclosure = input_value.get("disclosure")
    if disclosure == "intentionally-withheld":
        verdict = "intentionally-withheld"
    elif disclosure == "unavailable":
        verdict = "unavailable"
    else:
        verdict = "not-applicable"
    return _outcome(
        "accepted",
        "partial-knowledge-retained",
        verdict,
        disclosure=disclosure,
        knownFields=input_value.get("knownFields", []),
        omittedFields=input_value.get("omittedFields", []),
        reason=input_value.get("reason"),
    )


def _evaluate_completion(input_value: dict[str, Any]) -> dict[str, Any]:
    if (
        input_value.get("callSucceeded") is True
        and input_value.get("completionVerdict") != "proved"
    ):
        return _outcome(
            "rejected",
            "completion-unproved",
            "rejected",
            callSucceeded=True,
            completionVerdict=input_value.get("completionVerdict"),
        )
    return _outcome(
        "accepted",
        "completion-proved",
        "admitted",
        completionVerdict=input_value.get("completionVerdict"),
    )


def _evaluate_recovery(input_value: dict[str, Any]) -> dict[str, Any]:
    divergent = input_value.get("divergentRoots", [])
    if (
        input_value.get("offline") is True
        and input_value.get("reconnect") is True
        and len(set(divergent)) > 1
    ):
        return _outcome(
            "conflicted",
            "conflict-visible",
            "conflicted",
            divergentRoots=divergent,
            lastWriteWinsApplied=False,
        )
    return _outcome(
        "accepted",
        "reconnect-preserved",
        "not-applicable",
        divergentRoots=divergent,
    )


def _evaluate_portability(
    source_home: Path,
    target_home: Path,
    request_id: str,
    input_value: dict[str, Any],
) -> dict[str, Any]:
    exported_profile = input_value.get("exportedProfileRoot")
    imported_profile = input_value.get("importedProfileRoot")
    if exported_profile != imported_profile:
        return _outcome(
            "rejected",
            "profile-root-mismatch",
            "rejected",
            exportedProfileRoot=exported_profile,
            importedProfileRoot=imported_profile,
        )
    exported_payload = input_value.get("exportedPayloadRoot")
    imported_payload = input_value.get("importedPayloadRoot")
    if exported_payload != imported_payload:
        return _outcome(
            "rejected",
            "payload-digest-mismatch",
            "rejected",
            exportedPayloadRoot=exported_payload,
            importedPayloadRoot=imported_payload,
        )
    bundle = {
        "schema": "kungfu.agent-hub-portability-bundle/v1",
        "profileRoot": exported_profile,
        "payloadRoot": exported_payload,
    }
    source_store_root = _record(
        source_home, request_id, "export", {"bundleRoot": semantic_root(bundle)}
    )
    target_store_root = _record(target_home, request_id, "import", {"bundle": bundle})
    return _outcome(
        "accepted",
        "export-import-preserved",
        "admitted",
        bundleRoot=semantic_root(bundle),
        sourceStoreRoot=source_store_root,
        targetStoreRoot=target_store_root,
    )


def _evaluate(
    request: dict[str, Any], source_home: Path, target_home: Path
) -> dict[str, Any]:
    envelope = request.get("input")
    if not isinstance(envelope, dict) or not isinstance(envelope.get("input"), dict):
        return _outcome(
            "error",
            "adapter-request-invalid",
            "not-applicable",
            reason="evaluate input must contain a scenario input object",
        )
    category = envelope.get("category")
    input_value = envelope["input"]
    request_id = str(request.get("requestId", "unknown"))
    if category == "negotiation":
        return _evaluate_negotiation(input_value)
    if category == "delivery":
        return _evaluate_delivery(source_home, target_home, request_id, input_value)
    if category == "authority":
        return _evaluate_authority(target_home, request_id, input_value)
    if category == "conflict":
        return _evaluate_conflict(input_value)
    if category == "knowledge":
        return _evaluate_knowledge(input_value)
    if category == "completion":
        return _evaluate_completion(input_value)
    if category == "recovery":
        return _evaluate_recovery(input_value)
    if category == "portability":
        return _evaluate_portability(source_home, target_home, request_id, input_value)
    return _outcome(
        "error",
        "category-unsupported",
        "not-applicable",
        category=category,
    )


def handle_request(
    request: dict[str, Any],
    *,
    source_home: str | Path,
    target_home: str | Path,
    qualification_root: str | Path | None = None,
) -> dict[str, Any]:
    source, target = _assert_isolated(source_home, target_home, qualification_root)
    source_workspace = _ensure_workspace_domain(source)
    target_workspace = _ensure_workspace_domain(target)
    request_id = str(request.get("requestId", "unknown"))
    base = {
        "schemaVersion": 1,
        "contract": RESPONSE_CONTRACT,
        "requestId": request_id,
        "adapter": ADAPTER,
    }
    if request.get("schemaVersion") != 1 or request.get("contract") != REQUEST_CONTRACT:
        return {
            **base,
            **_outcome(
                "error",
                "adapter-request-invalid",
                "not-applicable",
                reason="request envelope does not use the exact v1 contract",
            ),
        }
    if request.get("operation") == "handshake":
        hubs = [
            capabilities("kungfu-work/hub-alpha", source),
            capabilities("kungfu-work/hub-beta", target),
        ]
        return {
            **base,
            "status": "accepted",
            "code": "adapter-ready",
            "verdict": "not-applicable",
            "hubs": [
                {
                    "hubId": document["identity"]["hubId"],
                    "capabilities": document,
                    "capabilityRoot": semantic_root(document),
                }
                for document in hubs
            ],
            "observations": {
                "binding": "jsonl-stdio/v1",
                "minimumHubCount": 2,
                "authorityDomainsDistinct": True,
                "sourceDomainRoot": hubs[0]["authorityRoots"][0],
                "targetDomainRoot": hubs[1]["authorityRoots"][0],
                "productSurface": "kungfu agent hub handle",
                "sourceWorkspace": source_workspace,
                "targetWorkspace": target_workspace,
            },
        }
    if request.get("operation") != "evaluate":
        outcome = _outcome(
            "error",
            "adapter-operation-unsupported",
            "not-applicable",
            operation=request.get("operation"),
        )
    else:
        outcome = _evaluate(request, source, target)
    outcome["observations"].update(
        {
            "sourceDomain": _domain_identity("kungfu-work/hub-alpha", source),
            "targetDomain": _domain_identity("kungfu-work/hub-beta", target),
            "authorityDomainsDistinct": True,
            "productSurface": "kungfu agent hub handle",
            "sourceWorkspace": source_workspace,
            "targetWorkspace": target_workspace,
        }
    )
    return {**base, **outcome}
