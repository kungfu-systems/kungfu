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
from typing import Any, Mapping

from kungfu import profile_sdk
from kungfu.storage import service as storage_service


CATALOG_SCHEMA = "kungfu.profile-composition/v1"
QUERY_PLAN_SCHEMA = "kungfu.profile-query-plan/v1"
_GENERIC_VIEWS = {"table", "timeline", "diff", "causal-graph", "attention"}


def catalog(
    source: str | Path, runtime_dir: str | Path, *, require_active: bool = False
) -> dict[str, Any]:
    validated = profile_sdk.validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    profile = inspection["profile"]
    artifacts = {
        "factSurfaces": _merge_refs(
            inspection, profile["kfd1"]["factSurfaces"], "surfaces"
        ),
        "claims": _merge_refs(inspection, profile["kfd2"]["claims"], "claims"),
        "policies": _merge_refs(inspection, profile["kfd2"]["policies"], "policies"),
        "views": _read_ref(inspection, profile["views"]["registry"]).get("views"),
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


def query_plan(
    source: str | Path,
    runtime_dir: str | Path,
    view_id: str,
) -> dict[str, Any]:
    composed = catalog(source, runtime_dir, require_active=True)
    view = _by_id(composed["views"], view_id, "view")
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
    return {"schema": QUERY_PLAN_SCHEMA, "planId": _root(identity), **identity}


def execute_query(
    source: str | Path,
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
) -> dict[str, Any]:
    if plan.get("schema") != QUERY_PLAN_SCHEMA:
        _fail("query-plan-invalid", "execute requires a Profile query plan")
    refreshed = query_plan(
        source, runtime_dir, str((plan.get("view") or {}).get("id") or "")
    )
    if refreshed.get("planId") != plan.get("planId"):
        _fail("query-plan-stale", "Profile, lifecycle state or query plan changed")
    result = storage_service.fact_query_definition(
        runtime_dir, dict(refreshed["view"]["definition"])
    )
    return {
        "schema": "kungfu.profile-query-receipt/v1",
        "planId": refreshed["planId"],
        "profileSuiteRoot": refreshed["profileSuiteRoot"],
        "catalogRoot": refreshed["catalogRoot"],
        "viewId": refreshed["view"]["id"],
        "queryDefinitionRoot": result.get("query_definition_hash"),
        "queryProofRoot": (result.get("lineage") or {}).get("proof_hash"),
        "result": result,
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
        spec = view.get("view")
        if (
            not isinstance(definition, Mapping)
            or definition.get("schema") != "kungfu.query.definition/v1"
        ):
            _fail(
                "view-query-invalid", "view requires a QueryDefinition", view=view["id"]
            )
        refs = _strings(view.get("factSurfaces"), "view.factSurfaces")
        if not refs or set(refs) - surface_ids:
            _fail(
                "view-surface-unresolved",
                "view references unknown fact surfaces",
                view=view["id"],
            )
        if not isinstance(spec, Mapping) or spec.get("kind") not in _GENERIC_VIEWS:
            _fail(
                "view-spec-unsupported",
                "Profile composition requires a generic ViewSpec",
                view=view["id"],
            )


def _diagnostics(
    source: Mapping[str, Any], artifacts: Mapping[str, list[Any]]
) -> list[dict[str, Any]]:
    diagnostics = []
    packages = source.get("memberPackages") or {}
    for name, path in sorted(packages.items()):
        if not Path(str(path)).exists():
            diagnostics.append({"code": "member-unavailable", "member": name})
    if not artifacts["views"]:
        diagnostics.append({"code": "no-contributed-views", "severity": "info"})
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


def _merge_refs(
    inspection: Mapping[str, Any], refs: list[Mapping[str, Any]], field: str
) -> list[Any]:
    rows = []
    for ref in refs:
        value = _read_ref(inspection, ref).get(field)
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


def _root(value: Any) -> str:
    data = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _fail(code: str, message: str, **details: Any) -> None:
    raise profile_sdk.ProfileSdkError(code, message, **details)
