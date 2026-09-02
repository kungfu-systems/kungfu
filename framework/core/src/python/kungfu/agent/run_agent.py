# SPDX-License-Identifier: Apache-2.0

"""Stable facade for provider-neutral Agent process orchestration."""

from __future__ import annotations

from dataclasses import dataclass as dataclass
import json
import os
from pathlib import Path
import re as re
import subprocess as subprocess
import sys
import threading as threading
import time
from typing import Any, Callable, Mapping, Sequence as Sequence
import uuid

import kungfu
from kungfu.agent import resources as agent_resources
from kungfu.agent import runtime_profiles
from kungfu.agent import session_contract as session_contract
from kungfu.agent import session_surface
from kungfu.agent.native_launch import (
    COMMAND_WRAPPER_SUFFIXES as _WINDOWS_COMMAND_WRAPPER_SUFFIXES,
    NativeLaunchCoordinator as NativeLaunchCoordinator,
    apply_platform_tls_trust as apply_platform_tls_trust,
    encode_wrapper_prompt as _encode_windows_wrapper_prompt,
    managed_console_scope as _managed_console_scope,
    managed_workspace_id as _managed_workspace_id,
    native_environment as _native_environment,
    native_provider_adapter,
    provider_interactive_argv as interactive_launch_argv,
    provider_runtime_health as _provider_runtime_health,
    resolve_command_wrapper as _resolve_windows_command_wrapper,
)
from kungfu.agent.provider_bootstrap import refresh_native_skill_runtime_audit
from kungfu.agent.managed_run import ManagedRunCoordinator as ManagedRunCoordinator
from kungfu.agent.provider_output import (
    parse_provider_output,
    public_activities_from_provider_line,
    public_command_preview as public_command_preview,
)
from kungfu.content_hash import compute_content_hash_value
from kungfu.initiative_family import canonical as assignment_canonical
from kungfu.skill import build_skill_context as build_skill_context
from kungfu.workspace import resolve_workspace_target as resolve_workspace_target
from kungfu.rewind import (
    ACTION_RUN_BEGIN,
    ACTION_RUN_END,
    SCHEMA_VERSION,
    bundle,
    events,
)
from kungfu.rewind.fb.RunStatus import RunStatus
from kungfu.agent._run_agent.runtime import (
    REPORT_SCHEMA as REPORT_SCHEMA,
    CONTINUATION_SCHEMA as CONTINUATION_SCHEMA,
    _ROOT as _ROOT,
    _ANSI_ESCAPE as _ANSI_ESCAPE,
    _WINDOWS_PROCESS_ENV_ALLOWLIST as _WINDOWS_PROCESS_ENV_ALLOWLIST,
    _COMMON_ENV_ALLOWLIST as _COMMON_ENV_ALLOWLIST,
    _PROVIDER_ENV_ALLOWLIST as _PROVIDER_ENV_ALLOWLIST,
    _DEFAULT_ARGV as _DEFAULT_ARGV,
    _BOOTSTRAP as _BOOTSTRAP,
    bind_current_native_work as bind_current_native_work,
    canonical_root as canonical_root,
    validate_work_ref as validate_work_ref,
    validate_continuation as validate_continuation,
    select_profile as select_profile,
    select_interactive_profile as select_interactive_profile,
    launch_argv as launch_argv,
    _direct_process_transport as _direct_process_transport,
    native_environment as _runtime_native_environment,
    run_native_interactive as _runtime_run_native_interactive,
    _environment as _environment,
    _cwd as _cwd,
    ProcessResult as ProcessResult,
    _session_ref as _session_ref,
    _invoke_session_control as _invoke_session_control,
    _wait_for_session as _wait_for_session,
    run_session_attempt as run_session_attempt,
    run_process as run_process,
)


_COMPATIBILITY_EXPORTS = (
    agent_resources,
    _WINDOWS_PROCESS_ENV_ALLOWLIST,
    _WINDOWS_COMMAND_WRAPPER_SUFFIXES,
    _encode_windows_wrapper_prompt,
    _native_environment,
    interactive_launch_argv,
    _provider_runtime_health,
    _resolve_windows_command_wrapper,
    assignment_canonical,
    build_skill_context,
    resolve_workspace_target,
)


_MOVED_CALLABLE_SYMBOLS = (
    "bind_current_native_work validate_work_ref "
    "validate_continuation select_profile select_interactive_profile launch_argv "
    "_direct_process_transport _environment _cwd ProcessResult _session_ref "
    "_invoke_session_control _wait_for_session run_session_attempt run_process"
).split()
for _symbol in _MOVED_CALLABLE_SYMBOLS:
    globals()[_symbol].__module__ = __name__
    globals()[_symbol].__qualname__ = _symbol


def agent_activity_history_projection(
    work_ref: Mapping[str, Any] | None,
    *,
    entrypoint: str = "managed-run",
) -> dict[str, Any]:
    """Project Agent activity through the stable facade contract."""

    return agent_resources.agent_activity_history_projection(
        validate_work_ref(work_ref), entrypoint=entrypoint
    )


def native_environment(*args, **kwargs) -> dict[str, str]:
    """Build a native environment through the public injectable Skill seam."""

    return _runtime_native_environment(
        *args, skill_context_builder=build_skill_context, **kwargs
    )


