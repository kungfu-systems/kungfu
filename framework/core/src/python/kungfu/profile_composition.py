# SPDX-License-Identifier: Apache-2.0

"""Exact-root composition of Profile query, assessment and view declarations.

This application layer owns no facts, queries, assessments, lifecycle state or
view trust. It validates Profile-owned content against the installed contract
and delegates plans/execution to the existing Core authorities.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from kungfu import profile_sdk
from kungfu.profile_sdk_kfd3 import contract_operations, materialize_contract
from kungfu.storage import service as storage_service

SourcePath = str | Path
JsonObject = Mapping[str, Any]

CATALOG_SCHEMA = "kungfu.profile-composition/v1"
QUERY_PLAN_SCHEMA = "kungfu.profile-query-plan/v1"
RESOLVED_QUERY_PLAN_SCHEMA = "kungfu.profile-resolved-query-plan/v1"
ASSESSMENT_PLAN_SCHEMA = "kungfu.profile-assessment-plan/v1"
CONTRACT_PLAN_SCHEMA = "kungfu.profile-contract-plan/v1"
MANAGER_SCHEMA = "kungfu.profile-manager/v1"
_root = profile_sdk._root
_GENERIC_VIEWS = {"table", "timeline", "diff", "causal-graph", "attention"}
_PROFILE_VIEW_KEYS = {
    "kind",
    "profileId",
    "profileVersion",
    "memberId",
    "viewId",
    "spec",
}
_ARTIFACT_SCHEMA_KEYS = {
    "kungfu.profile-contract-world/v1": "contractWorldSchema",
    "kungfu.profile-fact-surfaces/v1": "factSurfacesSchema",
    "kungfu.profile-claims/v1": "claimsSchema",
    "kungfu.profile-assessment-policies/v1": "assessmentPoliciesSchema",
    "kungfu.profile-views/v1": "viewsSchema",
}


def catalog(
    source: str | Path, runtime_dir: str | Path, *, require_active: bool = False
) -> dict[str, Any]:
    validated = profile_sdk.validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    profile = inspection["profile"]
    views = _read_typed_ref(
        inspection,
        profile["views"]["registry"],
        "kungfu.profile-views/v1",
    ).get("views")
    if not isinstance(views, list):
        _fail("composition-artifact-invalid", "views must be an array")
    artifacts: dict[str, list[Any]] = {
        "factSurfaces": _merge_refs(
            inspection,
            profile["kfd1"]["factSurfaces"],
            "surfaces",
            "kungfu.profile-fact-surfaces/v1",
        ),
        "claims": _merge_refs(
            inspection,
            profile["kfd2"]["claims"],
            "claims",
            "kungfu.profile-claims/v1",
        ),
        "policies": _merge_refs(
            inspection,
            profile["kfd2"]["policies"],
            "policies",
            "kungfu.profile-assessment-policies/v1",
        ),
        "views": views,
    }
    for name, value in artifacts.items():
        if not isinstance(value, list):
            _fail("composition-artifact-invalid", f"{name} must be an array")
    _validate_artifacts(profile, artifacts)
    state = _profile_state(runtime_dir, profile["id"])
    active_exact = bool(
        state
        and state.get("activated")
        and state.get("profile_suite_root") == inspection["profile_suite_root"]
    )
    if require_active and not active_exact:
        _fail(
            "profile-not-active",
            "composition requires this exact Profile root to be active",
            profileId=profile["id"],
            profileSuiteRoot=inspection["profile_suite_root"],
        )
    payload = {
        "schema": CATALOG_SCHEMA,
        "profileId": profile["id"],
        "profileVersion": profile["version"],
        "profileSuiteRoot": inspection["profile_suite_root"],
        "profileRevision": state.get("revision") if state else None,
        "activeExactRoot": active_exact,
        "memberRoots": validated["source"]["memberRoots"],
        "purposes": profile["kfd2"]["purposes"],
        **artifacts,
        "diagnostics": _diagnostics(validated["source"], artifacts),
    }
    payload["catalogRoot"] = _root(payload)
    return payload


def manager(runtime_dir: str | Path) -> dict[str, Any]:
    """Project lifecycle and current source health without owning either."""

    lifecycle = storage_service.profile_lifecycle(
        runtime_dir, "list", include_removed=True
    )
    profiles = []
    for state in lifecycle.get("profiles") or []:
        source = _source_directory(state)
        projected = {
            "profileId": state.get("profile_id"),
            "profileVersion": state.get("profile_version"),
            "profileSuiteRoot": state.get("profile_suite_root"),
            "profileRevision": state.get("revision"),
            "lifecycleState": state.get("state"),
            "activated": bool(state.get("activated")),
            "removed": bool(state.get("removed")),
            "grantedPermissions": state.get("granted_permissions") or [],
            "qualification": state.get("qualification") or {},
            "availableRoots": state.get("available_roots", 0),
            "source": str(source) if source else None,
            "health": "removed" if state.get("removed") else "unavailable",
            "catalog": None,
            "diagnostics": [],
        }
        if state.get("removed"):
            projected["diagnostics"] = [
                _diagnostic(
                    "profile-removed",
                    "Profile lifecycle state is removed; facts remain intact.",
                )
            ]
        elif source is None:
            projected["diagnostics"] = [
                _diagnostic(
                    "profile-source-unavailable",
                    "Recorded Profile source package is no longer available.",
                )
            ]
        else:
            try:
                composed = catalog(source, runtime_dir)
                projected["catalog"] = composed
                projected["health"] = (
                    "active" if composed["activeExactRoot"] else "inactive"
                )
                projected["diagnostics"] = composed["diagnostics"]
            except profile_sdk.ProfileSdkError as error:
                projected["health"] = "degraded"
                projected["diagnostics"] = [error.diagnosis]
            except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
                projected["health"] = "degraded"
                projected["diagnostics"] = [
                    _diagnostic("profile-source-invalid", str(error))
                ]
        profiles.append(projected)
    return {
        "schema": MANAGER_SCHEMA,
        "lifecycleCommandContract": profile_sdk.lifecycle_command_contract(),
        "runtimeDir": lifecycle.get("runtime_dir", str(runtime_dir)),
        "cutSystemTime": lifecycle.get("cut_system_time", 0),
        "profiles": profiles,
        "count": len(profiles),
        "knownLimits": [
            "GUI focus is shell state and is not Profile activation.",
            "A removed Profile does not delete admitted facts.",
            "Mutation requires an exact plan and external decision authorization.",
        ],
    }


def query_plan(
    source: str | Path,
    runtime_dir: str | Path,
    view_id: str,
) -> dict[str, Any]:
    composed = catalog(source, runtime_dir, require_active=True)
    view = _by_id(composed["views"], view_id, "view")
    if "definition" not in view:
        _fail(
            "query-family-resolution-required",
            "view requires a member-resolved query definition",
            view=view_id,
        )
    core = storage_service.query_plan(
        runtime_dir, action="explain", definition=view["definition"]
    )
    identity = {
        "catalogRoot": composed["catalogRoot"],
        "profileSuiteRoot": composed["profileSuiteRoot"],
        "profileRevision": composed["profileRevision"],
        "view": view,
        "corePlan": core,
    }
    return {"schema": QUERY_PLAN_SCHEMA, "planId": _root(identity)} | identity


def resolved_query_plan(
    source: SourcePath,
    runtime_dir: SourcePath,
    view_id: str,
    resolution: JsonObject,
    require_active: bool = True,
) -> dict[str, Any]:
    """Bind one member-resolved QueryDefinition to an exact active family."""

    composed = catalog(source, runtime_dir, require_active=require_active)
    view = _by_id(composed["views"], view_id, "view")
    family = view.get("queryFamily")
    if not isinstance(family, Mapping):
        _fail("query-family-required", "view does not declare a runtime query family")
    _validate_query_resolution(family, resolution)
    member = str(family["member"])
    member_root = composed["memberRoots"].get(member)
    if not member_root:
        _fail(
            "query-resolver-member-unavailable",
            "query family resolver is not in the exact Suite closure",
            member=member,
        )
    definition = dict(resolution["definition"])
    _validate_resolved_definition(view, definition)
    core = storage_service.query_plan(
        runtime_dir, action="explain", definition=definition
    )
    normalized = {
        "schema": "kungfu.profile-query-resolution/v1",
        "familyId": family["id"],
        "bindings": dict(resolution["bindings"]),
        "definition": definition,
    }
    identity = {
        "catalogRoot": composed["catalogRoot"],
        "profileSuiteRoot": composed["profileSuiteRoot"],
        "profileRevision": composed["profileRevision"],
        "view": view,
        "resolverMember": member,
        "resolverMemberRoot": member_root,
        "resolution": normalized,
        "corePlan": core,
    }
    return {
        "schema": RESOLVED_QUERY_PLAN_SCHEMA,
        "planId": _root(identity),
        **identity,
    }


def execute_query(
    source: SourcePath,
    runtime_dir: SourcePath,
    plan: JsonObject,
    require_active: bool = True,
) -> dict[str, Any]:
    if plan.get("schema") not in {QUERY_PLAN_SCHEMA, RESOLVED_QUERY_PLAN_SCHEMA}:
        _fail("query-plan-invalid", "execute requires a Profile query plan")
    if plan.get("schema") == RESOLVED_QUERY_PLAN_SCHEMA:
        refreshed = resolved_query_plan(
            source,
            runtime_dir,
            str((plan.get("view") or {}).get("id") or ""),
            dict(plan.get("resolution") or {}),
            require_active=require_active,
        )
    else:
        refreshed = query_plan(
            source, runtime_dir, str((plan.get("view") or {}).get("id") or "")
        )
    if refreshed.get("planId") != plan.get("planId"):
        _fail("query-plan-stale", "Profile, lifecycle state or query plan changed")
    definition = (
        refreshed["resolution"]["definition"]
        if refreshed["schema"] == RESOLVED_QUERY_PLAN_SCHEMA
        else refreshed["view"]["definition"]
    )
    result = storage_service.fact_query_definition(runtime_dir, dict(definition))
    return {
        "schema": "kungfu.profile-query-receipt/v1",
        "planId": refreshed["planId"],
        "profileSuiteRoot": refreshed["profileSuiteRoot"],
        "catalogRoot": refreshed["catalogRoot"],
        "viewId": refreshed["view"]["id"],
        "queryDefinitionRoot": result.get("query_definition_root"),
        "queryProofRoot": result.get("query_proof_root"),
        "result": result,
    }


def compose_query_receipt(
    source: SourcePath,
    runtime_dir: SourcePath,
    view_id: str,
    receipts: Sequence[JsonObject],
    result: JsonObject,
    require_active: bool = True,
) -> dict[str, Any]:
    """Bind a domain reducer's composite result to exact public subreceipts."""

    if len(receipts) == 1:
        single_receipt = dict(receipts[0])
        if single_receipt.get("result") != result:
            _fail(
                "query-composition-result-mismatch",
                "single query receipt result changed during composition",
            )
        return single_receipt
    composed = catalog(source, runtime_dir, require_active=require_active)
    view = _by_id(composed["views"], view_id, "view")
    if not receipts:
        _fail("query-composition-empty", "query composition requires subreceipts")
    for subreceipt in receipts:
        if (
            subreceipt.get("schema") != "kungfu.profile-query-receipt/v1"
            or subreceipt.get("profileSuiteRoot") != composed["profileSuiteRoot"]
            or subreceipt.get("catalogRoot") != composed["catalogRoot"]
            or subreceipt.get("viewId") != view_id
        ):
            _fail(
                "query-composition-receipt-mismatch",
                "query subreceipt belongs to another Profile, catalog or view",
            )
    expected = sorted(
        (
            str(receipt.get("queryDefinitionRoot") or ""),
            str(receipt.get("queryProofRoot") or ""),
            str((receipt.get("result") or {}).get("result_hash") or ""),
        )
        for receipt in receipts
    )
    actual = sorted(
        (
            str(row.get("query_definition_root") or ""),
            str(row.get("query_proof_root") or ""),
            str(row.get("result_hash") or ""),
        )
        for row in (result.get("lineage") or {}).get("subqueries") or []
    )
    if expected != actual:
        _fail(
            "query-composition-proof-mismatch",
            "composite result does not bind every public subreceipt",
        )
    identity = {
        "profileSuiteRoot": composed["profileSuiteRoot"],
        "catalogRoot": composed["catalogRoot"],
        "view": view,
        "subreceiptPlanIds": [receipt.get("planId") for receipt in receipts],
        "queryDefinitionRoot": result.get("query_definition_root"),
        "queryProofRoot": result.get("query_proof_root"),
        "resultHash": result.get("result_hash"),
    }
    return {
        "schema": "kungfu.profile-query-receipt/v1",
        "planId": _root(identity),
        "profileSuiteRoot": composed["profileSuiteRoot"],
        "catalogRoot": composed["catalogRoot"],
        "viewId": view_id,
        "queryDefinitionRoot": result["query_definition_root"],
        "queryProofRoot": result["query_proof_root"],
        "result": dict(result),
        "subreceipts": [
            {
                "planId": receipt.get("planId"),
                "queryDefinitionRoot": receipt.get("queryDefinitionRoot"),
                "queryProofRoot": receipt.get("queryProofRoot"),
            }
            for receipt in receipts
        ],
    }


