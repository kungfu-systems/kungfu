# SPDX-License-Identifier: Apache-2.0

"""Shared Agent Work Lab authority.

The GUI and TUI consume this module through the public CLI. Startup inspection
reads the verified global Work projection without materializing runtime state.
"""

from __future__ import annotations

import hashlib
import json
import multiprocessing
import os
import platform
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

import kungfu
from kungfu import assignment_orchestration as orchestration
from kungfu.agent import runtime_profiles
from kungfu.agent.work_projection import STARTUP_SCHEMA, inspect_startup
from kungfu.initiative_family import canonical as assignment_canonical
from kungfu.rewind import (
    ACTION_RUN_BEGIN,
    ACTION_RUN_END,
    SCHEMA_VERSION,
    events as rewind_events,
)
from kungfu.rewind.fb.RunStatus import RunStatus
from kungfu.storage import service as storage_service
from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle
from kungfu.workspace import resolve_workspace_target


CATALOG_SCHEMA = "kungfu.agent-work-lab.catalog/v1"
DEMO_PLAN_SCHEMA = "kungfu.agent-work-lab.demo-plan/v1"
DEMO_REPORT_SCHEMA = "kungfu.agent-work-lab.report/v1"
AGENT_PLAN_SCHEMA = "kungfu.agent-work-lab.agent-plan/v1"
AGENT_REPORT_SCHEMA = "kungfu.agent-work-lab.agent-report/v1"
PUBLIC_ACTIVITY_SCHEMA = "kungfu.agent-work-lab.public-activity/v1"
PUBLIC_OUTPUT_SCHEMA = "kungfu.agent-work-lab.public-output/v1"
TEMPLATE_SCHEMA = "kungfu.project-template/v1"
PLAN_SCHEMA = "kungfu.project-template.plan/v1"
RECEIPT_SCHEMA = "kungfu.project-template.creation-receipt/v1"
DEFAULT_TEMPLATE_ID = "kungfu.agent-work-starter"
FORBIDDEN_TEMPLATE_ROOTS = {".git", ".kungfu"}


