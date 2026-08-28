# SPDX-License-Identifier: Apache-2.0

"""Canonical Agent Session value validation shared by CLI builders.

The JSON Schema in ``framework/agent-session/schemas`` is the public contract.
This dependency-free runtime validator keeps the installed Python front door
fail-closed without requiring a JSON Schema package at runtime.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from pathlib import Path
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
    "skillRuntimeAudit",
    "bootstrap",
    "envelopeRoot",
}
_ENVELOPE_REQUIRED_FIELDS = _ENVELOPE_FIELDS - {"bootstrap", "skillRuntimeAudit"}


def native_cli_front_door(ambient: Mapping[str, Any], env: dict[str, str]) -> str:
    """Resolve the executable Kungfu front door exposed to a native Agent."""

    configured = str(ambient.get("KUNGFU_CLI_BIN") or "").strip()
    candidate = configured or shutil.which(
        "kungfu", path=str(ambient.get("PATH") or "")
    )
    if configured and not os.path.isabs(os.path.expanduser(configured)):
        candidate = shutil.which(configured, path=str(ambient.get("PATH") or ""))
    if not candidate:
        return "kungfu"
    cli_path = Path(candidate).expanduser().absolute()
    if not cli_path.is_file() or not os.access(cli_path, os.X_OK):
        raise ValueError("KUNGFU_CLI_BIN must identify an executable Kungfu front door")
    env["KUNGFU_CLI_BIN"] = str(cli_path)
    return str(cli_path)


def qualified_work_control_profile(
    runtime_dir: str, work_ref: Mapping[str, Any] | None
):
    """Resolve and verify the exact Work Control Profile for native launch."""

    from kungfu.assignment_runtime import profile_lifecycle

    profile = profile_lifecycle.resolve_qualified_work_profile(
        runtime_dir, required=False
    )
    if work_ref is not None:
        if profile is None:
            raise ValueError(
                "bound native Agent Console requires a qualified active Work Control Profile"
            )
        if (
            str(work_ref.get("profileId") or "") != profile["id"]
            or str(work_ref.get("profileRoot") or "") != profile["root"]
        ):
            raise ValueError(
                "native Agent WorkRef does not match the exact qualified Work Control Profile root"
            )
    return profile


def active_profile_roots(
    profile: Mapping[str, Any] | None,
) -> list[dict[str, str]]:
    """Project a qualified profile into the public Agent Console envelope."""

    if profile is None:
        return []
    return [{"id": str(profile["id"]), "root": str(profile["root"])}]


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


def retain_expected_work_ref(current, expected) -> dict[str, Any]:
    """Preserve a planned WorkRef when its stable coordinates remain current."""

    value = validate_work_ref(current)
    if expected is None:
        return value
    retained = validate_work_ref(dict(expected.get("workRef") or {}))
    stable_fields = (
        "workspaceId",
        "profileId",
        "profileRoot",
        "entityType",
        "entityId",
        "entityRoot",
        "purpose",
        "initiativeId",
    )
    if any(retained.get(field) != value.get(field) for field in stable_fields):
        raise ValueError(
            "expected WorkRef does not match the current Assignment coordinates"
        )
    return retained


def require_expected_binding(expected, work_ref, session) -> None:
    """Fail before mutation when a planned native binding has drifted."""

    if expected is None:
        return
    if dict(expected.get("workRef") or {}) != work_ref:
        raise ValueError("native Work binding drifted from expected WorkRef")
    if dict(expected.get("session") or {}) != session:
        raise ValueError("native Work binding drifted to another SessionAttempt")


def validate_agent_console_envelope(
    value: Mapping[str, Any],
) -> dict[str, Any]:
    result = _object(value, "AgentConsoleEnvelope")
    _exact_fields(
        result,
        allowed=_ENVELOPE_FIELDS,
        required=_ENVELOPE_REQUIRED_FIELDS,
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
    if "skillRuntimeAudit" in result:
        audit = _object(
            result.get("skillRuntimeAudit"),
            "AgentConsoleEnvelope.skillRuntimeAudit",
        )
        audit_fields = {
            "schema",
            "path",
            "runtimeAuditRoot",
            "registryStateRoot",
            "historyRoot",
            "diagnosisRoot",
            "catalogRoot",
            "decisionPolicyRoot",
            "workRefRoot",
            "kfxDependencyRoots",
            "receiptRoots",
            "recoveryRoot",
            "entrypoints",
            "authority",
        }
        _exact_fields(
            audit,
            allowed=audit_fields,
            required=audit_fields,
            label="AgentConsoleEnvelope.skillRuntimeAudit",
        )
        if audit.get("schema") != "kungfu.skill-runtime-audit-pointer/v1":
            raise ValueError(
                "AgentConsoleEnvelope.skillRuntimeAudit.schema is unsupported"
            )
        _text(audit.get("path"), "AgentConsoleEnvelope.skillRuntimeAudit.path")
        for field in (
            "runtimeAuditRoot",
            "registryStateRoot",
            "historyRoot",
            "diagnosisRoot",
            "catalogRoot",
            "decisionPolicyRoot",
            "recoveryRoot",
        ):
            if _ROOT.fullmatch(str(audit.get(field) or "")) is None:
                raise ValueError(
                    f"AgentConsoleEnvelope.skillRuntimeAudit.{field} must be a sha256 root"
                )
        work_ref_root = audit.get("workRefRoot")
        if work_ref_root is not None and _ROOT.fullmatch(str(work_ref_root)) is None:
            raise ValueError(
                "AgentConsoleEnvelope.skillRuntimeAudit.workRefRoot must be null or a sha256 root"
            )
        for field in ("kfxDependencyRoots", "receiptRoots"):
            roots = audit.get(field)
            if (
                not isinstance(roots, list)
                or len(roots) != len(set(roots))
                or any(_ROOT.fullmatch(str(root)) is None for root in roots)
            ):
                raise ValueError(
                    f"AgentConsoleEnvelope.skillRuntimeAudit.{field} must be unique sha256 roots"
                )
        entrypoints = _object(
            audit.get("entrypoints"),
            "AgentConsoleEnvelope.skillRuntimeAudit.entrypoints",
        )
        entrypoint_fields = {
            "catalog",
            "advise",
            "read",
            "audit",
            "explain",
            "diagnose",
            "kfx",
        }
        _exact_fields(
            entrypoints,
            allowed=entrypoint_fields,
            required=entrypoint_fields,
            label="AgentConsoleEnvelope.skillRuntimeAudit.entrypoints",
        )
        for field in entrypoint_fields:
            argv = entrypoints[field]
            if (
                not isinstance(argv, list)
                or not argv
                or not all(isinstance(item, str) and item for item in argv)
            ):
                raise ValueError(
                    f"AgentConsoleEnvelope.skillRuntimeAudit.entrypoints.{field} must be argv"
                )
        if audit.get("authority") != "read-only-projection":
            raise ValueError(
                "AgentConsoleEnvelope.skillRuntimeAudit.authority must be read-only-projection"
            )
    if "bootstrap" in result:
        bootstrap = _object(result.get("bootstrap"), "AgentConsoleEnvelope.bootstrap")
        bootstrap_fields = {
            "schema",
            "state",
            "attemptId",
            "receiptRoot",
            "mutationsAllowed",
        }
        _exact_fields(
            bootstrap,
            allowed=bootstrap_fields,
            required=bootstrap_fields,
            label="AgentConsoleEnvelope.bootstrap",
        )
        if bootstrap.get("schema") != "kungfu.agent-bootstrap-receipt/v1":
            raise ValueError("AgentConsoleEnvelope.bootstrap.schema is unsupported")
        if bootstrap.get("state") not in {"pending", "verified", "degraded"}:
            raise ValueError("AgentConsoleEnvelope.bootstrap.state is unsupported")
        if bootstrap.get("attemptId") != result["attemptId"]:
            raise ValueError(
                "AgentConsoleEnvelope.bootstrap.attemptId must match attemptId"
            )
        if _ROOT.fullmatch(str(bootstrap.get("receiptRoot") or "")) is None:
            raise ValueError(
                "AgentConsoleEnvelope.bootstrap.receiptRoot must be a sha256 root"
            )
        mutations_allowed = bootstrap.get("mutationsAllowed")
        if not isinstance(mutations_allowed, bool):
            raise ValueError(
                "AgentConsoleEnvelope.bootstrap.mutationsAllowed must be boolean"
            )
        if mutations_allowed is not (bootstrap["state"] == "verified"):
            raise ValueError(
                "AgentConsoleEnvelope.bootstrap mutation state is inconsistent"
            )
    envelope_root = result.pop("envelopeRoot")
    expected_root = semantic_root(result)
    result["envelopeRoot"] = envelope_root
    if envelope_root != expected_root:
        raise ValueError(
            "AgentConsoleEnvelope.envelopeRoot does not match its canonical body"
        )
    return result