def assessment_plan(
    source: str | Path,
    runtime_dir: str | Path,
    query_receipt: Mapping[str, Any],
    *,
    claim_id: str,
    claim_instance_id: str | None = None,
    policy_id: str,
    purpose: str,
    work_episode_id: int,
    independent_observation: Mapping[str, Any] | None = None,
    executor_profile: str | None = None,
) -> dict[str, Any]:
    composed = catalog(source, runtime_dir, require_active=True)
    claim = _by_id(composed["claims"], claim_id, "claim")
    policy = _by_id(composed["policies"], policy_id, "assessment policy")
    if policy["claimId"] != claim_id or purpose not in policy["purposes"]:
        _fail(
            "assessment-binding-mismatch",
            "assessment policy does not bind the requested claim and purpose",
        )
    if query_receipt.get("schema") != "kungfu.profile-query-receipt/v1":
        _fail("query-receipt-invalid", "assessment requires a Profile query receipt")
    if (
        query_receipt.get("profileSuiteRoot") != composed["profileSuiteRoot"]
        or query_receipt.get("catalogRoot") != composed["catalogRoot"]
    ):
        _fail("query-receipt-stale", "query receipt belongs to another Profile cut")
    result = query_receipt.get("result") or {}
    if query_receipt.get("queryDefinitionRoot") != result.get(
        "query_definition_root"
    ) or query_receipt.get("queryProofRoot") != result.get("query_proof_root"):
        _fail(
            "query-receipt-root-mismatch",
            "Profile query receipt roots do not match the bound Core result",
        )
    lineage = result.get("lineage") or {}
    try:
        root = _episode_root(lineage, work_episode_id)
    except profile_sdk.ProfileSdkError:
        observation = independent_observation or {}
        if observation.get("relation") != "observed-work":
            raise
        root = _verified_runtime_episode_root(runtime_dir, work_episode_id)
        if observation.get("episodeRoot") != root:
            _fail(
                "independent-observation-root-mismatch",
                "independent work Episode root does not match Core verification",
                workEpisodeId=str(work_episode_id),
                verifiedEpisodeRoot=root,
            )
    missing = _missing_evidence(
        policy["requiredEvidence"],
        result,
        lineage,
        root,
        independent_observation,
    )
    if missing:
        _fail(
            "assessment-evidence-unavailable",
            "declared assessment evidence is not established at this cut",
            missingEvidence=missing,
            profileSuiteRoot=composed["profileSuiteRoot"],
            queryProofRoot=query_receipt.get("queryProofRoot"),
        )
    instance_id = str(claim_instance_id or claim["id"]).strip()
    if not instance_id:
        _fail("claim-instance-required", "assessment claim instance id is empty")
    executor = str(executor_profile or policy.get("executorProfile") or "thread")
    if executor not in {"inline", "thread", "process"}:
        _fail(
            "assessment-executor-invalid",
            "assessment executor profile must be inline, thread, or process",
        )
    request = {
        "claim_id": instance_id,
        "claim_type": claim["type"],
        "purpose": purpose,
        # Episode ids are uint64 in Core and can exceed the signed range used by
        # the Python/C++ JSON bridge. Their canonical API representation is text.
        "work_episode_id": str(work_episode_id),
        "work_episode_root": root,
        "query_definition_root": query_receipt["queryDefinitionRoot"],
        "query_proof_root": query_receipt["queryProofRoot"],
        "contract_world": lineage["contract_world_declaration"],
        "fact_surfaces": lineage["fact_surface_declarations"],
        "policy": {
            "id": policy["id"],
            "version": policy["version"],
            "root": _root(policy),
        },
        "evidence": _evidence_summary(result, lineage),
        "deadline": 0,
        "responsibility": policy["responsibility"],
        "residual_risks": policy["residualRisks"],
    }
    identity = {
        "catalogRoot": composed["catalogRoot"],
        "profileSuiteRoot": composed["profileSuiteRoot"],
        "profileRevision": composed["profileRevision"],
        "source": str(Path(source).resolve()),
        "queryReceipt": dict(query_receipt),
        "independentObservation": dict(independent_observation or {}),
        "claimTypeId": claim["id"],
        "claimInstanceId": instance_id,
        "request": request,
        "executorProfile": executor,
    }
    plan = {"schema": ASSESSMENT_PLAN_SCHEMA, "planId": _root(identity)} | identity
    plan["decisionCard"] = profile_sdk.decision_card(
        "profile-assessment-authorization",
        f"Authorize assessment of {instance_id} as {claim_id} for {purpose} at the exact query cut.",
        choices=["approve", "deny"],
        basis={
            "planId": plan["planId"],
            "profileSuiteRoot": composed["profileSuiteRoot"],
            "queryProofRoot": request["query_proof_root"],
        },
        required_authority="profile-assessment-operator",
        resume_command="answer this card, then run kungfu profile assess-run with the exact plan",
    )
    return plan


