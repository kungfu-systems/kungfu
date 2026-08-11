# SPDX-License-Identifier: Apache-2.0

"""Skill dependency projections and thin KFX/Profile/Work authority composition.

This module owns no package, trust, capability, Profile, or Work decision. It
joins exact Skill coordinates to decisions returned by the Core-native KFX
registry and Profile action runtime, then roots one plan and receipt for every
product surface.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from kungfu import kfx_contract, profile_sdk
from kungfu.canonical_json import canonical_json_bytes
from kungfu.skill import contract as skill_contract
from kungfu.skill.contract import (
    validate_dependency_plan_v2,
    validate_dependency_receipt_v2,
)
from kungfu.skill.registry import inspect_registry, registry_root
from kungfu.storage import service as storage_service


DEPENDENCY_SCHEMA = "kungfu.skill-dependencies/v1"


def skill_binding_root(home):
    return os.path.join(home, "skill-bindings")


def skill_binding_path(home, skill_key):
    return os.path.join(skill_binding_root(home), f"{skill_key}.json")


def build_skill_dependency_binding(home, skill):
    rows = [_dependency_row(home, skill, dep) for dep in skill.get("kfx", [])]
    resolved = sum(1 for row in rows if row["status"] == "resolved")
    binding = {
        "schema": DEPENDENCY_SCHEMA,
        "skill": {
            "key": skill["key"],
            "title": skill["title"],
            "kind": skill["kind"],
            "sourceHash": skill["source"]["hash"],
            "sourcePath": skill["source"]["path"],
        },
        "registry": {
            "type": "kfx",
            "root": _kfx_registry_root(home),
        },
        "dependencies": rows,
        "summary": {
            "total": len(rows),
            "resolved": resolved,
            "unresolved": len(rows) - resolved,
        },
    }
    skill_contract.validate_dependencies(binding)
    return binding


def write_skill_dependency_binding(home, skill):
    document = build_skill_dependency_binding(home, skill)
    path = skill_binding_path(home, skill["key"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(document, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    return path, document


def read_skill_dependency_binding(home, skill_key):
    path = skill_binding_path(home, skill_key)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _dependency_row(home, skill, dep):
    key = str(dep["key"])
    package_dir = os.path.join(_kfx_registry_root(home), key)
    resolved = _resolve_kfx_package(package_dir, key)
    version = dep.get("version")
    if version is not None:
        version = str(version)
    status = "resolved" if resolved else "unresolved"
    reason = None
    if resolved and version and resolved.get("version") != version:
        status = "unresolved"
        reason = f"installed version {resolved.get('version')} does not match {version}"
    elif not resolved:
        reason = "not installed in kfx registry"
    row = {
        "skillKey": skill["key"],
        "kfxKey": key,
        "role": dep.get("role"),
        "version": version,
        "required": _bool(dep.get("required"), True),
        "status": status,
        "registryKey": key,
        "registryPath": package_dir,
    }
    for extra_key, extra_value in sorted(dep.items()):
        if extra_key not in {"key", "role", "version", "required"}:
            row[extra_key] = extra_value
    if resolved:
        row["package"] = resolved
    if reason:
        row["reason"] = reason
    return row


def _resolve_kfx_package(package_dir, expected_key):
    return kfx_contract.resolve_kfx_package(package_dir, expected_key)


def _kfx_registry_root(home):
    return os.path.join(home, "extensions")


def _bool(value, default):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "yes", "1"}:
            return True
        if normalized in {"false", "no", "0"}:
            return False
    return default


PLAN_SCHEMA = "kungfu.skill-dependency-plan/v2"
RECEIPT_SCHEMA = "kungfu.skill-dependency-invocation-receipt/v2"
AUDIT_EVENT_SCHEMA = "kungfu.skill-audit-event/v1"
SURFACES = ("agent", "cli", "gui", "tui")


class SkillAuthorityError(ValueError):
    """Stable refusal at the Skill-to-authority composition edge."""

    def __init__(self, code: str, message: str, recovery: str) -> None:
        self.code = code
        self.recovery = recovery
        super().__init__(message)


def plan_dependency_invocation(
    home: str | Path,
    runtime_dir: str | Path,
    key: str,
    *,
    work_ref: str,
    work_root: str,
    cut_root: str,
    policy_root: str,
    host: str,
    kfx_request: Mapping[str, Any] | None = None,
    profile_sources: Mapping[str, str | Path] | None = None,
    profile_inputs: Mapping[str, Any] | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Join one selected Skill to exact native authority decisions, read-only."""

    for label, value in (
        ("work-root-invalid", work_root),
        ("cut-root-invalid", cut_root),
        ("policy-root-invalid", policy_root),
    ):
        _require_root(value, label)
    if not work_ref or not host:
        raise SkillAuthorityError(
            "KF_SKILL_INVOCATION_CONTEXT_INCOMPLETE",
            "Work reference and host are required",
            "rebuild the plan with one exact Work reference and target host",
        )

    report = inspect_registry(home, key)
    entry = report["entries"][key]
    revision = entry.get("activeRevision")
    if revision is None or not entry.get("activeReference"):
        raise SkillAuthorityError(
            "KF_SKILL_NOT_ACTIVE",
            f"Skill {key!r} has no active immutable revision",
            "install or roll back to an exact retained Skill revision",
        )
    selected = next(
        (
            row
            for row in entry.get("workSelections", [])
            if row.get("active")
            and row.get("workRef") == work_ref
            and row.get("workRoot") == work_root
            and row.get("revision") == revision
        ),
        None,
    )
    if selected is None:
        raise SkillAuthorityError(
            "KF_SKILL_WORK_SELECTION_MISMATCH",
            "Skill invocation is not selected for this exact Work root",
            "create and apply a fresh Skill select plan with the exact Work root",
        )
    record = entry["revisions"][str(revision)]
    definition_path = registry_root(home) / record["definitionRef"]
    definition = _read_json(definition_path)
    dependencies = definition["dependencies"]
    skill_identity = {
        "key": key,
        "revision": revision,
        "contentRoot": record["contentRoot"],
        "definitionRoot": record["definitionRoot"],
        "class": record["class"],
    }

    kfx_plan: dict[str, Any] | None = None
    kfx_rows: list[dict[str, Any]] = []
    if dependencies["kfx"]:
        request = copy.deepcopy(
            dict(kfx_request)
            if kfx_request is not None
            else {
                "roots": [
                    {"kind": "user", "path": str(Path(home).resolve() / "extensions")}
                ]
            }
        )
        try:
            kfx_plan = storage_service.kfx_registry("plan", request, runtime_dir)
        except (OSError, RuntimeError, TypeError, ValueError) as error:
            kfx_rows = [
                _dependency_refusal(
                    "kfx",
                    row,
                    "KF_SKILL_KFX_AUTHORITY_UNAVAILABLE",
                    str(error),
                    "restore the Core-native KFX registry and build a fresh plan",
                )
                for row in dependencies["kfx"]
            ]
        else:
            kfx_rows = [
                _resolve_kfx_dependency(row, kfx_plan, host, cut_root, policy_root)
                for row in dependencies["kfx"]
            ]

    profile_sources = profile_sources or {}
    profile_inputs = profile_inputs or {}
    profile_rows = [
        _resolve_profile_dependency(
            row,
            runtime_dir,
            profile_sources,
            profile_inputs,
        )
        for row in dependencies["profiles"]
    ]

    all_rows = [*kfx_rows, *profile_rows]
    required_refusals = [
        row for row in all_rows if row["required"] and row["status"] != "available"
    ]
    optional_refusals = [
        row for row in all_rows if not row["required"] and row["status"] != "available"
    ]
    instruction_only = record["class"] == "instruction-only"
    if instruction_only:
        decision = {
            "status": "inert",
            "code": "KF_SKILL_INSTRUCTION_ONLY_INERT",
            "executionAllowed": False,
            "recovery": "load rooted instructions only; add a new reviewed Skill revision to request execution",
        }
    elif required_refusals:
        first = required_refusals[0]
        decision = {
            "status": "refused",
            "code": first["code"],
            "executionAllowed": False,
            "recovery": first["recovery"],
        }
    else:
        decision = {
            "status": "degraded" if optional_refusals else "ready",
            "code": (
                "KF_SKILL_OPTIONAL_DEPENDENCY_DEGRADED"
                if optional_refusals
                else "KF_SKILL_DEPENDENCIES_ADMITTED"
            ),
            "executionAllowed": True,
            "recovery": (
                "invoke without optional dependencies or repair them and rebuild the plan"
                if optional_refusals
                else "invoke with this exact plan root"
            ),
        }

    capability_basis = [
        {
            "kind": row["kind"],
            "key": row["key"],
            "authorizationRoot": row.get("authorizationRoot"),
            "capabilityGrantRoot": row.get("capabilityGrantRoot"),
            "requested": row.get("requestedCapabilities", []),
            "status": row["status"],
        }
        for row in all_rows
    ]
    trust_roots = sorted(
        {str(row["trustReportRoot"]) for row in all_rows if row.get("trustReportRoot")}
    )
    base = {
        "schema": PLAN_SCHEMA,
        "skill": skill_identity,
        "work": {"ref": work_ref, "root": work_root},
        "authority": {
            "skillRegistryRoot": report["stateRoot"],
            "kfxPlanRoot": kfx_plan.get("planRoot") if kfx_plan else None,
            "kfxGraphRoot": kfx_plan.get("graphRoot") if kfx_plan else None,
            "profileAuthority": "core-profile-lifecycle-and-action-runtime",
            "policyRoot": policy_root,
            "cutRoot": cut_root,
            "host": host,
            "trustReportRoots": trust_roots,
            "capabilityDecisionRoot": _root(capability_basis),
        },
        "dependencies": {"kfx": kfx_rows, "profiles": profile_rows},
        "effects": copy.deepcopy(definition["effects"]),
        "decision": decision,
        "runId": run_id,
        "nonClaims": [
            "skill-prose-is-not-capability",
            "skill-source-or-provenance-is-not-trust",
            "skill-does-not-grant-product-system-identity",
            "skill-plan-is-not-work-completion",
            "skill-plan-does-not-own-kfx-or-profile-state",
        ],
    }
    plan_root = _root(base)
    audit_identity_root = _root(
        {
            "schema": "kungfu.skill-dependency-audit-identity/v2",
            "planRoot": plan_root,
            "skill": skill_identity,
            "work": base["work"],
            "runId": run_id,
        }
    )
    result = {
        **base,
        "planRoot": plan_root,
        "auditIdentityRoot": audit_identity_root,
    }
    result["surfaceProjections"] = _surface_projections(result)
    validate_dependency_plan_v2(result)
    return result


