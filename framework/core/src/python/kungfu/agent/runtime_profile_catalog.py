# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral Runtime Profile discovery catalog."""

from __future__ import annotations

import copy
from typing import Any, Callable, Mapping


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
