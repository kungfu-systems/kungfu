# SPDX-License-Identifier: Apache-2.0

"""Canonical Agent Session value validation shared by CLI builders.

The JSON Schema in ``framework/agent-session/schemas`` is the public contract.
This dependency-free runtime validator keeps the installed Python front door
fail-closed without requiring a JSON Schema package at runtime.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Mapping, overload


WORK_REF_SCHEMA = "kungfu.work-ref/v1"
AGENT_CONSOLE_ENVELOPE_SCHEMA = "kungfu.agent-console-envelope/v1"
AGENT_RUNTIME_PROFILE_SCHEMA = "kungfu.agent-runtime-profile/v1"

_ROOT = re.compile(r"sha256:[0-9a-f]{64}\Z")
_IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}\Z")
_WORK_REF_FIELDS = {
    "schema",
    "workspaceId",
    "profileId",
    "profileRoot",
    "entityType",
    "entityId",
    "entityRoot",
    "purpose",
    "systemTimeCut",
    "initiativeId",
}
_LEGACY_WORK_REF_FIELDS = _WORK_REF_FIELDS - {"initiativeId"}
_ENVELOPE_FIELDS = {
    "schema",
    "workspaceId",
    "consoleId",
    "attemptId",
    "runtimeProfileId",
    "provider",
    "activeProfiles",
    "workRef",
    "entrypoints",
    "knownLimits",
    "envelopeRoot",
}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def semantic_root(value: Any) -> str:
    encoded = canonical_json(value).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _object(value: Mapping[str, Any] | None, label: str) -> dict[str, Any]:
    if value is None or not isinstance(value, Mapping) or not value:
        raise ValueError(f"{label} must be a non-empty JSON object")
    return dict(value)


def _exact_fields(
    value: Mapping[str, Any],
    *,
    allowed: set[str],
    required: set[str],
    label: str,
) -> None:
    extras = sorted(set(value) - allowed)
    missing = sorted(required - set(value))
    if extras or missing:
        details = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if extras:
            details.append(f"unknown {', '.join(extras)}")
        raise ValueError(f"{label} has an invalid shape; {'; '.join(details)}")


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be non-empty text")
    return value


@overload
def validate_work_ref(
    value: None,
    *,
    compatibility: bool = False,
) -> None: ...


@overload
def validate_work_ref(
    value: Mapping[str, Any],
    *,
    compatibility: bool = False,
) -> dict[str, Any]: ...


def validate_work_ref(
    value: Mapping[str, Any] | None,
    *,
    compatibility: bool = False,
) -> dict[str, Any] | None:
    if value is None:
        return None
    result = _object(value, "WorkRef")
    required = (
        _LEGACY_WORK_REF_FIELDS
        if compatibility and "initiativeId" not in result
        else _WORK_REF_FIELDS
    )
    _exact_fields(
        result,
        allowed=_WORK_REF_FIELDS,
        required=required,
        label="WorkRef",
    )
    if result.get("schema") != WORK_REF_SCHEMA:
        raise ValueError(f"WorkRef.schema must be {WORK_REF_SCHEMA}")
    for field in (
        "workspaceId",
        "profileId",
        "entityType",
        "entityId",
        "purpose",
        "systemTimeCut",
    ):
        _text(result.get(field), f"WorkRef.{field}")
    for field in ("profileRoot", "entityRoot"):
        if _ROOT.fullmatch(str(result.get(field) or "")) is None:
            raise ValueError(f"WorkRef.{field} must be a sha256 root")
    if result["entityType"] == "assignment":
        if not compatibility or "initiativeId" in result:
            _text(result.get("initiativeId"), "WorkRef.initiativeId")
    elif "initiativeId" in result:
        raise ValueError("WorkRef.initiativeId is only valid for assignment identity")
    return result


def validate_agent_console_envelope(
    value: Mapping[str, Any],
) -> dict[str, Any]:
    result = _object(value, "AgentConsoleEnvelope")
    _exact_fields(
        result,
        allowed=_ENVELOPE_FIELDS,
        required=_ENVELOPE_FIELDS,
        label="AgentConsoleEnvelope",
    )
    if result.get("schema") != AGENT_CONSOLE_ENVELOPE_SCHEMA:
        raise ValueError(
            f"AgentConsoleEnvelope.schema must be {AGENT_CONSOLE_ENVELOPE_SCHEMA}"
        )
    for field in ("workspaceId", "consoleId", "attemptId", "runtimeProfileId"):
        _text(result.get(field), f"AgentConsoleEnvelope.{field}")
    if _IDENTIFIER.fullmatch(str(result.get("provider") or "")) is None:
        raise ValueError("AgentConsoleEnvelope.provider must be a provider identifier")
    active_profiles = result.get("activeProfiles")
    if not isinstance(active_profiles, list):
        raise ValueError("AgentConsoleEnvelope.activeProfiles must be an array")
    for profile in active_profiles:
        profile_value = _object(profile, "active Profile")
        _exact_fields(
            profile_value,
            allowed={"id", "root"},
            required={"id", "root"},
            label="active Profile",
        )
        _text(profile_value.get("id"), "active Profile.id")
        if _ROOT.fullmatch(str(profile_value.get("root") or "")) is None:
            raise ValueError("active Profile.root must be a sha256 root")
    result["workRef"] = validate_work_ref(result.get("workRef"))
    entrypoints = _object(result.get("entrypoints"), "AgentConsoleEnvelope.entrypoints")
    entrypoint_fields = {"context", "capabilities", "profiles", "bindWork"}
    _exact_fields(
        entrypoints,
        allowed=entrypoint_fields,
        required=entrypoint_fields,
        label="AgentConsoleEnvelope.entrypoints",
    )
    for field in entrypoint_fields:
        argv = entrypoints[field]
        if (
            not isinstance(argv, list)
            or not argv
            or not all(isinstance(item, str) for item in argv)
        ):
            raise ValueError(f"AgentConsoleEnvelope.entrypoints.{field} must be argv")
    limits = result.get("knownLimits")
    if not isinstance(limits, list) or not all(
        isinstance(item, str) for item in limits
    ):
        raise ValueError("AgentConsoleEnvelope.knownLimits must be a text array")
    envelope_root = result.pop("envelopeRoot")
    expected_root = semantic_root(result)
    result["envelopeRoot"] = envelope_root
    if envelope_root != expected_root:
        raise ValueError(
            "AgentConsoleEnvelope.envelopeRoot does not match its canonical body"
        )
    return result
