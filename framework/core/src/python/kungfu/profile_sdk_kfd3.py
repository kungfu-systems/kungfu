# SPDX-License-Identifier: Apache-2.0

"""KFD-3 qualification policy and evidence for Profile SDK sources."""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, NoReturn

import kungfu
from kungfu import kfx_contract
from kungfu.profile_sdk_kfd3_release import (
    _shared_api_release_audit as _shared_api_release_audit,
)
from kungfu.storage import service as storage_service
from kungfu.profile_sdk_support import (
    KFD3_QUALIFICATION_PLAN_SCHEMA,
    KFD3_QUALIFICATION_RECEIPT_SCHEMA,
    KFD3_RELEASE_MANIFEST_SCHEMA,
    KFD3_WITNESS_SCHEMA,
    ProfileSdkError,
    _confined,
    _root,
    _sha256,
    _validate_sdk_value,
)


@dataclass(frozen=True)
class Kfd3Operations:
    validate_source: Callable[..., dict[str, Any]]
    application: Callable[..., dict[str, Any]]
    intent_plan: Callable[..., dict[str, Any]]
    decision_card: Callable[..., dict[str, Any]]
    lifecycle_plan: Callable[..., dict[str, Any]]
    lifecycle_apply: Callable[..., dict[str, Any]]
    answer_decision: Callable[..., dict[str, Any]]


def _agent_interface_authority() -> dict[str, Any]:
    """Audit the installed KFD-3 authority rather than trusting Profile prose."""

    from kungfu.agent.kfd3 import registry, registry_digest, verify_agent_interface
    from kungfu.cli.commands.agent import agent

    verification = verify_agent_interface(agent)

    application_api = next(
        (
            row
            for row in registry().get("apis", [])
            if row.get("id") == "kungfu.profile.application"
        ),
        None,
    )
    if not verification["ok"] or application_api is None:
        raise ProfileSdkError(
            "kfd3-authority-audit-failed",
            "installed collaboration-interface authority is not closed",
            agentVerification=verification,
        )
    return {
        "standard": "KFD-3",
        "registryId": verification["registry"]["registryId"],
        "registryRoot": "sha256:" + registry_digest(),
        "auditRoot": _root(verification),
        "applicationApi": {
            "id": application_api["id"],
            "surface": application_api["surface"],
            "name": application_api["name"],
            "aliases": application_api.get("aliases", []),
        },
    }


def _profile_facet_audit(resolved: Mapping[str, Any]) -> dict[str, Any]:
    """Reject executable/custom surfaces that can bypass the shared service."""

    native_runtime = kfx_contract.load_contract()["nativeRuntime"]
    view_placement = native_runtime["experienceFlowHost"]["placements"].get("gui")
    if view_placement != "sandboxed-ipc":
        raise ProfileSdkError(
            "kfd3-view-placement-authority-invalid",
            "Core does not declare the required sandboxed Profile view placement",
            placement=view_placement,
        )
    package_dirs = {
        "suite": Path(str(resolved["source"])),
        **{
            str(key): Path(str(path))
            for key, path in (resolved.get("memberPackages") or {}).items()
        },
    }
    custom_views = []
    failures = []
    for key, package_dir in sorted(package_dirs.items()):
        manifest = kfx_contract.read_manifest_from_dir(str(package_dir))
        config = (manifest.get("kungfuConfig") or {}).get("config") or {}
        view = config.get("view")
        if view is not None:
            capabilities = sorted(view.get("capabilities") or [])
            entry = str(view.get("entry") or "dist/view/index.js")
            entry_path = _confined(package_dir, entry)
            reasons = []
            if capabilities:
                reasons.append(
                    "custom Profile views may not receive capability handles"
                )
            if not entry_path.is_file():
                reasons.append("custom Profile view bundle is missing")
            row = {
                "packageKey": key,
                "runtime": view_placement,
                "capabilities": capabilities,
                "entry": entry,
                "bundleRoot": (
                    "sha256:" + _sha256(entry_path.read_bytes())
                    if entry_path.is_file()
                    else None
                ),
                "passed": not reasons,
            }
            custom_views.append(row)
            if reasons:
                failures.append(
                    {"packageKey": key, "facet": "view", "reasons": reasons}
                )
        for facet in ("adapter", "service", "wasm"):
            if config.get(facet) is not None:
                failures.append(
                    {
                        "packageKey": key,
                        "facet": facet,
                        "reasons": [
                            "executable Profile member facets are not yet confined to the shared intent runtime"
                        ],
                    }
                )
    if failures:
        raise ProfileSdkError(
            "kfd3-no-bypass-failed",
            "Profile exposes a custom surface outside the qualified application service",
            failures=failures,
        )
    return {
        "passed": True,
        "policy": "generic-renderer-or-capability-free-sandboxed-view/v1",
        "customViews": custom_views,
        "executableFacetCount": 0,
    }


