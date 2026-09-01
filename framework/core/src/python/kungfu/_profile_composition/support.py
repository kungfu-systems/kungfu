# SPDX-License-Identifier: Apache-2.0

"""Private validation and evidence helpers for Profile composition."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping, NoReturn

from kungfu import kfx_contract, profile_sdk
from kungfu.storage import service as storage_service

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
    return _relocated_source_directory(state)


def _relocated_source_directory(state: Mapping[str, Any]) -> Path | None:
    """Resolve an identical bundled source after product-image replacement."""

    bundled_root = os.environ.get("KF_BUNDLED_EXTENSION_ROOT", "")
    profile_id = state.get("profile_id")
    profile_root = state.get("profile_suite_root")
    if bundled_root and isinstance(profile_id, str) and isinstance(profile_root, str):
        try:
            discovered = profile_sdk.discover_source(
                profile_id,
                search_roots=[bundled_root],
            )
            if discovered.get("profileSuiteRoot") == profile_root:
                return Path(discovered["source"]).expanduser().resolve()
        except (KeyError, profile_sdk.ProfileSdkError):
            pass
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
