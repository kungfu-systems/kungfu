# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral ``kungfu run agent`` process orchestration.

The runner launches only the executable selected by a verified Agent Runtime
Profile. It records one fresh Episode and a content-bound public report, but a
successful process exit or provider self-report never settles Work.
"""

from __future__ import annotations

from dataclasses import dataclass
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
from kungfu.agent import resources as agent_resources
from kungfu.agent import runtime_profiles
from kungfu.agent import session_contract
from kungfu.agent import session_surface
from kungfu.agent.native_launch import (
    COMMAND_WRAPPER_SUFFIXES as _WINDOWS_COMMAND_WRAPPER_SUFFIXES,
    NativeLaunchCoordinator,
    apply_platform_tls_trust,
    encode_wrapper_prompt as _encode_windows_wrapper_prompt,
    native_environment as _native_environment,
    native_provider_adapter,
    provider_runtime_health as _provider_runtime_health,
    resolve_command_wrapper as _resolve_windows_command_wrapper,
)
from kungfu.agent.provider_bootstrap import refresh_native_skill_runtime_audit
from kungfu.agent.managed_run import ManagedRunCoordinator
from kungfu.agent.provider_output import (
    parse_provider_output,
    public_activities_from_provider_line,
    public_command_preview as public_command_preview,
)
from kungfu.content_hash import compute_content_hash_value
from kungfu.skill import build_skill_context
from kungfu.workspace import resolve_workspace_target
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
_ROOT = re.compile(r"sha256:[0-9a-f]{64}\Z")
_ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def bind_current_native_work(
    runtime_dir: str,
    initiative_id: str,
    assignment_id: str,
    *,
    work_workspace_root: str | None = None,
    envelope_override: Mapping[str, Any] | None = None,
    console_workspace_root: str | None = None,
) -> dict[str, Any] | None:
    """Atomically bind the current native attempt before it acts on Work."""

    raw = os.environ.get("KUNGFU_AGENT_CONSOLE_ENVELOPE", "").strip()
    if not raw and envelope_override is None:
        return None
    injected = envelope_override is None
    envelope = (
        json.loads(raw)
        if injected
        else session_contract.validate_agent_console_envelope(
            dict(envelope_override or {})
        )
    )
    from kungfu import assignment_orchestration as orchestration
    from kungfu import profile_sdk
    from kungfu.cli.commands import assignment as work_commands

    workspace_root = (
        os.environ.get("KUNGFU_WORKSPACE_ROOT", "").strip()
        if injected
        else str(console_workspace_root or "").strip()
    )
    if not workspace_root:
        raise ValueError(
            "native Agent Console is missing its Kungfu Project workspace root"
        )
    target = resolve_workspace_target("read-only", workspace_root, cwd=workspace_root)
    if (
        target.identity.workspace_kind != "project"
        or target.identity.workspace_id != str(envelope.get("workspaceId") or "")
    ):
        raise ValueError(
            "native Agent Console workspace does not match its Kungfu Project"
        )
    project_runtime_dir = str(Path(target.runtime_dir).expanduser().resolve())
    if injected:
        injected_runtime_dir = os.environ.get("KUNGFU_AGENT_RUNTIME_DIR", "").strip()
        if not injected_runtime_dir:
            raise ValueError(
                "native Agent Console is missing its stable Kungfu Project runtime"
            )
        if Path(injected_runtime_dir).expanduser().resolve() != Path(
            project_runtime_dir
        ):
            raise ValueError(
                "native Agent Console runtime does not match its Kungfu Project"
            )
        agent_resources.validated_current_bootstrap_receipt(envelope)

    # ``runtime_dir`` belongs to the CLI invocation context. A packaged CLI may
    # deliberately use ``--home`` while the native attempt is attached to a
    # Project, so an implicit target must keep using the verified launch
    # workspace. An explicit ``--workspace`` may select Work in another Project;
    # bind that exact Project identity while preserving the current Console and
    # attempt identities.
    work_runtime_dir = project_runtime_dir
    work_workspace_id = str(envelope["workspaceId"])
    binding_scope = "same-project"
    if work_workspace_root:
        work_target = resolve_workspace_target(
            "read-only",
            work_workspace_root,
            cwd=work_workspace_root,
        )
        if work_target.identity.workspace_kind != "project":
            raise ValueError("native Work binding requires an exact Project workspace")
        exact_work_runtime_dir = str(
            Path(work_target.runtime_dir).expanduser().resolve()
        )
        if Path(runtime_dir).expanduser().resolve() != Path(exact_work_runtime_dir):
            raise ValueError(
                "native Work binding runtime does not match the explicit Project"
            )
        work_runtime_dir = exact_work_runtime_dir
        work_workspace_id = work_target.identity.workspace_id
        if work_workspace_id != str(envelope["workspaceId"]):
            binding_scope = "explicit-external-project"

    status = work_commands._status(work_runtime_dir, initiative_id, assignment_id)
    work_control = profile_sdk.validate_source(
        work_commands.profile_source(), work_runtime_dir
    )["inspection"]
    work_ref = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": work_workspace_id,
        "profileId": work_control["profile"]["id"],
        "profileRoot": work_control["profile_suite_root"],
        "entityType": "assignment",
        "entityId": assignment_id,
        "entityRoot": orchestration.semantic_root(status["assignment"]),
        "purpose": "continue-project-assignment",
        "systemTimeCut": status["query_proof_root"],
        "initiativeId": initiative_id,
    }
    session_contract.validate_work_ref(work_ref)
    session = {
        "workConsoleId": str(envelope["consoleId"]),
        "sessionAttemptId": str(envelope["attemptId"]),
    }
    actor_id = os.environ.get("KUNGFU_AGENT_SESSION_ACTOR", f"cli:{os.getpid()}")

    def invoke_session(request):
        if injected:
            return session_surface.invoke(request)
        return session_surface.invoke_for_project(
            request,
            fallback_runtime_dir=project_runtime_dir,
            cwd=workspace_root,
        )

    plan = invoke_session(
        {
            "operation": "plan-native-bind-work",
            "client": "kfd3-agent",
            "actorId": actor_id,
            "input": {
                "session": session,
                "workRef": work_ref,
                "bindingScope": binding_scope,
                "sourceWorkspaceId": str(envelope["workspaceId"]),
            },
        }
    )
    receipt = invoke_session(
        {
            "operation": "bind-native-work",
            "client": "kfd3-agent",
            "actorId": actor_id,
            "plan": plan,
            "expectedPlanRoot": plan["root"],
        }
    )
    return {"workRef": work_ref, "session": session, "receipt": receipt}


_WINDOWS_PROCESS_ENV_ALLOWLIST = (
    # Windows command shims and runtimes resolve their installation and system
    # paths through these variables.  In particular, npm ``*.cmd`` launchers
    # commonly dispatch through ``%APPDATA%``.  They are process coordinates,
    # not credentials, and must survive the credential-safe environment cut.
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "ALLUSERSPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
)


_COMMON_ENV_ALLOWLIST = (
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TERMINFO",
    "TERMINFO_DIRS",
    "COLORFGBG",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "NO_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "VTE_VERSION",
    "TMPDIR",
    "SHELL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "KUNGFU_CLI_BIN",
    *_WINDOWS_PROCESS_ENV_ALLOWLIST,
)
_PROVIDER_ENV_ALLOWLIST = {
    "codex": ("OPENAI_API_KEY", "CODEX_HOME"),
    "claude": ("ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"),
    "amp": (),
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
    "amp": ["--execute"],
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


canonical_root = session_contract.semantic_root


def agent_activity_history_projection(
    work_ref: Mapping[str, Any] | None,
    *,
    entrypoint: str = "managed-run",
) -> dict[str, Any]:
    return agent_resources.agent_activity_history_projection(
        validate_work_ref(work_ref), entrypoint=entrypoint
    )


def validate_work_ref(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Read current or retained legacy v1 WorkRef data.

    New Assignment writers use ``session_contract.validate_work_ref`` directly
    and therefore require the unambiguous Initiative locator.
    """

    return session_contract.validate_work_ref(value, compatibility=True)


