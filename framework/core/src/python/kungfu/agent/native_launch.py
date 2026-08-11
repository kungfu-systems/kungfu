# SPDX-License-Identifier: Apache-2.0

"""Provider-native launch lifecycle, independent from CLI parsing."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping
import uuid

from kungfu.agent.work_projection import WorkProjectionPort
from kungfu.workspace import (
    WorkspaceTargetRequired,
    load_workspace_registry,
    resolve_workspace_target,
)


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
    ) -> None:
        self.verify_profile = verify_profile
        self.resolve_cwd = resolve_cwd
        self.build_adapter = build_adapter
        self.build_environment = build_environment
        self.session_ref = session_ref
        self.interactive_argv = interactive_argv
        self.semantic_root = semantic_root
        self.heartbeat_observation = heartbeat_observation

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
            if heartbeat_errors and completed is not None:
                raise ValueError(f"native Agent observer failed: {heartbeat_errors[0]}")
