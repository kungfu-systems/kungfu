# SPDX-License-Identifier: Apache-2.0

"""Production Local Profile for the Assignment Runtime v1 contract."""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
import json
import os
from pathlib import Path
from typing import Any, TextIO

import click

from kungfu import assignment_orchestration as orchestration

from .authority import WorkControlAuthority
from .authority import (
    EVENT_SCHEMA,
    PROFILE_ID,
    PROFILE_VERSION,
    PROTOCOL,
    SNAPSHOT_SCHEMA,
    REQUEST_SCHEMA,
    LocalRuntimeError,
    _copy_json,
    _stable,
)
from .local import EmbeddedLocalAssignmentRuntime

HOST_SCHEMA = "kungfu.gui.assignment-runtime-host/v1"


class ProfileDomain:
    """Lazy native module whose calls retain the installed Profile source."""

    def __init__(self, module_name: str):
        self.module_name = module_name

    def _domain(self):
        from kungfu import profile_sdk

        source = profile_sdk.discover_source("kungfu.work-control")["source"]
        package = profile_sdk.load_member_python_package(
            source, "work-control-actions", "domain"
        )
        return source, getattr(package, self.module_name), package.work_control

    def __getattr__(self, name: str):
        source, module, binder = self._domain()
        value = getattr(module, name)
        if not callable(value):
            return value

        def bound(*args, **kwargs):
            return binder._with_profile_source(source, lambda: value(*args, **kwargs))

        bound.__name__ = getattr(value, "__name__", name)
        bound.__doc__ = getattr(value, "__doc__", None)
        return bound

    def __dir__(self):
        _, module, _ = self._domain()
        return sorted(set(dir(module)))


def profile_domain(module_name: str) -> ProfileDomain:
    """Expose one native Work Control domain without a wrapper-only module."""

    return ProfileDomain(module_name)


def profile_source() -> Path:
    """Resolve Work Control only from explicit installed extension roots."""

    from kungfu import profile_sdk

    roots = [
        Path(value).expanduser()
        for value in os.environ.get("KF_EXTENSION_PATH", "").split(os.pathsep)
        if value
    ]
    if not roots:
        raise ValueError(
            "KF_EXTENSION_PATH does not name an installed Work Control Profile"
        )
    discovered = profile_sdk.discover_source("kungfu.work-control", search_roots=roots)
    return Path(discovered["source"])


def create_runtime_host_command(
    resolve_runtime: Callable[[str, bool, str], tuple[Any, Path, dict[str, Any]]],
) -> click.Command:
    """Build the hidden host command without coupling transport to the CLI."""

    @click.command(name="runtime-host", hidden=True)
    @click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
    @click.option("--home", is_flag=True)
    def runtime_host(workspace_root: str, home: bool) -> None:
        identity, runtime_dir, _ = resolve_runtime(workspace_root, home, "read-only")
        runtime = EmbeddedLocalAssignmentRuntime(
            runtime_dir,
            realm_id=identity.workspace_id,
            generation=identity.identity_root,
            profile_source=profile_source(),
        )
        try:
            serve(
                runtime,
                click.get_text_stream("stdin"),
                click.get_text_stream("stdout"),
            )
        except LocalRuntimeError as error:
            raise click.exceptions.Exit(2) from error

    return runtime_host


