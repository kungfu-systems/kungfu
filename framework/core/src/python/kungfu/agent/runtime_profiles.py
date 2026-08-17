# SPDX-License-Identifier: Apache-2.0

"""Machine-global, credential-blind Agent Runtime Profile catalog."""

from __future__ import annotations

import copy
import hashlib
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Mapping

from kungfu import config as kungfu_config
from kungfu.agent import resources as agent_resources
from kungfu.agent.provider_bootstrap import (
    ProviderBootstrapAdapter,
    validate_file_paths as _validate_file_paths,
    validate_templates as _validate_templates,
)
from kungfu.agent.verification_probe import VerificationProbe
from kungfu.agent.runtime_profile_catalog import (
    RuntimeProfileCatalog,
    human_agent_catalog as human_agent_catalog,
    resolve_human_selector as resolve_human_selector,
)
from kungfu.agent.runtime_profile_store import RuntimeProfileStore
from kungfu.rewind.cost.discovery import (
    ProviderDiscovery,
    discover_all_provider_candidates,
)


ADAPTER_SCHEMA = "kungfu.native-provider-adapter/v1"
BUILTIN_PROVIDERS = ("codex", "claude", "amp", "opencode")


def policy_payload(runtime_dir, target, mode, enabled=True):
    closeout_gate = enabled and mode in {"report", "managed-run"}
    return {
        "schema": "kungfu.agent-policy/v1",
        "target": target,
        "mode": mode,
        "enabled": enabled,
        "reportCloseoutGate": closeout_gate,
        "reportAdapter": "kungfu work claim-completion"
        if target == "codex"
        else "kungfu report run begin",
        "receiptVerifier": "kungfu work status"
        if target == "codex"
        else "kungfu report run end",
        "runtimeDir": runtime_dir,
    }


def _builtin_skill(provider: str) -> str:
    return str(agent_resources.skill_path(provider))


def builtin_adapters() -> dict[str, dict[str, Any]]:
    """Return built-ins in the same public shape accepted from config."""

    shared: dict[str, dict[str, Any]] = {
        "codex": {
            "label": "Codex",
            "discovery": {
                "executableNames": ["codex"],
                "knownPaths": ["/Applications/Codex.app/Contents/Resources/codex"],
                "versionArgv": ["--version"],
            },
            "credentialEnvironment": ["OPENAI_API_KEY", "CODEX_HOME"],
            "skill": {
                "source": _builtin_skill("codex"),
                "argv": [
                    "-c",
                    "log_dir={provider_log_dir:json}",
                    "--no-alt-screen",
                    "-c",
                    "skills.config=[{path={skill_dir:json},enabled=true}]",
                ],
                "environment": {},
                "environmentJson": {},
                "files": [],
            },
            "knownLimits": [
                "Codex uses its native inline TUI so Project trust prompts and "
                "startup errors remain in terminal scrollback"
            ],
        },
        "claude": {
            "label": "Claude",
            "discovery": {
                "executableNames": ["claude"],
                "knownPaths": [],
                "versionArgv": ["--version"],
            },
            "credentialEnvironment": ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
            "skill": {
                "source": _builtin_skill("claude"),
                "argv": ["--append-system-prompt-file", "{skill_file}"],
                "environment": {},
                "environmentJson": {},
                "files": [],
            },
            "knownLimits": [],
        },
        "amp": {
            "label": "Amp",
            "discovery": {
                "executableNames": ["amp"],
                "knownPaths": [],
                "versionArgv": ["--version"],
            },
            "credentialEnvironment": [],
            "skill": {
                "source": _builtin_skill("amp"),
                "argv": ["--settings-file", "{adapter_root}/settings.json"],
                "environment": {},
                "environmentJson": {},
                "files": [
                    {
                        "path": "settings.json",
                        "content": {"amp.skills.path": "{skills_root}"},
                    }
                ],
            },
            "knownLimits": [
                "Amp uses a session-scoped user-settings overlay to advertise "
                "the Kungfu Skill; workspace settings and provider "
                "authentication remain external"
            ],
        },
        "opencode": {
            "label": "OpenCode",
            "discovery": {
                "executableNames": ["opencode"],
                "knownPaths": [],
                "versionArgv": ["--version"],
            },
            "credentialEnvironment": [],
            "skill": {
                "source": _builtin_skill("opencode"),
                "argv": [],
                "environment": {},
                "environmentJson": {
                    "OPENCODE_CONFIG_CONTENT": {"instructions": ["{skill_file}"]}
                },
                "files": [],
            },
            "knownLimits": [],
        },
    }
    return {
        provider: {"schema": ADAPTER_SCHEMA, "id": provider, **definition}
        for provider, definition in shared.items()
    }


