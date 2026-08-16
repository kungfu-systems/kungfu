# SPDX-License-Identifier: Apache-2.0

"""Provider-native launch lifecycle, independent from CLI parsing."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import threading
import time
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping
import uuid

from kungfu.agent.work_projection import WorkProjectionPort
from kungfu.agent import resources as agent_resources
from kungfu.agent import runtime_profiles
from kungfu.agent import session_contract
from kungfu.agent.provider_bootstrap import (
    COMMAND_WRAPPER_SUFFIXES as _COMMAND_WRAPPER_SUFFIXES,
    encode_wrapper_prompt as _encode_wrapper_prompt,
    prepare_native_skill_runtime_audit,
    provider_runtime_health as provider_runtime_health,
    resolve_command_wrapper as _resolve_command_wrapper,
)
from kungfu.skill import build_skill_context
from kungfu.workspace import (
    WorkspaceTargetRequired,
    load_workspace_registry,
    resolve_workspace_target,
)


_DARWIN_DEFAULT_SSL_CERT_FILE = Path("/etc/ssl/cert.pem")
COMMAND_WRAPPER_SUFFIXES = _COMMAND_WRAPPER_SUFFIXES
encode_wrapper_prompt = _encode_wrapper_prompt
resolve_command_wrapper = _resolve_command_wrapper


def apply_platform_tls_trust(
    env: dict[str, str], *, platform: str | None = None
) -> None:
    """Retain explicit TLS trust, or use the standard macOS CLI CA bundle."""

    if env.get("SSL_CERT_FILE"):
        return
    if (sys.platform if platform is None else platform) != "darwin":
        return
    if _DARWIN_DEFAULT_SSL_CERT_FILE.is_file():
        env["SSL_CERT_FILE"] = str(_DARWIN_DEFAULT_SSL_CERT_FILE)


def unbound_work_selection(workspace_id):
    return {
        "schema": "kungfu.native-work-selection/v1",
        "workspaceId": workspace_id,
        "state": "none",
        "candidateAssignmentIds": [],
        "settledAssignmentIds": [],
        "selectionAuthority": "kungfu-work-cli",
        "entrypoint": "kungfu work status",
    }


def resolve_native_launch_target(ctx, workspace_root=None, *, cwd=None):
    """Resolve native provider cwd without requiring durable Project Work."""

    source_cwd = str(Path(cwd or os.getcwd()).expanduser().resolve())
    if workspace_root:
        target = resolve_workspace_target("read-only", workspace_root, cwd=source_cwd)
        return target, target.identity.workspace_root, "explicit-project"

    environment_root = os.environ.get("KF_WORKSPACE_ROOT")
    if environment_root:
        target = resolve_workspace_target("read-only", environment_root, cwd=source_cwd)
        return target, target.identity.workspace_root, "environment-project"

    discovery_environment = dict(os.environ)
    for name in ("KF_WORKSPACE_ROOT", "KF_HOME", "KF_RUNTIME_DIR"):
        discovery_environment.pop(name, None)
    try:
        target = resolve_workspace_target(
            "read-only", cwd=source_cwd, env=discovery_environment
        )
        if target.identity.workspace_kind == "project":
            return target, target.identity.workspace_root, "working-directory-project"
    except WorkspaceTargetRequired:
        pass

    active_root = os.environ.get("KUNGFU_WORKSPACE_ROOT")
    if active_root:
        try:
            target = resolve_workspace_target("read-only", active_root, cwd=source_cwd)
            if target.identity.workspace_kind == "project":
                return target, target.identity.workspace_root, "active-project"
        except (OSError, ValueError):
            pass

    try:
        registry = load_workspace_registry(config_home=ctx.config_home)
    except (OSError, ValueError, json.JSONDecodeError):
        registry = {"last_workspace_id": None, "recent": []}
    selected_id = registry.get("last_workspace_id")
    selected = next(
        (
            row
            for row in registry.get("recent") or []
            if row.get("workspace_id") == selected_id
            and row.get("workspace_kind") == "project"
            and row.get("workspace_root")
        ),
        None,
    )
    if selected is not None:
        try:
            target = resolve_workspace_target(
                "read-only", str(selected["workspace_root"]), cwd=source_cwd
            )
            if target.identity.workspace_id == selected_id:
                return target, target.identity.workspace_root, "selected-project"
        except (OSError, ValueError):
            pass

    home_environment = {
        **os.environ,
        "KF_CONFIG_HOME": str(ctx.config_home),
        "KF_HOME": str(ctx.home),
    }
    target = resolve_workspace_target(
        "capture-only", home=True, cwd=source_cwd, env=home_environment
    )
    return target, source_cwd, "working-directory-unbound"


def prepare_native_launch(ctx, workspace_root, provider_name, project_work_binding):
    target, launch_root, resolution = resolve_native_launch_target(ctx, workspace_root)
    if target.identity.workspace_kind == "project":
        work_ref, work_selection = project_work_binding(
            target.identity.workspace_root,
            target.identity.workspace_id,
            target.runtime_dir,
        )
    else:
        work_ref = None
        work_selection = unbound_work_selection(target.identity.workspace_id)
    notices = []
    if resolution == "selected-project":
        notices.append(f"Project: {launch_root} (current selection)")
    elif resolution == "working-directory-unbound":
        notices.append(
            f"No Project is selected for {launch_root}; starting {provider_name} "
            "in this directory without durable Work binding. Use `kungfu project "
            "create-plan` or `kungfu project select <path>` when you want a Project."
        )
    if provider_name == "codex":
        notices.append(
            f"Codex may ask whether to trust {launch_root}. Answer the prompt in "
            "this terminal; Kungfu will not answer it for you."
        )
    return target, launch_root, work_ref, work_selection, notices


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
    "SYSTEMROOT",
    "SYSTEMDRIVE",
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
    skill_context_builder: Callable[..., dict[str, Any]] = build_skill_context,
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
    selected = dict(profile or {})
    profile_id = str(selected.get("id") or f"kungfu.agent-runtime.{provider}")
    bootstrap_receipt = (
        agent_resources.native_bootstrap_receipt(
            provider,
            profile=selected,
            adapter=selected_adapter,
            session_ref=session_ref,
        )
        if session_ref is not None
        else None
    )
    bootstrap_context = agent_resources.bootstrap_context(bootstrap_receipt)
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
            "bootstrapRequiredBeforeProjectWrite": True,
            "mutationsAllowed": bootstrap_context["mutationsAllowed"],
            "conflictCode": "native_work_already_active",
            "canonicalEntrypoint": "bindWork",
            "internalSessionOperations": [
                "plan-native-bind-work",
                "bind-native-work",
            ],
            "internalSessionOperationsAreCliEntrypoints": False,
        },
        "bootstrap": bootstrap_context,
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
        attempt_id = str(session_ref["sessionAttemptId"])
        skill_audit_log_path = os.path.join(
            runtime_dir,
            "skill-manager",
            f"agent-console-{attempt_id}-events.jsonl",
        )
        skill_context = skill_context_builder(
            runtime_home,
            source="cli",
            manager="python",
            profile=profile_id,
            agent=provider,
            runtime_dir=runtime_dir,
            env=ambient,
            cwd=workspace_root,
        )
        (
            skill_work_ref,
            skill_runtime_audit,
            skill_runtime_audit_path,
            skill_runtime_audit_final_path,
        ) = prepare_native_skill_runtime_audit(
            runtime_home,
            runtime_dir,
            attempt_id,
            work_ref,
        )
        agent_skill_projection = skill_runtime_audit["surfaceProjections"]["agent"]
        skill_runtime_roots = skill_runtime_audit["roots"]
        receipt_roots = sorted(
            {
                str(root)
                for root in (
                    bootstrap_context.get("receiptRoot"),
                    skill_runtime_audit.get("documentRoot"),
                )
                if root
            }
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
            "skillRuntimeAudit": {
                "schema": "kungfu.skill-runtime-audit-pointer/v1",
                "path": skill_runtime_audit_path,
                "runtimeAuditRoot": agent_skill_projection["runtimeAuditRoot"],
                "registryStateRoot": agent_skill_projection["registryStateRoot"],
                "historyRoot": agent_skill_projection["historyRoot"],
                "diagnosisRoot": agent_skill_projection["diagnosisRoot"],
                "catalogRoot": agent_resources.canonical_root(
                    skill_context.get("catalog") or []
                ),
                "decisionPolicyRoot": agent_resources.skill_decision_policy_root(),
                "workRefRoot": session_contract.semantic_root(
                    dict(work_ref)
                    if work_ref is not None
                    else {
                        "state": "unbound",
                        "workspaceId": str(
                            work_selection.get("workspaceId") or workspace_root
                        ),
                    }
                ),
                "kfxDependencyRoots": sorted(
                    str(root) for root in skill_runtime_roots["dependencyRoots"]
                ),
                "receiptRoots": receipt_roots,
                "recoveryRoot": agent_resources.canonical_root(
                    skill_runtime_audit["recovery"]
                ),
                "entrypoints": {
                    "catalog": [cli_bin, "skill", "catalog", "--json"],
                    "advise": [
                        cli_bin,
                        "agent",
                        "skill-advisory",
                        "--signals",
                        "<signals.json>",
                        "--json",
                    ],
                    "read": [cli_bin, "skill", "read", "<key-or-path>", "--json"],
                    "audit": [
                        cli_bin,
                        "skill",
                        "audit",
                        "--audit-file",
                        skill_audit_log_path,
                        "--json",
                    ],
                    "explain": [
                        cli_bin,
                        "skill",
                        "explain",
                        "<key-or-path>",
                        "--json",
                    ],
                    "diagnose": [cli_bin, "skill", "diagnose", "--json"],
                    "kfx": [cli_bin, "kfx", "native", "status", "--json"],
                },
                "authority": agent_skill_projection["authority"],
            },
            "bootstrap": bootstrap_context,
        }
        console_envelope = {
            **console_envelope_body,
            "envelopeRoot": session_contract.semantic_root(console_envelope_body),
        }
        session_contract.validate_agent_console_envelope(console_envelope)
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
                "KUNGFU_AGENT_BOOTSTRAP_RECEIPT": json.dumps(
                    bootstrap_receipt,
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
                "KUNGFU_SKILL_AUDIT_FILE": skill_audit_log_path,
                "KUNGFU_SKILL_READ_ENTRYPOINT": (
                    f"{shlex.quote(cli_bin)} skill read <key-or-path> "
                    f"--run-id {shlex.quote(attempt_id)} --audit-file "
                    f"{shlex.quote(skill_audit_log_path)} --json"
                ),
                "KUNGFU_SKILL_RUN_ID": attempt_id,
                "KUNGFU_SKILL_RUNTIME_AUDIT_FILE": skill_runtime_audit_path,
                "KUNGFU_SKILL_RUNTIME_AUDIT_FINAL_FILE": (
                    skill_runtime_audit_final_path
                ),
                "KUNGFU_AGENT_SESSION_ACTOR": (
                    f"native:{provider}:{session_ref['sessionAttemptId']}"
                ),
                "KUNGFU_AGENT_PROVIDER_VERSION": provider_version,
            }
        )
        if skill_work_ref:
            env["KUNGFU_SKILL_WORK_REF"] = skill_work_ref
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


@dataclass(frozen=True)
class NativeTerminalRoute:
    stdin: str
    stdout: str
    stderr: str


def _non_terminal_streams() -> list[str]:
    return [
        name
        for name, descriptor in (("stdin", 0), ("stdout", 1), ("stderr", 2))
        if not os.isatty(descriptor)
    ]


def _native_terminal_route(provider: str) -> NativeTerminalRoute | None:
    missing = _non_terminal_streams()
    if os.name == "nt":
        # Windows console launchers can expose CRT descriptors that Python
        # reports as TTYs while their inherited Win32 handles are not usable as
        # terminal input by a child Node/Rust UI.  Reopen the controlling
        # console for every provider-native child so the child receives stable
        # console handles instead of launcher-specific inherited handles.
        route = NativeTerminalRoute("CONIN$", "CONOUT$", "CONOUT$")
    elif not missing:
        return None
    elif os.name == "posix":
        route = NativeTerminalRoute("/dev/tty", "/dev/tty", "/dev/tty")
    else:
        route = None

    try:
        if route is None:
            raise OSError("unsupported platform")
        with open(route.stdin, "rb", buffering=0) as terminal:
            if not os.isatty(terminal.fileno()):
                raise OSError("controlling terminal is not a TTY")
    except OSError as error:
        descriptors = ", ".join(missing) or "inherited Windows console handles"
        raise ValueError(
            f"provider-native UI '{provider}' requires an interactive terminal; "
            f"non-terminal descriptors: {descriptors}. No controlling terminal is "
            "available. Run the command from a terminal or PTY (for example, tmux)."
        ) from error
    return route


@contextmanager
def _native_terminal_stdio(route: NativeTerminalRoute | None):
    if route is None:
        yield {}
        return
    with ExitStack() as stack:
        stdin = stack.enter_context(open(route.stdin, "rb", buffering=0))
        stdout = stack.enter_context(open(route.stdout, "wb", buffering=0))
        stderr = stack.enter_context(open(route.stderr, "wb", buffering=0))
        yield {"stdin": stdin, "stdout": stdout, "stderr": stderr}


class NativeLaunchCoordinator:
    """Own one provider-native process and its Core observer lifecycle."""

    def __init__(
        self,
        *,
        verify_profile: Callable[[Mapping[str, Any]], Mapping[str, Any]],
        resolve_cwd: Callable[..., str | None],
        build_adapter: Callable[..., Mapping[str, Any]],
        build_environment: Callable[..., dict[str, str]],
        session_ref: Callable[[Mapping[str, Any], str], Mapping[str, str]],
        interactive_argv: Callable[[Mapping[str, Any]], list[str]],
        semantic_root: Callable[[Any], str],
        heartbeat_observation: Callable[[Mapping[str, Any]], Mapping[str, Any]],
        finalize_environment: Callable[[Mapping[str, str]], None],
        provider_health: Callable[..., Mapping[str, Any]] | None = None,
    ) -> None:
        self.verify_profile = verify_profile
        self.resolve_cwd = resolve_cwd
        self.build_adapter = build_adapter
        self.build_environment = build_environment
        self.session_ref = session_ref
        self.interactive_argv = interactive_argv
        self.semantic_root = semantic_root
        self.heartbeat_observation = heartbeat_observation
        self.finalize_environment = finalize_environment
        self.provider_health = provider_health

    def run(
        self,
        profile: Mapping[str, Any],
        *,
        runtime_dir: str,
        config_home: str,
        runtime_home: str,
        workspace_root: str,
        work_ref: Mapping[str, Any] | None,
        work_selection: Mapping[str, Any],
        process_runner: Callable[..., Any] | None = None,
        session_invoker: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
        session_endpoint: str | None = None,
        work_observer: Callable[[Mapping[str, Any] | None], Mapping[str, Any]]
        | None = None,
        heartbeat_seconds: float = 0.5,
        work_projection_seconds: float = 2.0,
    ) -> int:
        verification = self.verify_profile(profile)
        if verification.get("ok") is not True:
            raise ValueError(
                "Agent Runtime Profile verification failed: "
                f"{verification.get('error') or 'unknown error'}"
            )
        cwd = self.resolve_cwd(
            profile, workspace_root=workspace_root, home=runtime_home
        )
        provider = str(profile["provider"])
        if self.provider_health is not None:
            health = self.provider_health(profile, cwd=cwd)
            if health.get("ok") is not True:
                diagnostic = str(
                    health.get("diagnostic") or "provider runtime probe failed"
                )
                raise ValueError(
                    "Codex Windows sandbox is unavailable: "
                    f"{diagnostic}. Kungfu did not launch the Agent or disable "
                    "sandboxing. Run Codex directly from a local Windows terminal, "
                    "use `/setup-default-sandbox`, and retry; use the deterministic "
                    "Mock Agent onboarding while the provider sandbox is unavailable."
                )
        adapter_id = str((profile.get("bootstrap") or {}).get("adapter") or provider)
        if adapter_id != provider:
            raise ValueError(
                "Agent Runtime Profile bootstrap adapter must match provider"
            )
        terminal_route = (
            _native_terminal_route(provider) if process_runner is None else None
        )
        attempt_id = f"native:{uuid.uuid4()}"
        adapter = self.build_adapter(
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
                self.session_ref(work_ref, attempt_id)["workConsoleId"]
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
        env = self.build_environment(
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
            stdio_is_tty=True if process_runner is None else None,
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
                        "providerVersion": str(
                            verification.get("version") or "unknown"
                        ),
                        "profileRoot": self.semantic_root(profile),
                        "runtimeProfileId": str(
                            profile.get("id") or f"kungfu.agent-runtime.{provider}"
                        ),
                        "bootstrap": json.loads(env["KUNGFU_AGENT_CONTEXT"])[
                            "bootstrap"
                        ],
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
        projection_port = (
            WorkProjectionPort(
                work_observer,
                fallback_seconds=work_projection_seconds,
            )
            if work_observer is not None
            else None
        )
        projected_binding_root: str | None = None

        def heartbeat() -> None:
            nonlocal projected_binding_root
            if session_invoker is None:
                return
            while not stop_heartbeat.is_set():
                try:
                    current = session_invoker(
                        {"operation": "show", "session": dict(session_ref)}
                    )
                    binding = current.get("binding") or {}
                    observed = self.heartbeat_observation(binding)
                    session_invoker(
                        {
                            "operation": "heartbeat-native",
                            "client": "cli",
                            "actorId": actor_id,
                            "session": dict(session_ref),
                            "processIdentity": process_identity,
                            "observation": {
                                "schema": str(observed["schema"]),
                                "state": str(observed.get("state") or "unknown"),
                                "staleAfterMs": max(
                                    5000, int(heartbeat_seconds * 10000)
                                ),
                                "workRefRoot": observed.get("workRefRoot"),
                                "diagnostic": observed.get("diagnostic"),
                            },
                        }
                    )
                    bound_ref = (
                        binding.get("workRef")
                        if binding.get("kind") == "work"
                        else None
                    )
                    if projection_port is not None and bound_ref:
                        binding_root = self.semantic_root(bound_ref)
                        projection = projection_port.refresh(
                            bound_ref,
                            force=binding_root != projected_binding_root,
                        )
                        projected_binding_root = binding_root
                        if projection is not None:
                            session_invoker(
                                {
                                    "operation": "project-native-work",
                                    "client": "cli",
                                    "actorId": actor_id,
                                    "session": dict(session_ref),
                                    "processIdentity": process_identity,
                                    "projection": projection,
                                }
                            )
                except Exception as error:  # pragma: no cover
                    heartbeat_errors.append(error)
                    return
                stop_heartbeat.wait(heartbeat_seconds)

        heartbeat_thread: threading.Thread | None = None

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

        argv = [*self.interactive_argv(profile), *adapter["argv"]]
        completed: Any | None = None
        try:
            if process_runner is None:
                with _native_terminal_stdio(terminal_route) as terminal_stdio:
                    provider_process = subprocess.Popen(
                        argv, cwd=cwd, env=env, **terminal_stdio
                    )
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
            finalize_error: Exception | None = None
            try:
                self.finalize_environment(env)
            except Exception as error:  # pragma: no cover - defensive lifecycle path
                finalize_error = error
            finally:
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
                                    int(completed.returncode)
                                    if completed is not None
                                    else None
                                ),
                                "signal": None,
                            },
                        }
                    )
            if finalize_error is not None:
                raise ValueError(
                    f"native Agent skill audit finalization failed: {finalize_error}"
                ) from finalize_error
            if heartbeat_errors and completed is not None:
                raise ValueError(f"native Agent observer failed: {heartbeat_errors[0]}")
