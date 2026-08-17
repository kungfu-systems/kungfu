# SPDX-License-Identifier: Apache-2.0

"""Managed Agent Session orchestration independent from CLI parsing."""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Mapping


_TERMINAL_MOCK_SCENARIOS = frozenset(
    {
        "crash",
        "deliverable",
        "disconnect",
        "recovery-delivery",
        "recovery-story",
        "review-fit",
    }
)


def _terminal_mock_scenario(selected: Mapping[str, Any]) -> bool:
    if selected.get("provider") != "synthetic":
        return False
    argv = list((selected.get("launch") or {}).get("argv") or [])
    try:
        scenario = str(argv[argv.index("--scenario") + 1])
    except (ValueError, IndexError):
        return False
    return scenario in _TERMINAL_MOCK_SCENARIOS


def _session_argv(
    provider: str,
    launch: Mapping[str, Any],
    cwd: str,
    project_trust: Mapping[str, Any] | None,
) -> list[str]:
    if provider == "synthetic":
        return [str(value) for value in launch.get("argv") or []]
    if provider != "codex" or project_trust is None:
        return []
    if project_trust.get("schema") != "kungfu.agent-project-trust/v1":
        raise ValueError("Codex Project trust grant schema is invalid")
    if project_trust.get("provider") != "codex":
        raise ValueError("Codex Project trust grant provider is invalid")
    if project_trust.get("scope") != "single-invocation":
        raise ValueError("Codex Project trust grant scope is invalid")
    if project_trust.get("persistent") is not False:
        raise ValueError("Codex Project trust grant must be invocation-scoped")
    workspace_root = str(project_trust.get("workspaceRoot") or "")
    canonical_cwd = os.path.realpath(cwd)
    if not workspace_root or os.path.realpath(workspace_root) != canonical_cwd:
        raise ValueError("Codex Project trust grant does not match the exact workspace")
    expected_allows = [
        "project-local-config",
        "project-local-hooks",
        "project-local-exec-policies",
    ]
    if project_trust.get("allows") != expected_allows:
        raise ValueError("Codex Project trust grant effects are invalid")
    override = f'projects={{{json.dumps(canonical_cwd)}={{trust_level="trusted"}}}}'
    return ["-c", override]


def _initial_session_boundary_reached(status: Mapping[str, Any]) -> bool:
    interaction = status.get("interactionState")
    if interaction in {"ready", "approval-needed", "ended"}:
        return True
    if interaction != "unknown":
        return False
    adapter = status.get("providerAdapter") or {}
    return adapter.get("compatible") is False or adapter.get("reason") not in {
        None,
        "no-supported-state-signature",
    }


def _session_boundary_reached(
    status: Mapping[str, Any],
    *,
    before_sequence: int,
    terminal_mock: bool,
    observed_busy: bool = False,
) -> bool:
    interaction = status.get("interactionState")
    if terminal_mock:
        return interaction == "ended" and status.get("live") is not True
    if interaction in {"approval-needed", "unknown", "ended"}:
        return True
    attention_kind = str(
        ((status.get("workAgent") or {}).get("attention") or {}).get("kind") or ""
    )
    return (
        interaction == "ready"
        and int((status.get("output") or {}).get("nextSequence") or 0) > before_sequence
        and (observed_busy or attention_kind in {"needs-answer", "ready-for-review"})
    )