def invoke_dependency_plan(
    home: str | Path,
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
    *,
    expected_plan_root: str,
    profile_answers: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Reverify native authorizations and invoke admitted Profile actions."""

    plan = copy.deepcopy(dict(plan))
    _verify_plan(plan, expected_plan_root)
    _verify_current_skill_selection(home, plan)
    decision = plan["decision"]
    if not decision.get("executionAllowed"):
        raise SkillAuthorityError(
            str(decision["code"]),
            "Skill dependency plan refused invocation",
            str(decision["recovery"]),
        )

    native_decisions = []
    for row in plan["dependencies"]["kfx"]:
        if row["status"] != "available":
            continue
        request = {
            "packageKey": row["key"],
            "host": plan["authority"]["host"],
            "expectedCutRoot": row["cutRoot"],
            "expectedRevision": row["nativeRevision"],
            "expectedGenerationRoot": row["generationRoot"],
            "expectedPackageRoot": row["root"],
            "expectedCapabilityGrantRoot": row["capabilityGrantRoot"],
            "expectedAuthorizationRoot": row["authorizationRoot"],
            "expectedGrantedCapabilities": row["grantedCapabilities"],
        }
        try:
            decision_result = storage_service.kfx_registry(
                "authorize-host", request, runtime_dir
            )
        except (OSError, RuntimeError, TypeError, ValueError) as error:
            raise SkillAuthorityError(
                "KF_SKILL_KFX_AUTHORIZATION_STALE",
                f"Core rejected the exact KFX authorization for {row['key']}: {error}",
                "rebuild the dependency plan from the current KFX cut",
            ) from error
        if not decision_result.get("executionAllowed"):
            raise SkillAuthorityError(
                "KF_SKILL_KFX_AUTHORIZATION_REVOKED",
                f"Core revoked KFX authorization for {row['key']}",
                "rebuild the dependency plan from the current KFX cut",
            )
        observed_authorization = decision_result.get("authorization")
        if isinstance(observed_authorization, Mapping) and any(
            observed_authorization.get(field) != expected
            for field, expected in (
                ("cutRoot", row["cutRoot"]),
                ("revision", row["nativeRevision"]),
                ("generationRoot", row["generationRoot"]),
                ("packageRoot", row["root"]),
                ("capabilityGrantRoot", row["capabilityGrantRoot"]),
                ("authorizationRoot", row["authorizationRoot"]),
                ("grantedCapabilities", row["grantedCapabilities"]),
            )
        ):
            raise SkillAuthorityError(
                "KF_SKILL_KFX_AUTHORIZATION_STALE",
                f"Core returned changed KFX authorization identity for {row['key']}",
                "discard the receipt and rebuild from the current KFX cut",
            )
        native_decisions.append(
            {
                "mode": "authorized-host-dispatch",
                "request": request,
                "decision": decision_result,
            }
        )

    profile_answers = profile_answers or {}
    profile_receipts = []
    for row in plan["dependencies"]["profiles"]:
        if row["status"] != "available":
            continue
        for contribution in row["contributions"]:
            profile_plan = contribution["plan"]
            answer_key = f"{row['key']}:{contribution['id']}"
            try:
                receipt = profile_sdk.authorized_action_invoke(
                    runtime_dir, profile_plan, profile_answers.get(answer_key)
                )
            except (OSError, RuntimeError, TypeError, ValueError) as error:
                raise SkillAuthorityError(
                    "KF_SKILL_PROFILE_INVOCATION_REFUSED",
                    f"Profile contribution {answer_key} refused invocation: {error}",
                    "inspect the retained Profile evidence and build a fresh plan",
                ) from error
            if not receipt.get("verified"):
                raise SkillAuthorityError(
                    "KF_SKILL_PROFILE_INVOCATION_REFUSED",
                    f"Profile contribution {answer_key} was not verified",
                    "inspect the retained Profile receipt and build a fresh plan",
                )
            profile_receipts.append(
                {
                    "profile": row["key"],
                    "contribution": contribution["id"],
                    "receipt": receipt,
                }
            )

    receipt = {
        "schema": RECEIPT_SCHEMA,
        "planRoot": expected_plan_root,
        "skill": copy.deepcopy(plan["skill"]),
        "work": copy.deepcopy(plan["work"]),
        "authority": copy.deepcopy(plan["authority"]),
        "nativeAuthorizationDecisions": native_decisions,
        "profileReceipts": profile_receipts,
        "auditIdentityRoot": plan["auditIdentityRoot"],
        "status": "verified",
        "kfxInvocationBoundary": "authorized-host-dispatch",
        "selectionLoadOrInvocationIsCompletion": False,
    }
    receipt["receiptRoot"] = _root(receipt)
    receipt["surfaceProjections"] = _surface_projections(receipt)
    validate_dependency_receipt_v2(receipt)
    return receipt


def dependency_audit_event(
    value: Mapping[str, Any], *, event_type: str, run_id: str | None = None
) -> dict[str, Any]:
    """Build metadata-only durable evidence for plans, refusals, and receipts."""

    event = {
        "schema": AUDIT_EVENT_SCHEMA,
        "type": event_type,
        "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "run_id": run_id,
        "skill": copy.deepcopy(value.get("skill")),
        "work": copy.deepcopy(value.get("work")),
        "planRoot": value.get("planRoot"),
        "receiptRoot": value.get("receiptRoot"),
        "auditIdentityRoot": value.get("auditIdentityRoot"),
        "decision": copy.deepcopy(value.get("decision")),
        "authorityRoots": copy.deepcopy(value.get("authority")),
        "payloadsPersisted": False,
    }
    event["eventRoot"] = _root(event)
    return event


def _resolve_kfx_dependency(
    dependency: Mapping[str, Any],
    native: Mapping[str, Any],
    host: str,
    cut_root: str,
    policy_root: str,
) -> dict[str, Any]:
    key = str(dependency["key"])
    package = next(
        (row for row in native.get("packages", []) if row.get("key") == key), None
    )
    if package is None:
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_MISSING",
            "package is absent from the Core-native KFX registry plan",
            f"install and admit exact KFX {key}, then rebuild the Skill plan",
        )
    if package.get("packageRoot") != dependency["root"]:
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_ROOT_STALE",
            "installed package root differs from the declared Skill coordinate",
            "publish a new Skill revision or restore the declared KFX root",
        )
    descriptor = native.get("hostContract") or {}
    observed_revision = descriptor.get("revision", native.get("revision"))
    if observed_revision != dependency["revision"]:
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_REVISION_INCOMPATIBLE",
            f"Core registry revision is {observed_revision!r}",
            "bind the exact current KFX revision in a new Skill revision",
        )
    compatibility = package.get("apiCompatibility") or {}
    if compatibility.get("compatible") is False:
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_INCOMPATIBLE",
            "Core reported an incompatible KFX contract",
            "install a contract-compatible KFX revision",
        )
    authorization = next(
        (
            row
            for row in descriptor.get("runtimeAuthorizations", [])
            if row.get("packageKey") == key and row.get("host") == host
        ),
        None,
    )
    if authorization is None:
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_HOST_UNAVAILABLE",
            f"no Core host authorization exists for {host}",
            "choose an admitted declared host or repair KFX placement",
        )
    if authorization.get("packageRoot") != dependency["root"]:
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_AUTHORIZATION_STALE",
            "host authorization binds another package root",
            "rebuild native KFX admission for the exact package root",
        )
    if authorization.get("revision") != observed_revision:
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_AUTHORIZATION_STALE",
            "host authorization binds another native registry revision",
            "rebuild native KFX admission from the current registry revision",
        )
    generation_root = descriptor.get("generationRoot")
    if authorization.get("generationRoot") != generation_root or not _is_root(
        generation_root
    ):
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_AUTHORIZATION_STALE",
            "host authorization does not bind the current native generation",
            "rebuild native KFX admission from the current generation",
        )
    state = str(descriptor.get("admission", {}).get("state"))
    if state == "revoked":
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_REVOKED",
            "Core-native KFX admission is revoked",
            "resolve the revocation and obtain a fresh Fact cut",
        )
    if authorization.get("policyRoot") != policy_root:
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_POLICY_MISMATCH",
            "KFX authorization does not bind the requested Core policy root",
            "rebuild admission under the exact current Core policy",
        )
    if authorization.get("cutRoot") != cut_root:
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_CUT_MISMATCH",
            "KFX authorization does not bind the requested Fact cut",
            "rebuild admission at the exact current cut",
        )
    requested = sorted(dependency.get("capabilityRequests", []))
    declared = set(package.get("declaredCapabilities", []))
    granted = set(authorization.get("grantedCapabilities", []))
    if not set(requested).issubset(declared) or not set(requested).issubset(granted):
        return _dependency_refusal(
            "kfx",
            dependency,
            "KF_SKILL_KFX_CAPABILITY_CONFLICT",
            "requested capability is undeclared or ungranted",
            "reduce the Skill request or obtain a separate exact KFX capability grant",
        )
    if not authorization.get("executionAllowed"):
        code = (
            "KF_SKILL_KFX_UNTRUSTED"
            if package.get("admissionGrade") in {"refused", "untrusted"}
            else "KF_SKILL_KFX_AUTHORIZATION_REQUIRED"
        )
        return _dependency_refusal(
            "kfx",
            dependency,
            code,
            "Core-native KFX authority refused execution",
            "satisfy the reported trust, Work/Warrant, and capability gates; never elevate from Skill prose",
        )
    return {
        "kind": "kfx",
        "key": key,
        "revision": dependency["revision"],
        "root": dependency["root"],
        "required": dependency["required"],
        "status": "available",
        "code": "KF_SKILL_KFX_ADMITTED",
        "requestedCapabilities": requested,
        "grantedCapabilities": sorted(granted),
        "nativeRevision": observed_revision,
        "generationRoot": generation_root,
        "cutRoot": authorization.get("cutRoot"),
        "authorizationRoot": authorization.get("authorizationRoot"),
        "capabilityGrantRoot": authorization.get("capabilityGrantRoot"),
        "trustReportRoot": authorization.get("reportRoot"),
        "recovery": "rebuild the plan if any authority root changes",
    }


def _resolve_profile_dependency(
    dependency: Mapping[str, Any],
    runtime_dir: str | Path,
    profile_sources: Mapping[str, str | Path],
    profile_inputs: Mapping[str, Any],
) -> dict[str, Any]:
    profile_id = str(dependency["id"])
    try:
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=profile_id
        )
    except (OSError, RuntimeError, TypeError, ValueError) as error:
        return _dependency_refusal(
            "profile",
            {"key": profile_id, **dependency},
            "KF_SKILL_PROFILE_MISSING",
            str(error),
            f"install, qualify, and activate exact Profile {profile_id}",
        )
    if state.get("profile_suite_root") != dependency["root"]:
        return _dependency_refusal(
            "profile",
            {"key": profile_id, **dependency},
            "KF_SKILL_PROFILE_ROOT_STALE",
            "active Profile root differs from the Skill coordinate",
            "publish a new Skill revision or roll back the Profile root",
        )
    if state.get("revision") != dependency["revision"]:
        return _dependency_refusal(
            "profile",
            {"key": profile_id, **dependency},
            "KF_SKILL_PROFILE_REVISION_INCOMPATIBLE",
            f"active Profile revision is {state.get('revision')!r}",
            "bind the exact active Profile revision in a new Skill revision",
        )
    if state.get("state") != "activated" and not state.get("activated"):
        return _dependency_refusal(
            "profile",
            {"key": profile_id, **dependency},
            "KF_SKILL_PROFILE_NOT_ACTIVE",
            "Profile exists but is not activated",
            "qualify and activate the exact Profile root",
        )
    source = profile_sources.get(profile_id)
    if source is None:
        return _dependency_refusal(
            "profile",
            {"key": profile_id, **dependency},
            "KF_SKILL_PROFILE_SOURCE_REQUIRED",
            "Profile action planning needs the installed content-bound source edge",
            "provide the source coordinate reported by the admitted Profile lifecycle",
        )
    contributions = []
    for contribution_id in dependency["contributions"]:
        answer_key = f"{profile_id}:{contribution_id}"
        try:
            plan = profile_sdk.plan_action(
                source,
                runtime_dir,
                contribution_id,
                profile_inputs.get(answer_key),
            )
        except (OSError, RuntimeError, TypeError, ValueError) as error:
            return _dependency_refusal(
                "profile",
                {"key": profile_id, **dependency},
                "KF_SKILL_PROFILE_CONTRIBUTION_REFUSED",
                str(error),
                "repair the admitted Profile contribution and build a fresh plan",
            )
        if plan.get("profileSuiteRoot") != dependency["root"]:
            return _dependency_refusal(
                "profile",
                {"key": profile_id, **dependency},
                "KF_SKILL_PROFILE_ACTION_STALE",
                "Profile action plan binds another Profile root",
                "discard the stale action plan and rebuild from current Profile authority",
            )
        contributions.append(
            {"id": contribution_id, "planRoot": plan.get("planId"), "plan": plan}
        )
    return {
        "kind": "profile",
        "key": profile_id,
        "revision": dependency["revision"],
        "root": dependency["root"],
        "required": dependency["required"],
        "status": "available",
        "code": "KF_SKILL_PROFILE_ADMITTED",
        "requestedCapabilities": [],
        "contributions": contributions,
        "trustReportRoot": state.get("trust_report_root"),
        "recovery": "rebuild the plan if the Profile root or action plan changes",
    }


def _dependency_refusal(
    kind: str,
    dependency: Mapping[str, Any],
    code: str,
    reason: str,
    recovery: str,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "key": dependency.get("key") or dependency.get("id"),
        "revision": dependency.get("revision"),
        "root": dependency.get("root"),
        "required": bool(dependency.get("required", True)),
        "status": "refused",
        "code": code,
        "reason": reason,
        "recovery": recovery,
        "requestedCapabilities": list(dependency.get("capabilityRequests", [])),
    }


def _surface_projections(value: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        surface: {
            "surface": surface,
            "planRoot": value.get("planRoot"),
            "receiptRoot": value.get("receiptRoot"),
            "capabilityDecisionRoot": (value.get("authority") or {}).get(
                "capabilityDecisionRoot"
            ),
            "trustReportRoots": (value.get("authority") or {}).get(
                "trustReportRoots", []
            ),
            "auditIdentityRoot": value.get("auditIdentityRoot"),
        }
        for surface in SURFACES
    }


def _verify_plan(plan: Mapping[str, Any], expected: str) -> None:
    if plan.get("schema") != PLAN_SCHEMA or plan.get("planRoot") != expected:
        raise SkillAuthorityError(
            "KF_SKILL_PLAN_ROOT_MISMATCH",
            "Skill dependency plan identity does not match",
            "discard the plan and rebuild from current authority",
        )
    base = {
        key: copy.deepcopy(value)
        for key, value in plan.items()
        if key not in {"planRoot", "auditIdentityRoot", "surfaceProjections"}
    }
    if _root(base) != expected:
        raise SkillAuthorityError(
            "KF_SKILL_PLAN_ROOT_MISMATCH",
            "Skill dependency plan content changed after planning",
            "discard the plan and rebuild from current authority",
        )


def _verify_current_skill_selection(home: str | Path, plan: Mapping[str, Any]) -> None:
    skill = plan["skill"]
    work = plan["work"]
    report = inspect_registry(home, str(skill["key"]))
    if report.get("stateRoot") != plan["authority"]["skillRegistryRoot"]:
        raise SkillAuthorityError(
            "KF_SKILL_REGISTRY_STALE",
            "Skill registry changed after dependency planning",
            "discard the plan and rebuild from the current Skill registry",
        )
    entry = report["entries"][str(skill["key"])]
    record = entry.get("revisions", {}).get(str(skill["revision"])) or {}
    selected = any(
        row.get("active")
        and row.get("workRef") == work["ref"]
        and row.get("workRoot") == work["root"]
        and row.get("revision") == skill["revision"]
        for row in entry.get("workSelections", [])
    )
    if (
        entry.get("activeRevision") != skill["revision"]
        or record.get("contentRoot") != skill["contentRoot"]
        or record.get("definitionRoot") != skill["definitionRoot"]
        or not selected
    ):
        raise SkillAuthorityError(
            "KF_SKILL_WORK_SELECTION_MISMATCH",
            "Skill or exact Work selection changed after dependency planning",
            "select the current Skill revision for the exact Work root and rebuild",
        )


def _require_root(value: str, code: str) -> None:
    if not _is_root(value):
        raise SkillAuthorityError(
            code,
            f"not a canonical SHA-256 root: {value!r}",
            "resolve the exact authority root and rebuild the plan",
        )


def _is_root(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 71
        and value.startswith("sha256:")
        and all(character in "0123456789abcdef" for character in value[7:])
    )


def _read_json(path: Path) -> dict[str, Any]:
    import json

    value = json.loads(path.read_text("utf-8"))
    if not isinstance(value, dict):
        raise SkillAuthorityError(
            "KF_SKILL_DEFINITION_INVALID",
            f"Skill definition is not an object: {path}",
            "restore the immutable Skill definition from the registry receipt",
        )
    return value


def _root(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_json_bytes(value)).hexdigest()}"