def authorized_assessment_execute(
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
    answer: Mapping[str, Any],
) -> dict[str, Any]:
    if plan.get("schema") != ASSESSMENT_PLAN_SCHEMA:
        _fail("assessment-plan-invalid", "assessment execution requires an exact plan")
    refreshed = assessment_plan(
        str(plan.get("source") or ""),
        runtime_dir,
        dict(plan.get("queryReceipt") or {}),
        claim_id=str(plan.get("claimTypeId") or ""),
        claim_instance_id=str(plan.get("claimInstanceId") or ""),
        policy_id=str(
            ((plan.get("request") or {}).get("policy") or {}).get("id") or ""
        ),
        purpose=str((plan.get("request") or {}).get("purpose") or ""),
        work_episode_id=int((plan.get("request") or {}).get("work_episode_id") or 0),
        independent_observation=dict(plan.get("independentObservation") or {}),
        executor_profile=str(plan.get("executorProfile") or "thread"),
    )
    if refreshed["planId"] != plan.get("planId"):
        _fail("assessment-plan-stale", "Profile or assessment inputs changed")
    card = plan.get("decisionCard") or {}
    profile_sdk.validate_decision_answer(answer, card)
    if answer.get("choice") != "approve" or (answer.get("basis") or {}).get(
        "planId"
    ) != plan.get("planId"):
        _fail("decision-denied", "assessment plan was not approved")
    requested = storage_service.assessment_request(runtime_dir, dict(plan["request"]))
    assessed = storage_service.assessment_execute(
        runtime_dir,
        requested["assessment_key"],
        executor_profile=str(plan["executorProfile"]),
    )
    return {
        "schema": "kungfu.profile-assessment-receipt/v1",
        "planId": plan["planId"],
        "authorizationId": answer["authorizationId"],
        "profileSuiteRoot": plan["profileSuiteRoot"],
        "catalogRoot": plan["catalogRoot"],
        "assessment": assessed,
    }