def _earn_kfd3(
    ops: Kfd3Operations,
    source: str | Path,
    runtime_dir: str | Path,
    *,
    qualification_source: str,
) -> dict[str, Any]:
    """Run the KFD-3 probes and return a receipt for the next lifecycle revision."""

    validated = ops.validate_source(source, runtime_dir)
    resolved = validated["source"]
    closure = validated["collaboration"]
    if not closure["declared"]:
        raise ProfileSdkError(
            "collaboration-not-declared",
            "KFD-3 qualification requires a content-bound collaboration facet",
        )
    projection = ops.application(source, runtime_dir, include_qualification=False)
    if qualification_source == "local" and not projection["activeExactRoot"]:
        raise ProfileSdkError(
            "kfd3-active-root-required",
            "KFD-3 qualification requires the exact Profile root to be active",
        )
    if not projection["intents"]:
        raise ProfileSdkError(
            "kfd3-intent-probe-required",
            "KFD-3 qualification requires at least one material intent probe",
        )
    authority = _agent_interface_authority()
    if qualification_source == "release":
        no_bypass, probes = _shared_api_release_audit(projection, resolved)
    else:
        unsupported = [
            row["id"]
            for row in projection["intents"]
            if row["action"]["runner"] != "profile-lifecycle"
            or row["action"]["operation"] not in {"qualify", "activate", "remove"}
        ]
        if unsupported:
            raise ProfileSdkError(
                "kfd3-action-runtime-unqualified",
                "one or more material intents do not resolve to an executable confined runtime",
                intentIds=unsupported,
            )
        no_bypass = _profile_facet_audit(resolved)
        probes = []
        for intent in projection["intents"]:
            human_plan = ops.intent_plan(source, runtime_dir, intent["id"], {})
            agent_plan = ops.intent_plan(source, runtime_dir, intent["id"], {})
            matched = (
                human_plan["planId"] == agent_plan["planId"]
                and human_plan["actionPlanId"] == agent_plan["actionPlanId"]
                and human_plan["closureRoot"] == agent_plan["closureRoot"]
            )
            if not matched:
                raise ProfileSdkError(
                    "kfd3-dual-client-drift",
                    "Human and Agent probes produced different exact plans",
                    intentId=intent["id"],
                )
            probes.append(
                {
                    "intentId": intent["id"],
                    "humanPlanId": human_plan["planId"],
                    "agentPlanId": agent_plan["planId"],
                    "actionPlanId": human_plan["actionPlanId"],
                    "matched": True,
                }
            )
    inventory = {
        "intentIds": sorted(row["id"] for row in projection["intents"]),
        "actionIds": sorted(row["actionId"] for row in projection["intents"]),
        "viewIds": sorted(
            {
                view_id
                for row in projection["intents"]
                for view_id in (row["inspectViewId"], row["verifyViewId"])
            }
        ),
        "applicationApiId": authority["applicationApi"]["id"],
    }
    identity = {
        "profileId": projection["profileId"],
        "profileSuiteRoot": projection["profileSuiteRoot"],
        "collaborationRoot": projection["collaborationRoot"],
        "closureRoot": projection["closureRoot"],
        "profileRevision": (
            1
            if qualification_source == "release"
            else int(projection["profileRevision"] or 0) + 1
        ),
        "runtimeContract": "kungfu.profile-lifecycle/v1",
        "qualificationSource": qualification_source,
        "authority": authority,
        "surfaceInventory": inventory,
        "noBypass": no_bypass,
        "clientProbes": probes,
        "knownLimits": projection["knownLimits"],
        "evidenceScope": [
            "installed-agent-interface-closure",
            "profile-content-closure",
            "public-surface-inventory",
            (
                "release-owned-shared-api-parity"
                if qualification_source == "release"
                else "custom-view-no-bypass"
            ),
            (
                "gui-agent-api-registry-match"
                if qualification_source == "release"
                else "dual-client-exact-plan"
            ),
        ],
    }
    receipt = {
        "schema": KFD3_QUALIFICATION_RECEIPT_SCHEMA,
        "receiptId": _root(identity),
        **identity,
        "qualified": True,
    }
    witness_identity = {
        "profileId": receipt["profileId"],
        "profileSuiteRoot": receipt["profileSuiteRoot"],
        "collaborationRoot": receipt["collaborationRoot"],
        "closureRoot": receipt["closureRoot"],
        "qualificationReceiptId": receipt["receiptId"],
        "authorityRegistryRoot": authority["registryRoot"],
        "claim": "profile-collaboration-closure-qualified",
    }
    witness = {
        "schema": KFD3_WITNESS_SCHEMA,
        "witnessId": _root(witness_identity),
        **witness_identity,
        "standard": "KFD-3",
        "issuer": "kungfu-profile-runtime",
        "qualified": True,
    }
    _validate_sdk_value("kfd3WitnessSchema", witness, "KFD-3 witness")
    result = {**receipt, "witness": witness}
    _validate_sdk_value(
        "kfd3QualificationReceiptSchema", result, "KFD-3 qualification receipt"
    )
    return result


