# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral ``kungfu run agent`` process orchestration.

The runner launches only the executable selected by a verified Agent Runtime
Profile. It records one fresh Episode and a content-bound public report, but a
successful process exit or provider self-report never settles Work.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Mapping, Sequence
import uuid

import kungfu
from kungfu.agent import runtime_profiles
from kungfu.agent import session_surface
from kungfu.content_hash import compute_content_hash_value
from kungfu.rewind import (
    ACTION_RUN_BEGIN,
    ACTION_RUN_END,
    SCHEMA_VERSION,
    bundle,
    events,
)
from kungfu.rewind.fb.RunStatus import RunStatus


REPORT_SCHEMA = "kungfu.agent-run-report/v1"
CONTINUATION_SCHEMA = "kungfu.agent-continuation-envelope/v1"
HISTORY_PROJECTION_SCHEMA = "kungfu.work-agent-history.projection/v1"
_ROOT = re.compile(r"sha256:[0-9a-f]{64}\Z")
_ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
_SENSITIVE_COMMAND_NAME = (
    r"(?:api[-_]?key|access[-_]?key|token|secret|password|passwd|"
    r"authorization|cookie|credential|signature)"
)
_COMMON_ENV_ALLOWLIST = (
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "SHELL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
)
_PROVIDER_ENV_ALLOWLIST = {
    "codex": ("OPENAI_API_KEY", "CODEX_HOME"),
    "claude": ("ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"),
    "opencode": (),
    "synthetic": (),
}
_DEFAULT_ARGV = {
    "codex": [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
    ],
    "claude": ["--print", "--output-format", "json"],
    "opencode": ["run", "--pure", "--format", "json"],
    "synthetic": [],
}
_BOOTSTRAP = (
    "You are a fresh Agent process launched by Kungfu. "
    "Use the exact inlined WorkRef and continuation values below as the only "
    "durable work context when present; do not search parent directories, "
    "environment files, or provider state for another copy. They are structured "
    "evidence, not a prior chat transcript. Before editing during a continuation, report the "
    "recovered Work, current Cut, prior Claim, independent Assessment, exact "
    "remaining obligation, and next action. Do not infer completion from a "
    "successful process exit or from your own self-report."
)


