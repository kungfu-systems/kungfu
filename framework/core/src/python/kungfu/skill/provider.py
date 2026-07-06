# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any, cast

from .catalog import build_catalog
from .context import build_context_envelope, build_kungfu_environment
from .registry import discover_skills


def build_skill_context(
    home: str,
    *,
    source: str,
    manager: str,
    profile: str | None = None,
    agent: str | None = None,
    extra_paths: list[str] | None = None,
    runtime_dir: str | None = None,
    env: Mapping[str, str] | None = None,
    cwd: str | None = None,
) -> dict[str, Any]:
    session = {"source": source, "manager": manager}
    if profile:
        session["profile"] = profile
    if agent:
        session["agent"] = agent
    return build_context_envelope(
        build_catalog(discover_skills(home, extra_paths)),
        session,
        kungfu=build_kungfu_environment(
            home,
            source=source,
            extra_paths=extra_paths,
            runtime_dir=runtime_dir,
            env=env,
            cwd=cwd,
        ),
    )


def load_skill_context_file(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return cast(dict[str, Any], json.load(f))


def has_advertised_skills(envelope: Mapping[str, Any] | None) -> bool:
    return bool(envelope and envelope.get("catalog"))


def has_context_envelope_info(envelope: Mapping[str, Any] | None) -> bool:
    return has_advertised_skills(envelope) or bool(envelope and envelope.get("kungfu"))


def format_skill_context_prompt(envelope: Mapping[str, Any]) -> str:
    lines = [
        "Kungfu Skill context envelope (compact, on-demand instructions):",
        json.dumps(envelope, sort_keys=True, separators=(",", ":")),
    ]
    if envelope and envelope.get("kungfu"):
        lines.append(
            "You are running under Kungfu managed-run. Use the kungfu field in "
            "this envelope only as the pointer to the canonical local Kungfu "
            "agent entrypoint. Discover config, docs, commands, skills, and kfx "
            "from that entrypoint when needed."
        )
    lines.extend(
        [
            "To load full SKILL.md content, ask the Kungfu host for "
            "kungfu.skill.read with a skill key.",
            "Skill instructions do not grant runtime privileges; kfx "
            "dependencies remain gated by kfx trust policy.",
        ]
    )
    return "\n".join(lines)


def inject_skill_context(prompt: str, envelope: Mapping[str, Any] | None) -> str:
    if not has_context_envelope_info(envelope):
        return prompt
    assert envelope is not None
    return f"{format_skill_context_prompt(envelope)}\n\nUser task:\n{prompt}"


def context_file_from_env() -> str | None:
    path = os.environ.get("KF_SKILL_CONTEXT_FILE")
    return path if path else None