def contract_materialization_plan(
    source: SourcePath,
    runtime_dir: SourcePath,
    require_active: bool = True,
) -> dict[str, Any]:
    """Plan explicit KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03 declarations from one active Profile closure."""

    composed = catalog(source, runtime_dir, require_active=require_active)
    validated = profile_sdk.validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    artifact = _read_typed_ref(
        inspection,
        inspection["profile"]["kfd1"]["contractWorld"],
        "kungfu.profile-contract-world/v1",
    )
    _validate_contract_material(inspection["profile"], composed, artifact)
    current = storage_service.fact_type_list(runtime_dir)
    operations = contract_operations(
        artifact,
        current,
        fail=_fail,
        root=_root,
    )
    identity = {
        "source": str(Path(source).resolve()),
        "catalogRoot": composed["catalogRoot"],
        "profileSuiteRoot": composed["profileSuiteRoot"],
        "profileRevision": composed["profileRevision"],
        "factCatalogRoot": _root(current),
        "contract": artifact,
        "operations": operations,
    }
    plan = {
        "schema": CONTRACT_PLAN_SCHEMA,
        "planId": _root(identity),
        **identity,
        "requiresAuthorization": bool(operations),
    }
    if operations:
        plan["decisionCard"] = profile_sdk.decision_card(
            "profile-contract-materialization",
            "Authorize these exact Profile declarations in the workspace Fact Library.",
            choices=["approve", "deny"],
            basis={
                "planId": plan["planId"],
                "profileSuiteRoot": plan["profileSuiteRoot"],
                "factCatalogRoot": plan["factCatalogRoot"],
                "operations": operations,
            },
            required_authority="workspace-fact-contract-owner",
            resume_command="answer this card, then apply the exact Profile contract plan",
        )
    return plan


