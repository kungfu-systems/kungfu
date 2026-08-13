# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral Runtime Profile discovery catalog."""

from __future__ import annotations

import copy
from importlib import import_module
from typing import Any, Callable, Mapping

from kungfu import config as kungfu_config


def unavailable_provider_diagnostic(provider: str) -> dict[str, Any]:
    """Describe one provider that has no bounded discovery candidate."""

    return {
        "provider": provider,
        "available": False,
        "message": "no executable found on PATH or a known location",
    }


def recommended_profile_id(
    explicit_default: Any,
    configured_ids: set[Any],
    available_ids: list[str],
) -> str | None:
    """Choose only an explicit valid default or the first verified candidate."""

    if explicit_default in configured_ids or explicit_default in available_ids:
        return str(explicit_default)
    return available_ids[0] if available_ids else None


def _runtime_profiles():
    return import_module("kungfu.agent.runtime_profiles")


def human_agent_catalog(
    *, config_home: str | None = None, runtime_home: str | None = None
) -> dict[str, Any]:
    """Return a deduplicated human projection without reading credentials."""

    payload = _runtime_profiles().discover_catalog(
        resolved_config=kungfu_config.resolve_config(
            config_home=config_home, runtime_home=runtime_home
        )
    )
    discovered = {
        row["profile"]["id"]: row
        for row in payload.get("discovered", [])
        if isinstance(row, Mapping)
        and isinstance(row.get("profile"), Mapping)
        and row["profile"].get("id")
    }
    configured_profiles = payload.get("configured", [])
    agents: list[dict[str, Any]] = []
    seen: set[str] = set()
    for profile in [
        *configured_profiles,
        *(row["profile"] for row in payload.get("discovered", [])),
    ]:
        profile_id = str(profile.get("id") or "")
        if not profile_id or profile_id in seen:
            continue
        seen.add(profile_id)
        discovery = discovered.get(profile_id, {})
        configured = profile in configured_profiles
        verification: Mapping[str, Any] = {}
        if configured and profile_id not in discovered:
            try:
                verification = _runtime_profiles().verify_profile(profile)
            except (OSError, RuntimeError, TypeError, ValueError):
                verification = {"ok": False}
        agents.append(
            {
                "id": profile_id,
                "label": str(profile.get("label") or profile_id),
                "provider": str(profile.get("provider") or ""),
                "source": str(profile.get("source") or "configured"),
                "configured": configured,
                "discovered": profile_id in discovered,
                "available": bool(
                    discovery.get("available", verification.get("ok", False))
                ),
                "version": discovery.get("version") or verification.get("version"),
                "default": profile_id == payload.get("defaultProfileId"),
                "recommended": profile_id == payload.get("recommendedProfileId"),
            }
        )
    return {**payload, "agents": agents, "credentialContentsRead": False}


def resolve_human_selector(
    selector: str | None,
    *,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """Resolve a human selector to one exact Runtime Profile id."""

    catalog = _runtime_profiles().human_agent_catalog(
        config_home=config_home, runtime_home=runtime_home
    )
    agents = list(catalog["agents"])
    requested = str(selector or "default").strip()
    folded = requested.casefold()
    if folded in {"default", "recommended"}:
        profile_id = (
            catalog.get("defaultProfileId")
            if folded == "default"
            else catalog.get("recommendedProfileId")
        ) or catalog.get("recommendedProfileId")
        if profile_id:
            return str(profile_id), catalog
        raise ValueError(
            "no default Agent is available; install an Agent CLI or run "
            "`kungfu agent runtime discover`"
        )
    exact = [row for row in agents if str(row["id"]).casefold() == folded]
    labels = [row for row in agents if str(row["label"]).casefold() == folded]
    providers = [row for row in agents if str(row["provider"]).casefold() == folded]
    matches = exact or list(
        {str(row["id"]): row for row in [*labels, *providers]}.values()
    )
    if len(matches) == 1:
        return str(matches[0]["id"]), catalog
    if len(matches) > 1:
        for preference in ("default", "recommended", "configured"):
            preferred = [row for row in matches if row.get(preference) is True]
            if len(preferred) == 1:
                return str(preferred[0]["id"]), catalog
        choices = ", ".join(str(row["id"]) for row in matches)
        raise ValueError(f"Agent selector {requested!r} is ambiguous: {choices}")
    raise ValueError(
        f"Agent {requested!r} is unavailable; run `kungfu agent-work-lab agents`"
    )


class RuntimeProfileCatalog:
    """Combine configured profiles with provider discovery candidates."""

    def __init__(
        self,
        *,
        schema: str,
        providers: tuple[str, ...],
        resolve_config: Callable[[], Mapping[str, Any]],
        adapters: Callable[..., Mapping[str, Mapping[str, Any]]],
        discover_all: Callable[..., Mapping[str, list[Any]]],
        discover_custom: Callable[..., list[Any]],
        build_profile: Callable[..., dict[str, Any]],
        profile_id: Callable[[str, str, str], str],
        profile_label: Callable[..., str],
    ) -> None:
        self.schema = schema
        self.providers = providers
        self.resolve_config = resolve_config
        self.adapters = adapters
        self.discover_all = discover_all
        self.discover_custom = discover_custom
        self.build_profile = build_profile
        self.profile_id = profile_id
        self.profile_label = profile_label

    def discover(
        self,
        *,
        resolved_config: Mapping[str, Any] | None = None,
        discovery_kwargs: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        resolved = dict(resolved_config or self.resolve_config())
        agent_config = dict((resolved.get("config") or {}).get("agent") or {})
        backend = str(agent_config.get("backendDefault") or "tmux")
        kwargs = dict(discovery_kwargs or {})
        discovered = dict(self.discover_all(**kwargs))
        adapters = self.adapters(resolved_config=resolved)
        for provider, adapter in adapters.items():
            if provider in self.providers:
                continue
            discovered[provider] = self.discover_custom(adapter, **kwargs)
        candidates: list[dict[str, Any]] = []
        diagnostics: list[dict[str, Any]] = []
        for provider, adapter in adapters.items():
            rows = discovered.get(provider, [])
            if not rows:
                diagnostics.append(unavailable_provider_diagnostic(provider))
            for row in rows:
                if not row.path or not row.path_class:
                    continue
                profile = self.build_profile(
                    profile_id=self.profile_id(provider, row.path_class, row.path),
                    label=self.profile_label(provider, row.path_class),
                    provider=provider,
                    executable=row.path,
                    version_argv=list(adapter["discovery"]["versionArgv"]),
                    backend=backend,
                    source="discovered",
                )
                profile["label"] = self.profile_label(
                    provider,
                    row.path_class,
                    provider_label=str(adapter.get("label") or provider),
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
        recommended = recommended_profile_id(
            explicit_default,
            configured_ids,
            available_ids,
        )
        return {
            "schema": self.schema,
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