def validate_continuation(
    value: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if value is None:
        return None
    result = dict(value)
    if not result:
        raise ValueError("continuation envelope must be a non-empty JSON object")
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


def select_interactive_profile(
    *, config_home: str | None = None, runtime_home: str | None = None
) -> tuple[dict[str, Any], str]:
    """Select a default native UI profile without guessing among candidates."""

    resolved = runtime_profiles.kungfu_config.resolve_config(
        config_home=config_home, runtime_home=runtime_home
    )
    catalog = runtime_profiles.discover_catalog(resolved_config=resolved)
    default_profile_id = catalog.get("defaultProfileId")
    if default_profile_id:
        return (
            runtime_profiles.find_profile(
                str(default_profile_id),
                config_home=config_home,
                runtime_home=runtime_home,
            ),
            "default",
        )
    candidates: dict[str, dict[str, Any]] = {}
    for profile in catalog.get("configured", []):
        if profile.get("id"):
            candidates[str(profile["id"])] = dict(profile)
    for row in catalog.get("discovered", []):
        profile = dict(row.get("profile") or {})
        if profile.get("id"):
            candidates.setdefault(str(profile["id"]), profile)
    if len(candidates) == 1:
        return next(iter(candidates.values())), "only-available"
    if not candidates:
        raise ValueError(
            "no Agent Runtime Profile is available; run "
            "`kungfu agent runtime discover` or configure one explicitly"
        )
    choices = ", ".join(sorted(candidates))
    raise ValueError(
        "multiple Agent Runtime Profiles are available "
        f"({choices}); run `kungfu agent runtime set-default <profile-id> --execute` "
        "or pass --agent <profile-id>"
    )


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


def interactive_launch_argv(profile: Mapping[str, Any]) -> list[str]:
    """Build the provider-native argv without managed-run prompt flags."""

    launch = dict(profile.get("launch") or {})
    executable = str(launch.get("executable") or "")
    if not executable:
        raise ValueError("Agent Runtime Profile executable is required")
    if launch.get("shellMode") is True:
        raise ValueError(
            "kungfu native Agent launch requires an exact executable profile; "
            "shellMode is unsupported"
        )
    return [
        executable,
        *(str(value) for value in launch.get("interactiveArgv") or []),
    ]


def native_environment(*args, **kwargs) -> dict[str, str]:
    """Compatibility facade retaining the injectable Skill context seam."""

    return _native_environment(
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
    """Run a verified provider UI with inherited terminal file descriptors."""
    coordinator = NativeLaunchCoordinator(
        verify_profile=runtime_profiles.verify_profile,
        resolve_cwd=_cwd,
        build_adapter=native_provider_adapter,
        build_environment=native_environment,
        session_ref=_session_ref,
        interactive_argv=interactive_launch_argv,
        semantic_root=canonical_root,
        heartbeat_observation=session_surface.native_heartbeat_observation,
        finalize_environment=refresh_native_skill_runtime_audit,
        provider_health=_provider_runtime_health,
    )
    return coordinator.run(
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
    )


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
    apply_platform_tls_trust(env)
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
    return agent_resources.session_ref(work, run_id)


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
    permission_mode: str = "workspace-write",
    event_sink: Callable[[Mapping[str, Any]], None] | None = None,
    session_started_callback: Callable[[Mapping[str, str], Mapping[str, Any]], None]
    | None = None,
    project_trust: Mapping[str, Any] | None = None,
) -> tuple[ProcessResult, dict[str, Any]]:
    """Start one Work-bound Session, deliver the first turn, and yield at attention."""
    coordinator = ManagedRunCoordinator(
        session_ref=_session_ref,
        semantic_root=canonical_root,
        wait_for_session=_wait_for_session,
        invoke_control=_invoke_session_control,
        result_factory=ProcessResult,
    )
    return coordinator.run(
        invoke=invoke,
        run_id=run_id,
        selected=selected,
        verification=verification,
        work=work,
        cwd=cwd,
        env=env,
        prompt=prompt,
        timeout_seconds=timeout_seconds,
        permission_mode=permission_mode,
        event_sink=event_sink,
        session_started=session_started_callback,
        project_trust=project_trust,
    )


def run_process(
    argv: Sequence[str],
    *,
    cwd: str | None,
    env: Mapping[str, str],
    timeout_seconds: float,
    output_sink: Callable[[str, str], None] | None = None,
) -> ProcessResult:
    process_argv = _resolve_windows_command_wrapper(argv, env=env)
    command_wrapper = (
        sys.platform == "win32"
        and bool(process_argv)
        and Path(str(process_argv[0])).suffix.lower()
        in _WINDOWS_COMMAND_WRAPPER_SUFFIXES
    )
    if command_wrapper:
        process_argv = _encode_windows_wrapper_prompt(process_argv)
    process = subprocess.Popen(
        process_argv,
        cwd=cwd,
        env=dict(env),
        shell=command_wrapper,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
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
    cwd = _cwd(selected, workspace_root=workspace_root, home=home)
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
    workspace_id = str(
        work.get("workspaceId") if work is not None else cwd or runtime_home
    )
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
        workspace_root=str(cwd or runtime_home),
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
