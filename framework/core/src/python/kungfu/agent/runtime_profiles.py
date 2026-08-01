# SPDX-License-Identifier: Apache-2.0

"""Machine-global Agent Runtime Profile catalog.

This module only inspects executable paths and bounded ``--version`` output. It
never reads provider credentials, sessions, billing state, or private logs.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping
import uuid

from kungfu import config as kungfu_config
from kungfu.agent import resources as agent_resources
from kungfu.rewind.cost.discovery import (
    ProviderDiscovery,
    discover_all_provider_candidates,
)


ADAPTER_SCHEMA = "kungfu.native-provider-adapter/v1"
BUILTIN_PROVIDERS = ("codex", "claude", "amp", "opencode")
_TEMPLATE = re.compile(
    r"\{(skill_file|skill_dir|skills_root|adapter_root|provider_log_dir)(:json)?\}"
)
_UNRESOLVED_TEMPLATE = re.compile(r"\{[a-z_]+(?::json)?\}")


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


def _validate_file_paths(adapter_id: str, adapter: Mapping[str, Any]) -> None:
    seen: set[str] = set()
    for row in dict(adapter.get("skill") or {}).get("files") or []:
        relative = Path(str(row.get("path") or ""))
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ValueError(
                f"native Provider adapter {adapter_id} has unsafe runtime file path: "
                f"{relative}"
            )
        normalized = relative.as_posix()
        if normalized in seen:
            raise ValueError(
                f"native Provider adapter {adapter_id} repeats runtime file path: "
                f"{normalized}"
            )
        seen.add(normalized)


def _validate_templates(adapter_id: str, adapter: Mapping[str, Any]) -> None:
    paths = {
        "adapter_root": "/kungfu/runtime/adapter",
        "skills_root": "/kungfu/runtime/adapter/skills",
        "skill_dir": "/kungfu/runtime/adapter/skills/kungfu-agent-onboarding",
        "skill_file": "/kungfu/runtime/adapter/skills/kungfu-agent-onboarding/SKILL.md",
        "provider_log_dir": "/kungfu/runtime/native-attempt/provider-logs/agent",
    }
    skill = dict(adapter.get("skill") or {})
    duplicate_environment = set(skill.get("environment") or {}).intersection(
        skill.get("environmentJson") or {}
    )
    if duplicate_environment:
        names = ", ".join(sorted(str(value) for value in duplicate_environment))
        raise ValueError(
            f"native Provider adapter {adapter_id} repeats environment keys: {names}"
        )
    try:
        _render(skill.get("argv") or [], paths)
        _render(skill.get("environment") or {}, paths)
        _render(skill.get("environmentJson") or {}, paths)
        _render([row.get("content") for row in skill.get("files") or []], paths)
    except ValueError as error:
        raise ValueError(
            f"native Provider adapter {adapter_id} has an invalid template: {error}"
        ) from error


def _render_text(value: str, paths: Mapping[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        rendered = paths[match.group(1)]
        return json.dumps(rendered, ensure_ascii=False) if match.group(2) else rendered

    rendered = _TEMPLATE.sub(replace, value)
    unresolved = _UNRESOLVED_TEMPLATE.search(rendered)
    if unresolved:
        raise ValueError(
            f"unsupported native Provider adapter template: {unresolved.group(0)}"
        )
    return rendered


def _render(value: Any, paths: Mapping[str, str]) -> Any:
    if isinstance(value, str):
        return _render_text(value, paths)
    if isinstance(value, list):
        return [_render(item, paths) for item in value]
    if isinstance(value, dict):
        return {str(key): _render(item, paths) for key, item in value.items()}
    return copy.deepcopy(value)


def _write_runtime_file(path: Path, content: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_file() and path.read_text(encoding="utf-8") == content:
        return
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(content, encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


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

    definition = resolve_adapter(
        adapter_id,
        resolved_config=resolved_config,
        config_home=config_home,
        runtime_home=runtime_home,
    )
    adapter_root = (
        Path(runtime_dir) / "agent-sessions" / "native-provider-adapters" / adapter_id
    )
    if session_id is None:
        session_root = adapter_root
    else:
        session_token = str(session_id).removeprefix("native:")
        try:
            session_token = str(uuid.UUID(session_token))
        except ValueError as error:
            raise ValueError(
                "native Provider adapter session id must be a UUID"
            ) from error
        session_root = (
            Path(runtime_dir) / "agent-sessions" / "native-attempts" / session_token
        )
    provider_log_dir = session_root / "provider-logs" / adapter_id
    provider_log_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    skills_root = adapter_root / "skills"
    skill_dir = skills_root / "kungfu-agent-onboarding"
    skill_file = skill_dir / "SKILL.md"
    source = Path(
        os.path.abspath(os.path.expanduser(str(definition["skill"]["source"])))
    )
    if not source.is_file():
        raise ValueError(
            f"native Agent Skill is unavailable for {adapter_id}: {source}"
        )
    _write_runtime_file(skill_file, source.read_text(encoding="utf-8"))
    paths = {
        "adapter_root": str(adapter_root),
        "skills_root": str(skills_root),
        "skill_dir": str(skill_dir),
        "skill_file": str(skill_file),
        "provider_log_dir": str(provider_log_dir),
    }
    skill = dict(definition["skill"])
    for row in skill.get("files") or []:
        relative = Path(str(row["path"]))
        target = adapter_root.joinpath(relative)
        content = json.dumps(
            _render(row["content"], paths),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        _write_runtime_file(target, content + "\n")
    environment = {
        str(key): _render_text(str(value), paths)
        for key, value in dict(skill.get("environment") or {}).items()
    }
    for key, value in dict(skill.get("environmentJson") or {}).items():
        environment[str(key)] = json.dumps(
            _render(value, paths),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    return {
        "schema": ADAPTER_SCHEMA,
        "provider": adapter_id,
        "skillFile": str(skill_file),
        "providerLogDir": str(provider_log_dir),
        "argv": [_render_text(str(value), paths) for value in skill.get("argv") or []],
        "environment": environment,
        "credentialEnvironment": list(definition.get("credentialEnvironment") or []),
        "knownLimits": list(definition.get("knownLimits") or []),
    }


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
    "recovery-story",
    "review-fit",
)
BACKENDS = ("tmux", "direct")
CWD_POLICIES = ("workspace-root", "home", "inherit")
_VERSION_TIMEOUT_SECONDS = 5.0
_PROVIDER_VERSION_TIMEOUT_SECONDS = {"amp": 15.0}
_SEMANTIC_VERSION = re.compile(
    r"(?<![0-9])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)(?![0-9])"
)


def _parse_semantic_version(output: str) -> str | None:
    match = _SEMANTIC_VERSION.search(output)
    return match.group(1) if match else None


def _version_timeout_seconds(provider: str) -> float:
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
        label=f"Mock Agent · {scenario}",
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
    resolved = dict(resolved_config or kungfu_config.resolve_config())
    agent_config = dict((resolved.get("config") or {}).get("agent") or {})
    backend = str(agent_config.get("backendDefault") or "tmux")
    kwargs = dict(discovery_kwargs or {})
    discovered = discover_all_provider_candidates(**kwargs)
    adapters = adapter_catalog(resolved_config=resolved)
    for provider, adapter in adapters.items():
        if provider in PROVIDERS:
            continue
        discovered[provider] = _discover_configured_adapter(adapter, **kwargs)
    candidates: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    for provider, adapter in adapters.items():
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
                version_argv=list(adapter["discovery"]["versionArgv"]),
                backend=backend,
                source="discovered",
            )
            profile["label"] = _label(
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
    timeout_seconds: float = _VERSION_TIMEOUT_SECONDS,
) -> str | None:
    try:
        result = subprocess.run(
            [executable, *(str(value) for value in version_argv)],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    output = (result.stdout or result.stderr or "").strip()
    return output.splitlines()[0].strip() if output else None


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
    provider = str(profile.get("provider") or "")
    launch_argv = [
        str(value) for value in (profile.get("launch") or {}).get("argv") or []
    ]
    probe_argv = [
        str(value) for value in (profile.get("launch") or {}).get("versionArgv") or []
    ]
    if not probe_argv:
        probe_argv = (
            [*launch_argv, "--version"] if provider == "synthetic" else ["--version"]
        )
    available = bool(
        executable and os.path.isfile(executable) and os.access(executable, os.X_OK)
    )
    version = None
    error = None
    if available:
        try:
            result = subprocess.run(
                [executable, *probe_argv],
                capture_output=True,
                text=True,
                timeout=_version_timeout_seconds(provider),
                check=False,
                env=(
                    {**os.environ, "KUNGFU_AS_VARIANT": "node"}
                    if provider == "synthetic"
                    else None
                ),
            )
            text = (result.stdout or result.stderr or "").strip()
            if result.returncode != 0:
                error = f"version probe exited {result.returncode}"
            elif text:
                first_line = text.splitlines()[0].strip()[:256]
                version = _parse_semantic_version(first_line) or first_line
            else:
                error = "version probe returned no output"
        except (OSError, subprocess.SubprocessError) as exc:
            error = str(exc)
    else:
        error = "executable is missing or not executable"
    return {
        "schema": VERIFY_SCHEMA,
        "profileId": profile.get("id"),
        "provider": provider,
        "executable": executable,
        "argv": probe_argv,
        "available": available,
        "version": version,
        "ok": available and error is None,
        "error": error,
        "observedAt": datetime.now(UTC).isoformat(),
        "privacyBoundary": "bounded declared executable version probe only",
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