def authorized_contract_materialize(
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
    answer: Mapping[str, Any] | None,
) -> dict[str, Any]:
    return materialize_contract(
        runtime_dir,
        plan,
        answer,
        contract_plan_schema=CONTRACT_PLAN_SCHEMA,
        refresh=contract_materialization_plan,
        fail=_fail,
        validate_answer=profile_sdk.validate_decision_answer,
    )


from kungfu._profile_composition.support import (  # noqa: E402
    _episode_root as _episode_root,
    _verified_runtime_episode_root as _verified_runtime_episode_root,
    _source_directory as _source_directory,
    _diagnostic as _diagnostic,
    _missing_evidence as _missing_evidence,
    _evidence_summary as _evidence_summary,
    _validate_artifacts as _validate_artifacts,
    _is_supported_view_spec as _is_supported_view_spec,
    _validate_query_resolution as _validate_query_resolution,
    _validate_resolved_definition as _validate_resolved_definition,
    _validate_contract_material as _validate_contract_material,
    _diagnostics as _diagnostics,
    _read_ref as _read_ref,
    _read_typed_ref as _read_typed_ref,
    _merge_refs as _merge_refs,
    _profile_state as _profile_state,
    _unique_rows as _unique_rows,
    _by_id as _by_id,
    _strings as _strings,
    _fail as _fail,
)
