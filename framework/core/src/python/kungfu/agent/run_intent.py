# SPDX-License-Identifier: Apache-2.0

"""Stable intent routing for ``kungfu run`` entrypoints."""

from __future__ import annotations

from typing import Any, Callable, Mapping


def provider_launch_mode(request: Mapping[str, Any]) -> str:
    """Classify a provider request without coupling callers to the CLI surface."""

    native = (
        request.get("task") is None
        and request.get("work_selector") is None
        and request.get("workspace_root") is None
        and not request.get("plan_only")
        and not request.get("as_json")
        and not request.get("events_json")
        and request.get("expected_plan_root") is None
        and not request.get("allow_foreign_binding")
    )
    return "native" if native else "managed"


def validate_agent_invocation(prompt: str | None, has_managed_options: bool) -> str:
    """Return the Agent launch mode or reject managed options without a prompt."""

    if prompt is None and has_managed_options:
        raise ValueError(
            "--work-ref, --continuation, --timeout, and --json require --prompt"
        )
    return "native" if prompt is None else "managed"


class RunIntentDispatcher:
    """Separate provider-native UI intent from bounded managed execution."""

    @staticmethod
    def provider_mode(request: Mapping[str, Any]) -> str:
        return provider_launch_mode(request)

    def dispatch_provider(
        self,
        *,
        request: Mapping[str, Any],
        native: Callable[[], Any],
        managed: Callable[[], Any],
    ) -> Any:
        if self.provider_mode(request) == "native":
            return native()
        return managed()

    def dispatch_agent(
        self,
        *,
        prompt: str | None,
        has_managed_options: bool,
        native: Callable[[], Any],
        managed: Callable[[], Any],
    ) -> Any:
        if validate_agent_invocation(prompt, has_managed_options) == "native":
            return native()
        return managed()
