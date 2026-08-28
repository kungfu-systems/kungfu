# SPDX-License-Identifier: Apache-2.0

"""Profile capability and session-projection responsibility owner."""

from __future__ import annotations

import importlib
import json
from typing import Any

from kungfu.agent import domain_profile
from kungfu.agent.native_authority import require_conformance_oracle
from kungfu.storage import service as storage_service

_facade = importlib.import_module("kungfu.agent.work_profile")
ACTION_SCHEMA = _facade.ACTION_SCHEMA
RECEIPT_SCHEMA = _facade.RECEIPT_SCHEMA
ROLE_BODY_SCHEMA = _facade.ROLE_BODY_SCHEMA
CAPABILITIES_SCHEMA = _facade.CAPABILITIES_SCHEMA
AUTHORITY_BUNDLE_SCHEMA = _facade.AUTHORITY_BUNDLE_SCHEMA
SESSION_SCHEMA = _facade.SESSION_SCHEMA
SESSION_EXPANSION_SCHEMA = _facade.SESSION_EXPANSION_SCHEMA
SESSION_COMPRESSIBILITY_SCHEMA = _facade.SESSION_COMPRESSIBILITY_SCHEMA
ROLES = _facade.ROLES
TRANSITIONS = _facade.TRANSITIONS
DENIALS = _facade.DENIALS


def capabilities_python(*, conformance: bool = False) -> dict[str, Any]:
    require_conformance_oracle(conformance=conformance)
    profile_roots = domain_profile.roots_python(conformance=True)
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
    _facade.require_action_runtime()
    return storage_service.action_runtime("", "capabilities")


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


def session_compressibility_python(
    session: dict[str, Any], *, conformance: bool = False
) -> dict[str, Any]:
    """Return the exact roles that make a familiar session projection lossy."""

    require_conformance_oracle(conformance=conformance)
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


def session_valid_actions_python(
    session: dict[str, Any], *, conformance: bool = False
) -> list[str]:
    """Derive actions only from direction, current context, and authority."""

    require_conformance_oracle(conformance=conformance)
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


def expand_session_python(
    session: dict[str, Any], *, conformance: bool = False
) -> dict[str, Any]:
    """Expand one product session into the legacy-compatible five-role shape."""

    require_conformance_oracle(conformance=conformance)
    components = _validate_session(session)
    compressibility = session_compressibility_python(session, conformance=True)
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
        "validActions": session_valid_actions_python(session, conformance=True),
    }


def project_session_python(
    expansion: dict[str, Any], *, conformance: bool = False
) -> dict[str, Any]:
    """Project a compressible five-role expansion back to one session."""

    require_conformance_oracle(conformance=conformance)
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
            domain_profile.validate_role_body_python(body, conformance=True)
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

    _facade.require_action_runtime()
    return storage_service.action_runtime(
        "", "session_compressibility", {"session": dict(session)}
    )


def session_valid_actions(session: dict[str, Any]) -> list[str]:
    """Derive actions only from direction, current context, and authority."""

    _facade.require_action_runtime()
    return list(
        storage_service.action_runtime(
            "", "session_valid_actions", {"session": dict(session)}
        )
    )


def expand_session(session: dict[str, Any]) -> dict[str, Any]:
    """Expand one product session into the legacy-compatible five-role shape."""

    _facade.require_action_runtime()
    return storage_service.action_runtime(
        "", "expand_session", {"session": dict(session)}
    )


def project_session(expansion: dict[str, Any]) -> dict[str, Any]:
    """Project a compressible five-role expansion back to one session."""

    _facade.require_action_runtime()
    try:
        return storage_service.action_runtime(
            "", "project_session", {"expansion": dict(expansion)}
        )
    except Exception as error:  # noqa: BLE001 - preserve ValueError surface
        raise ValueError(str(error)) from error
