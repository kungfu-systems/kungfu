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
import shlex
import shutil
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
from kungfu.skill import build_skill_context
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


def bind_current_native_work(
    runtime_dir: str, initiative_id: str, assignment_id: str
) -> dict[str, Any] | None:
    """Atomically bind the current native attempt before it acts on Work."""

    raw = os.environ.get("KUNGFU_AGENT_CONSOLE_ENVELOPE", "").strip()
    if not raw:
        return None
    envelope = json.loads(raw)
    from kungfu import assignment_orchestration as orchestration
    from kungfu import profile_sdk
    from kungfu.cli.commands import assignment as work_commands
    from kungfu.workspace import resolve_workspace_target

    workspace_root = os.environ.get("KUNGFU_WORKSPACE_ROOT", "").strip()
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
    injected_runtime_dir = os.environ.get("KUNGFU_AGENT_RUNTIME_DIR", "").strip()
    if not injected_runtime_dir:
        raise ValueError(
            "native Agent Console is missing its stable Kungfu Project runtime"
        )
    if Path(injected_runtime_dir).expanduser().resolve() != Path(project_runtime_dir):
        raise ValueError(
            "native Agent Console runtime does not match its Kungfu Project"
        )

    # ``runtime_dir`` belongs to the CLI invocation context.  A packaged CLI may
    # deliberately use ``--home`` while the native attempt is attached to a
    # Project, so Work/Profile authority must come from the verified launch
    # workspace above rather than silently falling back to Home.
    del runtime_dir

    status = work_commands._status(project_runtime_dir, initiative_id, assignment_id)
    work_control = profile_sdk.validate_source(
        work_commands._profile_source(), project_runtime_dir
    )["inspection"]
    work_ref = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": str(envelope["workspaceId"]),
        "profileId": work_control["profile"]["id"],
        "profileRoot": work_control["profile_suite_root"],
        "entityType": "assignment",
        "entityId": assignment_id,
        "entityRoot": orchestration.semantic_root(status["assignment"]),
        "purpose": "continue-project-assignment",
        "systemTimeCut": status["query_proof_root"],
        "initiativeId": initiative_id,
    }
    session = {
        "workConsoleId": str(envelope["consoleId"]),
        "sessionAttemptId": str(envelope["attemptId"]),
    }
    actor_id = os.environ.get("KUNGFU_AGENT_SESSION_ACTOR", f"cli:{os.getpid()}")
    plan = session_surface.invoke(
        {
            "operation": "plan-native-bind-work",
            "client": "kfd3-agent",
            "actorId": actor_id,
            "input": {"session": session, "workRef": work_ref},
        }
    )
    receipt = session_surface.invoke(
        {
            "operation": "bind-native-work",
            "client": "kfd3-agent",
            "actorId": actor_id,
            "plan": plan,
            "expectedPlanRoot": plan["root"],
        }
    )
    return {"workRef": work_ref, "session": session, "receipt": receipt}


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


def native_provider_adapter(
    provider: str,
    *,
    runtime_dir: str,
    session_id: str | None = None,
    resolved_config: Mapping[str, Any] | None = None,
    config_home: str | None = None,
    runtime_home: str | None = None,
) -> dict[str, Any]:
    """Materialize one session-only Skill adapter for a provider-native UI."""

    return runtime_profiles.materialize_adapter(
        provider,
        runtime_dir=runtime_dir,
        session_id=session_id,
        resolved_config=resolved_config,
        config_home=config_home,
        runtime_home=runtime_home,
    )


