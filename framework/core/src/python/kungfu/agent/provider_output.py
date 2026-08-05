# SPDX-License-Identifier: Apache-2.0

"""Credential-safe public projection of managed Provider output."""

from __future__ import annotations

import json
import re
from typing import Any


_ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
_SENSITIVE_COMMAND_NAME = (
    r"(?:api[-_]?key|access[-_]?key|token|secret|password|passwd|"
    r"authorization|cookie|credential|signature)"
)


def public_command_preview(command: Any) -> str:
    """Return the actual workspace command with common credential values redacted."""

    if not isinstance(command, str):
        return ""
    value = " ".join(_ANSI_ESCAPE.sub("", command).split())
    if not value:
        return ""
    value = re.sub(
        rf"(?i)\b([A-Z0-9_]*{_SENSITIVE_COMMAND_NAME}[A-Z0-9_]*)="
        r"(?:\"[^\"]*\"|'[^']*'|[^\s]+)",
        r"\1=<redacted>",
        value,
    )
    value = re.sub(
        rf"(?i)(--?{_SENSITIVE_COMMAND_NAME}(?:=|\s+))"
        r"(?:\"[^\"]*\"|'[^']*'|[^\s]+)",
        r"\1<redacted>",
        value,
    )
    value = re.sub(
        rf"(?i)([?&][^=\s&]*{_SENSITIVE_COMMAND_NAME}[^=\s&]*=)[^&\s]+",
        r"\1<redacted>",
        value,
    )
    value = re.sub(
        r"(?i)(authorization\s*:\s*)(?:bearer\s+|basic\s+)?[^'\"\s]+",
        r"\1<redacted>",
        value,
    )
    return value[:1000]


def public_activities_from_provider_line(
    provider: str, line: str
) -> list[dict[str, Any]]:
    """Project bounded Agent/tool activity from one structured Provider line."""

    normalized = _ANSI_ESCAPE.sub("", line).strip()
    if not normalized or provider not in {"codex", "opencode"}:
        return []
    try:
        payload = json.loads(normalized)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, dict):
        return []
    if provider == "codex":
        event_type = payload.get("type")
        item = payload.get("item")
        if event_type not in {"item.started", "item.completed"} or not isinstance(
            item, dict
        ):
            return []
        item_type = str(item.get("type") or "")
        if item_type == "agent_message" and event_type == "item.completed":
            text = item.get("text")
            if not isinstance(text, str):
                return []
            return [
                {
                    "schema": "kungfu.agent-run.activity/v1",
                    "kind": "agent",
                    "phase": "progress",
                    "text": value[:1000],
                    "rawToolArgumentsExposed": False,
                }
                for raw in text.splitlines()
                if (value := _ANSI_ESCAPE.sub("", raw).strip())
            ]
        if item_type not in {
            "command_execution",
            "file_change",
            "mcp_tool_call",
            "web_search",
        }:
            return []
        phase = "started" if event_type == "item.started" else "completed"
        label = {
            "command_execution": "Workspace command",
            "file_change": "Project file change",
            "mcp_tool_call": "Connected tool",
            "web_search": "Web search",
        }[item_type]
        command_preview = (
            public_command_preview(item.get("command"))
            if item_type == "command_execution"
            else ""
        )
        text = f"{label} {phase}."
        if command_preview:
            text = f"{text} {command_preview}"
        return [
            {
                "schema": "kungfu.agent-run.activity/v1",
                "kind": "tool",
                "phase": phase,
                "text": text,
                **({"commandPreview": command_preview} if command_preview else {}),
                "rawToolArgumentsExposed": False,
            }
        ]
    part = payload.get("part")
    part = part if isinstance(part, dict) else {}
    text = part.get("text")
    if payload.get("type") == "text" and isinstance(text, str):
        return [
            {
                "schema": "kungfu.agent-run.activity/v1",
                "kind": "agent",
                "phase": "progress",
                "text": value[:1000],
                "rawToolArgumentsExposed": False,
            }
            for raw in text.splitlines()
            if (value := _ANSI_ESCAPE.sub("", raw).strip())
        ]
    return []


def parse_provider_output(provider: str, stdout: str) -> dict[str, Any]:
    """Extract stable session, text, usage, and cost fields from Provider output."""

    session_ids: set[str] = set()
    text_parts: list[str] = []
    usage: dict[str, Any] | None = None
    cost: int | float | None = None
    if provider in {"opencode", "codex"}:
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            session_id = event.get("sessionID") or event.get("thread_id")
            if isinstance(session_id, str) and session_id:
                session_ids.add(session_id)
            part_value = event.get("part")
            part: dict[str, Any] = part_value if isinstance(part_value, dict) else {}
            text = part.get("text")
            if not isinstance(text, str):
                item_value = event.get("item")
                item: dict[str, Any] = (
                    item_value if isinstance(item_value, dict) else {}
                )
                text = item.get("text")
            if isinstance(text, str) and text:
                text_parts.append(text)
            tokens = part.get("tokens")
            if isinstance(tokens, dict):
                usage = dict(tokens)
            part_cost = part.get("cost")
            if isinstance(part_cost, (int, float)):
                cost = part_cost
    elif provider == "claude":
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError:
            payload = {}
        if isinstance(payload, dict):
            session_id = payload.get("session_id")
            if isinstance(session_id, str) and session_id:
                session_ids.add(session_id)
            text = payload.get("result")
            if isinstance(text, str) and text:
                text_parts.append(text)
            if isinstance(payload.get("usage"), dict):
                usage = dict(payload["usage"])
            if isinstance(payload.get("total_cost_usd"), (int, float)):
                cost = payload["total_cost_usd"]
    elif provider == "amp" and stdout.strip():
        text_parts.append(stdout.strip())
    elif provider == "synthetic":
        visible = _ANSI_ESCAPE.sub("", stdout).strip()
        if visible:
            text_parts.append(visible[:128_000])
    return {
        "providerSessionIds": sorted(session_ids),
        "text": "\n".join(text_parts) if text_parts else None,
        "usage": usage,
        "cost": cost,
    }
