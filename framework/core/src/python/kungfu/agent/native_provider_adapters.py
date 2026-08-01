# SPDX-License-Identifier: Apache-2.0

"""Declarative adapters for provider-native Agent terminal interfaces.

Adapters may copy one explicitly selected Skill into Kungfu runtime state and
inject bounded argv, environment, JSON environment, or JSON settings files.
They never invoke a shell and never write provider configuration homes.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
from typing import Any, Mapping
import uuid

from kungfu import config as kungfu_config
from kungfu.agent import resources as agent_resources


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