def build_kfd3_release_manifest(
    ops: Kfd3Operations, sources: list[str | Path], runtime_dir: str | Path
) -> dict[str, Any]:
    """Run factory qualification and emit exact-root release receipts."""

    entries = []
    for source in sources:
        receipt = _earn_kfd3(ops, source, runtime_dir, qualification_source="release")
        entries.append(
            {
                "profileId": receipt["profileId"],
                "profileSuiteRoot": receipt["profileSuiteRoot"],
                "receipt": receipt,
            }
        )
    entries.sort(key=lambda row: (row["profileId"], row["profileSuiteRoot"]))
    identity = {"schema": KFD3_RELEASE_MANIFEST_SCHEMA, "entries": entries}
    return {**identity, "manifestRoot": _root(identity)}


def _release_qualification_receipt(
    profile_id: str, profile_suite_root: str
) -> dict[str, Any] | None:
    paths = []
    explicit = os.environ.get("KF_PROFILE_KFD3_MANIFEST")
    if explicit:
        paths.append(Path(explicit))
    paths.append(Path(sys.executable).resolve().with_name("profile-kfd3.json"))
    seen = set()
    fallback = None
    for path in paths:
        resolved = path.expanduser().resolve()
        if resolved in seen or not resolved.is_file():
            continue
        seen.add(resolved)
        try:
            manifest = json.loads(resolved.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if manifest.get("schema") != KFD3_RELEASE_MANIFEST_SCHEMA:
            continue
        identity = {"schema": manifest["schema"], "entries": manifest.get("entries")}
        if manifest.get("manifestRoot") != _root(identity):
            continue
        for entry in manifest.get("entries") or []:
            if entry.get("profileId") != profile_id:
                continue
            receipt = dict(entry.get("receipt") or {})
            if entry.get("profileSuiteRoot") == profile_suite_root:
                return receipt
            fallback = receipt
    return fallback


def _validate_kfd3_receipt_integrity(receipt: Mapping[str, Any]) -> None:
    identity_keys = [
        "profileId",
        "profileSuiteRoot",
        "collaborationRoot",
        "closureRoot",
        "profileRevision",
        "runtimeContract",
        "qualificationSource",
        "authority",
        "surfaceInventory",
        "noBypass",
        "clientProbes",
        "knownLimits",
        "evidenceScope",
    ]
    identity = {key: receipt.get(key) for key in identity_keys}
    if receipt.get("receiptId") != _root(identity):
        raise ProfileSdkError(
            "kfd3-receipt-identity-invalid",
            "KFD-3 receipt id does not bind its qualification evidence",
        )
    witness = receipt.get("witness") or {}
    witness_identity = {
        "profileId": receipt.get("profileId"),
        "profileSuiteRoot": receipt.get("profileSuiteRoot"),
        "collaborationRoot": receipt.get("collaborationRoot"),
        "closureRoot": receipt.get("closureRoot"),
        "qualificationReceiptId": receipt.get("receiptId"),
        "authorityRegistryRoot": (receipt.get("authority") or {}).get("registryRoot"),
        "claim": "profile-collaboration-closure-qualified",
    }
    if witness.get("witnessId") != _root(witness_identity):
        raise ProfileSdkError(
            "kfd3-witness-identity-invalid",
            "KFD-3 witness id does not bind the receipt and authority roots",
        )


def kfd3_status(
    ops: Kfd3Operations, source: str | Path, runtime_dir: str | Path
) -> dict[str, Any]:
    """Return the machine-readable qualification state without running probes."""

    validated = ops.validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    closure = validated["collaboration"]
    profile_id = inspection["profile"]["id"]
    try:
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=profile_id, include_removed=True
        )
    except ValueError as error:
        if not str(error).startswith("Profile not found:"):
            raise
        state = None
    active_exact_root = bool(
        state
        and state.get("activated")
        and state.get("profile_suite_root") == inspection["profile_suite_root"]
    )
    receipt = (state or {}).get("kfd3_qualification") or {}
    if not receipt:
        receipt = (
            _release_qualification_receipt(profile_id, inspection["profile_suite_root"])
            or {}
        )
    base = {
        "schema": "kungfu.profile-kfd3-status/v1",
        "profileId": profile_id,
        "profileSuiteRoot": inspection["profile_suite_root"],
        "qualified": False,
        "current": False,
        "activeExactRoot": active_exact_root,
        "receiptId": receipt.get("receiptId"),
        "witnessId": (receipt.get("witness") or {}).get("witnessId"),
        "qualificationSource": receipt.get("qualificationSource"),
    }
    if not closure["declared"]:
        return {
            **base,
            "status": "failed",
            "reason": closure["reason"],
            "nextActions": [],
        }
    if not active_exact_root:
        return {
            **base,
            "status": "stale" if receipt else "untested",
            "reason": "Profile must be active at this exact root before KFD-3 qualification",
            "nextActions": [{"action": "profile.activate", "requiresApproval": True}],
        }
    if not receipt:
        release_only = bool(closure["intents"]) and all(
            (row.get("protocol") or {}).get("mode") == "shared-api"
            for row in closure["intents"]
        )
        return {
            **base,
            "status": "untested",
            "reason": (
                "No factory KFD-3 release receipt exists for this exact system Profile root"
                if release_only
                else "No KFD-3 qualification receipt exists for this exact Profile root"
            ),
            "nextActions": (
                [{"action": "product.verify-release", "requiresApproval": False}]
                if release_only
                else [
                    {"action": "profile.kfd3.plan", "requiresApproval": False},
                    {"action": "profile.kfd3.qualify", "requiresApproval": True},
                ]
            ),
        }
    try:
        _validate_sdk_value(
            "kfd3QualificationReceiptSchema",
            receipt,
            "stored KFD-3 qualification receipt",
        )
        _validate_kfd3_receipt_integrity(receipt)
    except ProfileSdkError as error:
        return {
            **base,
            "status": "failed",
            "reason": "Stored KFD-3 qualification receipt is invalid",
            "diagnosis": error.diagnosis,
            "nextActions": [{"action": "profile.kfd3.plan", "requiresApproval": False}],
        }
    authority = _agent_interface_authority()
    current = bool(
        receipt.get("profileId") == profile_id
        and receipt.get("profileSuiteRoot") == inspection["profile_suite_root"]
        and receipt.get("collaborationRoot") == closure["collaborationRoot"]
        and receipt.get("closureRoot") == closure["closureRoot"]
        and (receipt.get("authority") or {}).get("registryRoot")
        == authority["registryRoot"]
    )
    if not current:
        return {
            **base,
            "status": "stale",
            "reason": "Profile or KFD-3 Runtime contract changed after qualification",
            "nextActions": [
                {"action": "profile.kfd3.plan", "requiresApproval": False},
                {"action": "profile.kfd3.qualify", "requiresApproval": True},
            ],
        }
    return {
        **base,
        "status": "qualified",
        "qualified": True,
        "current": True,
        "issuer": {
            "type": receipt["qualificationSource"],
            "name": (
                "Kungfu release qualification"
                if receipt["qualificationSource"] == "release"
                else "Kungfu local qualification"
            ),
        },
        "policyVersion": "kfd3-profile-collaboration/v1",
        "runtimeContractRoot": authority["registryRoot"],
        "evidenceScope": receipt["evidenceScope"],
        "nextActions": [{"action": "profile.kfd3.verify", "requiresApproval": False}],
    }