def content_root(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


human_agent_catalog = runtime_profiles.human_agent_catalog
resolve_agent_selector = runtime_profiles.resolve_human_selector


def _suite_catalog_candidates() -> list[Path]:
    candidates: list[Path] = []
    roots = [
        value
        for value in (
            os.environ.get("KF_BUNDLED_EXTENSION_ROOT"),
            *os.environ.get("KF_EXTENSION_PATH", "").split(os.pathsep),
        )
        if value
    ]
    for root in roots:
        candidates.append(
            Path(root).expanduser() / "agent-work-lab" / "experience" / "catalog.json"
        )
    candidates.append(
        Path(__file__).resolve().parents[5]
        / "extensions"
        / "agent-work-lab"
        / "experience"
        / "catalog.json"
    )
    return candidates


def _load_suite_catalog() -> tuple[dict[str, Any], Path, str]:
    for path in _suite_catalog_candidates():
        if not path.is_file():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        if (
            payload.get("schema") != "kungfu.agent-work-lab.suite-catalog/v1"
            or payload.get("id") != "kungfu.agent-work-lab"
            or payload.get("collection", {}).get("id") != "work-continuity"
            or [row.get("id") for row in payload.get("cases", [])]
            != ["offline-demo", "same-agent", "cross-agent"]
            or payload.get("capabilityDeclarations") != ["agentRuntime", "work"]
        ):
            raise RuntimeError(f"invalid Agent Work Lab Suite catalog: {path}")
        encoded = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        return (
            payload,
            path.resolve(),
            f"sha256:{hashlib.sha256(encoded).hexdigest()}",
        )
    raise RuntimeError(
        "Agent Work Lab Suite catalog is unavailable; install the first-party "
        "KFX Suite or set a valid bundled extension root"
    )


SUITE_ID = "kungfu.agent-work-lab"
FIXTURE_ID = "partial-claim-fresh-session"
CONTENT_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
ANSI_ESCAPE = re.compile(r"\x1b(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
PUBLIC_OUTPUT_MESSAGES = {
    1: "Recorded the bounded partial result and stopped.",
    2: "Found the prior governed state and completed only the remaining step.",
}
PUBLIC_PROGRESS_MESSAGES = {
    1: (
        "I’m starting fresh, so I’ll inspect the governed task state first.",
        "I found an unstarted task. I’ll record only the bounded first step.",
    ),
    2: (
        "I’m starting fresh, so I’ll recover the governed task state before acting.",
        "I found Session 1’s partial result and the same Work identity.",
    ),
}
DEMO_AGENT_IDENTITY = {
    "provider": "kungfu-demo-agent",
    "executableDigest": "sha256:" + hashlib.sha256(b"kungfu-demo-agent/v1").hexdigest(),
    "version": "1",
    "model": "deterministic-state-machine",
    "runtimeProfileRoot": "sha256:"
    + hashlib.sha256(b"kungfu-demo-agent-profile/v1").hexdigest(),
    "argv": ["bundled", "agent-work-lab-demo"],
}

AgentWorkLabEventSink = Callable[[Mapping[str, Any]], None]


def _work_ref(plan_root: str) -> dict[str, Any]:
    suite_catalog, _, suite_catalog_root = _load_suite_catalog()
    entity = {
        "suite": SUITE_ID,
        "collection": suite_catalog["collection"]["id"],
        "fixture": FIXTURE_ID,
        "catalogRoot": suite_catalog_root,
        "planRoot": plan_root,
    }
    return {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": f"agent-work-lab:{suite_catalog_root[7:23]}",
        "profileId": SUITE_ID,
        "profileRoot": suite_catalog_root,
        "entityType": "suite-case",
        "entityId": FIXTURE_ID,
        "entityRoot": content_root(entity),
        "purpose": "work-continuity",
        "systemTimeCut": plan_root,
    }


def _episode_content_root(runtime_dir: Path, episode_id: int) -> str:
    verified = storage_service.fsck(
        runtime_dir, episode_id=episode_id, verify_frames=True
    )
    if verified.get("ok") is not True:
        raise RuntimeError("Agent Work Lab Episode failed Core frame verification")
    inspected = storage_service.episode_inspect(runtime_dir, episode_id=episode_id)
    candidates = [
        inspected.get("content_root") or {},
        ((inspected.get("episode") or {}).get("root") or {}),
    ]
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        raw = str(
            candidate.get("computed")
            or candidate.get("root_value")
            or candidate.get("value")
            or ""
        )
        if CONTENT_ROOT.fullmatch(raw):
            return raw
        if re.fullmatch(r"[0-9a-f]{64}", raw):
            return f"sha256:{raw}"
    raise RuntimeError("Agent Work Lab Episode has no verified content root")


def _open_session_episode(
    runtime_dir: Path, attempt_index: int, actor: str
) -> RuntimeEpisodeLifecycle:
    run_id = f"agent-work-lab-session-{attempt_index}"
    episode = RuntimeEpisodeLifecycle(
        runtime_dir=str(runtime_dir),
        namespace="agent-work-lab",
        name=run_id,
        title=f"Agent Work Lab Session {attempt_index}",
        actor=actor,
        source=f"agent-work-lab:{attempt_index}",
    )
    episode.record_event(
        ACTION_RUN_BEGIN,
        rewind_events.run_begin(
            run_id=run_id,
            command="Agent Work Lab governed Session",
            runtime=platform.system().lower(),
            supervisor_version=kungfu.__version__,
            schema_version=SCHEMA_VERSION,
        ),
        run_id=run_id,
    )
    return episode


def _close_session_episode(
    episode: RuntimeEpisodeLifecycle,
    runtime_dir: Path,
    evidence_root: Path,
    attempt_index: int,
    receipt: Mapping[str, Any],
    *,
    ok: bool,
) -> dict[str, Any]:
    run_id = f"agent-work-lab-session-{attempt_index}"
    immutable_receipt = {
        "schema": "kungfu.agent-work-lab.session-receipt/v1",
        "attemptIndex": attempt_index,
        **dict(receipt),
    }
    receipt_root = content_root(immutable_receipt)
    receipt_path = evidence_root / f"session-{attempt_index}-receipt.json"
    _atomic_json(receipt_path, immutable_receipt)
    episode.attach_payload_ref(str(receipt_path))
    episode.record_event(
        ACTION_RUN_END,
        rewind_events.run_end(
            run_id,
            RunStatus.Succeeded if ok else RunStatus.Failed,
            0 if ok else 1,
        ),
        run_id=run_id,
    )
    episode.close(
        ok=ok,
        reason=(
            "Agent Work Lab Session evidence admitted"
            if ok
            else "Agent Work Lab Session evidence failed admission"
        ),
    )
    episode_root = _episode_content_root(runtime_dir, episode.episode_id)
    return {
        "episodeId": str(episode.episode_id),
        "episodeRoot": episode_root,
        "receiptRoot": receipt_root,
        "receiptPath": str(receipt_path),
    }


def _publish_event(
    events: list[dict[str, Any]],
    event: dict[str, Any],
    on_event: AgentWorkLabEventSink | None,
) -> None:
    events.append(event)
    if on_event is not None:
        on_event(event)


def catalog(
    runtime_dir: str | Path,
    *,
    config_home: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    suite_catalog, suite_catalog_path, suite_catalog_root = _load_suite_catalog()
    startup = inspect_startup(runtime_dir, config_home=config_home, env=env)
    return {
        "schema": CATALOG_SCHEMA,
        "startup": startup,
        "suite": {
            **suite_catalog,
            "catalogRoot": suite_catalog_root,
            "catalogPath": str(suite_catalog_path),
            "fixture": FIXTURE_ID,
            "oracle": "exact-partial-state-recognized-and-completed",
        },
        "actions": [
            {
                "id": "agent-work-lab.open",
                "mutation": "none",
                "resultSchema": "interactive-tui",
            },
            {
                "id": "agent-work-lab.watch",
                "mutation": "isolated-playback-only",
                "resultSchema": DEMO_REPORT_SCHEMA,
            },
            {
                "id": "agent-work-lab.tour",
                "mutation": "disposable-project-playback-only",
                "resultSchema": "kungfu.project-tour.episode-report/v1",
            },
            {
                "id": "agent-work-lab.try.plan",
                "mutation": "none",
                "resultSchema": PLAN_SCHEMA,
            },
            {
                "id": "agent-work-lab.try.create",
                "mutation": "new-reviewed-project-and-captured-work-after-explicit-confirmation",
                "resultSchema": RECEIPT_SCHEMA,
            },
            {
                "id": "agent-work-lab.test.plan",
                "mutation": "none",
                "resultSchema": "kungfu.agent-work-lab.test-plan/v1",
            },
            {
                "id": "agent-work-lab.test.run",
                "mutation": "isolated-agent-processes-after-explicit-confirmation",
                "resultSchema": AGENT_REPORT_SCHEMA,
            },
            {
                "id": "agent-work-lab.report.open",
                "mutation": "none",
                "resultSchema": "root-verified-agent-work-lab-report",
            },
            {
                "id": "agent-work-lab.agents.discover",
                "mutation": "none",
                "resultSchema": "kungfu.agent-runtime-profile-catalog/v1",
            },
            {
                "id": "agent-work-lab.startup.inspect",
                "mutation": "none",
                "resultSchema": STARTUP_SCHEMA,
            },
            {
                "id": "agent-work-lab.surface.catalog",
                "mutation": "none",
                "resultSchema": CATALOG_SCHEMA,
            },
            {
                "id": "agent-work-lab.demo.plan",
                "mutation": "none",
                "resultSchema": DEMO_PLAN_SCHEMA,
            },
            {
                "id": "agent-work-lab.demo.run",
                "mutation": "isolated-demo-only",
                "resultSchema": DEMO_REPORT_SCHEMA,
            },
            {
                "id": "agent-work-lab.agent.plan",
                "mutation": "none",
                "resultSchema": AGENT_PLAN_SCHEMA,
            },
            {
                "id": "agent-work-lab.agent.run",
                "mutation": "isolated-agent-processes-after-explicit-confirmation",
                "resultSchema": AGENT_REPORT_SCHEMA,
            },
            {
                "id": "agent-work-lab.starter-project.plan",
                "mutation": "none",
                "resultSchema": "kungfu.project-template.plan/v1",
            },
            {
                "id": "agent-work-lab.starter-project.create",
                "mutation": "new-project-files-and-captured-work-request-after-explicit-confirmation",
                "resultSchema": "kungfu.project-template.creation-receipt/v1",
            },
            {
                "id": "agent-work-lab.starter-project.resume",
                "mutation": "none",
                "resultSchema": "kungfu.project-template.resume/v1",
            },
        ],
        "authority": {
            "startup": "Core read-only resolver",
            "actions": "Core Agent Work Lab",
            "surfaces": ["cli", "gui", "tui"],
            "uiPrivateWrites": False,
        },
        "assessmentStates": [
            "unqualified",
            "qualified",
            "qualified-with-residuals",
            "failed",
            "stale",
        ],
    }


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
    suite_catalog, _, _ = _load_suite_catalog()
    """Run the real two-process deterministic fixture in a discardable root."""

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
        "meaning": "The deterministic continuity mechanism recognized and continued governed state across fresh sessions.",
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


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _provider_command(profile: Mapping[str, Any], prompt: str) -> list[str]:
    launch = dict(profile["launch"])
    command = [str(launch["executable"]), *launch.get("argv", [])]
    provider = profile["provider"]
    if provider == "codex":
        return [
            *command,
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "workspace-write",
            prompt,
        ]
    if provider == "claude":
        return [
            *command,
            "--print",
            "--output-format",
            "json",
            prompt,
        ]
    if provider == "amp":
        return [*command, "--execute", prompt]
    if provider == "opencode":
        return [*command, "run", "--pure", "--format", "json", prompt]
    raise ValueError(f"Unsupported Agent Runtime Profile provider: {provider}")


def agent_plan(
    profile_id: str,
    *,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, Any]:
    profile = runtime_profiles.find_profile(
        profile_id, config_home=config_home, runtime_home=runtime_home
    )
    verification = runtime_profiles.verify_profile(profile)
    launch = profile["launch"]
    executable = Path(launch["executable"]).resolve()
    identity = {
        "provider": profile["provider"],
        "profileId": profile["id"],
        "executable": str(executable),
        "executableDigest": _file_digest(executable),
        "version": verification.get("version"),
        "model": None,
        "runtimeProfileRoot": content_root(profile),
        "argv": [str(executable), *launch.get("argv", [])],
        "shellMode": bool(launch.get("shellMode")),
        "backend": profile.get("backendDefault"),
        "os": platform.system().lower(),
        "arch": platform.machine().lower(),
        "kungfuVersion": kungfu.__version__,
    }
    semantic = {
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "identity": identity,
        "sessions": demo_plan()["sessions"],
        "oracle": demo_plan()["oracle"],
    }
    return {
        "schema": AGENT_PLAN_SCHEMA,
        **semantic,
        "identityRoot": content_root(identity),
        "planRoot": content_root(semantic),
        "commandPreview": _provider_command(profile, "<agent-work-lab-prompt>"),
        "verification": verification,
        "credentialContentsRead": False,
        "writeOccurred": False,
    }


def _agent_prompt(state_path: Path, attempt_index: int) -> str:
    target_status = "partial" if attempt_index == 1 else "complete"
    target_steps = (
        '["claim-recorded"]'
        if attempt_index == 1
        else '["claim-recorded","continuation-completed"]'
    )
    prior = (
        "The fixture is unstarted. Record only the first step, then stop."
        if attempt_index == 1
        else (
            "This is a fresh agent session with no prior transcript. Inspect the "
            "existing file, recognize the partial first attempt, complete the "
            "remaining step, then stop."
        )
    )
    public_output = PUBLIC_OUTPUT_MESSAGES[attempt_index]
    progress_before_read, progress_before_write = PUBLIC_PROGRESS_MESSAGES[
        attempt_index
    ]
    return (
        "Kungfu Agent Work Lab. Work only inside the current isolated "
        "temporary directory. Do not inspect credentials, user chats, or any "
        "path outside this directory. "
        "Make your work observable with concise public status updates, never "
        "private reasoning. Before your first tool call, send exactly this "
        "public status line with no markdown: "
        f"KUNGFU_PROGRESS: {progress_before_read} "
        "After reading the state and before modifying it, send exactly this "
        "public status line with no markdown: "
        f"KUNGFU_PROGRESS: {progress_before_write} "
        f"{prior} Read {state_path.name}, then replace it with valid JSON. "
        "Preserve schema, suite, fixture, and workRef exactly. Set "
        f'status="{target_status}" and steps={target_steps}. '
        "Do not create or modify any other file. After the file is valid, make "
        "your final response exactly this single public line, with no markdown: "
        f"KUNGFU_PUBLIC: {public_output} "
        "This fixture measures exact state recognition and continuation, not "
        "general intelligence."
    )


def _provider_text_lines(stdout: str, provider: str) -> list[str]:
    """Extract public Agent messages while ignoring reasoning and tool payloads."""

    messages: list[str] = []
    for raw_line in stdout.splitlines():
        normalized = ANSI_ESCAPE.sub("", raw_line).strip()
        if provider != "codex":
            messages.append(normalized)
            continue
        try:
            payload = json.loads(normalized)
        except json.JSONDecodeError:
            # Keep compatibility with bounded test adapters and older CLIs.
            messages.append(normalized)
            continue
        if not isinstance(payload, dict) or payload.get("type") != "item.completed":
            continue
        item = payload.get("item")
        if not isinstance(item, dict) or item.get("type") != "agent_message":
            continue
        text = item.get("text")
        if isinstance(text, str):
            messages.extend(
                ANSI_ESCAPE.sub("", line).strip() for line in text.splitlines()
            )
    return messages


def _admit_public_activities(
    line: str, provider: str, attempt_index: int
) -> list[dict[str, Any]]:
    """Admit bounded Codex JSONL events without exposing commands or raw output."""

    if provider != "codex":
        return []
    try:
        payload = json.loads(ANSI_ESCAPE.sub("", line).strip())
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, dict):
        return []
    event_type = payload.get("type")
    item = payload.get("item")
    if event_type not in {"item.started", "item.completed"} or not isinstance(
        item, dict
    ):
        return []
    item_type = item.get("type")
    if item_type == "agent_message" and event_type == "item.completed":
        text = item.get("text")
        if not isinstance(text, str):
            return []
        admitted: list[dict[str, Any]] = []
        expected = set(PUBLIC_PROGRESS_MESSAGES[attempt_index])
        for raw_text_line in text.splitlines():
            normalized = ANSI_ESCAPE.sub("", raw_text_line).strip()
            if not normalized.startswith("KUNGFU_PROGRESS: "):
                continue
            message = normalized.removeprefix("KUNGFU_PROGRESS: ")
            if message not in expected:
                continue
            admitted.append(
                {
                    "schema": PUBLIC_ACTIVITY_SCHEMA,
                    "source": "provider-jsonl",
                    "kind": "agent",
                    "phase": "progress",
                    "text": message,
                    "rawOutputRedacted": True,
                }
            )
        return admitted
    if item_type not in {"command_execution", "file_change"}:
        return []
    phase = "started" if event_type == "item.started" else "completed"
    if item_type == "file_change":
        text = (
            "Applying the bounded fixture change in the isolated workspace."
            if phase == "started"
            else "The bounded fixture change was applied."
        )
    elif phase == "started":
        text = "Using a bounded tool inside the isolated test workspace."
    else:
        exit_code = item.get("exit_code")
        text = (
            "The bounded workspace tool completed."
            if exit_code in {None, 0}
            else "The bounded workspace tool reported a failure."
        )
    return [
        {
            "schema": PUBLIC_ACTIVITY_SCHEMA,
            "source": "provider-jsonl",
            "kind": "tool",
            "phase": phase,
            "text": text,
            "rawOutputRedacted": True,
        }
    ]


def _admit_public_output(
    stdout: str, attempt_index: int, provider: str = "codex"
) -> dict[str, Any] | None:
    """Admit only the exact bounded line requested by the Agent Work Lab fixture."""

    expected = f"KUNGFU_PUBLIC: {PUBLIC_OUTPUT_MESSAGES[attempt_index]}"
    normalized_lines = _provider_text_lines(stdout, provider)
    if expected not in normalized_lines:
        return None
    return {
        "schema": PUBLIC_OUTPUT_SCHEMA,
        "source": "provider-stdout",
        "admission": "exact-agent-work-lab-marker",
        "lines": [PUBLIC_OUTPUT_MESSAGES[attempt_index]],
        "rawOutputRedacted": True,
    }


def _run_agent_process(
    command: list[str],
    root: Path,
    timeout_seconds: int,
    on_stdout_line: Callable[[str], None] | None = None,
) -> tuple[int, int, str, str]:
    process = subprocess.Popen(
        command,
        cwd=root,
        env=os.environ.copy(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    reader_errors: list[Exception] = []

    def drain_stdout() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            stdout_lines.append(line)
            if on_stdout_line is not None:
                try:
                    on_stdout_line(line)
                except Exception as error:  # pragma: no cover - host callback failure
                    reader_errors.append(error)

    def drain_stderr() -> None:
        assert process.stderr is not None
        stderr_lines.extend(process.stderr)

    stdout_thread = threading.Thread(target=drain_stdout, daemon=True)
    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    try:
        process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        stdout_thread.join()
        stderr_thread.join()
        raise RuntimeError(
            f"local agent session timed out after {timeout_seconds} seconds"
        ) from None
    stdout_thread.join()
    stderr_thread.join()
    if reader_errors:
        raise RuntimeError(
            f"local agent event stream failed: {reader_errors[0]}"
        ) from reader_errors[0]
    return (
        process.pid,
        process.returncode,
        "".join(stdout_lines),
        "".join(stderr_lines),
    )


def run_agent(
    profile_id: str,
    *,
    target_profile_id: str | None = None,
    config_home: str | None = None,
    runtime_home: str | None = None,
    output_dir: str | Path | None = None,
    timeout_seconds: int = 300,
    on_event: AgentWorkLabEventSink | None = None,
) -> dict[str, Any]:
    suite_catalog, _, _ = _load_suite_catalog()
    """Run a selected local agent in two explicitly authorized fresh Sessions."""

    source_plan = agent_plan(
        profile_id, config_home=config_home, runtime_home=runtime_home
    )
    target_id = target_profile_id or profile_id
    target_plan = agent_plan(
        target_id, config_home=config_home, runtime_home=runtime_home
    )
    profiles = [
        runtime_profiles.find_profile(
            candidate, config_home=config_home, runtime_home=runtime_home
        )
        for candidate in (profile_id, target_id)
    ]
    if not all(row["verification"].get("ok") for row in (source_plan, target_plan)):
        raise ValueError("selected Agent Runtime Profile did not pass verification")
    migration = target_id != profile_id
    run_identity = (
        {
            "mode": "cross-provider-migration",
            "source": source_plan["identity"],
            "target": target_plan["identity"],
        }
        if migration
        else source_plan["identity"]
    )
    run_semantic = {
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "identity": run_identity,
        "sessions": demo_plan()["sessions"],
        "oracle": demo_plan()["oracle"],
    }
    plan_root = content_root(run_semantic)
    plan = {
        "planRoot": plan_root,
        "identity": run_identity,
        "identityRoot": content_root(run_identity),
    }
    if output_dir is None:
        root = Path(tempfile.mkdtemp(prefix="kungfu-agent-work-lab-"))
    else:
        root = Path(output_dir).expanduser().absolute()
        root.mkdir(parents=True, exist_ok=False)
    runtime_dir = root / "runtime"
    state_path = root / "fixture-state.json"
    initial_state = {
        "schema": "kungfu.agent-work-lab.fixture-state/v1",
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "workRef": _work_ref(plan_root),
        "steps": [],
        "status": "unstarted",
    }
    _atomic_json(state_path, initial_state)
    attempts: list[dict[str, Any]] = []
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
        prompt = _agent_prompt(state_path, attempt_index)
        command = _provider_command(profiles[attempt_index - 1], prompt)
        provider = str(profiles[attempt_index - 1]["provider"])
        episode = _open_session_episode(runtime_dir, attempt_index, provider)

        def receive_provider_line(line: str) -> None:
            for activity in _admit_public_activities(line, provider, attempt_index):
                _publish_event(
                    events,
                    {
                        "schema": "kungfu.agent-work-lab.event/v1",
                        "step": f"session-{attempt_index}-activity",
                        "status": (
                            "complete"
                            if activity["phase"] == "completed"
                            else "running"
                        ),
                        "root": content_root(activity),
                        "publicActivity": activity,
                    },
                    on_event,
                )

        try:
            process_id, returncode, stdout, stderr = _run_agent_process(
                command,
                root,
                timeout_seconds,
                on_stdout_line=receive_provider_line,
            )
        except RuntimeError as error:
            _close_session_episode(
                episode,
                runtime_dir,
                root,
                attempt_index,
                {
                    "workRef": initial_state["workRef"],
                    "status": "failed",
                    "errorRoot": content_root(str(error)),
                    "priorTranscriptIncluded": False,
                },
                ok=False,
            )
            raise
        receipt = {
            "schema": "kungfu.session-attempt/v1",
            "sessionAttemptId": f"agent-work-lab-attempt-{attempt_index}",
            "processId": process_id,
            "freshProcess": True,
            "priorTranscriptIncluded": False,
            "humanExplanationIncluded": False,
            "exitCode": returncode,
            "stdoutRoot": content_root(stdout),
            "stderrRoot": content_root(stderr),
        }
        stop_after_event = returncode != 0
        if returncode != 0:
            observed = None
        else:
            try:
                observed = json.loads(state_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                observed = None
                stop_after_event = True
        if observed is not None:
            expected_status = "partial" if attempt_index == 1 else "complete"
            expected_steps = (
                ["claim-recorded"]
                if attempt_index == 1
                else ["claim-recorded", "continuation-completed"]
            )
            receipt["observedState"] = observed.get("status")
            receipt["stateRoot"] = content_root(observed)
            if (
                observed.get("schema") != initial_state["schema"]
                or observed.get("suite") != SUITE_ID
                or observed.get("fixture") != FIXTURE_ID
                or observed.get("workRef") != initial_state["workRef"]
                or observed.get("status") != expected_status
                or observed.get("steps") != expected_steps
            ):
                stop_after_event = True
        episode_receipt = _close_session_episode(
            episode,
            runtime_dir,
            root,
            attempt_index,
            {
                "workRef": initial_state["workRef"],
                **receipt,
                "admittedState": observed if observed is not None else None,
            },
            ok=not stop_after_event,
        )
        receipt.update(episode_receipt)
        attempts.append(receipt)
        event_status = (
            str(receipt.get("observedState") or "complete")
            if returncode == 0 and observed is not None
            else "failed"
        )
        public_output = _admit_public_output(stdout, attempt_index, provider)
        _publish_event(
            events,
            {
                "schema": "kungfu.agent-work-lab.event/v1",
                "step": f"session-{attempt_index}",
                "status": event_status,
                "root": content_root(receipt),
                **({"publicOutput": public_output} if public_output else {}),
            },
            on_event,
        )
        if stop_after_event:
            break
    try:
        final_state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        final_state = {}
    oracle_checks = [
        {
            "id": "two-distinct-fresh-processes",
            "passed": len(attempts) == 2
            and attempts[0]["processId"] != attempts[1]["processId"],
        },
        {
            "id": "both-processes-exited-cleanly",
            "passed": len(attempts) == 2
            and all(row["exitCode"] == 0 for row in attempts),
        },
        {
            "id": "fresh-session-completed-exact-state",
            "passed": final_state.get("status") == "complete"
            and final_state.get("steps") == ["claim-recorded", "continuation-completed"]
            and final_state.get("workRef") == initial_state["workRef"],
        },
    ]
    residual_risks = (
        []
        if all(profile["provider"] == "codex" for profile in profiles)
        else [
            "The selected provider does not expose a Kungfu-verifiable "
            "workspace-only sandbox flag; filesystem confinement relies on "
            "its configured wrapper and the explicit fixture instruction."
        ]
    )
    status = (
        ("qualified" if not residual_risks else "qualified-with-residuals")
        if all(row["passed"] for row in oracle_checks)
        else "failed"
    )
    assessment = {
        "schema": "kungfu.agent-work-lab.assessment/v1",
        "status": status,
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "planRoot": plan["planRoot"],
        "identityRoot": plan["identityRoot"],
        "oracleChecks": oracle_checks,
        "residualRisks": residual_risks,
        "fixtureRoot": content_root(final_state),
        "receiptRoots": [attempt["receiptRoot"] for attempt in attempts],
        "episodeRoots": [attempt["episodeRoot"] for attempt in attempts],
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
        "schema": AGENT_REPORT_SCHEMA,
        "status": status,
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "planRoot": plan["planRoot"],
        "workRef": initial_state["workRef"],
        "sessionAttempts": attempts,
        "identity": plan["identity"],
        "identityRoot": plan["identityRoot"],
        "assessment": assessment,
        "events": events,
        "meaning": "The selected identity recognized and continued exact governed state across two fresh local agent processes.",
        "runMode": ("cross-provider-migration" if migration else "self-continuity"),
        "nonClaims": list(suite_catalog["nonClaims"]),
        "receiptRoots": [attempt["receiptRoot"] for attempt in attempts],
        "receiptDependencies": [
            root_value
            for attempt in attempts
            for root_value in (attempt["episodeRoot"], attempt["receiptRoot"])
        ],
        "recoveryGuidance": suite_catalog["recoveryGuidance"],
        "assessmentRoot": assessment["assessmentRoot"],
    }
    report = {
        **report_semantic,
        "reportRoot": content_root(report_semantic),
        "evidenceDirectory": str(root),
        "credentialContentsRead": False,
        "writeOccurred": True,
    }
    _atomic_json(root / "report.json", report)
    return report


def report_status(
    report: Mapping[str, Any], identity: Mapping[str, Any]
) -> dict[str, Any]:
    current_root = content_root(identity)
    recorded_root = report.get("identityRoot")
    return {
        "schema": "kungfu.agent-work-lab.report-status/v1",
        "status": (
            str(report.get("status") or "failed")
            if current_root == recorded_root
            else "stale"
        ),
        "recordedIdentityRoot": recorded_root,
        "currentIdentityRoot": current_root,
        "stale": current_root != recorded_root,
        "writeOccurred": False,
    }


def next_result_directory(runtime_dir: str | Path) -> Path:
    return (
        Path(runtime_dir).expanduser().absolute()
        / "agent-work-lab"
        / "results"
        / uuid.uuid4().hex
    )


def load_report(
    result: str | Path | None, *, runtime_dir: str | Path
) -> dict[str, Any]:
    """Load and root-verify one exact report or the latest bounded result."""

    if result is None:
        parent = (
            Path(runtime_dir).expanduser().absolute() / "agent-work-lab" / "results"
        )
        candidates = []
        try:
            for child in parent.iterdir():
                candidate = child / "report.json"
                if candidate.is_file():
                    candidates.append(candidate)
        except OSError:
            candidates = []
        if not candidates:
            raise ValueError(
                "no retained Agent Work Lab result is available; run "
                "`kungfu agent-work-lab test --execute` first, or pass an exact report path"
            )
        report_path = max(candidates, key=lambda path: path.stat().st_mtime_ns)
    else:
        report_path = Path(result).expanduser().absolute()
        if report_path.is_dir():
            report_path = report_path / "report.json"
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise ValueError(
            f"Agent Work Lab report is unreadable: {report_path}"
        ) from error
    if report.get("schema") not in {DEMO_REPORT_SCHEMA, AGENT_REPORT_SCHEMA}:
        raise ValueError(f"unsupported Agent Work Lab report: {report_path}")
    semantic = {
        key: value
        for key, value in report.items()
        if key
        not in {
            "reportRoot",
            "evidenceDirectory",
            "writeOccurred",
            "credentialContentsRead",
        }
    }
    if report.get("reportRoot") != content_root(semantic):
        raise ValueError(f"Agent Work Lab report root does not verify: {report_path}")
    return {**report, "reportPath": str(report_path), "writeOccurred": False}


class ProjectTemplateError(ValueError):
    """A fail-closed project-template diagnosis."""


def _template_candidates() -> list[Path]:
    candidates: list[Path] = []
    roots = [
        value
        for value in (
            os.environ.get("KF_BUNDLED_EXTENSION_ROOT"),
            *os.environ.get("KF_EXTENSION_PATH", "").split(os.pathsep),
        )
        if value
    ]
    for root in roots:
        candidates.append(
            Path(root).expanduser()
            / "agent-work-lab"
            / "experience"
            / "starter-project.json"
        )
    candidates.append(
        Path(__file__).resolve().parents[5]
        / "extensions"
        / "agent-work-lab"
        / "experience"
        / "starter-project.json"
    )
    return candidates


def _safe_relative_path(value: Any) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        raise ProjectTemplateError("template file path must be a non-empty string")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or value != path.as_posix()
        or any(part in {"", ".", ".."} for part in path.parts)
        or any(part in FORBIDDEN_TEMPLATE_ROOTS for part in path.parts)
    ):
        raise ProjectTemplateError(f"unsafe template file path: {value}")
    return path


def load_project_template(
    template_id: str = DEFAULT_TEMPLATE_ID,
    *,
    template_path: Path | None = None,
) -> tuple[dict[str, Any], Path, str]:
    candidates = [template_path] if template_path else _template_candidates()
    for candidate in candidates:
        if candidate is None or not candidate.is_file():
            continue
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ProjectTemplateError(
                f"invalid project template JSON: {candidate}"
            ) from error
        if payload.get("schema") != TEMPLATE_SCHEMA:
            raise ProjectTemplateError(f"invalid project template schema: {candidate}")
        if payload.get("id") != template_id:
            if template_path:
                raise ProjectTemplateError(
                    f"project template id mismatch: expected {template_id}"
                )
            continue
        files = payload.get("files")
        if not isinstance(files, list) or not files:
            raise ProjectTemplateError("project template requires at least one file")
        seen: set[str] = set()
        for row in files:
            if not isinstance(row, dict):
                raise ProjectTemplateError("project template file must be an object")
            relative = _safe_relative_path(row.get("path"))
            if relative.as_posix() in seen:
                raise ProjectTemplateError(
                    f"duplicate template file path: {relative.as_posix()}"
                )
            seen.add(relative.as_posix())
            if not isinstance(row.get("content"), str):
                raise ProjectTemplateError(
                    f"template file content must be text: {relative.as_posix()}"
                )
        initial_work = payload.get("initialWork")
        required_work = {
            "initiativeId",
            "assignmentId",
            "title",
            "objective",
            "acceptanceChecks",
        }
        if not isinstance(initial_work, dict) or not required_work.issubset(
            initial_work
        ):
            raise ProjectTemplateError("project template initialWork is incomplete")
        if not all(
            isinstance(initial_work[field], str) and initial_work[field]
            for field in required_work - {"acceptanceChecks"}
        ):
            raise ProjectTemplateError("project template Work identities are invalid")
        checks = initial_work["acceptanceChecks"]
        if not isinstance(checks, list) or not all(
            isinstance(check, str) and check for check in checks
        ):
            raise ProjectTemplateError(
                "project template acceptanceChecks must be non-empty strings"
            )
        return payload, candidate.resolve(), assignment_canonical.semantic_root(payload)
    raise ProjectTemplateError(
        f"project template is unavailable: {template_id}; install its KFX Suite"
    )


def _file_plan(payload: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "path": _safe_relative_path(row["path"]).as_posix(),
            "contentRoot": "sha256:"
            + hashlib.sha256(row["content"].encode("utf-8")).hexdigest(),
        }
        for row in payload["files"]
    ]


def default_project_destination(
    payload: dict[str, Any],
    *,
    parent: str | Path | None = None,
) -> Path:
    root = (
        Path(parent).expanduser()
        if parent is not None
        else Path.home() / "Kungfu Projects"
    ).resolve()
    name = str(payload.get("suggestedDirectoryName") or "kungfu-project")
    candidate = root / name
    index = 2
    while candidate.exists():
        candidate = root / f"{name}-{index}"
        index += 1
    return candidate


def plan_project_template(
    template_id: str,
    destination: str | Path | None = None,
    *,
    parent: str | Path | None = None,
    template_path: Path | None = None,
) -> dict[str, Any]:
    payload, source_path, template_root = load_project_template(
        template_id, template_path=template_path
    )
    target = (
        Path(destination).expanduser().resolve()
        if destination is not None
        else default_project_destination(payload, parent=parent)
    )
    if target.exists():
        raise ProjectTemplateError(f"destination already exists: {target}")
    if target == target.parent:
        raise ProjectTemplateError("destination cannot be a filesystem root")
    preimage = {
        "schema": PLAN_SCHEMA,
        "templateId": template_id,
        "templateVersion": payload["version"],
        "templateRoot": template_root,
        "templateSource": str(source_path),
        "destination": str(target),
        "files": _file_plan(payload),
        "initialWork": {
            "state": "capture-pending",
            "initiativeId": payload["initialWork"]["initiativeId"],
            "assignmentId": payload["initialWork"]["assignmentId"],
            "title": payload["initialWork"]["title"],
            "acceptanceChecks": payload["initialWork"]["acceptanceChecks"],
        },
        "effects": [
            f"Create {len(payload['files'])} project files under {target}",
            "Capture one content-addressed initial Work request under the project workspace",
        ],
        "skippedEffects": [
            "No existing path will be overwritten",
            "No Work is admitted, assigned, executed, or completed",
            "No Git repository, ignore rule, commit, remote, push, or publication is created",
        ],
        "confirmationRequired": True,
        "writeOccurred": False,
    }
    return {**preimage, "planRoot": assignment_canonical.semantic_root(preimage)}


def _assignment_request(payload: dict[str, Any], template_root: str) -> dict[str, Any]:
    work = payload["initialWork"]
    return {
        "schema": "kungfu.assignment-request/v1",
        "source": {
            "kind": "kungfu-project-template",
            "templateId": payload["id"],
            "templateRoot": template_root,
        },
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {
            "goal_id": work["assignmentId"],
            "mission_id": work["initiativeId"],
            "title": work["title"],
            "objective": work["objective"],
            "acceptance_criteria": work["acceptanceChecks"],
            "project_template_id": payload["id"],
            "project_template_root": template_root,
        },
    }


def _verify_created_files(
    destination: Path, files: list[dict[str, str]]
) -> dict[str, Any]:
    checks = []
    for row in files:
        candidate = destination.joinpath(*PurePosixPath(row["path"]).parts)
        observed = (
            "sha256:" + hashlib.sha256(candidate.read_bytes()).hexdigest()
            if candidate.is_file()
            else None
        )
        checks.append(
            {
                "path": row["path"],
                "expectedRoot": row["contentRoot"],
                "observedRoot": observed,
                "passed": observed == row["contentRoot"],
            }
        )
    return {"ok": all(row["passed"] for row in checks), "checks": checks}


def create_project_template(
    template_id: str,
    destination: str | Path,
    *,
    expected_plan_root: str,
    actor: str,
    template_path: Path | None = None,
) -> dict[str, Any]:
    if not actor.strip():
        raise ProjectTemplateError("actor is required")
    plan = plan_project_template(template_id, destination, template_path=template_path)
    if plan["planRoot"] != expected_plan_root:
        raise ProjectTemplateError("project template plan is stale or mismatched")
    payload, _, template_root = load_project_template(
        template_id, template_path=template_path
    )
    target = Path(plan["destination"])
    created = False
    try:
        target.mkdir(parents=True, exist_ok=False)
        created = True
        for row in payload["files"]:
            relative = _safe_relative_path(row["path"])
            output = target.joinpath(*relative.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("x", encoding="utf-8", newline="") as stream:
                stream.write(row["content"])
        verification = _verify_created_files(target, plan["files"])
        if not verification["ok"]:
            raise ProjectTemplateError(
                "created project files failed exact verification"
            )
        workspace_target = resolve_workspace_target(
            "capture-only",
            str(target),
            cwd=str(target),
        )
        capture = orchestration.capture_assignment_request(
            _assignment_request(payload, template_root), workspace_target
        )
        if capture.get("status") not in {"captured", "already-present"}:
            raise ProjectTemplateError("initial Work request capture failed")
    except Exception:
        if created and target.exists():
            shutil.rmtree(target)
        raise
    receipt_preimage = {
        "schema": RECEIPT_SCHEMA,
        "status": "created",
        "templateId": template_id,
        "templateRoot": template_root,
        "planRoot": plan["planRoot"],
        "destination": str(target),
        "actor": actor,
        "files": plan["files"],
        "verification": verification,
        "initialWork": {
            "state": "captured-pending-admission",
            "initiativeId": payload["initialWork"]["initiativeId"],
            "assignmentId": payload["initialWork"]["assignmentId"],
            "requestRoot": capture["requestRoot"],
            "receiptRoot": capture["receiptRoot"],
            "requestPath": capture["requestPath"],
        },
        "openAction": payload["openAction"],
        "nonClaims": payload["nonClaims"],
        "writeOccurred": True,
    }
    return {
        **receipt_preimage,
        "receiptRoot": assignment_canonical.semantic_root(receipt_preimage),
    }
