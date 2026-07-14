# SPDX-License-Identifier: Apache-2.0

"""Machine-global Agent Runtime Profile catalog.

This module only inspects executable paths and bounded ``--version`` output. It
never reads provider credentials, sessions, billing state, or private logs.
"""

from __future__ import annotations

import copy
import hashlib
import os
import re
import shutil
import subprocess
from datetime import UTC, datetime
from typing import Any, Mapping

from kungfu import config as kungfu_config
from kungfu.rewind.cost.discovery import discover_all_provider_candidates


PROFILE_SCHEMA = "kungfu.agent-runtime-profile/v1"
CATALOG_SCHEMA = "kungfu.agent-runtime-catalog/v1"
VERIFY_SCHEMA = "kungfu.agent-runtime-verification/v1"
PROVIDERS = ("codex", "claude")
BACKENDS = ("tmux", "direct")
CWD_POLICIES = ("workspace-root", "home", "inherit")
_VERSION_TIMEOUT_SECONDS = 5.0
_SEMANTIC_VERSION = re.compile(
    r"(?<![0-9])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)(?![0-9])"
)


def _parse_semantic_version(output: str) -> str | None:
    match = _SEMANTIC_VERSION.search(output)
    return match.group(1) if match else None


def _profile_id(provider: str, path_class: str, path: str) -> str:
    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()[:12]
    normalized_class = path_class.replace("_", "-")
    return f"{provider}.{normalized_class}.{digest}"


def _label(provider: str, path_class: str) -> str:
    provider_label = "Codex" if provider == "codex" else "Claude"
    source = "App CLI" if path_class == "codex_app_bundle" else "PATH CLI"
    return f"{provider_label} · {source}"


def _profile(
    *,
    profile_id: str,
    label: str,
    provider: str,
    executable: str,
    argv: list[str] | None = None,
    shell_mode: bool = False,
    cwd_policy: str = "workspace-root",
    backend: str = "tmux",
    envelope: str = "required",
    source: str = "user",
    last_verified: str | None = None,
) -> dict[str, Any]:
    return {
        "schema": PROFILE_SCHEMA,
        "id": profile_id,
        "label": label,
        "provider": provider,
        "launch": {
            "executable": executable,
            "argv": list(argv or []),
            "shellMode": shell_mode,
        },
        "cwdPolicy": cwd_policy,
        "backendDefault": backend,
        "bootstrap": {"adapter": provider, "envelope": envelope},
        "source": source,
        "lastVerified": last_verified,
    }


def _validate_profile(profile: Mapping[str, Any], contract: dict[str, Any]) -> None:
    probe = kungfu_config.raw_default_config()
    probe["agent"]["runtimeProfiles"] = [copy.deepcopy(dict(profile))]
    probe["agent"]["defaultRuntimeProfile"] = profile.get("id")
    kungfu_config.validate_config(probe, contract=contract)
    provider = profile.get("provider")
    adapter = (profile.get("bootstrap") or {}).get("adapter")
    if adapter != provider:
        raise ValueError("Agent Runtime Profile bootstrap adapter must match provider")


def resolve_executable(value: str) -> str:
    expanded = (
        os.path.abspath(os.path.expanduser(value)) if os.path.sep in value else None
    )
    resolved = (
        expanded if expanded and os.access(expanded, os.X_OK) else shutil.which(value)
    )
    if not resolved:
        raise ValueError(f"Agent Runtime Profile executable is not available: {value}")
    return os.path.abspath(resolved)