def kfd3_qualification_plan(
    ops: Kfd3Operations, source: str | Path, runtime_dir: str | Path
) -> dict[str, Any]:
    """Describe the exact probes without executing or persisting them."""

    projection = ops.application(source, runtime_dir, include_qualification=False)
    if not projection["activeExactRoot"]:
        raise ProfileSdkError(
            "kfd3-active-root-required",
            "KFD-3 qualification requires the exact Profile root to be active",
        )
    identity = {
        "profileId": projection["profileId"],
        "profileSuiteRoot": projection["profileSuiteRoot"],
        "collaborationRoot": projection["collaborationRoot"],
        "closureRoot": projection["closureRoot"],
        "profileRevision": projection["profileRevision"],
        "runtimeContractRoot": _agent_interface_authority()["registryRoot"],
        "intentIds": sorted(row["id"] for row in projection["intents"]),
        "policyVersion": "kfd3-profile-collaboration/v1",
    }
    plan_id = _root(identity)
    card = ops.decision_card(
        "profile-kfd3-qualification",
        "Run the exact KFD-3 dual-client and no-bypass probes for this Profile root.",
        choices=["approve", "deny"],
        basis={"planId": plan_id, **identity},
        required_authority="workspace-profile-operator",
        resume_command="kungfu profile kfd3-authorize <source> --expected-plan-id <id> --choice approve --authorized-by <actor> --json",
    )
    return {
        "schema": KFD3_QUALIFICATION_PLAN_SCHEMA,
        "planId": plan_id,
        **identity,
        "probes": [
            "profile-content-closure",
            "application-authority",
            "public-surface-inventory",
            "custom-view-no-bypass",
            "dual-client-exact-plan",
        ],
        "sideEffects": ["append Kfd3Qualified lifecycle fact after all probes pass"],
        "requiresAuthorization": True,
        "decisionCard": card,
    }


