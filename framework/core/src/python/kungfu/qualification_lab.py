# SPDX-License-Identifier: Apache-2.0

"""Shared Agent Qualification Lab authority.

The GUI and TUI consume this module through the public CLI. Startup inspection
is deliberately filesystem-only and read-only: importing the native runtime or
opening a journal can materialize an otherwise empty home.
"""

from __future__ import annotations

import hashlib
import json
import multiprocessing
import os
import platform
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Mapping

import kungfu
from kungfu.agent import runtime_profiles


STARTUP_SCHEMA = "kungfu.qualification-lab.startup-route/v1"
CATALOG_SCHEMA = "kungfu.qualification-lab.catalog/v1"
DEMO_PLAN_SCHEMA = "kungfu.qualification-lab.demo-plan/v1"
DEMO_REPORT_SCHEMA = "kungfu.qualification-lab.report/v1"
AGENT_PLAN_SCHEMA = "kungfu.qualification-lab.agent-plan/v1"
AGENT_REPORT_SCHEMA = "kungfu.qualification-lab.agent-report/v1"
SUITE_ID = "kungfu.agent-continuity.v1"
FIXTURE_ID = "partial-claim-fresh-session"
WORK_JOURNAL_RELATIVE = Path("journal/system/work/items/live")
CONSOLE_REGISTRY_RELATIVE = Path("agent-session/work-console-registry.json")
MIGRATION_MARKERS = (
    ".migration-in-progress",
    ".storage-migration-in-progress",
    "migration.lock",
)
DEMO_AGENT_IDENTITY = {
    "provider": "kungfu-demo-agent",
    "executableDigest": "sha256:" + hashlib.sha256(b"kungfu-demo-agent/v1").hexdigest(),
    "version": "1",
    "model": "deterministic-state-machine",
    "runtimeProfileRoot": "sha256:"
    + hashlib.sha256(b"kungfu-demo-agent-profile/v1").hexdigest(),
    "argv": ["bundled", "qualification-lab-demo"],
}