def discover_catalog(
    *,
    resolved_config: Mapping[str, Any] | None = None,
    discovery_kwargs: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    resolved = dict(resolved_config or kungfu_config.resolve_config())
    agent_config = dict((resolved.get("config") or {}).get("agent") or {})
    backend = str(agent_config.get("backendDefault") or "tmux")
    discovered = discover_all_provider_candidates(**dict(discovery_kwargs or {}))
    candidates: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    for provider in PROVIDERS:
        rows = discovered.get(provider, [])
        if not rows:
            diagnostics.append(
                {
                    "provider": provider,
                    "available": False,
                    "message": "no executable found on PATH or a known location",
                }
            )
        for row in rows:
            if not row.path or not row.path_class:
                continue
            profile = _profile(
                profile_id=_profile_id(provider, row.path_class, row.path),
                label=_label(provider, row.path_class),
                provider=provider,
                executable=row.path,
                backend=backend,
                source="discovered",
            )
            candidates.append(
                {
                    "profile": profile,
                    "pathClass": row.path_class,
                    "version": row.version,
                    "available": True,
                    "candidatesChecked": row.candidates_checked,
                }
            )
    configured = copy.deepcopy(agent_config.get("runtimeProfiles") or [])
    configured_ids = {row.get("id") for row in configured}
    explicit_default = agent_config.get("defaultRuntimeProfile")
    available_ids = [row["profile"]["id"] for row in candidates]
    recommended = (
        explicit_default
        if explicit_default in configured_ids or explicit_default in available_ids
        else (available_ids[0] if available_ids else None)
    )
    return {
        "schema": CATALOG_SCHEMA,
        "configPath": resolved.get("configPath"),
        "configured": configured,
        "discovered": candidates,
        "defaultProfileId": explicit_default,
        "recommendedProfileId": recommended,
        "backendDefault": backend,
        "startupView": agent_config.get("startupView") or "profile-home",
        "diagnostics": diagnostics,
        "privacyBoundary": [
            "PATH and known executable locations only",
            "bounded --version probe only",
            "no provider auth, keychain, session, billing, or private log reads",
        ],
    }


def configured_profiles(
    *, config_home: str | None = None, runtime_home: str | None = None
) -> list[dict[str, Any]]:
    resolved = kungfu_config.resolve_config(
        config_home=config_home, runtime_home=runtime_home
    )
    return copy.deepcopy(resolved["config"]["agent"]["runtimeProfiles"])


def plan_upsert(
    *,
    profile_id: str,
    label: str,
    provider: str,
    executable: str,
    argv: list[str] | None = None,
    shell_mode: bool = False,
    cwd_policy: str = "workspace-root",
    backend: str = "tmux",
    envelope: str = "required",
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, Any]:
    contract = kungfu_config.load_contract()
    resolved_executable = resolve_executable(executable)
    profile = _profile(
        profile_id=profile_id,
        label=label,
        provider=provider,
        executable=resolved_executable,
        argv=argv,
        shell_mode=shell_mode,
        cwd_policy=cwd_policy,
        backend=backend,
        envelope=envelope,
    )
    _validate_profile(profile, contract)
    current = configured_profiles(config_home=config_home, runtime_home=runtime_home)
    previous = next((row for row in current if row.get("id") == profile_id), None)
    next_profiles = [row for row in current if row.get("id") != profile_id]
    next_profiles.append(profile)
    return {
        "schema": "kungfu.agent-runtime-profile-plan/v1",
        "action": "update" if previous else "add",
        "profile": profile,
        "previous": previous,
        "runtimeProfiles": next_profiles,
        "effects": ["write machine-global Kungfu config"],
        "requiresExecute": True,
    }


def apply_upsert(
    plan: Mapping[str, Any],
    *,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, Any]:
    if plan.get("schema") != "kungfu.agent-runtime-profile-plan/v1":
        raise ValueError("Agent Runtime Profile apply requires an exact plan")
    resolved = kungfu_config.set_user_config_value(
        "agent.runtimeProfiles",
        copy.deepcopy(plan["runtimeProfiles"]),
        config_home=config_home,
        runtime_home=runtime_home,
    )
    return {
        "schema": "kungfu.agent-runtime-profile-receipt/v1",
        "action": plan["action"],
        "profileId": plan["profile"]["id"],
        "configPath": resolved["configPath"],
        "changed": True,
    }


def plan_remove(
    profile_id: str, *, config_home: str | None = None, runtime_home: str | None = None
) -> dict[str, Any]:
    current = configured_profiles(config_home=config_home, runtime_home=runtime_home)
    previous = next((row for row in current if row.get("id") == profile_id), None)
    if previous is None:
        raise ValueError(f"Agent Runtime Profile not found: {profile_id}")
    return {
        "schema": "kungfu.agent-runtime-profile-remove-plan/v1",
        "profileId": profile_id,
        "previous": previous,
        "runtimeProfiles": [row for row in current if row.get("id") != profile_id],
        "effects": ["remove one machine-global launch profile"],
        "requiresExecute": True,
    }


def apply_remove(
    plan: Mapping[str, Any],
    *,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, Any]:
    if plan.get("schema") != "kungfu.agent-runtime-profile-remove-plan/v1":
        raise ValueError("Agent Runtime Profile removal requires an exact plan")
    resolved = kungfu_config.set_user_config_value(
        "agent.runtimeProfiles",
        copy.deepcopy(plan["runtimeProfiles"]),
        config_home=config_home,
        runtime_home=runtime_home,
    )
    if resolved["config"]["agent"].get("defaultRuntimeProfile") == plan["profileId"]:
        resolved = kungfu_config.set_user_config_value(
            "agent.defaultRuntimeProfile",
            None,
            config_home=config_home,
            runtime_home=runtime_home,
        )
    return {
        "schema": "kungfu.agent-runtime-profile-remove-receipt/v1",
        "profileId": plan["profileId"],
        "configPath": resolved["configPath"],
        "changed": True,
    }


def set_default(
    profile_id: str,
    *,
    execute: bool,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, Any]:
    resolved = kungfu_config.resolve_config(
        config_home=config_home, runtime_home=runtime_home
    )
    configured = resolved["config"]["agent"]["runtimeProfiles"]
    known = {row.get("id") for row in configured}
    if profile_id not in known:
        catalog = discover_catalog(resolved_config=resolved)
        known.update(row["profile"]["id"] for row in catalog["discovered"])
    if profile_id not in known:
        raise ValueError(
            f"Agent Runtime Profile is not configured or discovered: {profile_id}"
        )
    receipt = {
        "schema": "kungfu.agent-runtime-default-plan/v1",
        "profileId": profile_id,
        "previous": resolved["config"]["agent"].get("defaultRuntimeProfile"),
        "execute": execute,
        "changed": False,
    }
    if execute:
        updated = kungfu_config.set_user_config_value(
            "agent.defaultRuntimeProfile",
            profile_id,
            config_home=config_home,
            runtime_home=runtime_home,
        )
        receipt.update(
            {
                "schema": "kungfu.agent-runtime-default-receipt/v1",
                "configPath": updated["configPath"],
                "changed": True,
            }
        )
    return receipt


def verify_profile(profile: Mapping[str, Any]) -> dict[str, Any]:
    executable = str((profile.get("launch") or {}).get("executable") or "")
    available = bool(
        executable and os.path.isfile(executable) and os.access(executable, os.X_OK)
    )
    version = None
    error = None
    if available:
        try:
            result = subprocess.run(
                [executable, "--version"],
                capture_output=True,
                text=True,
                timeout=_VERSION_TIMEOUT_SECONDS,
                check=False,
            )
            text = (result.stdout or result.stderr or "").strip()
            if result.returncode != 0:
                error = f"version probe exited {result.returncode}"
            elif text:
                version = _parse_semantic_version(text.splitlines()[0])
                if version is None:
                    error = "version probe did not return a semantic version"
            else:
                error = "version probe returned no output"
        except (OSError, subprocess.SubprocessError) as exc:
            error = str(exc)
    else:
        error = "executable is missing or not executable"
    return {
        "schema": VERIFY_SCHEMA,
        "profileId": profile.get("id"),
        "provider": profile.get("provider"),
        "executable": executable,
        "argv": ["--version"],
        "available": available,
        "version": version,
        "ok": available and error is None,
        "error": error,
        "observedAt": datetime.now(UTC).isoformat(),
        "privacyBoundary": "bounded executable --version probe only",
    }


def find_profile(
    profile_id: str, *, config_home: str | None = None, runtime_home: str | None = None
) -> dict[str, Any]:
    resolved = kungfu_config.resolve_config(
        config_home=config_home, runtime_home=runtime_home
    )
    catalog = discover_catalog(resolved_config=resolved)
    for profile in catalog["configured"]:
        if profile.get("id") == profile_id:
            return profile
    for row in catalog["discovered"]:
        if row["profile"].get("id") == profile_id:
            return row["profile"]
    raise ValueError(f"Agent Runtime Profile not found: {profile_id}")