def qualify_kfd3(
    ops: Kfd3Operations,
    source: str | Path,
    runtime_dir: str | Path,
    *,
    authorization_id: str = "kfd3-cli-explicit",
    qualification_source: str = "local",
) -> dict[str, Any]:
    """Run probes once and persist the earned receipt in the lifecycle journal."""

    status = kfd3_status(ops, source, runtime_dir)
    if status["qualified"]:
        if status.get("qualificationSource") == "release":
            receipt = _release_qualification_receipt(
                status["profileId"], status["profileSuiteRoot"]
            )
            if receipt:
                return receipt
        else:
            state = storage_service.profile_lifecycle(
                runtime_dir, "get", profile_id=status["profileId"]
            )
            return dict(state["kfd3_qualification"])
    receipt = _earn_kfd3(
        ops, source, runtime_dir, qualification_source=qualification_source
    )
    core_plan = ops.lifecycle_plan(
        runtime_dir, "kfd3-qualify", source, qualification=receipt
    )["corePlan"]
    ops.lifecycle_apply(runtime_dir, core_plan, authorization_id)
    return receipt


def authorize_kfd3_qualification(
    ops: Kfd3Operations,
    source: str | Path,
    runtime_dir: str | Path,
    expected_plan_id: str,
    choice: str,
    authorized_by: str,
) -> dict[str, Any]:
    """Execute one reviewed KFD-3 plan and persist its exact-root receipt."""

    plan = kfd3_qualification_plan(ops, source, runtime_dir)
    if plan["planId"] != expected_plan_id:
        raise ProfileSdkError(
            "kfd3-plan-stale",
            "Profile or Runtime contract changed after KFD-3 planning",
            expectedPlanId=expected_plan_id,
            actualPlanId=plan["planId"],
        )
    answer = ops.answer_decision(plan["decisionCard"], choice, authorized_by)
    if answer["choice"] != "approve":
        raise ProfileSdkError(
            "kfd3-qualification-denied", "KFD-3 qualification was denied"
        )
    return qualify_kfd3(
        ops,
        source,
        runtime_dir,
        authorization_id=answer["authorizationId"],
        qualification_source="local",
    )