def native_environment(
    provider: str,
    *,
    runtime_dir: str,
    config_home: str,
    runtime_home: str,
    workspace_root: str,
    work_ref: Mapping[str, Any] | None,
    work_selection: Mapping[str, Any],
    profile: Mapping[str, Any] | None = None,
    session_ref: Mapping[str, str] | None = None,
    session_endpoint: str | None = None,
    provider_version: str = "unknown",
    adapter: Mapping[str, Any] | None = None,
    source: Mapping[str, str] | None = None,
    stdio_is_tty: bool | None = None,
) -> dict[str, str]:
    """Return a credential-safe native UI environment with compact Kungfu hints."""

    ambient = os.environ if source is None else source
    selected_adapter = dict(adapter or {})
    allowed = (
        *_COMMON_ENV_ALLOWLIST,
        *(str(value) for value in selected_adapter.get("credentialEnvironment") or []),
    )
    env = {key: str(ambient[key]) for key in allowed if ambient.get(key)}
    env.update(
        {
            str(key): str(value)
            for key, value in dict(selected_adapter.get("environment") or {}).items()
        }
    )
    terminal_attached = (
        all(stream.isatty() for stream in (sys.stdin, sys.stdout, sys.stderr))
        if stdio_is_tty is None
        else stdio_is_tty
    )
    ambient_term = str(ambient.get("TERM") or "").strip()
    terminal_recovery = terminal_attached and ambient_term.lower() in {"", "dumb"}
    if terminal_recovery:
        # A real provider-native terminal must not inherit the non-interactive
        # TERM=dumb marker used by launchers and automation wrappers.  ``xterm``
        # is the conservative baseline understood by the supported native UIs;
        # valid terminal types remain untouched.
        env["TERM"] = "xterm"
        env["KUNGFU_AGENT_TERMINAL_RECOVERY"] = f"{ambient_term or 'unset'}->xterm"
    configured_cli = str(ambient.get("KUNGFU_CLI_BIN") or "").strip()
    cli_candidate = configured_cli or shutil.which(
        "kungfu", path=str(ambient.get("PATH") or "")
    )
    if configured_cli and not os.path.isabs(os.path.expanduser(configured_cli)):
        cli_candidate = shutil.which(
            configured_cli, path=str(ambient.get("PATH") or "")
        )
    if cli_candidate:
        cli_path = Path(cli_candidate).expanduser().absolute()
        if not cli_path.is_file() or not os.access(cli_path, os.X_OK):
            raise ValueError(
                "KUNGFU_CLI_BIN must identify an executable Kungfu front door"
            )
        cli_bin = str(cli_path)
        env["KUNGFU_CLI_BIN"] = cli_bin
    else:
        cli_bin = "kungfu"
    bind_work_entrypoint = [
        cli_bin,
        "agent",
        "console",
        "bind-work",
        "--initiative-id",
        "<id>",
        "--assignment-id",
        "<id>",
        "--json",
    ]
    context = {
        "schema": "kungfu.native-agent-context/v1",
        "environment": "native-interactive",
        "entrypoints": {
            "context": [cli_bin, "agent", "context", "--json"],
            "skills": [cli_bin, "skill", "catalog", "--json"],
            "work": [cli_bin, "work", "status"],
            "bindWork": bind_work_entrypoint,
        },
        "workBinding": {
            "launchState": "bound" if work_ref is not None else "unbound",
            "requiredBeforeProjectWrite": True,
            "conflictCode": "native_work_already_active",
            "canonicalEntrypoint": "bindWork",
            "internalSessionOperations": [
                "plan-native-bind-work",
                "bind-native-work",
            ],
            "internalSessionOperationsAreCliEntrypoints": False,
        },
        "workSelection": dict(work_selection),
        "terminal": {
            "stdioAttached": terminal_attached,
            "ambientTerm": ambient_term or None,
            "effectiveTerm": env.get("TERM") or None,
            "program": env.get("TERM_PROGRAM") or None,
            "programVersion": env.get("TERM_PROGRAM_VERSION") or None,
            "recovered": terminal_recovery,
        },
    }
    selected = dict(profile or {})
    profile_id = str(selected.get("id") or f"kungfu.agent-runtime.{provider}")
    env.update(
        {
            "KF_CONFIG_HOME": config_home,
            "KF_HOME": runtime_home,
            "KF_RUNTIME_DIR": runtime_dir,
            "KUNGFU_AGENT_RUNTIME_DIR": runtime_dir,
            "KUNGFU_AGENT_ENVIRONMENT": "native-interactive",
            "KUNGFU_AGENT_CONTEXT": json.dumps(
                context, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ),
            "KUNGFU_AGENT_CONTEXT_ENTRYPOINT": (
                f"{shlex.quote(cli_bin)} agent context --json"
            ),
            "KUNGFU_SKILL_CATALOG_ENTRYPOINT": (
                f"{shlex.quote(cli_bin)} skill catalog --json"
            ),
            "KUNGFU_WORK_STATUS_ENTRYPOINT": f"{shlex.quote(cli_bin)} work status",
            "KUNGFU_WORKSPACE_ROOT": workspace_root,
            "KUNGFU_PRIOR_TRANSCRIPT_BYTES": "0",
        }
    )
    if session_ref is not None:
        skill_context = build_skill_context(
            runtime_home,
            source="cli",
            manager="python",
            profile=profile_id,
            agent=provider,
            runtime_dir=runtime_dir,
            env=ambient,
            cwd=workspace_root,
        )
        console_envelope_body = {
            "schema": "kungfu.agent-console-envelope/v1",
            "workspaceId": str(
                work_ref.get("workspaceId")
                if work_ref is not None
                else work_selection.get("workspaceId") or workspace_root
            ),
            "consoleId": str(session_ref["workConsoleId"]),
            "attemptId": str(session_ref["sessionAttemptId"]),
            "runtimeProfileId": profile_id,
            "provider": provider,
            "activeProfiles": (
                [
                    {
                        "id": str(work_ref["profileId"]),
                        "root": str(work_ref["profileRoot"]),
                    }
                ]
                if work_ref is not None
                else []
            ),
            "workRef": dict(work_ref) if work_ref is not None else None,
            "entrypoints": {
                "context": [cli_bin, "agent", "context", "--json"],
                "capabilities": [cli_bin, "agent", "capabilities", "--json"],
                "profiles": [cli_bin, "profile", "manager", "--json"],
                "bindWork": bind_work_entrypoint,
            },
            "knownLimits": [
                "native provider terminal bytes are not captured by Kungfu",
                "TUI observes Core Work state but cannot control provider input",
                "provider exit does not claim Work completion",
                *(str(value) for value in selected_adapter.get("knownLimits") or []),
            ],
        }
        console_envelope = {
            **console_envelope_body,
            "envelopeRoot": canonical_root(console_envelope_body),
        }
        env.update(
            {
                "KUNGFU_AGENT_ATTEMPT_ID": str(session_ref["sessionAttemptId"]),
                "KUNGFU_AGENT_CONSOLE_ID": str(session_ref["workConsoleId"]),
                "KUNGFU_AGENT_CONSOLE_ENVELOPE": json.dumps(
                    console_envelope,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                "KUNGFU_SKILL_CONTEXT": json.dumps(
                    skill_context,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                "KUNGFU_AGENT_SESSION_ACTOR": (
                    f"native:{provider}:{session_ref['sessionAttemptId']}"
                ),
                "KUNGFU_AGENT_PROVIDER_VERSION": provider_version,
            }
        )
        if session_endpoint:
            env["KUNGFU_AGENT_SESSION_ENDPOINT"] = session_endpoint
    if work_ref is not None:
        env["KUNGFU_WORK_REF"] = json.dumps(
            dict(work_ref),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    return env


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
) -> int:
    """Run a verified provider UI with inherited terminal file descriptors."""

    verification = runtime_profiles.verify_profile(profile)
    if verification.get("ok") is not True:
        raise ValueError(
            "Agent Runtime Profile verification failed: "
            f"{verification.get('error') or 'unknown error'}"
        )
    cwd = _cwd(profile, workspace_root=workspace_root, home=runtime_home)
    provider = str(profile["provider"])
    adapter_id = str((profile.get("bootstrap") or {}).get("adapter") or provider)
    if adapter_id != provider:
        raise ValueError("Agent Runtime Profile bootstrap adapter must match provider")
    attempt_id = f"native:{uuid.uuid4()}"
    adapter = native_provider_adapter(
        adapter_id,
        runtime_dir=runtime_dir,
        session_id=attempt_id,
        config_home=config_home,
        runtime_home=runtime_home,
    )
    workspace_id = str(
        work_ref.get("workspaceId")
        if work_ref is not None
        else work_selection.get("workspaceId") or workspace_root
    )
    session_ref = {
        "workConsoleId": (
            _session_ref(work_ref, attempt_id)["workConsoleId"]
            if work_ref is not None
            else f"assistant:{workspace_id}:{attempt_id}"
        ),
        "sessionAttemptId": attempt_id,
    }
    process_identity = {
        "launcherPid": os.getpid(),
        "attemptId": attempt_id,
        "launchedAt": time.time_ns(),
    }
    env = native_environment(
        provider,
        runtime_dir=runtime_dir,
        config_home=config_home,
        runtime_home=runtime_home,
        workspace_root=workspace_root,
        work_ref=work_ref,
        work_selection=work_selection,
        profile=profile,
        session_ref=session_ref if session_invoker is not None else None,
        session_endpoint=session_endpoint,
        provider_version=str(verification.get("version") or "unknown"),
        adapter=adapter,
    )
    actor_id = f"native:{provider}:{attempt_id}"
    registered = False
    if session_invoker is not None:
        binding = (
            {"kind": "work", "workRef": dict(work_ref)}
            if work_ref is not None
            else {"kind": "workspace-assistant", "workRef": None}
        )
        plan = session_invoker(
            {
                "operation": "plan-native-start",
                "client": "cli",
                "actorId": actor_id,
                "input": {
                    **session_ref,
                    "workspaceId": workspace_id,
                    "provider": provider,
                    "providerVersion": str(verification.get("version") or "unknown"),
                    "profileRoot": canonical_root(profile),
                    "runtimeProfileId": str(
                        profile.get("id") or f"kungfu.agent-runtime.{provider}"
                    ),
                    "binding": binding,
                },
            }
        )
        session_invoker(
            {
                "operation": "start-native",
                "actorId": actor_id,
                "client": "cli",
                "plan": dict(plan),
                "expectedPlanRoot": plan["root"],
                "processIdentity": process_identity,
            }
        )
        registered = True

    stop_heartbeat = threading.Event()
    heartbeat_errors: list[Exception] = []

    def heartbeat() -> None:
        if session_invoker is None:
            return
        while not stop_heartbeat.is_set():
            try:
                current = session_invoker(
                    {"operation": "show", "session": dict(session_ref)}
                )
                binding = current.get("binding") or {}
                observed = session_surface.native_heartbeat_observation(
                    binding, work_observer
                )
                session_invoker(
                    {
                        "operation": "heartbeat-native",
                        "client": "cli",
                        "actorId": actor_id,
                        "session": dict(session_ref),
                        "processIdentity": process_identity,
                        "observation": {
                            "state": str(observed.get("state") or "unknown"),
                            "staleAfterMs": max(5000, int(heartbeat_seconds * 10000)),
                            "work": observed.get("work"),
                            "diagnostic": observed.get("diagnostic"),
                        },
                    }
                )
            except Exception as error:  # pragma: no cover - surfaced after join
                heartbeat_errors.append(error)
                return
            stop_heartbeat.wait(heartbeat_seconds)

    heartbeat_thread = None

    def start_heartbeat() -> None:
        nonlocal heartbeat_thread
        if not registered:
            return
        heartbeat_thread = threading.Thread(
            target=heartbeat,
            name=f"kungfu-native-observer-{attempt_id}",
            daemon=True,
        )
        heartbeat_thread.start()

    argv = [*interactive_launch_argv(profile), *adapter["argv"]]
    completed: session_surface.ReturnCodeResult | None = None
    try:
        if process_runner is None:
            # Spawn the terminal owner before starting any Python observer
            # thread.  A cwd-bearing subprocess launch can require fork/exec on
            # macOS; forking after the heartbeat thread starts can leave a
            # provider-native TUI with an unsafe inherited process state.
            provider_process = subprocess.Popen(argv, cwd=cwd, env=env)
            start_heartbeat()
            completed = subprocess.CompletedProcess(argv, provider_process.wait())
        else:
            start_heartbeat()
            completed = process_runner(argv, cwd=cwd, env=env, check=False)
        return int(completed.returncode)
    finally:
        stop_heartbeat.set()
        if heartbeat_thread is not None:
            heartbeat_thread.join(timeout=max(1.0, heartbeat_seconds * 2))
        if registered and session_invoker is not None:
            session_invoker(
                {
                    "operation": "end-native",
                    "actorId": actor_id,
                    "client": "cli",
                    "session": dict(session_ref),
                    "processIdentity": process_identity,
                    "exit": {
                        "exitCode": (
                            int(completed.returncode) if completed is not None else None
                        ),
                        "signal": None,
                    },
                }
            )
        if heartbeat_errors and completed is not None:
            raise ValueError(f"native Agent observer failed: {heartbeat_errors[0]}")


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
    elif provider == "amp" and stdout.strip():
        text_parts.append(stdout.strip())
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