class ManagedRunCoordinator:
    """Start, instruct, observe, and snapshot one managed SessionAttempt."""

    def __init__(
        self,
        *,
        session_ref: Callable[[Mapping[str, Any], str], dict[str, str]],
        semantic_root: Callable[[Any], str],
        wait_for_session: Callable[..., Mapping[str, Any]],
        invoke_control: Callable[..., Mapping[str, Any]],
        result_factory: Callable[..., Any],
    ) -> None:
        self.session_ref = session_ref
        self.semantic_root = semantic_root
        self.wait_for_session = wait_for_session
        self.invoke_control = invoke_control
        self.result_factory = result_factory

    def run(
        self,
        *,
        invoke: Callable[[Mapping[str, Any]], Mapping[str, Any]],
        run_id: str,
        selected: Mapping[str, Any],
        verification: Mapping[str, Any],
        work: Mapping[str, Any],
        cwd: str,
        env: Mapping[str, str],
        prompt: str,
        timeout_seconds: float,
        permission_mode: str = "workspace-write",
        event_sink: Callable[[Mapping[str, Any]], None] | None = None,
        session_started: Callable[[Mapping[str, str], Mapping[str, Any]], None]
        | None = None,
        project_trust: Mapping[str, Any] | None = None,
    ) -> tuple[Any, dict[str, Any]]:
        provider = str(selected["provider"])
        ref = self.session_ref(work, run_id)
        launch = dict(selected.get("launch") or {})
        argv = _session_argv(provider, launch, cwd, project_trust)
        start_input = {
            **ref,
            "workspaceId": str(work["workspaceId"]),
            "provider": provider,
            "providerVersion": str(verification.get("version") or "unknown"),
            "profileRoot": self.semantic_root(selected),
            "executable": str(launch["executable"]),
            "argv": argv,
            "cwd": cwd,
            "env": dict(env),
            "runtimeProfileId": str(selected["id"]),
            "binding": {"kind": "work", "workRef": dict(work)},
        }
        if provider == "codex":
            start_input["structured"] = {
                "threadStartParams": {
                    "cwd": cwd,
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": "user",
                    "sandbox": permission_mode,
                }
            }
        plan = invoke({"operation": "plan-start", "input": start_input})
        started = invoke(
            {
                "operation": "start",
                "actorId": "kungfu-project-work",
                "client": "cli",
                "plan": plan,
                "expectedPlanRoot": plan["root"],
                "attachment": {
                    "attachmentId": f"project-work:{run_id}",
                    "presentation": "project-work",
                },
                "execution": {"env": dict(env), "cols": 120, "rows": 36},
            }
        )
        actual_console = started.get("workConsoleId")
        actual_attempt = started.get("sessionAttemptId")
        if isinstance(actual_console, str) and isinstance(actual_attempt, str):
            ref = {
                "workConsoleId": actual_console,
                "sessionAttemptId": actual_attempt,
            }
        if session_started is not None:
            session_started(ref, started)
        ready = self.wait_for_session(
            invoke,
            ref,
            _initial_session_boundary_reached,
            timeout_seconds=(
                None if provider == "synthetic" else min(timeout_seconds, 30.0)
            ),
            event_driven=provider == "synthetic",
        )
        if ready.get("interactionState") != "ready":
            raise ValueError(
                "Agent Session requires attention before the initial Work instruction"
            )
        controller = ready.get("controller") or {}
        if controller.get("holderId") != "kungfu-project-work":
            acquired = self.invoke_control(invoke, ref, "acquire-control", {})
            if acquired.get("status") not in {"granted", "duplicate"}:
                raise ValueError(
                    "Agent Session could not acquire control for the initial "
                    f"Work instruction: {acquired.get('reason') or acquired.get('status')}"
                )
        before_sequence = int((ready.get("output") or {}).get("nextSequence") or 0)
        delivered = self.invoke_control(invoke, ref, "instruct", {"text": prompt})
        if delivered.get("status") not in {"written", "delivered", "duplicate"}:
            raise ValueError(
                "Agent Session rejected the Work instruction: "
                f"{delivered.get('reason')}"
            )
        if event_sink is not None:
            event_sink(
                {
                    "schema": "kungfu.agent-run.activity/v1",
                    "kind": "agent",
                    "phase": "started",
                    "text": "Agent Session accepted the Work instruction.",
                    "rawToolArgumentsExposed": False,
                }
            )
        terminal_mock_scenario = _terminal_mock_scenario(selected)
        observed_busy = False

        def completed_turn(status: Mapping[str, Any]) -> bool:
            nonlocal observed_busy
            if status.get("interactionState") == "busy":
                observed_busy = True
            return _session_boundary_reached(
                status,
                before_sequence=before_sequence,
                terminal_mock=terminal_mock_scenario,
                observed_busy=observed_busy,
            )

        boundary = self.wait_for_session(
            invoke,
            ref,
            completed_turn,
            timeout_seconds=None if provider == "synthetic" else timeout_seconds,
            event_driven=provider == "synthetic",
        )
        snapshot = invoke(
            {"operation": "snapshot", "session": dict(ref), "requestedSequence": 0}
        )
        lines = list(
            ((snapshot.get("terminal") or {}).get("vt") or {}).get("lines") or []
        )
        structured_text = snapshot.get("agentText")
        visible = (
            structured_text.strip()
            if isinstance(structured_text, str) and structured_text.strip()
            else "\n".join(str(line).rstrip() for line in lines).strip()
        )
        if event_sink is not None:
            for line in visible.splitlines()[-12:]:
                if line.strip():
                    event_sink(
                        {
                            "schema": "kungfu.agent-run.activity/v1",
                            "kind": "agent",
                            "phase": "waiting",
                            "text": line.strip()[:1000],
                            "rawToolArgumentsExposed": False,
                        }
                    )
        exit_value = boundary.get("exit") or {}
        exit_code = int(exit_value.get("exitCode") or exit_value.get("code") or 0)
        session_value = {
            "schema": "kungfu.agent-run-session/v1",
            **ref,
            "live": boundary.get("live") is True,
            "lifecycleState": boundary.get("lifecycleState"),
            "interactionState": boundary.get("interactionState"),
            "workAgent": boundary.get("workAgent"),
            "product": boundary.get("product"),
            "controller": boundary.get("controller"),
            "output": boundary.get("output"),
        }
        return (
            self.result_factory(
                exit_code=exit_code,
                stdout=visible,
                stderr="",
                interrupted=False,
                timed_out=False,
            ),
            session_value,
        )