def verify_kfd3(
    ops: Kfd3Operations,
    source: str | Path,
    runtime_dir: str | Path,
    receipt: Mapping[str, Any],
) -> dict[str, Any]:
    """Verify a supplied qualification receipt against the current earned cut."""

    _validate_sdk_value(
        "kfd3QualificationReceiptSchema",
        dict(receipt),
        "KFD-3 qualification receipt",
    )
    status = kfd3_status(ops, source, runtime_dir)
    if not status["qualified"]:
        raise ProfileSdkError(
            "kfd3-qualification-not-current",
            "Profile has no current KFD-3 qualification receipt",
            status=status,
        )
    if status.get("qualificationSource") == "release":
        current = _release_qualification_receipt(
            status["profileId"], status["profileSuiteRoot"]
        )
    else:
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=status["profileId"]
        )
        current = dict(state["kfd3_qualification"])
    if not current:
        raise ProfileSdkError(
            "kfd3-qualification-not-current",
            "Profile has no current KFD-3 qualification receipt",
        )
    if dict(receipt) != current:
        raise ProfileSdkError(
            "kfd3-qualification-stale-or-tampered",
            "qualification receipt does not match the current earned Profile cut",
            expectedReceiptId=current["receiptId"],
            actualReceiptId=receipt.get("receiptId"),
            expectedWitnessId=current["witness"]["witnessId"],
            actualWitnessId=(receipt.get("witness") or {}).get("witnessId"),
        )
    return {
        "schema": "kungfu.profile-kfd3-verification/v1",
        "profileId": current["profileId"],
        "profileSuiteRoot": current["profileSuiteRoot"],
        "receiptId": current["receiptId"],
        "witnessId": current["witness"]["witnessId"],
        "verified": True,
    }