def _agent_config(resolved_config: Mapping[str, Any]) -> Mapping[str, Any]:
    config = resolved_config.get("config") or resolved_config
    return dict(config.get("agent") or {})


def adapter_catalog(
    *,
    resolved_config: Mapping[str, Any] | None = None,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Merge built-ins with configured third-party adapters, fail closed."""

    resolved = resolved_config or kungfu_config.resolve_config(
        config_home=config_home, runtime_home=runtime_home
    )
    result = builtin_adapters()
    seen: set[str] = set()
    for raw in _agent_config(resolved).get("nativeProviderAdapters") or []:
        adapter = copy.deepcopy(dict(raw))
        adapter_id = str(adapter.get("id") or "")
        if adapter_id in result:
            raise ValueError(
                f"native Provider adapter cannot replace built-in provider: {adapter_id}"
            )
        if adapter_id in seen:
            raise ValueError(f"duplicate native Provider adapter: {adapter_id}")
        discovery = dict(adapter.get("discovery") or {})
        if not (discovery.get("executableNames") or discovery.get("knownPaths")):
            raise ValueError(
                f"native Provider adapter {adapter_id} requires a discovery candidate"
            )
        for known_path in discovery.get("knownPaths") or []:
            if not os.path.isabs(os.path.expanduser(str(known_path))):
                raise ValueError(
                    f"native Provider adapter {adapter_id} knownPaths must be absolute"
                )
        skill_source = os.path.expanduser(
            str(adapter.get("skill", {}).get("source") or "")
        )
        if not os.path.isabs(skill_source):
            raise ValueError(
                f"native Provider adapter {adapter_id} Skill source must be absolute"
            )
        _validate_file_paths(adapter_id, adapter)
        _validate_templates(adapter_id, adapter)
        result[adapter_id] = adapter
        seen.add(adapter_id)
    process_environment = _agent_config(resolved).get("nativeProcessEnvironment") or []
    for adapter in result.values():
        adapter["processEnvironment"] = list(process_environment)
    return result


def resolve_adapter(
    adapter_id: str,
    *,
    resolved_config: Mapping[str, Any] | None = None,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, Any]:
    catalog = adapter_catalog(
        resolved_config=resolved_config,
        config_home=config_home,
        runtime_home=runtime_home,
    )
    if adapter_id not in catalog:
        raise ValueError(
            f"native Provider adapter is not registered: {adapter_id}; configure "
            "agent.nativeProviderAdapters first"
        )
    return copy.deepcopy(catalog[adapter_id])


def materialize_adapter(
    adapter_id: str,
    *,
    runtime_dir: str,
    session_id: str | None = None,
    resolved_config: Mapping[str, Any] | None = None,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, Any]:
    """Materialize one adapter under Kungfu runtime state only."""
    return ProviderBootstrapAdapter(
        resolve=resolve_adapter,
        schema=ADAPTER_SCHEMA,
    ).materialize(
        adapter_id,
        runtime_dir=runtime_dir,
        session_id=session_id,
        resolved_config=resolved_config,
        config_home=config_home,
        runtime_home=runtime_home,
    )


PROFILE_SCHEMA = "kungfu.agent-runtime-profile/v1"
CATALOG_SCHEMA = "kungfu.agent-runtime-catalog/v1"
VERIFY_SCHEMA = "kungfu.agent-runtime-verification/v1"
PROVIDERS = BUILTIN_PROVIDERS
MOCK_SCENARIOS = (
    "complete",
    "deliverable",
    "question",
    "approval",
    "blocked",
    "crash",
    "disconnect",
    "multi-step",
    "recovery-delivery",
    "recovery-story",
    "review-fit",
)
BACKENDS = ("tmux", "direct")
CWD_POLICIES = ("workspace-root", "home", "inherit")
_VERSION_TIMEOUT_SECONDS = 5.0
_PROVIDER_VERSION_TIMEOUT_SECONDS = {"amp": 15.0, "synthetic": None}


def _version_timeout_seconds(provider: str) -> float | None:
    return _PROVIDER_VERSION_TIMEOUT_SECONDS.get(provider, _VERSION_TIMEOUT_SECONDS)


def _profile_id(provider: str, path_class: str, path: str) -> str:
    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()[:12]
    normalized_class = path_class.replace("_", "-")
    return f"{provider}.{normalized_class}.{digest}"


def _label(provider: str, path_class: str, *, provider_label: str | None = None) -> str:
    provider_label = {
        "codex": "Codex",
        "claude": "Claude",
        "amp": "Amp",
        "opencode": "OpenCode",
    }.get(provider, provider_label or provider)
    source = {
        "codex_app_bundle": "App CLI",
        "known": "Known path CLI",
    }.get(path_class, "PATH CLI")
    return f"{provider_label} · {source}"


def _profile(
    *,
    profile_id: str,
    label: str,
    provider: str,
    executable: str,
    argv: list[str] | None = None,
    interactive_argv: list[str] | None = None,
    version_argv: list[str] | None = None,
    shell_mode: bool = False,
    cwd_policy: str = "workspace-root",
    backend: str = "tmux",
    envelope: str = "required",
    source: str = "user",
    last_verified: str | None = None,
) -> dict[str, Any]:
    launch = {
        "executable": executable,
        "argv": list(argv or []),
        "interactiveArgv": list(interactive_argv or []),
        "shellMode": shell_mode,
    }
    if version_argv:
        launch["versionArgv"] = list(version_argv)
    return {
        "schema": PROFILE_SCHEMA,
        "id": profile_id,
        "label": label,
        "provider": provider,
        "launch": launch,
        "cwdPolicy": cwd_policy,
        "backendDefault": backend,
        "bootstrap": {"adapter": provider, "envelope": envelope},
        "source": source,
        "lastVerified": last_verified,
    }


def deterministic_mock_profile(
    scenario: str = "multi-step",
    *,
    executable: str | None = None,
    script: str | None = None,
) -> dict[str, Any]:
    """Return the explicit credential-free Mock Agent profile used by qualification."""

    if scenario not in MOCK_SCENARIOS:
        raise ValueError(
            f"unknown Mock Agent scenario: {scenario}; expected {', '.join(MOCK_SCENARIOS)}"
        )
    source_root = Path(__file__).resolve().parents[6]
    script_value = (
        script
        or os.environ.get("KUNGFU_MOCK_AGENT_SCRIPT")
        or str(
            source_root / "framework" / "agent-session" / "src" / "mock-provider.mjs"
        )
    )
    executable_value = (
        executable
        or os.environ.get("KUNGFU_MOCK_AGENT_EXECUTABLE")
        or shutil.which("node")
        or ""
    )
    if not executable_value:
        raise ValueError("Mock Agent requires the bundled Node runtime")
    if not Path(script_value).is_file():
        raise ValueError(f"Mock Agent script is unavailable: {script_value}")
    return _profile(
        profile_id=f"kungfu.mock-agent.{scenario}",
        label=(
            "Mock Reviewer · deterministic-fit"
            if scenario == "review-fit"
            else f"Mock Agent · {scenario}"
        ),
        provider="synthetic",
        executable=os.path.abspath(executable_value),
        argv=[os.path.abspath(script_value), "--scenario", scenario],
        cwd_policy="workspace-root",
        backend="direct",
        source="qualification",
    )


def _validate_profile(
    profile: Mapping[str, Any],
    contract: dict[str, Any],
    *,
    resolved_config: Mapping[str, Any] | None = None,
) -> None:
    probe = copy.deepcopy(contract["defaults"])
    if resolved_config is not None:
        source_config = resolved_config.get("config") or resolved_config
        probe["agent"]["nativeProviderAdapters"] = copy.deepcopy(
            (source_config.get("agent") or {}).get("nativeProviderAdapters") or []
        )
    probe["agent"]["runtimeProfiles"] = [copy.deepcopy(dict(profile))]
    probe["agent"]["defaultRuntimeProfile"] = profile.get("id")
    kungfu_config.validate_config(probe, contract=contract)
    provider = profile.get("provider")
    adapter = (profile.get("bootstrap") or {}).get("adapter")
    if adapter != provider:
        raise ValueError("Agent Runtime Profile bootstrap adapter must match provider")
    resolve_adapter(str(adapter), resolved_config={"config": probe})


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
    return RuntimeProfileCatalog(
        schema=CATALOG_SCHEMA,
        providers=PROVIDERS,
        resolve_config=kungfu_config.resolve_config,
        adapters=adapter_catalog,
        discover_all=discover_all_provider_candidates,
        discover_custom=_discover_configured_adapter,
        build_profile=_profile,
        profile_id=_profile_id,
        profile_label=_label,
    ).discover(
        resolved_config=resolved_config,
        discovery_kwargs=discovery_kwargs,
    )


def _discover_configured_adapter(
    adapter: Mapping[str, Any],
    *,
    which: Any = shutil.which,
    version_probe: Any = None,
    exists: Any = None,
    **_kwargs: Any,
) -> list[ProviderDiscovery]:
    """Discover a configured adapter without provider-specific core code."""

    exists = exists or (lambda path: os.path.isfile(path) and os.access(path, os.X_OK))
    discovery = dict(adapter["discovery"])
    checked: list[tuple[str, str]] = []
    for name in discovery.get("executableNames") or []:
        path = which(str(name))
        if path:
            checked.append((os.path.abspath(path), "path"))
    for value in discovery.get("knownPaths") or []:
        checked.append((os.path.abspath(os.path.expanduser(str(value))), "known"))
    results: list[ProviderDiscovery] = []
    seen: set[str] = set()
    for path, path_class in checked:
        if path in seen or not exists(path):
            continue
        seen.add(path)
        provider = str(adapter["id"])
        version = (
            version_probe(path)
            if version_probe is not None
            else _probe_version(
                path,
                discovery["versionArgv"],
                timeout_seconds=_version_timeout_seconds(provider),
            )
        )
        results.append(
            ProviderDiscovery(
                provider=provider,
                found=True,
                path=path,
                path_class=path_class,
                version=version,
                candidates_checked=[candidate for candidate, _kind in checked],
            )
        )
    return results


def _probe_version(
    executable: str,
    version_argv: list[str],
    *,
    timeout_seconds: float | None = _VERSION_TIMEOUT_SECONDS,
) -> str | None:
    return VerificationProbe(
        schema=VERIFY_SCHEMA,
        default_timeout_seconds=_VERSION_TIMEOUT_SECONDS,
        provider_timeouts=_PROVIDER_VERSION_TIMEOUT_SECONDS,
        run=subprocess.run,
    ).raw_version(
        executable,
        version_argv,
        timeout_seconds=timeout_seconds,
    )


def configured_profiles(
    *, config_home: str | None = None, runtime_home: str | None = None
) -> list[dict[str, Any]]:
    return RuntimeProfileStore(
        resolve_config=kungfu_config.resolve_config,
        set_config_value=kungfu_config.set_user_config_value,
        discover_catalog=discover_catalog,
    ).configured(config_home=config_home, runtime_home=runtime_home)


def plan_upsert(
    *,
    profile_id: str,
    label: str,
    provider: str,
    executable: str,
    argv: list[str] | None = None,
    interactive_argv: list[str] | None = None,
    shell_mode: bool = False,
    cwd_policy: str = "workspace-root",
    backend: str = "tmux",
    envelope: str = "required",
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, Any]:
    contract = kungfu_config.load_contract()
    resolved = kungfu_config.resolve_config(
        config_home=config_home, runtime_home=runtime_home
    )
    adapter = resolve_adapter(provider, resolved_config=resolved)
    resolved_executable = resolve_executable(executable)
    profile = _profile(
        profile_id=profile_id,
        label=label,
        provider=provider,
        executable=resolved_executable,
        argv=argv,
        interactive_argv=interactive_argv,
        version_argv=list(adapter["discovery"]["versionArgv"]),
        shell_mode=shell_mode,
        cwd_policy=cwd_policy,
        backend=backend,
        envelope=envelope,
    )
    _validate_profile(profile, contract, resolved_config=resolved)
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
    return RuntimeProfileStore(
        resolve_config=kungfu_config.resolve_config,
        set_config_value=kungfu_config.set_user_config_value,
        discover_catalog=discover_catalog,
    ).apply_upsert(plan, config_home=config_home, runtime_home=runtime_home)


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
    return RuntimeProfileStore(
        resolve_config=kungfu_config.resolve_config,
        set_config_value=kungfu_config.set_user_config_value,
        discover_catalog=discover_catalog,
    ).apply_remove(plan, config_home=config_home, runtime_home=runtime_home)


def set_default(
    profile_id: str,
    *,
    execute: bool,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, Any]:
    return RuntimeProfileStore(
        resolve_config=kungfu_config.resolve_config,
        set_config_value=kungfu_config.set_user_config_value,
        discover_catalog=discover_catalog,
    ).set_default(
        profile_id,
        execute=execute,
        config_home=config_home,
        runtime_home=runtime_home,
    )


def verify_profile(profile: Mapping[str, Any]) -> dict[str, Any]:
    return VerificationProbe(
        schema=VERIFY_SCHEMA,
        default_timeout_seconds=_VERSION_TIMEOUT_SECONDS,
        provider_timeouts=_PROVIDER_VERSION_TIMEOUT_SECONDS,
        run=subprocess.run,
    ).verify(profile)


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
