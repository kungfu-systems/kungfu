# SPDX-License-Identifier: Apache-2.0

"""Customizable provider bootstrap adapter materialization."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any, Callable, Mapping, Sequence
import uuid

from kungfu.skill import (
    build_skill_runtime_audit,
    read_audit_file,
    write_skill_runtime_audit,
)


_TEMPLATE = re.compile(
    r"\{(skill_file|skill_dir|skills_root|adapter_root|provider_log_dir)(:json)?\}"
)
_UNRESOLVED_TEMPLATE = re.compile(r"\{[a-z_]+(?::json)?\}")
_TMUX_PROCESS_ENVIRONMENT = frozenset({"TMUX", "TMUX_PANE"})
COMMAND_WRAPPER_SUFFIXES = {".bat", ".cmd"}
_FORWARDING_WRAPPER = re.compile(
    r'\A\s*@echo\s+off\s*\r?\n\s*call\s+"(?P<target>[^"\r\n]+)"\s+%\*\s*\Z',
    re.IGNORECASE,
)
_NPM_WRAPPER_ENTRY = re.compile(
    r"^\s*endlocal\s+&\s+goto\s+#_undefined_#\s+2>nul\s+\|\|\s+"
    r'title\s+%comspec%\s+&\s+"%_prog%"\s+'
    r'"%dp0%\\(?P<entry>[^"\r\n]+)"\s+%\*\s*$',
    re.IGNORECASE | re.MULTILINE,
)
_NPM_WRAPPER_MARKERS = (
    "goto start",
    ":find_dp0",
    "set dp0=%~dp0",
    "call :find_dp0",
    'set "_prog=',
)
_ENV_REFERENCE = re.compile(r"%([^%\r\n]+)%")
_PROMPT_INSTRUCTION_PREFIX = (
    "Kungfu Windows command-wrapper transport: the complete prompt follows as "
    "ASCII text with Unicode escapes. Interpret every backslash-u escape, "
    "including surrogate pairs, then follow the decoded prompt exactly: "
)
_PROMPT_SAFE_CHARACTERS = frozenset(" .,:;/_-")


def resolve_command_wrapper(
    argv: Sequence[str],
    *,
    env: Mapping[str, str],
    platform: str | None = None,
) -> list[str]:
    """Resolve exact forwarding and standard npm wrappers before shell parsing."""

    resolved = [str(value) for value in argv]
    if (sys.platform if platform is None else platform) != "win32" or not resolved:
        return resolved
    environment = {str(key).casefold(): str(value) for key, value in env.items()}
    observed: set[str] = set()
    for _ in range(8):
        wrapper = Path(resolved[0])
        identity = str(wrapper.resolve(strict=False)).casefold()
        if (
            wrapper.suffix.lower() not in COMMAND_WRAPPER_SUFFIXES
            or identity in observed
        ):
            break
        observed.add(identity)
        try:
            if wrapper.stat().st_size > 16 * 1024:
                break
            content = wrapper.read_text(encoding="utf-8", errors="replace")
        except OSError:
            break
        forwarding_match = _FORWARDING_WRAPPER.fullmatch(content)
        if forwarding_match is None:
            npm_launch = _resolve_npm_wrapper(
                wrapper, content=content, environment=environment
            )
            if npm_launch is None:
                break
            resolved = [*npm_launch, *resolved[1:]]
            break

        missing_environment = False

        def expand_environment(reference: re.Match[str]) -> str:
            nonlocal missing_environment
            value = environment.get(reference.group(1).casefold())
            if value is None:
                missing_environment = True
                return reference.group(0)
            return value

        target_text = _ENV_REFERENCE.sub(
            expand_environment, forwarding_match.group("target")
        )
        if missing_environment:
            break
        target = Path(target_text)
        if not target.is_absolute():
            target = wrapper.parent / target
        if not target.is_file():
            break
        resolved[0] = str(target)
    return resolved


def _runtime_health_base(
    profile: Mapping[str, Any], effective_platform: str
) -> dict[str, Any]:
    return {
        "schema": "kungfu.native-provider-runtime-health/v1",
        "provider": str(profile.get("provider") or ""),
        "executable": str((profile.get("launch") or {}).get("executable") or ""),
        "platform": effective_platform,
        "probe": "codex-windows-sandbox-smoke",
        "modelInvoked": False,
        "networkRequired": False,
        "permissionsWidened": False,
    }


def provider_runtime_health(
    profile: Mapping[str, Any],
    *,
    cwd: str,
    env: Mapping[str, str] | None = None,
    platform: str | None = None,
    run: Callable[..., Any] = subprocess.run,
    timeout_seconds: float = 20.0,
) -> dict[str, Any]:
    """Probe a provider-owned runtime boundary before starting its native UI."""

    effective_platform = sys.platform if platform is None else platform
    base = _runtime_health_base(profile, effective_platform)
    if effective_platform != "win32" or base["provider"] != "codex":
        return {**base, "status": "not-applicable", "ok": True, "warning": None}

    ambient = dict(os.environ if env is None else env)
    command = resolve_command_wrapper(
        [base["executable"]], env=ambient, platform=effective_platform
    )
    try:
        help_result = run(
            [*command, "--help"],
            cwd=cwd,
            env=ambient,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return {
            **base,
            "status": "capability-unverified",
            "ok": True,
            "warning": f"Codex capability probe was unavailable: {error}",
        }
    help_text = f"{help_result.stdout or ''}\n{help_result.stderr or ''}"
    if (
        help_result.returncode != 0
        or re.search(r"(?im)^\s*sandbox\s+.*sandbox", help_text) is None
    ):
        return {
            **base,
            "status": "capability-unverified",
            "ok": True,
            "warning": (
                "Codex does not advertise the model-free Windows sandbox helper; "
                "continuing without a version-based admission rule"
            ),
        }

    try:
        result = run(
            [
                *command,
                "sandbox",
                "windows",
                "--",
                "cmd.exe",
                "/d",
                "/c",
                "exit",
                "0",
            ],
            cwd=cwd,
            env=ambient,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return {
            **base,
            "status": "unavailable",
            "ok": False,
            "warning": None,
            "diagnostic": str(error)[:512],
        }
    diagnostic = (result.stderr or result.stdout or "").strip().splitlines()
    return {
        **base,
        "status": "ready" if result.returncode == 0 else "unavailable",
        "ok": result.returncode == 0,
        "warning": None,
        "diagnostic": diagnostic[0][:512] if diagnostic else None,
    }


def _resolve_npm_wrapper(
    wrapper: Path, *, content: str, environment: Mapping[str, str]
) -> list[str] | None:
    """Return the native argv prefix for a standard npm-generated shim."""

    lowered = content.casefold()
    if not all(marker in lowered for marker in _NPM_WRAPPER_MARKERS):
        return None
    match = _NPM_WRAPPER_ENTRY.search(content)
    if match is None:
        return None

    wrapper_root = wrapper.parent.resolve(strict=False)
    entrypoint = (wrapper_root / match.group("entry")).resolve(strict=False)
    try:
        entrypoint.relative_to(wrapper_root)
    except ValueError:
        return None
    if not entrypoint.is_file():
        return None

    local_node = wrapper_root / "node.exe"
    if local_node.is_file():
        executable = local_node
    else:
        node = shutil.which("node", path=environment.get("path"))
        if not node:
            return None
        executable = Path(node)
    if not executable.is_file():
        return None
    return [str(executable), str(entrypoint)]


def encode_wrapper_prompt(argv: Sequence[str]) -> list[str]:
    """Encode multiline prompts outside ``cmd.exe`` metacharacter syntax."""

    resolved = [str(value) for value in argv]
    if not resolved or not any(marker in resolved[-1] for marker in ("\r", "\n")):
        return resolved
    resolved[-1] = _PROMPT_INSTRUCTION_PREFIX + _escape_prompt(resolved[-1])
    return resolved


def _escape_prompt(value: str) -> str:
    encoded: list[str] = []
    for character in value:
        codepoint = ord(character)
        if character.isascii() and (
            character.isalnum() or character in _PROMPT_SAFE_CHARACTERS
        ):
            encoded.append(character)
        elif codepoint <= 0xFFFF:
            encoded.append(f"\\u{codepoint:04x}")
        else:
            scalar = codepoint - 0x10000
            encoded.append(f"\\u{0xD800 + (scalar >> 10):04x}")
            encoded.append(f"\\u{0xDC00 + (scalar & 0x3FF):04x}")
    return "".join(encoded)


def prepare_native_skill_runtime_audit(
    runtime_home: str,
    runtime_dir: str,
    attempt_id: str,
    work_ref: Mapping[str, Any] | None,
) -> tuple[str | None, dict[str, Any], str, str]:
    """Write the launch audit and return its native Console coordinates."""

    skill_work_ref = None
    if work_ref is not None:
        skill_work_ref = (
            str(work_ref.get("entityId") or work_ref.get("workspaceId") or "") or None
        )
    document = build_skill_runtime_audit(
        runtime_home,
        run_id=attempt_id,
        work_ref=skill_work_ref,
    )
    audit_root = Path(runtime_dir) / "skill-manager"
    launch_path = str(audit_root / f"agent-console-{attempt_id}.json")
    final_path = str(audit_root / f"agent-console-{attempt_id}-final.json")
    write_skill_runtime_audit(launch_path, document)
    return skill_work_ref, document, launch_path, final_path


def refresh_native_skill_runtime_audit(env: Mapping[str, str]) -> None:
    """Refresh the Agent Console pointer after rooted on-demand Skill activity."""

    output_path = env.get("KUNGFU_SKILL_RUNTIME_AUDIT_FINAL_FILE")
    runtime_home = env.get("KF_HOME")
    if not output_path or not runtime_home:
        return
    audit_documents = []
    audit_path = env.get("KUNGFU_SKILL_AUDIT_FILE")
    if audit_path and Path(audit_path).is_file():
        audit_documents.append(read_audit_file(audit_path))
    document = build_skill_runtime_audit(
        runtime_home,
        audit_documents=audit_documents,
        run_id=env.get("KUNGFU_SKILL_RUN_ID"),
        work_ref=env.get("KUNGFU_SKILL_WORK_REF"),
    )
    write_skill_runtime_audit(output_path, document)


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