def materialize_contract(
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
    answer: Mapping[str, Any] | None,
    *,
    contract_plan_schema: str,
    refresh: Callable[[str, str | Path], dict[str, Any]],
    fail: Callable[[str, str], NoReturn],
    validate_answer: Callable[[Mapping[str, Any], Mapping[str, Any]], None],
) -> dict[str, Any]:
    if plan.get("schema") != contract_plan_schema:
        fail(
            "contract-plan-invalid", "materialization requires a Profile contract plan"
        )
    refreshed = refresh(str(plan.get("source") or ""), runtime_dir)
    if refreshed["planId"] != plan.get("planId"):
        fail("contract-plan-stale", "Profile or Fact Library declarations changed")
    if refreshed["operations"]:
        if not isinstance(answer, Mapping):
            fail(
                "contract-authorization-required",
                "contract plan requires a decision answer",
            )
        card = plan.get("decisionCard") or {}
        validate_answer(answer, card)
        if answer.get("choice") != "approve" or (answer.get("basis") or {}).get(
            "planId"
        ) != plan.get("planId"):
            fail("decision-denied", "contract materialization was not approved")
    system_time = _native_system_time()
    receipts = []
    contract = dict(refreshed["contract"])
    world = contract["contractWorld"]
    current = storage_service.fact_type_list(runtime_dir)
    world_reference = next(
        (
            {"id": row["id"], "version": row["version"], "root": row["root"]}
            for row in current.get("contract_worlds") or []
            if row.get("id") == world["id"] and row.get("version") == world["version"]
        ),
        None,
    )
    for index, operation in enumerate(refreshed["operations"]):
        at = system_time + index
        if operation["kind"] == "declare-contract-world":
            receipt = storage_service.fact_declare_contract_world(
                runtime_dir,
                {
                    "id": world["id"],
                    "version": world["version"],
                    "effective_from": at,
                    "effective_until": 0,
                    "fact_surface_ids": world["factSurfaceIds"],
                },
                system_time=at,
            )
            receipts.append(receipt)
            world_reference = receipt["reference"]
        elif operation["kind"] == "declare-fact-surface":
            if world_reference is None:
                fail(
                    "contract-world-reference-missing",
                    "contract materialization requires the exact contract-world reference",
                )
            surface = next(
                row for row in contract["factSurfaces"] if row["id"] == operation["id"]
            )
            receipts.append(
                storage_service.fact_type_create(
                    runtime_dir,
                    {
                        "id": surface["id"],
                        "version": surface["version"],
                        "contract_world_id": surface["contractWorldId"],
                        "contract_world": world_reference,
                        "source_authorities": surface["sourceAuthorities"],
                        "schema": surface["schema"],
                        "effective_from": at,
                        "effective_until": 0,
                    },
                    system_time=at,
                )
            )
    return {
        "schema": "kungfu.profile-contract-receipt/v1",
        "planId": refreshed["planId"],
        "profileSuiteRoot": refreshed["profileSuiteRoot"],
        "catalogRoot": refreshed["catalogRoot"],
        "authorizationId": (answer or {}).get("authorizationId"),
        "status": "materialized" if receipts else "current",
        "receipts": receipts,
        "factCatalog": storage_service.fact_type_list(runtime_dir),
    }


