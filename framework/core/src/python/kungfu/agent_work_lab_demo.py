# SPDX-License-Identifier: Apache-2.0

"""Deterministic fresh-session demo owned by Agent Work Lab."""

from __future__ import annotations

import json
import multiprocessing
import os
import tempfile
from pathlib import Path
from typing import Any, Mapping

from kungfu.agent_work_lab_evidence import (
    DEMO_AGENT_IDENTITY,
    DEMO_PLAN_SCHEMA,
    DEMO_REPORT_SCHEMA,
    FIXTURE_ID,
    SUITE_ID,
    AgentWorkLabEventSink,
    close_episode as _close_session_episode,
    content_root,
    load_suite_catalog as _load_suite_catalog,
    open_episode as _open_session_episode,
    publish_event as _publish_event,
    work_reference as _work_ref,
)


def demo_plan() -> dict[str, Any]:
    semantic = {
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "sessions": [
            {
                "index": 1,
                "freshProcess": True,
                "action": "record-partial-claim-and-end",
            },
            {
                "index": 2,
                "freshProcess": True,
                "priorTranscript": False,
                "humanExplanation": False,
                "action": "recognize-state-and-continue",
            },
        ],
        "oracle": "partial-first-attempt-recognized-and-fixture-completed",
        "isolation": "new-discardable-temporary-directory",
    }
    return {
        "schema": DEMO_PLAN_SCHEMA,
        **semantic,
        "planRoot": content_root(semantic),
        "writeOccurred": False,
    }


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def _demo_worker(
    state_path_value: str, attempt_index: int, work_ref: Mapping[str, Any]
) -> None:
    state_path = Path(state_path_value)
    if attempt_index == 1:
        if state_path.exists():
            raise RuntimeError("first demo session requires a new fixture")
        state = {
            "schema": "kungfu.agent-work-lab.fixture-state/v1",
            "suite": SUITE_ID,
            "fixture": FIXTURE_ID,
            "workRef": dict(work_ref),
            "steps": ["claim-recorded"],
            "status": "partial",
            "attempts": [
                {
                    "schema": "kungfu.session-attempt/v1",
                    "sessionAttemptId": "agent-work-lab-attempt-1",
                    "processId": os.getpid(),
                    "freshProcess": True,
                    "priorTranscriptIncluded": False,
                    "humanExplanationIncluded": False,
                    "observedState": "verified-empty-fixture",
                    "action": "record-partial-claim-and-end",
                    "status": "ended-partial",
                }
            ],
        }
        _atomic_json(state_path, state)
        return
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if (
        state.get("schema") != "kungfu.agent-work-lab.fixture-state/v1"
        or state.get("suite") != SUITE_ID
        or state.get("fixture") != FIXTURE_ID
        or state.get("steps") != ["claim-recorded"]
        or state.get("status") != "partial"
        or len(state.get("attempts", [])) != 1
    ):
        raise RuntimeError(
            "second demo session did not observe the exact partial state"
        )
    state["attempts"].append(
        {
            "schema": "kungfu.session-attempt/v1",
            "sessionAttemptId": "agent-work-lab-attempt-2",
            "processId": os.getpid(),
            "freshProcess": True,
            "priorTranscriptIncluded": False,
            "humanExplanationIncluded": False,
            "observedState": "partial-first-attempt",
            "action": "continue-remaining-step",
            "status": "ended-complete",
        }
    )
    state["steps"].append("continuation-completed")
    state["status"] = "complete"
    _atomic_json(state_path, state)


def _semantic_attempt(attempt: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in attempt.items() if key not in {"processId"}}