def content_root(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _diagnostic(
    runtime_dir: Path, code: str, message: str, *, evidence: list[str] | None = None
) -> dict[str, Any]:
    return {
        "schema": STARTUP_SCHEMA,
        "state": "diagnostic",
        "route": "diagnostic",
        "reasonCode": code,
        "message": message,
        "runtimeDir": str(runtime_dir),
        "workGraphPresent": None,
        "evidence": evidence or [],
        "writeOccurred": False,
    }


def _work_graph(runtime_dir: Path, code: str, evidence: list[str]) -> dict[str, Any]:
    return {
        "schema": STARTUP_SCHEMA,
        "state": "existing-work",
        "route": "work-graph",
        "reasonCode": code,
        "message": "Canonical local Work graph data is present.",
        "runtimeDir": str(runtime_dir),
        "workGraphPresent": True,
        "evidence": evidence,
        "writeOccurred": False,
    }


def _empty(runtime_dir: Path, code: str) -> dict[str, Any]:
    return {
        "schema": STARTUP_SCHEMA,
        "state": "verified-empty",
        "route": "qualification-lab",
        "reasonCode": code,
        "message": "No canonical local Work graph data is present.",
        "runtimeDir": str(runtime_dir),
        "workGraphPresent": False,
        "evidence": [],
        "writeOccurred": False,
    }


def _inspect_console_registry(runtime_dir: Path) -> dict[str, Any] | None:
    target = runtime_dir / CONSOLE_REGISTRY_RELATIVE
    if not target.exists():
        return None
    if target.is_symlink() or not target.is_file():
        return _diagnostic(
            runtime_dir,
            "work-console-registry-invalid",
            "The WorkConsole registry is not a regular file.",
            evidence=[str(CONSOLE_REGISTRY_RELATIVE)],
        )
    try:
        value = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return _diagnostic(
            runtime_dir,
            "work-console-registry-unreadable",
            f"The WorkConsole registry cannot be verified: {error}",
            evidence=[str(CONSOLE_REGISTRY_RELATIVE)],
        )
    if (
        not isinstance(value, dict)
        or value.get("schema") != "kungfu.work-console-registry/v2"
        or not isinstance(value.get("consoles"), list)
    ):
        return _diagnostic(
            runtime_dir,
            "work-console-registry-corrupt",
            "The WorkConsole registry does not match its canonical contract.",
            evidence=[str(CONSOLE_REGISTRY_RELATIVE)],
        )
    if value["consoles"]:
        return _work_graph(
            runtime_dir,
            "work-console-registry-present",
            [str(CONSOLE_REGISTRY_RELATIVE)],
        )
    return None


def inspect_startup(runtime_dir: str | Path) -> dict[str, Any]:
    """Resolve the boot route without opening or creating runtime state."""

    selected = Path(runtime_dir).expanduser()
    if not selected.exists():
        return _empty(selected.absolute(), "runtime-home-absent")
    try:
        if selected.is_symlink() or not selected.is_dir():
            return _diagnostic(
                selected.absolute(),
                "runtime-home-invalid",
                "The Kungfu runtime home is not a regular directory.",
            )
        selected = selected.resolve()
        if not os.access(selected, os.R_OK | os.X_OK):
            return _diagnostic(
                selected,
                "runtime-home-permission-denied",
                "The Kungfu runtime home cannot be inspected safely.",
            )
        markers = [name for name in MIGRATION_MARKERS if (selected / name).exists()]
        if markers:
            return _diagnostic(
                selected,
                "runtime-migration-in-progress",
                "Kungfu data is migrating; startup will not classify it as empty.",
                evidence=markers,
            )
        console = _inspect_console_registry(selected)
        if console is not None:
            return console
        journal = selected / WORK_JOURNAL_RELATIVE
        if not journal.exists():
            manifest = selected / "work/store/manifest.json"
            if manifest.exists():
                return _diagnostic(
                    selected,
                    "work-journal-missing",
                    "Work metadata exists but the canonical journal is missing.",
                    evidence=["work/store/manifest.json"],
                )
            return _empty(selected, "work-authority-absent")
        if journal.is_symlink() or not journal.is_dir():
            return _diagnostic(
                selected,
                "work-journal-invalid",
                "The canonical Work journal path is not a regular directory.",
                evidence=[str(WORK_JOURNAL_RELATIVE)],
            )
        entries = list(journal.iterdir())
        invalid = [
            entry.name
            for entry in entries
            if entry.is_symlink() or not entry.is_file() or entry.stat().st_size <= 0
        ]
        if invalid:
            return _diagnostic(
                selected,
                "work-journal-corrupt",
                "The canonical Work journal contains unverifiable entries.",
                evidence=[
                    str(WORK_JOURNAL_RELATIVE / name) for name in sorted(invalid)
                ],
            )
        if not entries:
            return _diagnostic(
                selected,
                "work-journal-incomplete",
                "The canonical Work journal directory exists without records.",
                evidence=[str(WORK_JOURNAL_RELATIVE)],
            )
        return _work_graph(
            selected,
            "work-journal-present",
            [
                str(WORK_JOURNAL_RELATIVE / entry.name)
                for entry in sorted(entries, key=lambda row: row.name)
            ],
        )
    except OSError as error:
        return _diagnostic(
            selected.absolute(),
            "runtime-home-unreadable",
            f"Kungfu data cannot be inspected safely: {error}",
        )


def catalog(runtime_dir: str | Path) -> dict[str, Any]:
    startup = inspect_startup(runtime_dir)
    return {
        "schema": CATALOG_SCHEMA,
        "startup": startup,
        "suite": {
            "id": SUITE_ID,
            "fixture": FIXTURE_ID,
            "oracle": "exact-partial-state-recognized-and-completed",
            "claims": [
                "continuity mechanism",
                "deterministic state recognition",
                "fresh-session continuation",
            ],
            "nonClaims": [
                "model intelligence",
                "production fitness",
                "security assessment",
                "KFD certification",
                "provider ranking",
            ],
        },
        "actions": [
            {
                "id": "qualification-lab.demo.plan",
                "mutation": "none",
                "resultSchema": DEMO_PLAN_SCHEMA,
            },
            {
                "id": "qualification-lab.demo.run",
                "mutation": "isolated-demo-only",
                "resultSchema": DEMO_REPORT_SCHEMA,
            },
            {
                "id": "qualification-lab.agent.plan",
                "mutation": "none",
                "resultSchema": AGENT_PLAN_SCHEMA,
            },
            {
                "id": "qualification-lab.agent.run",
                "mutation": "isolated-agent-processes-after-explicit-confirmation",
                "resultSchema": AGENT_REPORT_SCHEMA,
            },
        ],
        "authority": {
            "startup": "Core read-only resolver",
            "actions": "Core Qualification Lab",
            "surfaces": ["cli", "gui", "tui"],
            "uiPrivateWrites": False,
        },
        "qualificationStates": [
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


def _demo_worker(state_path_value: str, attempt_index: int) -> None:
    state_path = Path(state_path_value)
    if attempt_index == 1:
        if state_path.exists():
            raise RuntimeError("first demo session requires a new fixture")
        work_ref = {
            "schema": "kungfu.work-ref/v1",
            "workspaceId": f"qualification-lab:{FIXTURE_ID}",
            "profileId": "kungfu.agent-qualification",
            "entityType": "qualification-fixture",
            "entityId": FIXTURE_ID,
        }
        state = {
            "schema": "kungfu.qualification-lab.fixture-state/v1",
            "suite": SUITE_ID,
            "fixture": FIXTURE_ID,
            "workRef": work_ref,
            "steps": ["claim-recorded"],
            "status": "partial",
            "attempts": [
                {
                    "schema": "kungfu.session-attempt/v1",
                    "sessionAttemptId": "qualification-attempt-1",
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
        state.get("schema") != "kungfu.qualification-lab.fixture-state/v1"
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
            "sessionAttemptId": "qualification-attempt-2",
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


def run_demo(output_dir: str | Path | None = None) -> dict[str, Any]:
    """Run the real two-process deterministic fixture in a discardable root."""

    plan = demo_plan()
    if output_dir is None:
        root = Path(tempfile.mkdtemp(prefix="kungfu-qualification-lab-"))
    else:
        root = Path(output_dir).expanduser().absolute()
        root.mkdir(parents=True, exist_ok=False)
    state_path = root / "fixture-state.json"
    process_ids: list[int] = []
    for attempt_index in (1, 2):
        process = multiprocessing.get_context("spawn").Process(
            target=_demo_worker, args=(str(state_path), attempt_index)
        )
        process.start()
        process_ids.append(process.pid or 0)
        process.join(30)
        if process.is_alive():
            process.terminate()
            process.join(5)
            raise RuntimeError(f"demo session {attempt_index} timed out")
        if process.exitcode != 0:
            raise RuntimeError(
                f"demo session {attempt_index} exited {process.exitcode}"
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
        "schema": "kungfu.qualification-lab.assessment/v1",
        "status": "qualified" if passed else "failed",
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "planRoot": plan["planRoot"],
        "identityRoot": identity_root,
        "oracleChecks": oracle_checks,
        "fixtureRoot": content_root(semantic_state),
    }
    assessment["assessmentRoot"] = content_root(assessment)
    events = [
        {
            "schema": "kungfu.qualification-lab.event/v1",
            "step": "plan",
            "status": "ready",
            "root": plan["planRoot"],
        },
        {
            "schema": "kungfu.qualification-lab.event/v1",
            "step": "session-1",
            "status": "ended-partial",
            "root": content_root(_semantic_attempt(attempts[0])),
        },
        {
            "schema": "kungfu.qualification-lab.event/v1",
            "step": "session-2",
            "status": "ended-complete",
            "root": content_root(_semantic_attempt(attempts[1])),
        },
        {
            "schema": "kungfu.qualification-lab.event/v1",
            "step": "assessment",
            "status": assessment["status"],
            "root": assessment["assessmentRoot"],
        },
    ]
    report_semantic = {
        "schema": DEMO_REPORT_SCHEMA,
        "status": assessment["status"],
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "planRoot": plan["planRoot"],
        "workRef": state["workRef"],
        "sessionAttempts": [_semantic_attempt(attempt) for attempt in attempts],
        "identity": DEMO_AGENT_IDENTITY,
        "identityRoot": identity_root,
        "assessment": assessment,
        "events": events,
        "meaning": "The deterministic continuity mechanism recognized and continued governed state across fresh sessions.",
        "nonClaims": catalog(root)["suite"]["nonClaims"],
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
            "--skip-git-repo-check",
            "--sandbox",
            "workspace-write",
            prompt,
        ]
    if provider == "claude":
        return [
            *command,
            "--print",
            "--permission-mode",
            "acceptEdits",
            prompt,
        ]
    if provider == "opencode":
        return [*command, "run", prompt]
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
        "commandPreview": _provider_command(profile, "<qualification-prompt>"),
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
    return (
        "Kungfu Agent Qualification Lab. Work only inside the current isolated "
        "temporary directory. Do not inspect credentials, user chats, or any "
        "path outside this directory. "
        f"{prior} Read {state_path.name}, then replace it with valid JSON. "
        "Preserve schema, suite, fixture, and workRef exactly. Set "
        f'status="{target_status}" and steps={target_steps}. '
        "Do not create or modify any other file. This fixture measures exact "
        "state recognition and continuation, not general intelligence."
    )


def _run_agent_process(
    command: list[str], root: Path, timeout_seconds: int
) -> tuple[int, int, str, str]:
    process = subprocess.Popen(
        command,
        cwd=root,
        env=os.environ.copy(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate()
        raise RuntimeError(
            f"local agent session timed out after {timeout_seconds} seconds"
        ) from None
    return process.pid, process.returncode, stdout, stderr


def run_agent(
    profile_id: str,
    *,
    target_profile_id: str | None = None,
    config_home: str | None = None,
    runtime_home: str | None = None,
    output_dir: str | Path | None = None,
    timeout_seconds: int = 300,
) -> dict[str, Any]:
    """Qualify a selected local agent in two explicitly authorized fresh runs."""

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
    plan = {
        "planRoot": content_root(run_semantic),
        "identity": run_identity,
        "identityRoot": content_root(run_identity),
    }
    if output_dir is None:
        root = Path(tempfile.mkdtemp(prefix="kungfu-agent-qualification-"))
    else:
        root = Path(output_dir).expanduser().absolute()
        root.mkdir(parents=True, exist_ok=False)
    state_path = root / "fixture-state.json"
    initial_state = {
        "schema": "kungfu.qualification-lab.fixture-state/v1",
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "workRef": {
            "schema": "kungfu.work-ref/v1",
            "workspaceId": f"qualification-lab:{FIXTURE_ID}",
            "profileId": "kungfu.agent-qualification",
            "entityType": "qualification-fixture",
            "entityId": FIXTURE_ID,
        },
        "steps": [],
        "status": "unstarted",
    }
    _atomic_json(state_path, initial_state)
    attempts: list[dict[str, Any]] = []
    for attempt_index in (1, 2):
        prompt = _agent_prompt(state_path, attempt_index)
        command = _provider_command(profiles[attempt_index - 1], prompt)
        process_id, returncode, stdout, stderr = _run_agent_process(
            command, root, timeout_seconds
        )
        receipt = {
            "schema": "kungfu.session-attempt/v1",
            "sessionAttemptId": f"qualification-attempt-{attempt_index}",
            "processId": process_id,
            "freshProcess": True,
            "priorTranscriptIncluded": False,
            "humanExplanationIncluded": False,
            "exitCode": returncode,
            "stdoutRoot": content_root(stdout),
            "stderrRoot": content_root(stderr),
        }
        attempts.append(receipt)
        if returncode != 0:
            break
        try:
            observed = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            break
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
        "schema": "kungfu.qualification-lab.assessment/v1",
        "status": status,
        "suite": SUITE_ID,
        "fixture": FIXTURE_ID,
        "planRoot": plan["planRoot"],
        "identityRoot": plan["identityRoot"],
        "oracleChecks": oracle_checks,
        "residualRisks": residual_risks,
        "fixtureRoot": content_root(final_state),
    }
    assessment["assessmentRoot"] = content_root(assessment)
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
        "events": [
            {
                "schema": "kungfu.qualification-lab.event/v1",
                "step": f"session-{index + 1}",
                "status": (
                    str(row.get("observedState") or "complete")
                    if row.get("exitCode") == 0
                    else "failed"
                ),
                "root": content_root(row),
            }
            for index, row in enumerate(attempts)
        ],
        "meaning": "The selected identity recognized and continued exact governed state across two fresh local agent processes.",
        "runMode": ("cross-provider-migration" if migration else "self-continuity"),
        "nonClaims": catalog(root)["suite"]["nonClaims"],
        "receiptRoots": [content_root(row) for row in attempts],
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
        "schema": "kungfu.qualification-lab.report-status/v1",
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
