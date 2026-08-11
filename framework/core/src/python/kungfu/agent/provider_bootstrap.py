# SPDX-License-Identifier: Apache-2.0

"""Customizable provider bootstrap adapter materialization."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
from typing import Any, Callable, Mapping
import uuid


_TEMPLATE = re.compile(
    r"\{(skill_file|skill_dir|skills_root|adapter_root|provider_log_dir)(:json)?\}"
)
_UNRESOLVED_TEMPLATE = re.compile(r"\{[a-z_]+(?::json)?\}")
_TMUX_PROCESS_ENVIRONMENT = frozenset({"TMUX", "TMUX_PANE"})


def native_process_environment(
    ambient: Mapping[str, str], names: list[str]
) -> dict[str, str]:
    """Resolve registered ambient process capabilities without persisting values."""

    configured = set(names)
    if not configured:
        return {}
    if configured != _TMUX_PROCESS_ENVIRONMENT:
        raise ValueError(
            "native process environment must contain the complete registered "
            "TMUX/TMUX_PANE capability"
        )

    tmux = str(ambient.get("TMUX") or "").strip()
    pane = str(ambient.get("TMUX_PANE") or "").strip()
    if not tmux and not pane:
        return {}
    if not tmux or not pane or "\x00" in tmux or "\x00" in pane:
        return {}
    socket_path, separator, coordinates = tmux.rpartition(",")
    server_prefix, second_separator, server_pid = socket_path.rpartition(",")
    if (
        not separator
        or not second_separator
        or not server_prefix
        or not server_pid.isdigit()
        or not coordinates.isdigit()
        or re.fullmatch(r"%[0-9]+", pane) is None
    ):
        return {}
    return {"TMUX": tmux, "TMUX_PANE": pane}


def render_text(value: str, paths: Mapping[str, str]) -> str:
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


def render(value: Any, paths: Mapping[str, str]) -> Any:
    if isinstance(value, str):
        return render_text(value, paths)
    if isinstance(value, list):
        return [render(item, paths) for item in value]
    if isinstance(value, dict):
        return {str(key): render(item, paths) for key, item in value.items()}
    return copy.deepcopy(value)


def validate_file_paths(adapter_id: str, adapter: Mapping[str, Any]) -> None:
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


def validate_templates(adapter_id: str, adapter: Mapping[str, Any]) -> None:
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
        render(skill.get("argv") or [], paths)
        render(skill.get("environment") or {}, paths)
        render(skill.get("environmentJson") or {}, paths)
        render([row.get("content") for row in skill.get("files") or []], paths)
    except ValueError as error:
        raise ValueError(
            f"native Provider adapter {adapter_id} has an invalid template: {error}"
        ) from error


def write_runtime_file(path: Path, content: str) -> None:
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


class ProviderBootstrapAdapter:
    """Materialize one provider Skill adapter under runtime state only."""

    def __init__(
        self,
        *,
        resolve: Callable[..., Mapping[str, Any]],
        schema: str,
    ) -> None:
        self.resolve = resolve
        self.schema = schema

    def materialize(
        self,
        adapter_id: str,
        *,
        runtime_dir: str,
        session_id: str | None = None,
        resolved_config: Mapping[str, Any] | None = None,
        config_home: str | None = None,
        runtime_home: str | None = None,
    ) -> dict[str, Any]:
        definition = self.resolve(
            adapter_id,
            resolved_config=resolved_config,
            config_home=config_home,
            runtime_home=runtime_home,
        )
        adapter_root = (
            Path(runtime_dir)
            / "agent-sessions"
            / "native-provider-adapters"
            / adapter_id
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
        write_runtime_file(skill_file, source.read_text(encoding="utf-8"))
        paths = {
            "adapter_root": str(adapter_root),
            "skills_root": str(skills_root),
            "skill_dir": str(skill_dir),
            "skill_file": str(skill_file),
            "provider_log_dir": str(provider_log_dir),
        }
        skill = dict(definition["skill"])
        for row in skill.get("files") or []:
            target = adapter_root.joinpath(Path(str(row["path"])))
            content = json.dumps(
                render(row["content"], paths),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            write_runtime_file(target, content + "\n")
        environment = {
            str(key): render_text(str(value), paths)
            for key, value in dict(skill.get("environment") or {}).items()
        }
        environment.update(
            native_process_environment(
                os.environ,
                [str(value) for value in definition.get("processEnvironment") or []],
            )
        )
        for key, value in dict(skill.get("environmentJson") or {}).items():
            environment[str(key)] = json.dumps(
                render(value, paths),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        return {
            "schema": self.schema,
            "provider": adapter_id,
            "skillFile": str(skill_file),
            "providerLogDir": str(provider_log_dir),
            "argv": [
                render_text(str(value), paths) for value in skill.get("argv") or []
            ],
            "environment": environment,
            "credentialEnvironment": list(
                definition.get("credentialEnvironment") or []
            ),
            "processEnvironment": list(definition.get("processEnvironment") or []),
            "knownLimits": list(definition.get("knownLimits") or []),
        }
