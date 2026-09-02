# SPDX-License-Identifier: Apache-2.0

"""Work binding, launch policy, and process transport for ``run_agent``.

The runner launches only the executable selected by a verified Agent Runtime
Profile. It records one fresh Episode and a content-bound public report, but a
successful process exit or provider self-report never settles Work.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import partial
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Mapping, Sequence
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
    provider_interactive_argv as interactive_launch_argv,
    provider_runtime_health as _provider_runtime_health,
    resolve_command_wrapper as _resolve_windows_command_wrapper,
)
from kungfu.agent.provider_bootstrap import refresh_native_skill_runtime_audit
from kungfu.agent.managed_run import ManagedRunCoordinator
from kungfu.initiative_family import canonical as assignment_canonical
from kungfu.skill import build_skill_context
from kungfu.workspace import resolve_workspace_target

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
    work_profile_source: str | Path | None = None,
    envelope_override: Mapping[str, Any] | None = None,
    console_workspace_root: str | None = None,
    expected_binding: Mapping[str, Any] | None = None,
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

    # A packaged --home runtime still retains the verified launch workspace.
    # Explicit --workspace may bind another exact Project while preserving the
    # current Console and attempt identities.
    # The resulting WorkRef remains bound to that explicit Project identity.
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
        work_runtime_dir = exact_work_runtime_dir
        work_workspace_id = work_target.identity.workspace_id
        if work_workspace_id != str(envelope["workspaceId"]):
            binding_scope = "explicit-external-project"

    status = work_commands._status(work_runtime_dir, initiative_id, assignment_id)
    work_control = work_commands.profile_lifecycle.resolve_qualified_work_profile(
        work_runtime_dir,
        source=work_profile_source,
    )
    work_ref = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": work_workspace_id,
        "profileId": work_control["id"],
        "profileRoot": work_control["root"],
        "entityType": "assignment",
        "entityId": assignment_id,
        "entityRoot": assignment_canonical.semantic_root(status["assignment"]),
        "purpose": "continue-project-assignment",
        "systemTimeCut": status["query_proof_root"],
        "initiativeId": initiative_id,
    }
    session_contract.validate_work_ref(work_ref)
    session = {
        "workConsoleId": str(envelope["consoleId"]),
        "sessionAttemptId": str(envelope["attemptId"]),
    }
    session_contract.require_expected_binding(expected_binding, work_ref, session)
    actor_id = os.environ.get("KUNGFU_AGENT_SESSION_ACTOR", f"cli:{os.getpid()}")

    invoke_session = partial(
        session_surface.invoke_for_project,
        fallback_runtime_dir=project_runtime_dir,
        cwd=workspace_root,
        environ={"KUNGFU_AGENT_SESSION_ENDPOINT": None},
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


def _direct_process_transport(
    provider: str, argv: Sequence[str]
) -> tuple[list[str], str | None]:
    """Select a portable direct-process prompt transport.

    Codex accepts ``-`` as the prompt argument and then reads the complete
    instruction from stdin.  The deterministic Mock Agent accepts the same
    content as one bracketed-paste frame.  Keeping both prompts out of argv
    avoids the Windows command-line length limit without binding Kungfu to any
    Agent version.  Other providers retain their native argv contract.
    """

    values = [str(value) for value in argv]
    if provider not in {"codex", "synthetic"}:
        return values, None
    if not values:
        raise ValueError("direct-process launch argv is required")
    if provider == "synthetic":
        prompt = values[-1]
        return values[:-1], f"\x1b[200~{prompt}\x1b[201~\r"
    return [*values[:-1], "-"], values[-1]


def native_environment(
    *args,
    skill_context_builder: Callable[..., dict[str, Any]] = build_skill_context,
    **kwargs,
) -> dict[str, str]:
    """Compatibility facade retaining the injectable Skill context seam."""

    return _native_environment(
        *args, skill_context_builder=skill_context_builder, **kwargs
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
    environment_builder: Callable[..., dict[str, str]] = native_environment,
    provider_health: Callable[..., Mapping[str, Any]] = _provider_runtime_health,
) -> int:
    """Run a verified provider UI with inherited terminal file descriptors."""
    coordinator = NativeLaunchCoordinator(
        verify_profile=runtime_profiles.verify_profile,
        resolve_cwd=_cwd,
        build_adapter=native_provider_adapter,
        build_environment=environment_builder,
        session_ref=_session_ref,
        interactive_argv=interactive_launch_argv,
        semantic_root=canonical_root,
        heartbeat_observation=session_surface.native_heartbeat_observation,
        finalize_environment=refresh_native_skill_runtime_audit,
        provider_health=provider_health,
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
    timeout_seconds: float | None,
    event_driven: bool = False,
) -> Mapping[str, Any]:
    if event_driven:
        while True:
            event_status = invoke({"operation": "status", "session": dict(ref)})
            if predicate(event_status):
                return event_status
            change_sequence = event_status.get("changeSequence")
            if not isinstance(change_sequence, int) or change_sequence < 0:
                raise ValueError(
                    "Deterministic Mock Agent requires event-driven Session status"
                )
            event_status = invoke(
                {
                    "operation": "wait-status-change",
                    "session": dict(ref),
                    "afterChangeSequence": change_sequence,
                }
            )
            if predicate(event_status):
                return event_status
    if timeout_seconds is None:
        raise ValueError("Non-Mock Agent Session wait requires a timeout")
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
    timeout_seconds: float | None,
    stdin_text: str | None = None,
    output_sink: Callable[[str, str], None] | None = None,
) -> ProcessResult:
    process_argv = _resolve_windows_command_wrapper(argv, env=env)
    process_env = dict(env)
    process_env.setdefault("PYTHONUTF8", "1")
    process_env.setdefault("PYTHONIOENCODING", "utf-8")
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
        env=process_env,
        shell=command_wrapper,
        stdin=subprocess.PIPE if stdin_text is not None else None,
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
    if stdin_text is not None:
        assert process.stdin is not None
        try:
            process.stdin.write(stdin_text)
        except BrokenPipeError:
            pass
        finally:
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
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