def _write_line(stream: TextIO, value: dict[str, Any]) -> None:
    stream.write(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n")
    stream.flush()


def ready_envelope(runtime: EmbeddedLocalAssignmentRuntime) -> dict[str, Any]:
    return {
        "schema": HOST_SCHEMA,
        "status": "ready",
        "protocol": PROTOCOL,
        "profile": {"id": PROFILE_ID, "version": PROFILE_VERSION},
        "realm": dict(runtime.realm),
        "genesisCursor": runtime.genesis_cursor(runtime.realm["generation"]),
        "error": None,
    }


def error_envelope(error: LocalRuntimeError) -> dict[str, Any]:
    return {
        "schema": HOST_SCHEMA,
        "status": "error",
        "protocol": PROTOCOL,
        "profile": {"id": PROFILE_ID, "version": PROFILE_VERSION},
        "realm": None,
        "genesisCursor": None,
        "error": {
            "code": error.code,
            "message": error.message,
            "retryable": error.code
            in {
                "backend-unavailable",
                "generation-fenced",
                "stale-revision",
            },
            "details": dict(error.details),
        },
    }


def serve(
    runtime: EmbeddedLocalAssignmentRuntime,
    input_stream: TextIO,
    output_stream: TextIO,
) -> None:
    """Own one Runtime writer until the GUI transport disconnects."""

    try:
        runtime.start()
    except LocalRuntimeError as runtime_error:
        _write_line(output_stream, error_envelope(runtime_error))
        raise
    except Exception as cause:
        wrapped_error = LocalRuntimeError(
            "backend-unavailable",
            "Local Assignment Runtime writer failed to start",
        )
        _write_line(output_stream, error_envelope(wrapped_error))
        raise wrapped_error from cause
    try:
        _write_line(output_stream, ready_envelope(runtime))
        try:
            for raw in input_stream:
                if not raw.strip():
                    continue
                try:
                    request = json.loads(raw)
                except json.JSONDecodeError:
                    # Malformed transport bytes have no trustworthy request identity.
                    # Close the host so the client reconnects instead of inventing one.
                    raise LocalRuntimeError(
                        "invalid-command", "Runtime transport request is not valid JSON"
                    ) from None
                if not isinstance(request, dict):
                    raise LocalRuntimeError(
                        "invalid-command", "Runtime transport request must be an object"
                    )
                _write_line(output_stream, runtime.handle(request))
        except LocalRuntimeError as runtime_error:
            _write_line(output_stream, error_envelope(runtime_error))
            raise
        except Exception as cause:
            wrapped_error = LocalRuntimeError(
                "backend-unavailable",
                "Local Assignment Runtime transport failed",
            )
            _write_line(output_stream, error_envelope(wrapped_error))
            raise wrapped_error from cause
    finally:
        runtime.close()


class EmbeddedAssignmentRuntimeClient:
    """Typed in-process client that preserves the Runtime v1 JSON envelope."""

    _CLIENT_KINDS = {"gui", "cli", "agent", "kfx", "test"}

    def __init__(
        self,
        runtime: EmbeddedLocalAssignmentRuntime,
        *,
        client_id: str,
        kind: str,
    ) -> None:
        self.runtime = runtime
        self.client_id = _stable(client_id, "clientId")
        if kind not in self._CLIENT_KINDS:
            raise LocalRuntimeError(
                "malformed-identity", "Runtime client kind is unsupported"
            )
        self.kind = kind
        self._sequence = 0
        self._sequence_guard = threading.Lock()

    def invoke(
        self,
        operation: str,
        *,
        payload: Mapping[str, Any] | None = None,
        cursor: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        capability = self.runtime._operations.get(operation)
        if capability is None:
            raise LocalRuntimeError(
                "invalid-command", "Runtime operation is not in the active contract"
            )
        with self._sequence_guard:
            self._sequence += 1
            request_id = f"{self.client_id}:{self._sequence}"
        request = {
            "schema": REQUEST_SCHEMA,
            "requestId": request_id,
            "realm": dict(self.runtime.realm),
            "operation": operation,
            "client": {
                "clientId": self.client_id,
                "kind": self.kind,
                "requestedCapabilities": [capability],
            },
            "payload": _copy_json(payload or {}),
        }
        if cursor is not None:
            request["cursor"] = _copy_json(cursor)
        return self.runtime.handle(request)

    def discover(self) -> dict[str, Any]:
        return self.invoke("capabilities.discover")

    def snapshot(self) -> dict[str, Any]:
        return self.invoke("assignment.snapshot")

    def list_assignments(
        self, filters: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        return self.invoke("assignment.list", payload=filters)

    def get_assignment(self, initiative_id: str, assignment_id: str) -> dict[str, Any]:
        return self.invoke(
            "assignment.get",
            payload={
                "initiativeId": initiative_id,
                "assignmentId": assignment_id,
            },
        )

    def query_assignments(self, query: Mapping[str, Any]) -> dict[str, Any]:
        return self.invoke("assignment.query", payload=query)

    def watch(self, cursor: Mapping[str, Any]) -> dict[str, Any]:
        return self.invoke("events.watch", cursor=cursor)

    def submit(self, command: Mapping[str, Any]) -> dict[str, Any]:
        return self.invoke("command.submit", payload=command)

    def inspect_command(
        self, *, command_id: str = "", idempotency_key: str = ""
    ) -> dict[str, Any]:
        return self.invoke(
            "command.get",
            payload={
                key: value
                for key, value in {
                    "commandId": command_id,
                    "idempotencyKey": idempotency_key,
                }.items()
                if value
            },
        )

    def diagnostics(self) -> dict[str, Any]:
        return self.invoke("diagnostics.get")

    def recovery_plan(self) -> dict[str, Any]:
        return self.invoke("recovery.plan")

    def recovery_execute(self, plan: Mapping[str, Any]) -> dict[str, Any]:
        return self.invoke("recovery.execute", payload=plan)


__all__ = [
    "EVENT_SCHEMA",
    "SNAPSHOT_SCHEMA",
    "EmbeddedAssignmentRuntimeClient",
    "EmbeddedLocalAssignmentRuntime",
    "HOST_SCHEMA",
    "LocalRuntimeError",
    "WorkControlAuthority",
    "create_runtime_host_command",
    "error_envelope",
    "profile_source",
    "ready_envelope",
    "serve",
]
