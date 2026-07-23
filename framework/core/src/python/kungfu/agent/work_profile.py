# SPDX-License-Identifier: Apache-2.0

"""KFD-7 Product Profile over the generic Fact kernel.

This module is an outer-ring Profile. It owns product vocabulary and state
transitions while every persisted object, version, relation, Cut, ref move, and
kernel receipt remains owned by the native Fact kernel.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from kungfu.agent import domain_profile
from kungfu.storage import service as storage_service

# Authority for capabilities / apply / inspect / session projection prefers
# libkungfu ``action_runtime`` when the binding exposes the storage edge.
# Injected ``kernel=`` keeps the local Python path for characterization and
# contract tests that supply an in-memory Fact kernel. Stub bindings without
# ``run_storage_service_operation`` fall back to the pure-Python reference.


ACTION_SCHEMA = "kungfu.kfd7.profile-action/v1"
RECEIPT_SCHEMA = "kungfu.kfd7.profile-action-receipt/v1"
ROLE_BODY_SCHEMA = "kungfu.kfd7.profile-role/v1"
CAPABILITIES_SCHEMA = "kungfu.kfd7.profile-capabilities/v1"
INSPECTION_SCHEMA = "kungfu.kfd7.profile-inspection/v1"
AUTHORITY_BUNDLE_SCHEMA = "kungfu.fact-authority-bundle/v2"
SESSION_SCHEMA = "kungfu.kfd7.session/v1"
SESSION_EXPANSION_SCHEMA = "kungfu.kfd7.session-expansion/v1"
SESSION_COMPRESSIBILITY_SCHEMA = "kungfu.kfd7.session-compressibility/v1"

ROLES = ("fact", "episode", "pursuit", "atlas", "warrant")
INITIAL_STATES = {
    "fact": "declared",
    "episode": "open",
    "pursuit": "active",
    "atlas": "current",
    "warrant": "issued",
}
TRANSITIONS = {
    "fact": {
        ("create", "absent", "declared"),
        ("successor", "declared", "superseded"),
        ("fork", "declared", "declared"),
        ("degrade", "declared", "degraded"),
    },
    "episode": {
        ("create", "absent", "open"),
        ("seal", "open", "sealed"),
        ("compensate", "sealed", "compensated"),
        ("reconcile", "sealed", "reconciled"),
        ("reconcile", "compensated", "reconciled"),
    },
    "pursuit": {
        ("create", "absent", "active"),
        ("branch", "active", "active"),
        ("continue", "active", "active"),
        ("continue", "paused", "active"),
        ("pause", "active", "paused"),
        ("complete", "active", "completed"),
        ("complete", "paused", "completed"),
        ("abandon", "active", "abandoned"),
        ("abandon", "paused", "abandoned"),
    },
    "atlas": {
        ("create", "absent", "current"),
        ("refresh", "current", "current"),
        ("refresh", "stale", "current"),
        ("refresh", "conflicted", "current"),
        ("mark-stale", "current", "stale"),
        ("mark-conflicted", "current", "conflicted"),
        ("supersede", "current", "superseded"),
        ("supersede", "stale", "superseded"),
    },
    "warrant": {
        ("create", "absent", "issued"),
        ("attenuate", "issued", "attenuated"),
        ("attenuate", "attenuated", "attenuated"),
        ("expire", "issued", "expired"),
        ("expire", "attenuated", "expired"),
        ("revoke", "issued", "revoked"),
        ("revoke", "attenuated", "revoked"),
        ("deny", "issued", "denied"),
        ("deny", "attenuated", "denied"),
    },
}

DENIALS = (
    "responsibility-gap",
    "invalid-request",
    "invalid-transition",
    "profile-state-mismatch",
    "body-missing",
    "stale-ref",
    "replay-mismatch",
    "unauthorized",
    "warrant-expired",
    "warrant-revoked",
    "atlas-stale",
    "kernel-rejected",
)

_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
_FACT_ID = re.compile(r"^fact:[0-9a-f]{32}$")
_REF = re.compile(r"^[a-z][a-z0-9._/-]{0,127}$")
_ACTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

Kernel = Callable[[str | Path, str, dict[str, Any] | None], dict[str, Any]]


def _native_edge_available() -> bool:
    try:
        return hasattr(storage_service._runtime(), "run_storage_service_operation")
    except Exception:  # noqa: BLE001 - binding may be absent or stubbed
        return False


def capabilities_python() -> dict[str, Any]:
    profile_roots = domain_profile.roots_python()
    profile_contract = domain_profile.contract()
    return {
        "schema": CAPABILITIES_SCHEMA,
        "profile": "kungfu-kfd-7-action-profile",
        "roles": list(ROLES),
        "actionSchema": ACTION_SCHEMA,
        "receiptSchema": RECEIPT_SCHEMA,
        "roleBodySchema": ROLE_BODY_SCHEMA,
        "actionGeometryRoot": profile_roots["actionGeometryRoot"],
        "domainProfileRoot": profile_roots["domainProfileRoot"],
        "roleSchemaRoots": profile_roots["roleSchemaRoots"],
        "roleBodySchemas": {
            role: profile_contract["roleSchemas"][role]["schema"] for role in ROLES
        },
        "compatibility": profile_contract["legacyCompatibility"],
        "transitions": {
            role: [
                {"operation": operation, "from": source, "to": target}
                for operation, source, target in sorted(TRANSITIONS[role])
            ]
            for role in ROLES
        },
        "denials": list(DENIALS),
        "authority": {
            "profile": "role vocabulary, transition checks, progressive disclosure",
            "kernel": "identity, immutable versions, relations, Cuts, CAS, receipts",
            "episode": "causal occurrence and sealed evidence",
        },
        "recovery": {
            "projectionRebuild": {
                "status": "supported",
                "source": "native Fact journal and content-addressed bodies",
                "identity": "preserved",
            },
            "exportImport": {
                "status": "supported",
                "bundleSchema": AUTHORITY_BUNDLE_SCHEMA,
                "authority": "native Fact journal replay through the existing kernel",
                "preserves": [
                    "logical object ids",
                    "version and body roots",
                    "relation and Cut roots",
                    "named ref roots and revisions",
                ],
            },
            "backendMigration": {
                "status": "supported-by-storage-backend-switch",
                "identity": "five-role object, version, Cut, ref, and authority roots remain exact",
                "rollback": "reverse-sync-and-atomic-binding",
            },
            "cleanHome": {
                "status": "supported-from-qualified-authority-bundle",
                "requires": AUTHORITY_BUNDLE_SCHEMA,
                "lossCode": "profile-authority-unavailable",
            },
        },
        "sessionProjection": {
            "schema": SESSION_SCHEMA,
            "expand": "kungfu.agent.work_profile.expand_session",
            "project": "kungfu.agent.work_profile.project_session",
            "compressibilityPredicate": (
                "kungfu.agent.work_profile.session_compressibility"
            ),
            "semanticDimensions": [
                "direction",
                "perspective-boundary",
                "effective-authority",
                "causal-process",
                "admitted-result",
            ],
        },
        "nonClaims": [
            "A Profile receipt does not adopt KFD-7 or replace KFD authority.",
            "An accepted action does not prove Pursuit completion or complete reality.",
        ],
    }


def capabilities() -> dict[str, Any]:
    if _native_edge_available():
        return storage_service.action_runtime("", "capabilities")
    return capabilities_python()


def _require_session_component(
    session: dict[str, Any], field: str, identity_field: str
) -> dict[str, Any]:
    value = session.get(field)
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    identity = value.get(identity_field)
    if not isinstance(identity, str) or not identity:
        raise ValueError(f"{field}.{identity_field} is required")
    return value


def _validate_session(session: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if not isinstance(session, dict) or session.get("schema") != SESSION_SCHEMA:
        raise ValueError(f"schema must be {SESSION_SCHEMA}")
    if not isinstance(session.get("sessionId"), str) or not session["sessionId"]:
        raise ValueError("sessionId is required")
    components = {
        "pursuit": _require_session_component(session, "goal", "pursuitId"),
        "atlas": _require_session_component(session, "context", "atlasId"),
        "warrant": _require_session_component(session, "permissions", "warrantId"),
        "episode": _require_session_component(session, "run", "episodeId"),
        "fact": _require_session_component(session, "facts", "factId"),
    }
    identities = [
        components["fact"]["factId"],
        components["episode"]["episodeId"],
        components["pursuit"]["pursuitId"],
        components["atlas"]["atlasId"],
        components["warrant"]["warrantId"],
    ]
    if len(identities) != len(set(identities)):
        raise ValueError("session responsibilities require distinct identities")
    for field in ("basisRevision", "validThroughRevision"):
        value = components["atlas"].get(field)
        if not isinstance(value, int) or value < 0:
            raise ValueError(f"context.{field} must be a non-negative integer")
    valid_through = components["warrant"].get("validThroughRevision")
    if not isinstance(valid_through, int) or valid_through < 0:
        raise ValueError(
            "permissions.validThroughRevision must be a non-negative integer"
        )
    for field, component in (
        ("goal.operations", components["pursuit"]),
        ("permissions.allowedOperations", components["warrant"]),
    ):
        key = field.rsplit(".", 1)[1]
        value = component.get(key)
        if (
            not isinstance(value, list)
            or not value
            or any(not isinstance(item, str) or not item for item in value)
        ):
            raise ValueError(f"{field} must be a non-empty string array")
    return components


def session_compressibility_python(session: dict[str, Any]) -> dict[str, Any]:
    """Return the exact roles that make a familiar session projection lossy."""

    components = _validate_session(session)
    reasons: list[dict[str, str]] = []

    goal = components["pursuit"]
    if goal.get("state") != "active" or goal.get("alternatives"):
        reasons.append(
            {
                "role": "pursuit",
                "code": "multiple-or-terminal-direction",
            }
        )

    context = components["atlas"]
    if (
        context.get("state") != "current"
        or context["validThroughRevision"] < context["basisRevision"]
        or context.get("lossRoots")
        or len(context.get("perspectives", [])) > 1
    ):
        reasons.append({"role": "atlas", "code": "perspective-or-freshness-boundary"})

    permissions = components["warrant"]
    if (
        permissions.get("state") != "issued"
        or permissions["validThroughRevision"] < context["basisRevision"]
        or permissions.get("delegated") is True
    ):
        reasons.append({"role": "warrant", "code": "authority-boundary"})

    run = components["episode"]
    if (
        run.get("state") not in {"open", "sealed"}
        or len(run.get("episodeIds", [run["episodeId"]])) != 1
    ):
        reasons.append({"role": "episode", "code": "causal-branch"})

    facts = components["fact"]
    if facts.get("branchRoots") or len(facts.get("resultRoots", [])) > 1:
        reasons.append({"role": "fact", "code": "fact-branch"})

    return {
        "schema": SESSION_COMPRESSIBILITY_SCHEMA,
        "sessionId": session["sessionId"],
        "compressible": not reasons,
        "breakpoints": reasons,
        "revealedRoles": sorted({reason["role"] for reason in reasons}),
    }


def session_valid_actions_python(session: dict[str, Any]) -> list[str]:
    """Derive actions only from direction, current context, and authority."""

    components = _validate_session(session)
    context = components["atlas"]
    warrant = components["warrant"]
    pursuit = components["pursuit"]
    if (
        pursuit.get("state") != "active"
        or context.get("state") != "current"
        or context["validThroughRevision"] < context["basisRevision"]
        or warrant.get("state") != "issued"
        or warrant["validThroughRevision"] < context["basisRevision"]
    ):
        return []
    return sorted(set(pursuit["operations"]).intersection(warrant["allowedOperations"]))


def expand_session_python(session: dict[str, Any]) -> dict[str, Any]:
    """Expand one product session into the legacy-compatible five-role shape."""

    components = _validate_session(session)
    compressibility = session_compressibility_python(session)
    roles = {
        role: {
            "schema": ROLE_BODY_SCHEMA,
            "role": role,
            "state": components[role]["state"],
            "details": json.loads(json.dumps(components[role], sort_keys=True)),
        }
        for role in ROLES
    }
    return {
        "schema": SESSION_EXPANSION_SCHEMA,
        "sessionId": session["sessionId"],
        "compressibility": compressibility,
        "roles": roles,
        "observations": {
            "direction": roles["pursuit"]["details"],
            "perspective-boundary": roles["atlas"]["details"],
            "effective-authority": roles["warrant"]["details"],
            "causal-process": roles["episode"]["details"],
            "admitted-result": roles["fact"]["details"],
        },
        "validActions": session_valid_actions_python(session),
    }


def project_session_python(expansion: dict[str, Any]) -> dict[str, Any]:
    """Project a compressible five-role expansion back to one session."""

    if (
        not isinstance(expansion, dict)
        or expansion.get("schema") != SESSION_EXPANSION_SCHEMA
    ):
        raise ValueError(f"schema must be {SESSION_EXPANSION_SCHEMA}")
    compressibility = expansion.get("compressibility")
    if not isinstance(compressibility, dict) or not compressibility.get("compressible"):
        raise ValueError("session-complexity-breakpoint")
    roles = expansion.get("roles")
    if not isinstance(roles, dict) or set(roles) != set(ROLES):
        raise ValueError("all five expanded roles are required exactly once")
    for role in ROLES:
        body = roles[role]
        try:
            if not isinstance(body, dict):
                raise ValueError("role body must be an object")
            domain_profile.validate_role_body_python(body)
        except ValueError as error:
            raise ValueError(f"expanded {role} role is invalid: {error}") from error
        if body.get("role") != role or not isinstance(body.get("details"), dict):
            raise ValueError(f"expanded {role} role is invalid")
    projected = {
        "schema": SESSION_SCHEMA,
        "sessionId": expansion.get("sessionId"),
        "goal": roles["pursuit"]["details"],
        "context": roles["atlas"]["details"],
        "permissions": roles["warrant"]["details"],
        "run": roles["episode"]["details"],
        "facts": roles["fact"]["details"],
    }
    _validate_session(projected)
    return projected


def session_compressibility(session: dict[str, Any]) -> dict[str, Any]:
    """Return the exact roles that make a familiar session projection lossy."""

    if _native_edge_available():
        return storage_service.action_runtime(
            "", "session_compressibility", {"session": dict(session)}
        )
    return session_compressibility_python(session)


def session_valid_actions(session: dict[str, Any]) -> list[str]:
    """Derive actions only from direction, current context, and authority."""

    if _native_edge_available():
        return list(
            storage_service.action_runtime(
                "", "session_valid_actions", {"session": dict(session)}
            )
        )
    return session_valid_actions_python(session)


def expand_session(session: dict[str, Any]) -> dict[str, Any]:
    """Expand one product session into the legacy-compatible five-role shape."""

    if _native_edge_available():
        return storage_service.action_runtime(
            "", "expand_session", {"session": dict(session)}
        )
    return expand_session_python(session)


def project_session(expansion: dict[str, Any]) -> dict[str, Any]:
    """Project a compressible five-role expansion back to one session."""

    if _native_edge_available():
        try:
            return storage_service.action_runtime(
                "", "project_session", {"expansion": dict(expansion)}
            )
        except Exception as error:  # noqa: BLE001 - preserve ValueError surface
            raise ValueError(str(error)) from error
    return project_session_python(expansion)


def _kernel(
    runtime_dir: str | Path,
    action: str,
    request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return storage_service.fact_kernel(runtime_dir, action, request)


def export_authority(
    runtime_dir: str | Path,
    *,
    kernel: Kernel | None = None,
) -> dict[str, Any]:
    """Export the native Fact authority required to continue this Profile."""

    return (kernel or _kernel)(runtime_dir, "authority-export", {})


def import_authority(
    runtime_dir: str | Path,
    bundle: dict[str, Any],
    *,
    execute: bool = False,
    kernel: Kernel | None = None,
) -> dict[str, Any]:
    """Validate or replay one qualified Fact authority bundle."""

    return (kernel or _kernel)(
        runtime_dir,
        "authority-import",
        {"bundle": bundle, "execute": execute},
    )


def _denied(
    action_id: str,
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
    steps: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    steps = list(steps or [])
    return {
        "schema": RECEIPT_SCHEMA,
        "actionId": action_id,
        "status": "denied",
        "failureCode": code,
        "message": message,
        "details": details or {},
        "writeOccurred": any(step.get("writeOccurred") is True for step in steps),
        "refWriteOccurred": False,
        "steps": steps,
        "residualRisk": [
            "Immutable prerequisite records may exist even when the named ref CAS is denied."
        ]
        if any(step.get("writeOccurred") is True for step in steps)
        else [],
    }


def _require_root(value: Any, field: str, *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or _ROOT.fullmatch(value) is None:
        raise ValueError(f"{field} must be a sha256 content root")


def _require_root_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{field} must be a non-empty root array")
    for index, root in enumerate(value):
        _require_root(root, f"{field}[{index}]")
    if len(value) != len(set(value)):
        raise ValueError(f"{field} must not contain duplicates")
    return sorted(value)


def _step(action: str, response: dict[str, Any]) -> dict[str, Any]:
    return {
        "action": action,
        "status": response.get("status"),
        "ok": response.get("ok") is True,
        "failureCode": response.get("failure_code"),
        "writeOccurred": response.get("write_occurred") is True,
        "receiptRoot": response.get("receipt_root"),
    }


def _load_cut(
    runtime_dir: str | Path,
    cut_root: str | None,
    kernel: Kernel,
) -> tuple[dict[str, Any] | None, dict[str, dict[str, Any]], list[str]]:
    if cut_root is None:
        return None, {}, []
    response = kernel(
        runtime_dir,
        "query",
        {"cut_root": cut_root, "include_bodies": True},
    )
    if response.get("ok") is not True:
        raise RuntimeError(json.dumps(response, sort_keys=True))
    roles: dict[str, dict[str, Any]] = {}
    for row in response.get("objects", []):
        body = row.get("body")
        if row.get("body_status") != "present" or not isinstance(body, str):
            continue
        try:
            decoded = json.loads(body)
        except json.JSONDecodeError:
            continue
        role = decoded.get("role")
        if role not in ROLES:
            continue
        try:
            domain_profile.validate_role_body(decoded)
        except ValueError:
            continue
        roles[str(role)] = {
            "objectId": row["member"][0],
            "versionRoot": row["member"][1],
            "body": decoded,
        }
    relation_roots = [
        str(row["relation_root"])
        for row in response.get("relations", [])
        if isinstance(row, dict) and isinstance(row.get("relation_root"), str)
    ]
    return response, roles, relation_roots


def inspect(
    runtime_dir: str | Path,
    ref_name: str,
    *,
    kernel: Kernel | None = None,
) -> dict[str, Any]:
    if kernel is None and _native_edge_available():
        return storage_service.action_runtime(
            runtime_dir, "inspect", {"ref_name": ref_name}
        )
    kernel = kernel or _kernel
    if _REF.fullmatch(ref_name) is None or ".." in ref_name:
        return _denied("inspect", "invalid-request", "refName is not canonical")
    catalog = kernel(runtime_dir, "query", {})
    if catalog.get("ok") is not True:
        return _denied(
            "inspect",
            "kernel-rejected",
            "Fact kernel catalog query failed",
            details=catalog,
        )
    resolution = (catalog.get("refs") or {}).get(ref_name)
    if not isinstance(resolution, dict):
        return {
            "schema": INSPECTION_SCHEMA,
            "status": "absent",
            "refName": ref_name,
            "cutRoot": None,
            "revision": 0,
            "roles": {},
            "gaps": [{"role": role, "code": "responsibility-gap"} for role in ROLES],
            "relations": [],
        }
    cut_root = resolution.get("cut_root")
    try:
        cut, roles, relation_roots = _load_cut(runtime_dir, cut_root, kernel)
    except RuntimeError as error:
        return _denied(
            "inspect",
            "kernel-rejected",
            "Fact Cut query failed",
            details={"error": str(error)},
        )
    return {
        "schema": INSPECTION_SCHEMA,
        "status": "current" if len(roles) == len(ROLES) else "degraded",
        "refName": ref_name,
        "cutRoot": cut_root,
        "revision": resolution.get("revision", 0),
        "roles": roles,
        "gaps": [
            {"role": role, "code": "responsibility-gap"}
            for role in ROLES
            if role not in roles
        ],
        "relations": relation_roots,
        "basis": cut.get("cut") if isinstance(cut, dict) else None,
    }


def _validate_request(request: dict[str, Any]) -> None:
    if request.get("schema") != ACTION_SCHEMA:
        raise ValueError(f"schema must be {ACTION_SCHEMA}")
    action_id = request.get("actionId")
    if not isinstance(action_id, str) or _ACTION_ID.fullmatch(action_id) is None:
        raise ValueError("actionId is not canonical")
    ref_name = request.get("refName")
    if (
        not isinstance(ref_name, str)
        or _REF.fullmatch(ref_name) is None
        or ".." in ref_name
    ):
        raise ValueError("refName is not canonical")
    subject = request.get("subject")
    if not isinstance(subject, dict) or subject.get("role") not in ROLES:
        raise ValueError("subject.role is required")
    transition = (
        subject.get("operation"),
        subject.get("fromState"),
        subject.get("toState"),
    )
    if transition not in TRANSITIONS[str(subject["role"])]:
        raise ValueError("subject transition is not declared by the Kungfu Profile")
    basis = request.get("basis")
    ref = request.get("ref")
    for field, value in (("basis", basis), ("ref", ref)):
        if not isinstance(value, dict):
            raise ValueError(f"{field} is required")
        _require_root(value.get("cutRoot"), f"{field}.cutRoot", nullable=True)
        if not isinstance(value.get("revision"), int) or value["revision"] < 0:
            raise ValueError(f"{field}.revision must be a non-negative integer")
    responsibilities = request.get("responsibilities")
    if not isinstance(responsibilities, dict) or set(responsibilities) != set(ROLES):
        raise ValueError("all five responsibilities are required exactly once")
    for role in ROLES:
        value = responsibilities[role]
        if not isinstance(value, dict) or not isinstance(value.get("objectId"), str):
            raise ValueError(f"responsibilities.{role}.objectId is required")
        if _FACT_ID.fullmatch(value["objectId"]) is None:
            raise ValueError(f"responsibilities.{role}.objectId is not canonical")
        _require_root(
            value.get("expectedVersionRoot"),
            f"responsibilities.{role}.expectedVersionRoot",
            nullable=True,
        )
    object_ids = [responsibilities[role]["objectId"] for role in ROLES]
    if len(set(object_ids)) != len(ROLES):
        raise ValueError(
            "all five responsibilities require distinct logical object identities"
        )
    support = request.get("support")
    if not isinstance(support, dict):
        raise ValueError("support is required")
    for field in ("createdByReceiptRoot", "schemaRoot", "reasonRoot"):
        _require_root(support.get(field), f"support.{field}")
    _require_root_list(support.get("declarationRoots"), "support.declarationRoots")
    _require_root_list(support.get("admissionRoots"), "support.admissionRoots")


def _validate_lifecycle_payload(
    subject_role: str,
    subject: dict[str, Any],
    current_roles: dict[str, dict[str, Any]],
    payload: dict[str, Any],
    basis: dict[str, Any],
    ref: dict[str, Any],
) -> tuple[str, str, dict[str, Any]] | None:
    operation = subject["operation"]
    current_body = current_roles.get(subject_role, {}).get("body") or {}
    current_details = current_body.get("details") or {}
    if not isinstance(current_details, dict):
        return ("invalid-request", f"{subject_role} details must be an object", {})

    try:
        if subject_role == "episode" and operation == "seal":
            episode_id = payload.get("episodeId")
            if episode_id != current_details.get("episodeId"):
                return (
                    "replay-mismatch",
                    "Episode seal identity differs from the open Episode",
                    {
                        "expected": current_details.get("episodeId"),
                        "actual": episode_id,
                    },
                )
            for field in (
                "beforeCutRoot",
                "afterCutRoot",
                "causalRoot",
                "sealedContentRoot",
            ):
                _require_root(payload.get(field), f"payload.{field}")

        if subject_role == "episode" and operation == "reconcile":
            replay = payload.get("replay")
            if not isinstance(replay, dict):
                return (
                    "invalid-request",
                    "Episode reconciliation requires replay evidence",
                    {},
                )
            expected = {
                field: current_details.get(field)
                for field in (
                    "episodeId",
                    "beforeCutRoot",
                    "afterCutRoot",
                    "causalRoot",
                    "sealedContentRoot",
                )
            }
            actual = {field: replay.get(field) for field in expected}
            for field in (
                "beforeCutRoot",
                "afterCutRoot",
                "causalRoot",
                "sealedContentRoot",
            ):
                _require_root(actual[field], f"payload.replay.{field}")
            if actual != expected:
                return (
                    "replay-mismatch",
                    "Episode replay evidence differs from the sealed causal record",
                    {"expected": expected, "actual": actual},
                )

        if subject_role == "pursuit" and operation == "branch":
            if ref.get("cutRoot") is not None or ref.get("revision") != 0:
                return (
                    "invalid-transition",
                    "Pursuit branch requires a new destination ref at revision zero",
                    {},
                )
            _require_root(payload.get("branchReasonRoot"), "payload.branchReasonRoot")
            payload_branch = payload.get("branchOfCutRoot")
            if payload_branch != basis.get("cutRoot"):
                return (
                    "profile-state-mismatch",
                    "Pursuit branch must bind the exact source Cut",
                    {"expected": basis.get("cutRoot"), "actual": payload_branch},
                )

        if subject_role == "pursuit" and operation in {"complete", "abandon"}:
            _require_root(payload.get("settlementRoot"), "payload.settlementRoot")
            if not isinstance(payload.get("outcome"), str) or not payload["outcome"]:
                return (
                    "invalid-request",
                    "Pursuit settlement requires a non-empty outcome",
                    {},
                )

        if subject_role == "atlas" and operation == "mark-stale":
            _require_root_list(payload.get("lossRoots"), "payload.lossRoots")
            if (
                not isinstance(payload.get("lossReason"), str)
                or not payload["lossReason"]
            ):
                return (
                    "invalid-request",
                    "Atlas staleness requires an explicit loss reason",
                    {},
                )

        if subject_role == "atlas" and operation == "refresh":
            _require_root_list(payload.get("sourceRoots"), "payload.sourceRoots")
            _require_root_list(payload.get("lossRoots"), "payload.lossRoots")
            valid_through = payload.get("validThroughRevision")
            if not isinstance(valid_through, int) or valid_through < basis["revision"]:
                return (
                    "atlas-stale",
                    "refreshed Atlas does not cover the declared basis revision",
                    {
                        "basisRevision": basis["revision"],
                        "validThroughRevision": valid_through,
                    },
                )

        if subject_role == "warrant" and operation == "attenuate":
            old_allowed = current_details.get("allowedOperations")
            new_allowed = payload.get("allowedOperations")
            if not isinstance(old_allowed, list) or not isinstance(new_allowed, list):
                return (
                    "invalid-request",
                    "Warrant attenuation requires explicit old and new operation scopes",
                    {},
                )
            if not new_allowed or "*" in new_allowed:
                return (
                    "invalid-transition",
                    "attenuated Warrant scope must be a non-empty strict subset",
                    {},
                )
            old_scope = set(old_allowed)
            new_scope = set(new_allowed)
            if "*" not in old_scope and not new_scope < old_scope:
                return (
                    "unauthorized",
                    "Warrant attenuation cannot widen or preserve the old scope",
                    {"old": sorted(old_scope), "new": sorted(new_scope)},
                )
            old_valid_through = current_details.get("validThroughRevision")
            new_valid_through = payload.get("validThroughRevision")
            if (
                not isinstance(old_valid_through, int)
                or not isinstance(new_valid_through, int)
                or new_valid_through > old_valid_through
            ):
                return (
                    "unauthorized",
                    "Warrant attenuation cannot extend its validity revision",
                    {
                        "old": old_valid_through,
                        "new": new_valid_through,
                    },
                )

        if subject_role == "warrant" and operation in {"expire", "revoke", "deny"}:
            _require_root(payload.get("reasonRoot"), "payload.reasonRoot")
            if not isinstance(payload.get("reason"), str) or not payload["reason"]:
                return (
                    "invalid-request",
                    f"Warrant {operation} requires an explicit reason",
                    {},
                )
    except ValueError as error:
        return ("invalid-request", str(error), {})
    return None


def _kernel_failure(
    action_id: str,
    response: dict[str, Any],
    steps: list[dict[str, Any]],
) -> dict[str, Any]:
    code = str(response.get("failure_code") or "kernel-rejected")
    mapped = {
        "stale-ref": "stale-ref",
        "transition-id-reused": "replay-mismatch",
    }.get(code, "kernel-rejected")
    return _denied(
        action_id,
        mapped,
        str(response.get("message") or "native Fact kernel rejected the action"),
        details={"kernelFailureCode": code, "kernel": response.get("details", {})},
        steps=steps,
    )


def apply_action(
    runtime_dir: str | Path,
    request: dict[str, Any],
    *,
    execute: bool = False,
    kernel: Kernel | None = None,
) -> dict[str, Any]:
    """Validate, plan, and optionally execute one KFD-7 Profile action."""

    if kernel is None and _native_edge_available():
        return storage_service.action_runtime(
            runtime_dir,
            "apply_action",
            {"request": dict(request), "execute": execute},
        )
    kernel = kernel or _kernel
    action_id = str(request.get("actionId") or "unknown")
    try:
        _validate_request(request)
    except (KeyError, TypeError, ValueError) as error:
        code = (
            "responsibility-gap"
            if "five responsibilities" in str(error)
            else "invalid-transition"
            if "transition" in str(error)
            else "invalid-request"
        )
        return _denied(action_id, code, str(error))

    subject = request["subject"]
    basis = request["basis"]
    responsibilities = request["responsibilities"]
    try:
        cut, current_roles, current_relation_roots = _load_cut(
            runtime_dir, basis["cutRoot"], kernel
        )
    except RuntimeError as error:
        return _denied(
            action_id,
            "kernel-rejected",
            "declared basis Cut is unavailable",
            details={"error": str(error)},
        )

    missing = [role for role in ROLES if role not in current_roles]
    if basis["cutRoot"] is not None and missing:
        return _denied(
            action_id,
            "body-missing",
            "the declared Cut does not expose all five Profile role bodies",
            details={"missingRoles": missing},
        )

    for role in ROLES:
        expected = responsibilities[role]["expectedVersionRoot"]
        current = current_roles.get(role)
        actual = current["versionRoot"] if current else None
        if expected != actual:
            return _denied(
                action_id,
                "profile-state-mismatch",
                f"{role} version does not match the declared basis",
                details={"role": role, "expected": expected, "actual": actual},
            )
        if current and current["objectId"] != responsibilities[role]["objectId"]:
            return _denied(
                action_id,
                "profile-state-mismatch",
                f"{role} identity does not match the declared basis",
                details={
                    "role": role,
                    "expected": responsibilities[role]["objectId"],
                    "actual": current["objectId"],
                },
            )

    subject_role = str(subject["role"])
    current_subject = current_roles.get(subject_role)
    current_state = current_subject["body"]["state"] if current_subject else "absent"
    if current_state != subject["fromState"]:
        return _denied(
            action_id,
            "profile-state-mismatch",
            "subject state differs from the declared transition",
            details={"expected": subject["fromState"], "actual": current_state},
        )

    role_inputs = request.get("roleInputs") or {}
    if not isinstance(role_inputs, dict):
        return _denied(action_id, "invalid-request", "roleInputs must be an object")
    if basis["cutRoot"] is None:
        for role in ROLES:
            value = role_inputs.get(role)
            if (
                not isinstance(value, dict)
                or value.get("state") != INITIAL_STATES[role]
            ):
                return _denied(
                    action_id,
                    "responsibility-gap",
                    "bootstrap requires one initial body for every responsibility",
                    details={"role": role, "requiredState": INITIAL_STATES[role]},
                )

    atlas_body = (
        current_roles.get("atlas", {}).get("body") or role_inputs.get("atlas") or {}
    )
    atlas_state = atlas_body.get("state")
    atlas_details = atlas_body.get("details") or {}
    if not isinstance(atlas_details, dict):
        return _denied(action_id, "invalid-request", "Atlas details must be an object")
    if atlas_state != "current" and not (
        subject_role == "atlas" and subject["operation"] == "refresh"
    ):
        return _denied(
            action_id,
            "atlas-stale",
            f"Atlas state {atlas_state!r} cannot support the requested transition",
        )
    atlas_valid_through = atlas_details.get("validThroughRevision")
    if (
        not isinstance(atlas_valid_through, int)
        or basis["revision"] > atlas_valid_through
    ):
        return _denied(
            action_id,
            "atlas-stale",
            "Atlas freshness does not cover the declared basis revision",
            details={
                "basisRevision": basis["revision"],
                "validThroughRevision": atlas_valid_through,
            },
        )

    warrant_body = (
        current_roles.get("warrant", {}).get("body") or role_inputs.get("warrant") or {}
    )
    warrant_state = warrant_body.get("state")
    warrant_details = warrant_body.get("details") or {}
    if warrant_state in {"expired", "revoked", "denied"}:
        code = {
            "expired": "warrant-expired",
            "revoked": "warrant-revoked",
            "denied": "unauthorized",
        }[warrant_state]
        return _denied(
            action_id,
            code,
            f"Warrant state {warrant_state!r} cannot authorize an action",
        )
    valid_through = warrant_details.get("validThroughRevision")
    if not isinstance(valid_through, int) or basis["revision"] > valid_through:
        return _denied(
            action_id,
            "warrant-expired",
            "Warrant validity does not cover the declared basis revision",
            details={
                "basisRevision": basis["revision"],
                "validThroughRevision": valid_through,
            },
        )
    allowed = warrant_details.get("allowedOperations")
    operation_key = f"{subject_role}:{subject['operation']}"
    if not isinstance(allowed, list) or not any(
        candidate in allowed for candidate in ("*", subject["operation"], operation_key)
    ):
        return _denied(
            action_id,
            "unauthorized",
            "Warrant scope does not authorize the requested transition",
            details={"operation": operation_key, "allowedOperations": allowed or []},
        )

    payload = request.get("payload") or {}
    if not isinstance(payload, dict):
        return _denied(action_id, "invalid-request", "payload must be an object")
    lifecycle_denial = _validate_lifecycle_payload(
        subject_role,
        subject,
        current_roles,
        payload,
        basis,
        request["ref"],
    )
    if lifecycle_denial is not None:
        code, message, details = lifecycle_denial
        return _denied(action_id, code, message, details=details)

    changed_roles = list(ROLES) if basis["cutRoot"] is None else [subject_role]
    plan = {
        "schema": RECEIPT_SCHEMA,
        "actionId": action_id,
        "status": "planned",
        "failureCode": None,
        "writeOccurred": False,
        "refWriteOccurred": False,
        "basis": basis,
        "ref": request["ref"],
        "subject": subject,
        "changedRoles": changed_roles,
        "relationCount": len(request.get("relations") or []),
        "commitPoint": "native Fact ref CAS",
        "residualRisk": [
            "Episode identity and seal roots are Profile mappings until Episode qualification is attached."
        ],
    }
    if not execute:
        return plan

    support = request["support"]
    steps: list[dict[str, Any]] = []
    next_versions = {
        role: value["versionRoot"] for role, value in current_roles.items()
    }
    next_bodies = {role: dict(value["body"]) for role, value in current_roles.items()}

    for role in ROLES:
        if role in current_roles:
            continue
        response = kernel(
            runtime_dir,
            "object-put",
            {
                "object_id": responsibilities[role]["objectId"],
                "object_type": f"kfd7.profile.{role}",
                "created_by_receipt_root": support["createdByReceiptRoot"],
            },
        )
        steps.append(_step("object-put", response))
        if response.get("ok") is not True:
            return _kernel_failure(action_id, response, steps)

    for role in changed_roles:
        if role in current_roles:
            body = dict(current_roles[role]["body"])
            if body.get("schema") == ROLE_BODY_SCHEMA:
                body["schema"] = domain_profile.role_schema_id(role)
            body["bindings"] = domain_profile.role_bindings(role)
            details = dict(body.get("details") or {})
        else:
            source = role_inputs[role]
            body = {
                "schema": domain_profile.role_schema_id(role),
                "profile": "kungfu-kfd-7-action-profile",
                "role": role,
                "identity": {"objectId": responsibilities[role]["objectId"]},
                "state": source["state"],
                "details": dict(source.get("details") or {}),
                "bindings": domain_profile.role_bindings(role),
                "nonClaims": list(source.get("nonClaims") or []),
            }
            details = dict(body["details"])
        if role == subject_role:
            body["state"] = subject["toState"]
            details.update(payload)
            body["details"] = details
        body["lastActionId"] = action_id
        body["basedOnCutRoot"] = basis["cutRoot"]
        raw_body = json.dumps(
            body, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        )
        parents = [current_roles[role]["versionRoot"]] if role in current_roles else []
        response = kernel(
            runtime_dir,
            "version-put",
            {
                "object_id": responsibilities[role]["objectId"],
                "body": raw_body,
                "schema_root": support["schemaRoot"],
                "parent_version_roots": parents,
                "declaration_roots": support["declarationRoots"],
                "admission_roots": support["admissionRoots"],
            },
        )
        steps.append(_step("version-put", response))
        if response.get("ok") is not True:
            return _kernel_failure(action_id, response, steps)
        next_versions[role] = response["result"]["version_root"]
        next_bodies[role] = body

    relation_roots = set(current_relation_roots)
    relations = request.get("relations") or []
    if not isinstance(relations, list):
        return _denied(
            action_id, "invalid-request", "relations must be an array", steps=steps
        )
    for relation in relations:
        try:
            source_role = relation["sourceRole"]
            target_role = relation["targetRole"]
            if source_role not in ROLES or target_role not in ROLES:
                raise ValueError("relation roles must be KFD-7 responsibilities")
            relation_id = relation["relationId"]
            if (
                not isinstance(relation_id, str)
                or _FACT_ID.fullmatch(relation_id) is None
            ):
                raise ValueError("relationId is not canonical")
            _require_root(relation.get("attributesRoot"), "relation.attributesRoot")
        except (KeyError, TypeError, ValueError) as error:
            return _denied(action_id, "invalid-request", str(error), steps=steps)
        response = kernel(
            runtime_dir,
            "relation-add",
            {
                "relation_id": relation_id,
                "relation_type": relation["relationType"],
                "source": {
                    "kind": "logical-object",
                    "id": responsibilities[source_role]["objectId"],
                },
                "target": {
                    "kind": "logical-object",
                    "id": responsibilities[target_role]["objectId"],
                },
                "attributes_root": relation["attributesRoot"],
                "admission_roots": support["admissionRoots"],
            },
        )
        steps.append(_step("relation-add", response))
        if response.get("ok") is not True:
            return _kernel_failure(action_id, response, steps)
        relation_roots.add(response["result"]["relation_root"])

    base_cut = cut.get("cut", {}) if isinstance(cut, dict) else {}
    episode_frontier = request.get(
        "episodeFrontier", base_cut.get("episodeFrontier", [])
    )
    response = kernel(
        runtime_dir,
        "cut-put",
        {
            "parent_cut_roots": [basis["cutRoot"]] if basis["cutRoot"] else [],
            "object_versions": [
                {
                    "object_id": responsibilities[role]["objectId"],
                    "version_root": next_versions[role],
                }
                for role in ROLES
            ],
            "active_relation_roots": sorted(relation_roots),
            "declaration_roots": support["declarationRoots"],
            "admission_roots": support["admissionRoots"],
            "episode_frontier": episode_frontier,
            "omission_roots": request.get("omissionRoots", []),
            "conflict_roots": request.get("conflictRoots", []),
        },
    )
    steps.append(_step("cut-put", response))
    if response.get("ok") is not True:
        return _kernel_failure(action_id, response, steps)
    next_cut_root = response["result"]["cut_root"]

    ref_kind = (
        "fork"
        if subject["operation"] in {"fork", "branch"}
        else "create"
        if request["ref"]["cutRoot"] is None
        else "advance"
    )
    response = kernel(
        runtime_dir,
        "ref-cas",
        {
            "transition_id": action_id,
            "ref_name": request["refName"],
            "expected_old_cut_root": request["ref"]["cutRoot"],
            "expected_old_revision": request["ref"]["revision"],
            "new_cut_root": next_cut_root,
            "kind": ref_kind,
            "reason_root": support["reasonRoot"],
        },
    )
    steps.append(_step("ref-cas", response))
    if response.get("ok") is not True:
        return _kernel_failure(action_id, response, steps)

    ref_result = response.get("result") or {}
    return {
        "schema": RECEIPT_SCHEMA,
        "actionId": action_id,
        "status": response.get("status", "accepted"),
        "failureCode": None,
        "writeOccurred": any(step["writeOccurred"] for step in steps),
        "refWriteOccurred": response.get("write_occurred") is True,
        "basis": basis,
        "subject": subject,
        "result": {
            "cutRoot": ref_result.get("current_cut_root", next_cut_root),
            "revision": ref_result.get("current_revision"),
            "roleVersions": next_versions,
            "roleStates": {role: next_bodies[role]["state"] for role in ROLES},
            "relationRoots": sorted(relation_roots),
        },
        "kernelReceiptRoot": response.get("receipt_root"),
        "steps": steps,
        "residualRisk": [
            "Profile acceptance does not prove Pursuit completion, complete reality, or KFD-7 activation."
        ],
    }
