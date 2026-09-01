# SPDX-License-Identifier: Apache-2.0

"""Shared Agent Work Lab authority.

The GUI and TUI consume this module through the public CLI. Startup inspection
reads the verified global Work projection without materializing runtime state.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import tempfile
import threading
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, Mapping

import kungfu
from kungfu.agent import runtime_profiles
from kungfu.agent.work_projection import STARTUP_SCHEMA, inspect_startup
from kungfu.agent_work_lab_evidence import (
    AGENT_PLAN_SCHEMA,
    AGENT_REPORT_SCHEMA,
    ANSI_ESCAPE,
    CATALOG_SCHEMA,
    CONTENT_ROOT as CONTENT_ROOT,
    DEFAULT_TEMPLATE_ID as DEFAULT_TEMPLATE_ID,
    DEMO_AGENT_IDENTITY as DEMO_AGENT_IDENTITY,
    DEMO_PLAN_SCHEMA,
    DEMO_REPORT_SCHEMA,
    FIXTURE_ID,
    FORBIDDEN_TEMPLATE_ROOTS as FORBIDDEN_TEMPLATE_ROOTS,
    PLAN_SCHEMA,
    PUBLIC_ACTIVITY_SCHEMA,
    PUBLIC_OUTPUT_MESSAGES,
    PUBLIC_OUTPUT_SCHEMA,
    PUBLIC_PROGRESS_MESSAGES,
    RECEIPT_SCHEMA,
    SUITE_ID,
    TEMPLATE_SCHEMA as TEMPLATE_SCHEMA,
    AgentWorkLabEventSink,
    close_episode as _close_session_episode,
    content_root,
    load_suite_catalog as _load_suite_catalog,
    open_episode as _open_session_episode,
    publish_event as _publish_event,
    work_reference as _work_ref,
)
from kungfu.agent_work_lab_demo import (
    _atomic_json,
    _demo_worker as _demo_worker,
    _semantic_attempt as _semantic_attempt,
    demo_plan as demo_plan,
    run_demo as run_demo,
)
from kungfu.agent_work_lab_template import (
    ProjectTemplateError as ProjectTemplateError,
    _assignment_request as _assignment_request,
    _file_plan as _file_plan,
    _safe_relative_path as _safe_relative_path,
    _template_candidates as _template_candidates,
    _verify_created_files as _verify_created_files,
    create_project_template as create_project_template,
    default_project_destination as default_project_destination,
    load_project_template as load_project_template,
    plan_project_template as plan_project_template,
)


human_agent_catalog = runtime_profiles.human_agent_catalog
resolve_agent_selector = runtime_profiles.resolve_human_selector


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
                "mutation": (
                    "new-reviewed-project-and-captured-work-after-explicit-confirmation"
                ),
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
                "mutation": (
                    "new-project-files-and-captured-work-request-after-"
                    "explicit-confirmation"
                ),
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
        "meaning": (
            "The selected identity recognized and continued exact governed state "
            "across two fresh local agent processes."
        ),
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
                "`kungfu agent-work-lab test --execute` first, or pass an exact "
                "report path"
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


for _symbol in (
    "content_root",
    "demo_plan",
    "_atomic_json",
    "_demo_worker",
    "_semantic_attempt",
    "run_demo",
    "_template_candidates",
    "_safe_relative_path",
    "load_project_template",
    "_file_plan",
    "default_project_destination",
    "plan_project_template",
    "_assignment_request",
    "_verify_created_files",
    "create_project_template",
):
    globals()[_symbol].__module__ = __name__
    globals()[_symbol].__qualname__ = _symbol

ProjectTemplateError.__module__ = __name__
ProjectTemplateError.__qualname__ = "ProjectTemplateError"
