# SPDX-License-Identifier: Apache-2.0

"""Exact-root composition of Profile query, assessment and view declarations.

This application layer owns no facts, queries, assessments, lifecycle state or
view trust. It validates Profile-owned content against the installed contract
and delegates plans/execution to the existing Core authorities.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping, NoReturn, Sequence

from kungfu import kfx_contract, profile_sdk
from kungfu.profile_sdk_kfd3 import contract_operations, materialize_contract
from kungfu.storage import service as storage_service


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
    source: str | Path,
    runtime_dir: str | Path,
    view_id: str,
    resolution: Mapping[str, Any],
) -> dict[str, Any]:
    """Bind one member-resolved QueryDefinition to an exact active family."""

    composed = catalog(source, runtime_dir, require_active=True)
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
    source: str | Path,
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
) -> dict[str, Any]:
    if plan.get("schema") not in {QUERY_PLAN_SCHEMA, RESOLVED_QUERY_PLAN_SCHEMA}:
        _fail("query-plan-invalid", "execute requires a Profile query plan")
    if plan.get("schema") == RESOLVED_QUERY_PLAN_SCHEMA:
        refreshed = resolved_query_plan(
            source,
            runtime_dir,
            str((plan.get("view") or {}).get("id") or ""),
            dict(plan.get("resolution") or {}),
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
    source: str | Path,
    runtime_dir: str | Path,
    view_id: str,
    receipts: Sequence[Mapping[str, Any]],
    result: Mapping[str, Any],
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
    composed = catalog(source, runtime_dir, require_active=True)
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
    source: str | Path, runtime_dir: str | Path
) -> dict[str, Any]:
    """Plan explicit KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03 declarations from one active Profile closure."""

    composed = catalog(source, runtime_dir, require_active=True)
    validated = profile_sdk.validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    artifact = _read_typed_ref(
        inspection,
        inspection["profile"]["kfd1"]["contractWorld"],
        "kungfu.profile-contract-world/v1",
    )
    _validate_contract_material(inspection["profile"], composed, artifact)
    current = storage_service.fact_type_list(runtime_dir)
    fact_state = storage_service.fact_state(runtime_dir)
    admitted_sources: dict[tuple[str, str, str], set[str]] = {}
    for row in fact_state.get("observation_history") or []:
        if row.get("outcome") != "admitted":
            continue
        key = (
            str(row.get("fact_surface_id") or ""),
            str(row.get("schema_owner_root") or ""),
            str(row.get("contract_world_id") or ""),
        )
        source_id = str(row.get("source_id") or "")
        if all(key) and source_id:
            admitted_sources.setdefault(key, set()).add(source_id)
    operations = contract_operations(
        artifact,
        current,
        fail=_fail,
        root=_root,
        admitted_sources=admitted_sources,
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


def _episode_root(lineage: Mapping[str, Any], episode_id: int) -> str:
    for row in lineage.get("episode_content_roots") or []:
        if (
            str(row.get("episode_id")) != str(episode_id)
            or str(row.get("status")).lower() != "verified"
        ):
            continue
        computed = row.get("computed")
        if isinstance(computed, str) and computed.startswith("sha256:"):
            return computed
        if (
            isinstance(computed, Mapping)
            and computed.get("algorithm") == "sha256"
            and isinstance(computed.get("value"), str)
            and len(computed["value"]) == 64
        ):
            return "sha256:" + computed["value"]
    _fail(
        "work-episode-unverified",
        "selected work Episode has no verified content root at this query cut",
        workEpisodeId=episode_id,
        availableEpisodeRoots=lineage.get("episode_content_roots") or [],
    )


def _verified_runtime_episode_root(runtime_dir: str | Path, episode_id: int) -> str:
    verified = storage_service.fsck(
        runtime_dir, episode_id=episode_id, verify_frames=True
    )
    if not verified.get("ok"):
        _fail(
            "independent-work-episode-unverified",
            "independent work Episode failed Core frame verification",
            workEpisodeId=str(episode_id),
        )
    inspected = storage_service.episode_inspect(runtime_dir, episode_id=episode_id)
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
    _fail(
        "independent-work-episode-root-missing",
        "independent work Episode has no verified content root",
        workEpisodeId=str(episode_id),
    )


def _source_directory(state: Mapping[str, Any]) -> Path | None:
    closure = (state.get("latest_event") or {}).get("closure") or {}
    raw_profile_path = closure.get("profile_path")
    if not isinstance(raw_profile_path, str) or not raw_profile_path:
        return None
    profile_path = Path(raw_profile_path).expanduser().resolve()
    current = profile_path.parent
    for _ in range(16):
        manifest_path = current / kfx_contract.PACKAGE_MANIFEST_FILE
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            suite = (manifest.get("kungfuConfig") or {}).get("suite") or {}
            relative = suite.get("profile")
            if (
                isinstance(relative, str)
                and (current / relative).resolve() == profile_path
            ):
                return current
        except (OSError, json.JSONDecodeError, AttributeError):
            pass
        if current.parent == current:
            break
        current = current.parent
    return None


def _diagnostic(code: str, message: str) -> dict[str, Any]:
    return {
        "schema": profile_sdk.DIAGNOSIS_SCHEMA,
        "ok": False,
        "code": code,
        "message": message,
    }


def _missing_evidence(
    required: list[str],
    result: Mapping[str, Any],
    lineage: Mapping[str, Any],
    work_episode_root: str,
    independent_observation: Mapping[str, Any] | None,
) -> list[str]:
    missing = []
    if "query-proof" in required and not str(
        result.get("query_proof_root") or ""
    ).startswith("sha256:"):
        missing.append("query-proof")
    if "sealed-work-episode" in required and not work_episode_root.startswith(
        "sha256:"
    ):
        missing.append("sealed-work-episode")
    if "canonical-facts" in required and (
        not lineage.get("canonical_state") or int(result.get("row_count") or 0) == 0
    ):
        missing.append("canonical-facts")
    if "independent-observation" in required:
        observation = independent_observation or {}
        if (
            observation.get("episodeRoot") != work_episode_root
            or not str(observation.get("authority") or "").strip()
            or observation.get("relation") not in {"admitted-source", "observed-work"}
        ):
            missing.append("independent-observation")
    return missing


def _evidence_summary(
    result: Mapping[str, Any], lineage: Mapping[str, Any]
) -> dict[str, int]:
    counts = {
        "admitted": 0,
        "unregistered-surface": 0,
        "incompatible-schema": 0,
        "ambiguous-authority": 0,
    }
    for row in lineage.get("admission_outcomes") or []:
        outcome = str(row.get("outcome") or "")
        if outcome in counts:
            counts[outcome] += int(row.get("record_count") or 0)
    return {
        "canonical_fact_count": (
            int(result.get("row_count") or 0) if lineage.get("canonical_state") else 0
        ),
        "conflict_count": len(lineage.get("conflicts") or []),
        "admitted_count": counts["admitted"],
        "unregistered_surface_count": counts["unregistered-surface"],
        "incompatible_schema_count": counts["incompatible-schema"],
        "ambiguous_authority_count": counts["ambiguous-authority"],
        "unverifiable_count": len(lineage.get("unverifiable_inputs") or [])
        + len(lineage.get("missing_inputs") or []),
    }


def _validate_artifacts(
    profile: Mapping[str, Any], artifacts: Mapping[str, list[Any]]
) -> None:
    surfaces = _unique_rows(artifacts["factSurfaces"], "fact surface")
    claims = _unique_rows(artifacts["claims"], "claim")
    policies = _unique_rows(artifacts["policies"], "assessment policy")
    views = _unique_rows(artifacts["views"], "view")
    surface_ids, claim_ids = set(surfaces), set(claims)
    purposes = set(profile["kfd2"]["purposes"])
    for claim in claims.values():
        refs = _strings(claim.get("factSurfaces"), "claim.factSurfaces")
        if not refs or set(refs) - surface_ids:
            _fail(
                "claim-surface-unresolved",
                "claim references unknown fact surfaces",
                claim=claim["id"],
            )
    for policy in policies.values():
        if policy.get("claimId") not in claim_ids:
            _fail(
                "policy-claim-unresolved",
                "assessment policy references an unknown claim",
                policy=policy["id"],
            )
        policy_purposes = _strings(policy.get("purposes"), "policy.purposes")
        if not policy_purposes or set(policy_purposes) - purposes:
            _fail(
                "policy-purpose-unresolved",
                "assessment policy broadens declared purposes",
                policy=policy["id"],
            )
        _strings(policy.get("requiredEvidence"), "policy.requiredEvidence")
        _strings(policy.get("residualRisks"), "policy.residualRisks")
        if (
            not isinstance(policy.get("responsibility"), str)
            or not policy["responsibility"]
        ):
            _fail(
                "policy-responsibility-required",
                "assessment policy requires responsibility",
            )
    for view in views.values():
        definition = view.get("definition")
        family = view.get("queryFamily")
        spec = view.get("view")
        if isinstance(definition, Mapping):
            if definition.get("schema") != "kungfu.query.definition/v1":
                _fail(
                    "view-query-invalid",
                    "view requires a QueryDefinition",
                    view=view["id"],
                )
        elif isinstance(family, Mapping):
            members = set(
                profile["members"]["required"] + profile["members"]["optional"]
            )
            if family.get("member") not in members:
                _fail(
                    "query-resolver-member-unresolved",
                    "query family references an undeclared Suite member",
                    view=view["id"],
                )
            names = [row.get("name") for row in family.get("bindings") or []]
            if len(names) != len(set(names)):
                _fail(
                    "query-family-binding-duplicate",
                    "query family binding names must be unique",
                    view=view["id"],
                )
        else:
            _fail(
                "view-query-invalid",
                "view requires a QueryDefinition or query family",
                view=view["id"],
            )
        refs = _strings(view.get("factSurfaces"), "view.factSurfaces")
        if not refs or set(refs) - surface_ids:
            _fail(
                "view-surface-unresolved",
                "view references unknown fact surfaces",
                view=view["id"],
            )
        if not _is_supported_view_spec(spec):
            _fail(
                "view-spec-unsupported",
                "Profile composition requires a generic or Profile-owned ViewSpec",
                view=view["id"],
            )


def _is_supported_view_spec(spec: Any) -> bool:
    if not isinstance(spec, Mapping):
        return False
    if spec.get("kind") in _GENERIC_VIEWS:
        return True
    if spec.get("kind") != "profile" or set(spec) != _PROFILE_VIEW_KEYS:
        return False
    profile_spec = spec.get("spec")
    return all(
        isinstance(spec.get(key), str) and bool(spec[key])
        for key in ("profileId", "profileVersion", "memberId", "viewId")
    ) and (
        isinstance(profile_spec, Mapping)
        and isinstance(profile_spec.get("schema"), str)
        and bool(profile_spec["schema"])
    )


def _validate_query_resolution(
    family: Mapping[str, Any], resolution: Mapping[str, Any]
) -> None:
    if set(resolution) != {"schema", "familyId", "bindings", "definition"}:
        _fail(
            "query-resolution-invalid",
            "query resolution has an unexpected shape",
        )
    if (
        resolution.get("schema") != "kungfu.profile-query-resolution/v1"
        or resolution.get("familyId") != family.get("id")
        or not isinstance(resolution.get("bindings"), Mapping)
        or not isinstance(resolution.get("definition"), Mapping)
    ):
        _fail(
            "query-resolution-invalid",
            "query resolution does not bind the declared family",
        )
    declared = {str(row["name"]): row for row in family.get("bindings") or []}
    supplied = dict(resolution["bindings"])
    unknown = sorted(set(supplied) - set(declared))
    missing = sorted(
        name
        for name, row in declared.items()
        if row.get("required") and name not in supplied
    )
    invalid = []
    python_types = {"string": str, "integer": int, "boolean": bool}
    for name, value in supplied.items():
        expected = python_types.get(str(declared.get(name, {}).get("type") or ""))
        if expected is None or type(value) is not expected:
            invalid.append(name)
    if unknown or missing or invalid:
        _fail(
            "query-binding-invalid",
            "resolved bindings do not satisfy the query family",
            unknownBindings=unknown,
            missingBindings=missing,
            invalidBindings=sorted(invalid),
        )


def _validate_resolved_definition(
    view: Mapping[str, Any], definition: Mapping[str, Any]
) -> None:
    if definition.get("schema") != "kungfu.query.definition/v1":
        _fail(
            "resolved-query-definition-invalid",
            "query family must resolve a QueryDefinition",
        )
    basis = definition.get("basis") or {}
    declarations = basis.get("fact_surfaces") or []
    resolved = {
        str(row.get("id") or row.get("fact_surface_id") or "")
        for row in declarations
        if isinstance(row, Mapping)
    }
    resolved.discard("")
    declared = set(view.get("factSurfaces") or [])
    if not resolved or resolved != declared:
        _fail(
            "resolved-query-surface-mismatch",
            "resolved query must bind exactly the view fact surfaces",
            declaredFactSurfaces=sorted(declared),
            resolvedFactSurfaces=sorted(resolved),
        )


def _validate_contract_material(
    profile: Mapping[str, Any],
    composed: Mapping[str, Any],
    artifact: Mapping[str, Any],
) -> None:
    if artifact.get("profileId") != profile.get("id"):
        _fail(
            "contract-profile-mismatch",
            "contract material belongs to another Profile",
        )
    world = artifact["contractWorld"]
    declarations = _unique_rows(artifact["factSurfaces"], "contract fact surface")
    catalog_ids = {row["id"] for row in composed["factSurfaces"]}
    if set(world["factSurfaceIds"]) != catalog_ids or set(declarations) != catalog_ids:
        _fail(
            "contract-surface-mismatch",
            "contract material must bind every declared Profile fact surface exactly once",
        )
    for surface in declarations.values():
        if surface["contractWorldId"] != world["id"]:
            _fail(
                "contract-world-mismatch",
                "fact surface points at another contract world",
                factSurface=surface["id"],
            )


def _diagnostics(
    source: Mapping[str, Any], artifacts: Mapping[str, list[Any]]
) -> list[dict[str, Any]]:
    diagnostics = []
    packages = source.get("memberPackages") or {}
    for name, path in sorted(packages.items()):
        if not Path(str(path)).exists():
            diagnostics.append(
                {
                    **_diagnostic(
                        "member-unavailable",
                        "Declared KFX member package is no longer available.",
                    ),
                    "member": name,
                }
            )
    if not artifacts["views"]:
        diagnostics.append(
            {
                "schema": profile_sdk.DIAGNOSIS_SCHEMA,
                "ok": True,
                "code": "no-contributed-views",
                "message": "Profile does not contribute a generic ViewSpec.",
                "severity": "info",
            }
        )
    return diagnostics


def _read_ref(inspection: Mapping[str, Any], ref: Mapping[str, Any]) -> dict[str, Any]:
    root = Path(str(inspection["profile_path"])).parent.resolve()
    path = (root / str(ref["path"])).resolve()
    if root not in path.parents:
        _fail("composition-path-escape", "Profile artifact escapes its source root")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != ref["sha256"]:
        _fail(
            "composition-content-drift",
            "Profile artifact no longer matches its content ref",
            path=str(path),
        )
    value = json.loads(data)
    if not isinstance(value, dict):
        _fail(
            "composition-artifact-invalid",
            "Profile artifact must be an object",
            path=str(path),
        )
    return value


def _read_typed_ref(
    inspection: Mapping[str, Any], ref: Mapping[str, Any], schema: str
) -> dict[str, Any]:
    value = _read_ref(inspection, ref)
    if value.get("schema") != schema:
        _fail(
            "composition-schema-unsupported",
            f"Profile artifact must use {schema}",
            observed=value.get("schema"),
        )
    profile_sdk.validate_contract_artifact(
        _ARTIFACT_SCHEMA_KEYS[schema], value, f"Profile composition artifact {schema}"
    )
    return value


def _merge_refs(
    inspection: Mapping[str, Any],
    refs: list[Mapping[str, Any]],
    field: str,
    schema: str,
) -> list[Any]:
    rows: list[Any] = []
    for ref in refs:
        value = _read_typed_ref(inspection, ref, schema).get(field)
        if not isinstance(value, list):
            _fail(
                "composition-artifact-invalid",
                f"Profile artifact requires {field} array",
            )
        rows.extend(value)
    return rows


def _profile_state(runtime_dir: str | Path, profile_id: str) -> dict[str, Any]:
    try:
        return storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=profile_id
        )
    except (RuntimeError, ValueError):
        return {}


def _unique_rows(rows: list[Any], label: str) -> dict[str, Mapping[str, Any]]:
    result = {}
    for row in rows:
        if (
            not isinstance(row, Mapping)
            or not isinstance(row.get("id"), str)
            or not row["id"]
        ):
            _fail("composition-entry-invalid", f"{label} requires an id")
        if row["id"] in result:
            _fail("composition-entry-duplicate", f"duplicate {label} id", id=row["id"])
        result[row["id"]] = row
    return result


def _by_id(rows: list[Any], identity: str, label: str) -> Mapping[str, Any]:
    result = _unique_rows(rows, label).get(identity)
    if result is None:
        _fail(f"{label}-not-found", f"Profile {label} not found: {identity}")
    return result


def _strings(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item for item in value
    ):
        _fail("composition-entry-invalid", f"{label} must be a string array")
    return value


def _fail(code: str, message: str, **details: Any) -> NoReturn:
    raise profile_sdk.ProfileSdkError(code, message, **details)
