# SPDX-License-Identifier: Apache-2.0

"""Shared user-level onboarding state for CLI, GUI, and TUI entrypoints."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from kungfu import config as kungfu_config


ONBOARDING_VERSION = 1


def completed_agent_state(current: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Project a successful Agent-first Work start into the shared UI state."""

    value = dict(current or {})
    return {
        "version": ONBOARDING_VERSION,
        "status": "completed",
        "route": "agent",
        "labCompleted": value.get("labCompleted") is True,
        "tourCompleted": value.get("tourCompleted") is True,
        "completedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def complete_agent_route(
    *, config_home: str | None = None, runtime_home: str | None = None
) -> dict[str, Any]:
    """Persist completion only after an exact durable Work start or binding."""

    resolved = kungfu_config.resolve_config(
        config_home=config_home, runtime_home=runtime_home
    )
    current = (resolved.get("config") or {}).get("ui", {}).get("onboarding", {})
    state = completed_agent_state(current)
    updated = kungfu_config.set_user_config_value(
        "ui.onboarding",
        state,
        config_home=config_home,
        runtime_home=runtime_home,
    )
    return {
        "state": state,
        "configPath": updated["configPath"],
    }
