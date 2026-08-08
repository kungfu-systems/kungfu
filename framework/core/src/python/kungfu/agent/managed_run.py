# SPDX-License-Identifier: Apache-2.0

"""Managed Agent Session orchestration independent from CLI parsing."""

from __future__ import annotations

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
        event_sink: Callable[[Mapping[str, Any]], None] | None = None,
        session_started: Callable[[Mapping[str, str], Mapping[str, Any]], None]
        | None = None,
    ) -> tuple[Any, dict[str, Any]]:
        provider = str(selected["provider"])
        ref = self.session_ref(work, run_id)
        launch = dict(selected.get("launch") or {})
        argv = (
            [str(value) for value in launch.get("argv") or []]
            if provider == "synthetic"
            else []
        )
        start_input = {
            **ref,
            "workspaceId": str(work["workspaceId"]),
            "provider": provider,
            "providerVersion": str(verification["version"]),
            "profileRoot": self.semantic_root(selected),
            "executable": str(launch["executable"]),
            "argv": argv,
            "cwd": cwd,
            "env": dict(env),
            "runtimeProfileId": str(selected["id"]),
            "binding": {"kind": "work", "workRef": dict(work)},
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
            lambda status: (
                status.get("interactionState") in {"ready", "approval-needed", "ended"}
            ),
            timeout_seconds=min(timeout_seconds, 30.0),
        )
        if ready.get("interactionState") != "ready":
            raise ValueError(
                "Agent Session requires attention before the initial Work instruction"
            )
        before_sequence = int((ready.get("output") or {}).get("nextSequence") or 0)
        delivered = self.invoke_control(invoke, ref, "instruct", {"text": prompt})
        if delivered.get("status") not in {"written", "duplicate"}:
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
        boundary = self.wait_for_session(
            invoke,
            ref,
            lambda status: (
                (
                    terminal_mock_scenario
                    and status.get("interactionState") == "ended"
                    and status.get("live") is not True
                )
                or (
                    not terminal_mock_scenario
                    and status.get("interactionState")
                    in {"approval-needed", "unknown", "ended"}
                )
                or (
                    not terminal_mock_scenario
                    and status.get("interactionState") == "ready"
                    and int((status.get("output") or {}).get("nextSequence") or 0)
                    > before_sequence
                )
            ),
            timeout_seconds=timeout_seconds,
        )
        snapshot = invoke(
            {"operation": "snapshot", "session": dict(ref), "requestedSequence": 0}
        )
        lines = list(
            ((snapshot.get("terminal") or {}).get("vt") or {}).get("lines") or []
        )
        visible = "\n".join(str(line).rstrip() for line in lines).strip()
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