def run_native_interactive(
    profile: Mapping[str, Any],
    *,
    runtime_dir: str,
    config_home: str,
    runtime_home: str,
    workspace_root: str,
    work_ref: Mapping[str, Any] | None,
    work_selection: Mapping[str, Any],
    process_runner: Callable[..., session_surface.ReturnCodeResult] | None = None,
    session_invoker: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
    session_endpoint: str | None = None,
    work_observer: Callable[[Mapping[str, Any] | None], Mapping[str, Any]]
    | None = None,
    heartbeat_seconds: float = 0.5,
    work_projection_seconds: float = 2.0,
) -> int:
    """Launch the owner coordinator through facade-level injection seams."""

    return _runtime_run_native_interactive(
        profile,
        runtime_dir=runtime_dir,
        config_home=config_home,
        runtime_home=runtime_home,
        workspace_root=workspace_root,
        work_ref=work_ref,
        work_selection=work_selection,
        process_runner=process_runner,
        session_invoker=session_invoker,
        session_endpoint=session_endpoint,
        work_observer=work_observer,
        heartbeat_seconds=heartbeat_seconds,
        work_projection_seconds=work_projection_seconds,
        environment_builder=native_environment,
        provider_health=_provider_runtime_health,
    )


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
    session_started_callback: Callable[[Mapping[str, str], Mapping[str, Any]], None]
    | None = None,
    project_trust: Mapping[str, Any] | None = None,
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
    cwd, runtime_dir = _managed_console_scope(
        _cwd(selected, workspace_root=workspace_root, home=home),
        home,
        work,
        runtime_dir,
    )
    argv = launch_argv(
        selected,
        prompt,
        work_ref=work,
        continuation=continuation_value,
        workspace_root=cwd,
        permission_mode=permission_mode,
    )
    base_env, _base_env_keys = _environment(
        provider,
        runtime_dir=runtime_dir,
        run_id=run_id,
        workspace_root=cwd,
        work_ref=work,
        continuation=continuation_value,
    )
    runtime_home = str(Path(home or os.path.expanduser("~")).expanduser().resolve())
    effective_config_home = str(
        Path(config_home or os.path.join(runtime_home, ".kungfu-config"))
        .expanduser()
        .resolve()
    )
    workspace_root = str(cwd or runtime_home)
    workspace_id = _managed_workspace_id(work, workspace_root)
    managed_session_ref = (
        _session_ref(work, run_id)
        if work is not None
        else {
            "workConsoleId": f"assistant:{workspace_id}:{run_id}",
            "sessionAttemptId": run_id,
        }
    )
    adapter = native_provider_adapter(
        provider,
        runtime_dir=runtime_dir,
        session_id=run_id.removeprefix("agent-"),
        config_home=effective_config_home,
        runtime_home=runtime_home,
    )
    env = native_environment(
        provider,
        runtime_dir=runtime_dir,
        config_home=effective_config_home,
        runtime_home=runtime_home,
        workspace_root=workspace_root,
        work_ref=work,
        work_selection={"workspaceId": workspace_id},
        profile=selected,
        session_ref=managed_session_ref,
        provider_version=str(verification.get("version") or "unknown"),
        adapter=adapter,
        source=base_env,
        stdio_is_tty=False,
    )
    for key in ("KUNGFU_CONTROL_RUNTIME_DIR", "KUNGFU_AGENT_CONTINUATION"):
        if key in base_env:
            env[key] = base_env[key]
    env_keys = sorted(env)
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
                permission_mode=permission_mode,
                event_sink=event_sink,
                session_started_callback=session_started_callback,
                project_trust=project_trust,
            )
        else:
            if (
                session_requested
                and session_started_callback is not None
                and work is not None
            ):
                # Providers without a managed terminal transport still launch
                # as one bounded, Work-observing process. Advance native Work
                # immediately before that process can receive its first
                # instruction; otherwise a fresh Amp/OpenCode attempt remains
                # stranded in ``claimed`` and cannot enter independent review.
                session_started_callback(
                    _session_ref(work, run_id),
                    {"status": "started", "transport": "direct-process"},
                )
            if process_runner is run_process:
                process_argv, stdin_text = _direct_process_transport(provider, argv)
                result = process_runner(
                    process_argv,
                    cwd=cwd,
                    env=env,
                    timeout_seconds=(
                        None if provider == "synthetic" else timeout_seconds
                    ),
                    stdin_text=stdin_text,
                    output_sink=project_output,
                )
            else:
                result = process_runner(
                    argv, cwd=cwd, env=env, timeout_seconds=timeout_seconds
                )
        refresh_native_skill_runtime_audit(env)
        status = RunStatus.Succeeded if result.exit_code == 0 else RunStatus.Failed
        episode.record_event(
            ACTION_RUN_END,
            events.run_end(run_id, status, result.exit_code),
            run_id=run_id,
        )
        parsed = parse_provider_output(provider, result.stdout)
        if session_value is not None and parsed.get("text") is None:
            visible = _ANSI_ESCAPE.sub("", result.stdout).strip()
            if visible:
                # Managed Provider UIs expose a credential-safe VT text-grid
                # snapshot rather than their JSONL process protocol. Retain
                # that bounded final view so independent review can inspect
                # the actual answer instead of mistaking it for no answer.
                parsed["text"] = visible[:128_000]
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