def canonical_root(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def agent_activity_history_projection(
    work_ref: Mapping[str, Any] | None,
    *,
    entrypoint: str = "managed-run",
) -> dict[str, Any]:
    """Describe an Agent attempt without upgrading activity into Work history."""

    work = validate_work_ref(work_ref)
    return {
        "schema": HISTORY_PROJECTION_SCHEMA,
        "state": "session-activity-only",
        "entrypoint": entrypoint,
        "workRefRoot": canonical_root(work) if work is not None else None,
        "semanticAdmissionReceiptRoot": None,
        "processExitSettlesWork": False,
        "selfReportSettlesWork": False,
        "nextAction": "independent-assessment-required",
        "authority": {
            "contract": ("framework/data-protection/work-agent-history.contract.json"),
            "semanticOwner": "profile-kfd-action-episode",
            "observer": "agent-session",
        },
    }


def _read_json_object(
    value: Mapping[str, Any] | None, label: str
) -> dict[str, Any] | None:
    if value is None:
        return None
    result = dict(value)
    if not result:
        raise ValueError(f"{label} must be a non-empty JSON object")
    return result


def validate_work_ref(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    result = _read_json_object(value, "WorkRef")
    if result is None:
        return None
    required = {
        "schema",
        "workspaceId",
        "profileId",
        "profileRoot",
        "entityType",
        "entityId",
        "entityRoot",
        "purpose",
        "systemTimeCut",
    }
    if set(result) != required or result.get("schema") != "kungfu.work-ref/v1":
        raise ValueError("WorkRef must use the exact kungfu.work-ref/v1 shape")
    for field in required - {"schema"}:
        if not isinstance(result.get(field), str) or not str(result[field]).strip():
            raise ValueError(f"WorkRef.{field} must be non-empty text")
    for field in ("profileRoot", "entityRoot"):
        if _ROOT.fullmatch(str(result[field])) is None:
            raise ValueError(f"WorkRef.{field} must be a sha256 root")
    return result


def validate_continuation(
    value: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    result = _read_json_object(value, "continuation envelope")
    if result is None:
        return None
    required = {
        "schema",
        "workRef",
        "currentCutRoot",
        "priorClaimRoot",
        "assessmentRoot",
        "remainingObligation",
        "nextAction",
    }
    if set(result) != required or result.get("schema") != CONTINUATION_SCHEMA:
        raise ValueError(
            f"continuation envelope must use the exact {CONTINUATION_SCHEMA} shape"
        )
    result["workRef"] = validate_work_ref(result.get("workRef"))
    for field in ("currentCutRoot", "priorClaimRoot", "assessmentRoot"):
        if _ROOT.fullmatch(str(result.get(field) or "")) is None:
            raise ValueError(f"continuation envelope {field} must be a sha256 root")
    for field in ("remainingObligation", "nextAction"):
        if not isinstance(result.get(field), str) or not result[field].strip():
            raise ValueError(f"continuation envelope {field} must be non-empty text")
    forbidden = {"transcript", "messages", "history", "session"}
    if forbidden.intersection(result):
        raise ValueError("continuation envelope cannot contain transcript state")
    return result


def select_profile(
    profile_id: str | None,
    *,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> tuple[dict[str, Any], str]:
    if profile_id and profile_id.startswith("kungfu.mock-agent."):
        scenario = profile_id.removeprefix("kungfu.mock-agent.")
        return runtime_profiles.deterministic_mock_profile(scenario), "qualification"
    resolved = runtime_profiles.kungfu_config.resolve_config(
        config_home=config_home, runtime_home=runtime_home
    )
    catalog = runtime_profiles.discover_catalog(resolved_config=resolved)
    selected = (
        profile_id
        or catalog.get("defaultProfileId")
        or catalog.get("recommendedProfileId")
    )
    if not selected:
        raise ValueError(
            "no Agent Runtime Profile is available; run "
            "`kungfu agent runtime discover` or configure one explicitly"
        )
    profile = runtime_profiles.find_profile(
        str(selected), config_home=config_home, runtime_home=runtime_home
    )
    source = (
        "explicit"
        if profile_id
        else (
            "default" if catalog.get("defaultProfileId") == selected else "recommended"
        )
    )
    return profile, source


def launch_argv(
    profile: Mapping[str, Any],
    prompt: str,
    *,
    work_ref: Mapping[str, Any] | None = None,
    continuation: Mapping[str, Any] | None = None,
    workspace_root: str | None = None,
    permission_mode: str = "workspace-write",
) -> list[str]:
    launch = dict(profile.get("launch") or {})
    provider = str(profile.get("provider") or "")
    executable = str(launch.get("executable") or "")
    if provider not in _DEFAULT_ARGV:
        raise ValueError(f"unsupported Agent Runtime Profile provider: {provider}")
    if not executable:
        raise ValueError("Agent Runtime Profile executable is required")
    if launch.get("shellMode") is True:
        raise ValueError(
            "kungfu run agent requires an exact executable profile; shellMode is unsupported"
        )
    prefix = [str(value) for value in launch.get("argv") or _DEFAULT_ARGV[provider]]
    if permission_mode not in {"workspace-write", "read-only"}:
        raise ValueError(f"unsupported Agent permission mode: {permission_mode}")
    if provider == "codex":
        if "--sandbox" in prefix:
            sandbox_index = prefix.index("--sandbox")
            if sandbox_index + 1 >= len(prefix):
                raise ValueError("Codex --sandbox requires a value")
            prefix[sandbox_index + 1] = permission_mode
        else:
            prefix.extend(["--sandbox", permission_mode])
    admitted = {
        "workRef": dict(work_ref) if work_ref is not None else None,
        "continuation": dict(continuation) if continuation is not None else None,
        "workspaceRoot": workspace_root,
    }
    evidence = json.dumps(
        admitted, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    effective_prompt = (
        f"{_BOOTSTRAP}\n\n"
        "Admitted Kungfu context envelope (structured evidence; prior transcript "
        f"bytes = 0):\n{evidence}\n\nTask:\n{prompt}"
    )
    return [executable, *prefix, effective_prompt]


def _environment(
    provider: str,
    *,
    runtime_dir: str,
    run_id: str,
    workspace_root: str | None,
    work_ref: dict[str, Any] | None,
    continuation: dict[str, Any] | None,
    source: Mapping[str, str] | None = None,
) -> tuple[dict[str, str], list[str]]:
    ambient = os.environ if source is None else source
    allowed = (*_COMMON_ENV_ALLOWLIST, *_PROVIDER_ENV_ALLOWLIST[provider])
    env = {key: str(ambient[key]) for key in allowed if ambient.get(key)}
    if provider == "opencode":
        isolated = Path(runtime_dir) / "agent-runs" / run_id / "provider-home"
        env.update(
            {
                "XDG_DATA_HOME": str(isolated / "data"),
                "XDG_CONFIG_HOME": str(isolated / "config"),
                "XDG_CACHE_HOME": str(isolated / "cache"),
            }
        )
    if provider == "synthetic":
        env["KUNGFU_AS_VARIANT"] = "node"
    env.update(
        {
            "KUNGFU_AGENT_ATTEMPT_ID": run_id,
            "KUNGFU_CONTROL_RUNTIME_DIR": runtime_dir,
            "KUNGFU_PRIOR_TRANSCRIPT_BYTES": "0",
        }
    )
    if work_ref is not None:
        env["KUNGFU_WORK_REF"] = json.dumps(
            work_ref, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
    if continuation is not None:
        env["KUNGFU_AGENT_CONTINUATION"] = json.dumps(
            continuation,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    if workspace_root is not None:
        env["KUNGFU_WORKSPACE_ROOT"] = workspace_root
    return env, sorted(env)


def _cwd(
    profile: Mapping[str, Any], *, workspace_root: str | None, home: str | None
) -> str | None:
    policy = profile.get("cwdPolicy")
    if policy == "workspace-root":
        if not workspace_root:
            raise ValueError("workspace-root profile requires --workspace")
        return str(Path(workspace_root).expanduser().resolve())
    if policy == "home":
        return str(Path(home or os.path.expanduser("~")).expanduser().resolve())
    if policy == "inherit":
        return None
    raise ValueError(f"unsupported Agent Runtime Profile cwdPolicy: {policy}")


@dataclass
class ProcessResult:
    exit_code: int
    stdout: str
    stderr: str
    interrupted: bool
    timed_out: bool


def _session_ref(work: Mapping[str, Any], run_id: str) -> dict[str, str]:
    return {
        "workConsoleId": (
            f"work:{work['profileId']}:{work['entityType']}:{work['entityId']}"
        ),
        "sessionAttemptId": run_id,
    }


def _invoke_session_control(
    invoke: Callable[[Mapping[str, Any]], Mapping[str, Any]],
    ref: Mapping[str, str],
    operation: str,
    payload: Mapping[str, Any],
    *,
    automatic: bool = True,
) -> Mapping[str, Any]:
    plan = invoke(
        {
            "operation": "plan-control",
            "controlOperation": operation,
            "session": dict(ref),
            "payload": dict(payload),
        }
    )
    return invoke(
        {
            "operation": operation,
            "actorId": "kungfu-project-work",
            "client": "cli",
            "plan": plan,
            "expectedPlanRoot": plan["root"],
            "payload": dict(payload),
            "automatic": automatic,
        }
    )


def _wait_for_session(
    invoke: Callable[[Mapping[str, Any]], Mapping[str, Any]],
    ref: Mapping[str, str],
    predicate: Callable[[Mapping[str, Any]], bool],
    *,
    timeout_seconds: float,
) -> Mapping[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    latest: Mapping[str, Any] | None = None
    while time.monotonic() < deadline:
        latest = invoke({"operation": "status", "session": dict(ref)})
        if predicate(latest):
            return latest
        time.sleep(0.05)
    state = (latest or {}).get("interactionState") or "unavailable"
    raise ValueError(f"Agent Session did not reach a safe boundary: {state}")


def run_session_attempt(
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
) -> tuple[ProcessResult, dict[str, Any]]:
    """Start one Work-bound Session, deliver the first turn, and yield at attention."""

    provider = str(selected["provider"])
    ref = _session_ref(work, run_id)
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
        "profileRoot": canonical_root(selected),
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
    ready = _wait_for_session(
        invoke,
        ref,
        lambda status: (
            status.get("interactionState")
            in {"ready", "approval-needed", "unknown", "ended"}
        ),
        timeout_seconds=min(timeout_seconds, 30.0),
    )
    if ready.get("interactionState") != "ready":
        raise ValueError(
            "Agent Session requires attention before the initial Work instruction"
        )
    before_sequence = int((ready.get("output") or {}).get("nextSequence") or 0)
    delivered = _invoke_session_control(invoke, ref, "instruct", {"text": prompt})
    if delivered.get("status") not in {"written", "duplicate"}:
        raise ValueError(
            f"Agent Session rejected the Work instruction: {delivered.get('reason')}"
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
    boundary = _wait_for_session(
        invoke,
        ref,
        lambda status: (
            status.get("interactionState") in {"approval-needed", "unknown", "ended"}
            or (
                status.get("interactionState") == "ready"
                and int((status.get("output") or {}).get("nextSequence") or 0)
                > before_sequence
            )
        ),
        timeout_seconds=timeout_seconds,
    )
    snapshot = invoke(
        {"operation": "snapshot", "session": dict(ref), "requestedSequence": 0}
    )
    lines = list(((snapshot.get("terminal") or {}).get("vt") or {}).get("lines") or [])
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
        ProcessResult(
            exit_code=exit_code,
            stdout=visible,
            stderr="",
            interrupted=False,
            timed_out=False,
        ),
        session_value,
    )


def run_process(
    argv: Sequence[str],
    *,
    cwd: str | None,
    env: Mapping[str, str],
    timeout_seconds: float,
    output_sink: Callable[[str, str], None] | None = None,
) -> ProcessResult:
    process = subprocess.Popen(
        list(argv),
        cwd=cwd,
        env=dict(env),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    reader_errors: list[Exception] = []

    def drain(stream_name: str, stream: Any, target: list[str]) -> None:
        for line in stream:
            target.append(line)
            if output_sink is not None:
                try:
                    output_sink(stream_name, line)
                except Exception as error:  # pragma: no cover - host callback failure
                    reader_errors.append(error)

    assert process.stdout is not None
    assert process.stderr is not None
    stdout_thread = threading.Thread(
        target=drain,
        args=("stdout", process.stdout, stdout_lines),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=drain,
        args=("stderr", process.stderr, stderr_lines),
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()
    try:
        process.wait(timeout=timeout_seconds)
        interrupted = False
        timed_out = False
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        interrupted = True
        timed_out = True
    except KeyboardInterrupt:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        interrupted = True
        timed_out = False
    stdout_thread.join()
    stderr_thread.join()
    if reader_errors:
        raise RuntimeError(f"Agent output stream failed: {reader_errors[0]}")
    return ProcessResult(
        process.returncode or (124 if timed_out else 130 if interrupted else 0),
        "".join(stdout_lines),
        "".join(stderr_lines),
        interrupted,
        timed_out,
    )


def public_activities_from_provider_line(
    provider: str, line: str
) -> list[dict[str, Any]]:
    """Project bounded Agent/tool activity with a credential-safe command preview."""

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


def parse_provider_output(provider: str, stdout: str) -> dict[str, Any]:
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


def execute(
    *,
    prompt: str,
    runtime_dir: str,
    config_home: str | None = None,
    profile_id: str | None = None,
    workspace_root: str | None = None,
    home: str | None = None,
    work_ref: Mapping[str, Any] | None = None,
    continuation: Mapping[str, Any] | None = None,
    permission_mode: str = "workspace-write",
    timeout_seconds: float = 900,
    process_runner: Callable[..., ProcessResult] = run_process,
    event_sink: Callable[[Mapping[str, Any]], None] | None = None,
    session_invoker: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
    use_session: bool | None = None,
) -> dict[str, Any]:
    from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle

    if not prompt.strip():
        raise ValueError("agent prompt must be non-empty")
    run_id = f"agent-{uuid.uuid4().hex}"
    selected, selection = select_profile(
        profile_id, config_home=config_home, runtime_home=home
    )
    verification = runtime_profiles.verify_profile(selected)
    if not verification["ok"]:
        raise ValueError(
            "Agent Runtime Profile verification failed: "
            f"{verification.get('error') or 'unknown error'}"
        )
    work = validate_work_ref(work_ref)
    continuation_value = validate_continuation(continuation)
    if continuation_value is not None:
        if work is None:
            work = continuation_value["workRef"]
        elif work != continuation_value["workRef"]:
            raise ValueError("WorkRef does not match the continuation envelope")
    provider = str(selected["provider"])
    cwd = _cwd(selected, workspace_root=workspace_root, home=home)
    argv = launch_argv(
        selected,
        prompt,
        work_ref=work,
        continuation=continuation_value,
        workspace_root=cwd,
        permission_mode=permission_mode,
    )
    env, env_keys = _environment(
        provider,
        runtime_dir=runtime_dir,
        run_id=run_id,
        workspace_root=cwd,
        work_ref=work,
        continuation=continuation_value,
    )
    run_dir = Path(runtime_dir) / "agent-runs" / run_id
    bundle_dir = run_dir / "bundle"
    bundle_dir.mkdir(parents=True, exist_ok=True)
    episode = RuntimeEpisodeLifecycle(
        runtime_dir=runtime_dir,
        namespace="agent-run",
        name=run_id,
        title=f"agent run {run_id}",
        actor=provider,
        source=f"agent-run:{run_id}",
    )
    started = time.monotonic_ns()
    streamed_agent_text = False
    session_value: dict[str, Any] | None = None

    def project_output(stream_name: str, line: str) -> None:
        nonlocal streamed_agent_text
        if event_sink is None or stream_name != "stdout":
            return
        for activity in public_activities_from_provider_line(provider, line):
            streamed_agent_text = streamed_agent_text or activity.get("kind") == "agent"
            event_sink(activity)

    with episode.guard():
        episode.record_event(
            ACTION_RUN_BEGIN,
            events.run_begin(
                run_id=run_id,
                command=f"{provider} agent runtime",
                runtime=sys.platform,
                supervisor_version=kungfu.__version__,
                schema_version=SCHEMA_VERSION,
            ),
            run_id=run_id,
        )
        session_requested = (
            use_session
            if use_session is not None
            else bool(os.environ.get("KUNGFU_PROJECT_WORK_AGENT_SESSION"))
        )
        session_invoke = session_invoker
        if session_requested and session_invoke is None:
            session_invoke = session_surface.invoke
        if (
            session_requested
            and session_invoke is not None
            and provider in {"codex", "claude", "synthetic"}
            and permission_mode == "workspace-write"
            and work is not None
            and cwd is not None
        ):
            result, session_value = run_session_attempt(
                invoke=session_invoke,
                run_id=run_id,
                selected=selected,
                verification=verification,
                work=work,
                cwd=cwd,
                env=env,
                prompt=argv[-1],
                timeout_seconds=timeout_seconds,
                event_sink=event_sink,
            )
        elif process_runner is run_process:
            result = process_runner(
                argv,
                cwd=cwd,
                env=env,
                timeout_seconds=timeout_seconds,
                output_sink=project_output,
            )
        else:
            result = process_runner(
                argv, cwd=cwd, env=env, timeout_seconds=timeout_seconds
            )
        status = RunStatus.Succeeded if result.exit_code == 0 else RunStatus.Failed
        episode.record_event(
            ACTION_RUN_END,
            events.run_end(run_id, status, result.exit_code),
            run_id=run_id,
        )
        parsed = parse_provider_output(provider, result.stdout)
        if (
            event_sink is not None
            and not streamed_agent_text
            and isinstance(parsed.get("text"), str)
        ):
            for raw in str(parsed["text"]).splitlines():
                text = _ANSI_ESCAPE.sub("", raw).strip()
                if text:
                    event_sink(
                        {
                            "schema": "kungfu.agent-run.activity/v1",
                            "kind": "agent",
                            "phase": "completed",
                            "text": text[:1000],
                            "rawToolArgumentsExposed": False,
                        }
                    )
        response = {
            "schema": "kungfu.agent-run-response/v1",
            "runId": run_id,
            "provider": provider,
            "exitCode": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "parsed": parsed,
            "session": session_value,
        }
        response_path = bundle_dir / "response.json"
        response_path.write_text(
            json.dumps(response, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        episode.attach_payload_ref(str(response_path))
        profile_root = canonical_root(selected)
        manifest_path = str(bundle_dir / "manifest.json")
        report_body = {
            "schema": REPORT_SCHEMA,
            "runId": run_id,
            "attemptId": run_id,
            "runtimeProfile": {
                "id": selected["id"],
                "root": profile_root,
                "provider": provider,
                "executable": selected["launch"]["executable"],
                "version": verification["version"],
                "selection": selection,
                "verified": True,
            },
            "launch": {
                "mode": "agent-session" if session_value is not None else "process",
                "cwd": cwd,
                "permissionMode": permission_mode,
                "argvWithoutPrompt": argv[:-1],
                "environmentKeys": env_keys,
                "promptRoot": canonical_root(prompt),
                "promptBytes": len(prompt.encode("utf-8")),
                "admittedContextRoot": canonical_root(
                    {
                        "workRef": work,
                        "continuation": continuation_value,
                        "workspaceRoot": cwd,
                    }
                ),
                "bootstrapAndContextBytes": len(argv[-1].encode("utf-8"))
                - len(prompt.encode("utf-8")),
                "interrupted": result.interrupted,
                "timedOut": result.timed_out,
                "exitCode": result.exit_code,
                "wallTimeNs": max(0, time.monotonic_ns() - started),
            },
            "providerObservation": parsed,
            "session": session_value,
            "work": {
                "workRef": work,
                "continuation": continuation_value,
                "processExitSettlesWork": False,
                "selfReportSettlesWork": False,
                "settlementStatus": "unsettled",
                "nextAction": "independent-assessment-required",
            },
            "historyProtection": agent_activity_history_projection(work),
            "privacy": {
                "priorTranscriptBytesGivenToAgent": 0,
                "privateProviderSessionStoreRead": False,
                "providerHomeIsolation": (
                    "fresh-xdg-directories" if provider == "opencode" else "not-claimed"
                ),
                "environmentValuesReported": False,
            },
            "episode": {
                "episodeId": str(episode.episode_id),
                "responsePath": str(response_path),
                "manifestPath": manifest_path,
                "reportPath": str(bundle_dir / "report.json"),
            },
        }
        report = {**report_body, "reportRoot": canonical_root(report_body)}
        report_path = bundle_dir / "report.json"
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        episode.attach_payload_ref(str(report_path))
        emitted_manifest_path = bundle.emit(
            str(bundle_dir),
            runtime_dir,
            {
                "mode": "LIVE",
                "role": "SYSTEM",
                "namespace": "agent-run",
                "name": run_id,
                "dest": 0,
            },
            extra={
                "agent_run": {
                    "schema": REPORT_SCHEMA,
                    "report": "report.json",
                    "reportSha256": compute_content_hash_value(
                        report_path.read_bytes()
                    ),
                    "profileRoot": profile_root,
                    "workRefRoot": canonical_root(work) if work else None,
                    "continuationRoot": (
                        canonical_root(continuation_value)
                        if continuation_value
                        else None
                    ),
                    "completionAuthority": False,
                }
            },
        )
        if emitted_manifest_path != manifest_path:
            raise RuntimeError("agent-run manifest path changed during emission")
        episode.attach_payload_ref(manifest_path)
        episode.close(
            ok=result.exit_code == 0,
            reason=f"agent process exit_code={result.exit_code}; Work remains unsettled",
        )
    return report