def run_demo(
    output_dir: str | Path | None = None,
    *,
    on_event: AgentWorkLabEventSink | None = None,
) -> dict[str, Any]:
    """Run the real two-process deterministic fixture in a discardable root."""

    suite_catalog, _, _ = _load_suite_catalog()
    plan = demo_plan()
    if output_dir is None:
        root = Path(tempfile.mkdtemp(prefix="kungfu-agent-work-lab-"))
    else:
        root = Path(output_dir).expanduser().absolute()
        root.mkdir(parents=True, exist_ok=False)
    state_path = root / "fixture-state.json"
    runtime_dir = root / "runtime"
    work_ref = _work_ref(plan["planRoot"])
    process_ids: list[int] = []
    session_attempts: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    _publish_event(
        events,
        {
            "schema": "kungfu.agent-work-lab.event/v1",
            "step": "plan",
            "status": "ready",
            "root": plan["planRoot"],
        },
        on_event,
    )
    for attempt_index in (1, 2):
        _publish_event(
            events,
            {
                "schema": "kungfu.agent-work-lab.event/v1",
                "step": f"session-{attempt_index}-start",
                "status": "running",
                "root": plan["planRoot"],
            },
            on_event,
        )
        episode = _open_session_episode(
            runtime_dir, attempt_index, str(DEMO_AGENT_IDENTITY["provider"])
        )
        process = multiprocessing.get_context("spawn").Process(
            target=_demo_worker,
            args=(str(state_path), attempt_index, work_ref),
        )
        process.start()
        process_ids.append(process.pid or 0)
        process.join(30)
        if process.is_alive():
            process.terminate()
            process.join(5)
            _close_session_episode(
                episode,
                runtime_dir,
                root,
                attempt_index,
                {
                    "workRef": work_ref,
                    "processId": process.pid or 0,
                    "status": "timed-out",
                },
                ok=False,
            )
            raise RuntimeError(f"demo session {attempt_index} timed out")
        if process.exitcode != 0:
            _close_session_episode(
                episode,
                runtime_dir,
                root,
                attempt_index,
                {
                    "workRef": work_ref,
                    "processId": process.pid or 0,
                    "status": "failed",
                    "exitCode": process.exitcode,
                },
                ok=False,
            )
            raise RuntimeError(
                f"demo session {attempt_index} exited {process.exitcode}"
            )
        observed = json.loads(state_path.read_text(encoding="utf-8"))
        observed_attempt = observed["attempts"][-1]
        episode_receipt = _close_session_episode(
            episode,
            runtime_dir,
            root,
            attempt_index,
            {
                "workRef": work_ref,
                "processId": process.pid or 0,
                "status": str(observed_attempt["status"]),
                "stateRoot": content_root(observed),
                "priorTranscriptIncluded": False,
            },
            ok=True,
        )
        admitted_attempt = {**observed_attempt, **episode_receipt}
        session_attempts.append(admitted_attempt)
        _publish_event(
            events,
            {
                "schema": "kungfu.agent-work-lab.event/v1",
                "step": f"session-{attempt_index}",
                "status": str(observed_attempt["status"]),
                "root": content_root(_semantic_attempt(admitted_attempt)),
            },
            on_event,
        )
    state = json.loads(state_path.read_text(encoding="utf-8"))
    attempts = state.get("attempts", [])
    oracle_checks = [
        {
            "id": "distinct-fresh-processes",
            "passed": len(set(process_ids)) == 2 and all(process_ids),
        },
        {
            "id": "first-attempt-ended-partial",
            "passed": len(attempts) == 2
            and attempts[0].get("status") == "ended-partial",
        },
        {
            "id": "second-attempt-no-transcript-or-explanation",
            "passed": len(attempts) == 2
            and attempts[1].get("priorTranscriptIncluded") is False
            and attempts[1].get("humanExplanationIncluded") is False,
        },
        {
            "id": "second-attempt-recognized-partial-state",
            "passed": len(attempts) == 2
            and attempts[1].get("observedState") == "partial-first-attempt",
        },
        {
            "id": "fixture-completed",
            "passed": state.get("status") == "complete"
            and state.get("steps") == ["claim-recorded", "continuation-completed"],
        },
    ]
    passed = all(row["passed"] for row in oracle_checks)
    semantic_state = {
        **state,
        "attempts": [_semantic_attempt(attempt) for attempt in attempts],
    }
    identity_root = content_root(DEMO_AGENT_IDENTITY)
    assessment = {
        "schema": "kungfu.agent-work-lab.assessment/v1",
        "status": "qualified" if passed else "failed",
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "planRoot": plan["planRoot"],
        "identityRoot": identity_root,
        "oracleChecks": oracle_checks,
        "fixtureRoot": content_root(semantic_state),
        "receiptRoots": [attempt["receiptRoot"] for attempt in session_attempts],
        "episodeRoots": [attempt["episodeRoot"] for attempt in session_attempts],
    }
    assessment["assessmentRoot"] = content_root(assessment)
    _publish_event(
        events,
        {
            "schema": "kungfu.agent-work-lab.event/v1",
            "step": "assessment",
            "status": assessment["status"],
            "root": assessment["assessmentRoot"],
        },
        on_event,
    )
    report_semantic = {
        "schema": DEMO_REPORT_SCHEMA,
        "status": assessment["status"],
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "planRoot": plan["planRoot"],
        "workRef": state["workRef"],
        "sessionAttempts": [_semantic_attempt(attempt) for attempt in session_attempts],
        "identity": DEMO_AGENT_IDENTITY,
        "identityRoot": identity_root,
        "assessment": assessment,
        "events": events,
        "meaning": (
            "The deterministic continuity mechanism recognized and continued "
            "governed state across fresh sessions."
        ),
        "nonClaims": list(suite_catalog["nonClaims"]),
        "receiptDependencies": [
            root_value
            for attempt in session_attempts
            for root_value in (attempt["episodeRoot"], attempt["receiptRoot"])
        ],
        "recoveryGuidance": suite_catalog["recoveryGuidance"],
    }
    report = {
        **report_semantic,
        "reportRoot": content_root(report_semantic),
        "evidenceDirectory": str(root),
        "writeOccurred": True,
    }
    _atomic_json(root / "report.json", report)
    return report