def contract_operations(
    artifact: Mapping[str, Any],
    current: Mapping[str, Any],
    *,
    fail: Callable[..., NoReturn],
    root: Callable[[Any], str],
    admitted_sources: Mapping[tuple[str, str, str], set[str]],
) -> list[dict[str, str]]:
    world = artifact["contractWorld"]
    same_world = [
        row
        for row in current.get("contract_worlds") or []
        if row.get("id") == world["id"] and row.get("version") == world["version"]
    ]
    other_world = [
        row
        for row in current.get("contract_worlds") or []
        if row.get("id") == world["id"] and row.get("version") != world["version"]
    ]
    if len(same_world) > 1:
        fail("contract-world-ambiguous", "contract world is declared more than once")
    if not same_world and other_world:
        fail(
            "contract-version-migration-required",
            "another contract-world version exists; explicit migration is required",
            existingVersions=sorted(str(row.get("version")) for row in other_world),
            requestedVersion=world["version"],
        )
    if same_world:
        existing_surface_ids = set(same_world[0].get("fact_surface_ids") or [])
        declared_surface_ids = set(world["factSurfaceIds"])
        if existing_surface_ids != declared_surface_ids:
            # Contract-world declarations are immutable evidence. A later
            # Profile may retire a surface that never admitted a fact, but it
            # must not expand or replace the durable register in place.
            if not declared_surface_ids < existing_surface_ids:
                fail(
                    "contract-world-incompatible",
                    "existing contract world has another fact-surface register",
                )
            retired_with_facts = sorted(
                surface_id
                for surface_id in existing_surface_ids - declared_surface_ids
                if any(
                    key[0] == surface_id and key[2] == world["id"] and sources
                    for key, sources in admitted_sources.items()
                )
            )
            if retired_with_facts:
                fail(
                    "contract-world-surface-migration-required",
                    "removed fact surfaces retain admitted facts and require an explicit migration",
                    admittedFactSurfaces=retired_with_facts,
                )
    operations = []
    if not same_world:
        operations.append(
            {
                "kind": "declare-contract-world",
                "id": world["id"],
                "version": world["version"],
            }
        )
    current_types = current.get("fact_types") or []
    for surface in artifact["factSurfaces"]:
        same = [
            row
            for row in current_types
            if row.get("id") == surface["id"]
            and row.get("version") == surface["version"]
        ]
        other = [
            row
            for row in current_types
            if row.get("id") == surface["id"]
            and row.get("version") != surface["version"]
        ]
        if len(same) > 1:
            fail(
                "fact-surface-ambiguous",
                "fact surface is declared more than once",
                factSurface=surface["id"],
            )
        if not same and other:
            fail(
                "fact-surface-migration-required",
                "another fact-surface version exists; explicit migration is required",
                factSurface=surface["id"],
            )
        if same:
            row = same[0]
            contract = row.get("contract_world") or {}
            schema_root = root(surface["schema"])
            if (
                row.get("schema_owner_root") != schema_root
                or contract.get("id") != world["id"]
                or contract.get("version") != world["version"]
            ):
                fail(
                    "fact-surface-incompatible",
                    "existing fact surface differs from the Profile declaration",
                    factSurface=surface["id"],
                )
            declared_authorities = set(surface["sourceAuthorities"])
            existing_authorities = set(row.get("source_authorities") or [])
            if declared_authorities == existing_authorities:
                continue
            # Fact-surface declarations are immutable evidence. A later Profile may
            # retire an unused writer, but it must not reinterpret facts that writer
            # already admitted or widen the durable authority boundary in place.
            if not declared_authorities < existing_authorities:
                fail(
                    "fact-surface-incompatible",
                    "existing fact surface differs from the Profile declaration",
                    factSurface=surface["id"],
                )
            observed_authorities = admitted_sources.get(
                (surface["id"], schema_root, world["id"]),
                set(),
            )
            retired_with_facts = sorted(observed_authorities - declared_authorities)
            if retired_with_facts:
                fail(
                    "fact-surface-authority-migration-required",
                    "removed source authorities retain admitted facts and require an explicit migration",
                    factSurface=surface["id"],
                    admittedSourceAuthorities=retired_with_facts,
                )
        else:
            operations.append(
                {
                    "kind": "declare-fact-surface",
                    "id": surface["id"],
                    "version": surface["version"],
                }
            )
    return operations


def _native_system_time() -> int:
    return int(kungfu.__binding__.runtime.now_in_nano())
