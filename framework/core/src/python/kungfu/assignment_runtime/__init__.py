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
    _root,
    _stable,
)
from .local import EmbeddedLocalAssignmentRuntime

HOST_SCHEMA = "kungfu.gui.assignment-runtime-host/v1"
COMMAND_SCHEMA = "kungfu.assignment-runtime.command/v1"

_INTENT_COMMAND_TYPES = {
    "create-initiative": "initiative.create",
    "create-assignment": "assignment.create",
    "append-assignment-relation-event": "assignment.relation.append",
    "claim-assignment": "assignment.claim",
    "advance-assignment": "assignment.stage",
    "claim-completion": "assignment.completion.claim",
    "assess-progress": "initiative.progress.assess",
    "review-completion": "assignment.completion.review",
    "decide-continuation": "assignment.continuation.decide",
    "import-atlas": "assignment.atlas.import",
    "activate-work-control": "assignment.authority.activate",
    "restore-atlas-authority": "assignment.authority.restore",
    "export-initiative": "initiative.bundle.export",
    "import-initiative": "initiative.bundle.import",
}


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

    roots: list[str | Path] = [
        Path(value).expanduser()
        for value in [
            os.environ.get("KF_BUNDLED_EXTENSION_ROOT", ""),
            *os.environ.get("KF_EXTENSION_PATH", "").split(os.pathsep),
        ]
        if value
    ]
    if not roots:
        raise ValueError(
            "KF_BUNDLED_EXTENSION_ROOT or KF_EXTENSION_PATH does not name an "
            "installed Work Control Profile"
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


def _workspace_realm(runtime_dir: str | Path) -> tuple[str, str]:
    runtime_path = Path(runtime_dir).expanduser().resolve()
    material_path = runtime_path.parent / "workspace-identity.json"
    try:
        material = json.loads(material_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LocalRuntimeError(
            "malformed-identity",
            "Assignment Runtime requires qualified Workspace identity material",
        ) from error
    workspace_kind = str(material.get("workspaceKind") or "")
    generation = _stable(material.get("identityRoot"), "generation")
    if workspace_kind == "home":
        realm_id = "home"
    elif workspace_kind == "project":
        realm_id = f"project:{generation.removeprefix('sha256:')[:16]}"
    else:
        raise LocalRuntimeError(
            "malformed-identity",
            "Assignment Runtime supports only Home or Project Workspace realms",
        )
    return realm_id, generation


def _runtime_result(response: Mapping[str, Any]) -> dict[str, Any]:
    if response.get("status") == "ok" and isinstance(response.get("result"), Mapping):
        return dict(response["result"])
    error = dict(response.get("error") or {})
    raise LocalRuntimeError(
        str(error.get("code") or "internal"),
        str(error.get("message") or "Assignment Runtime request failed"),
        details=dict(error.get("details") or {}),
        diagnostics=[dict(row) for row in response.get("diagnostics") or []],
    )


def _normalize_action_values(values: Mapping[str, Any]) -> dict[str, Any]:
    normalized = _copy_json(dict(values))
    aliases = (
        ("missionId", "initiativeId"),
        ("goalId", "assignmentId"),
        ("goSet", "assignmentSet"),
    )
    for legacy, canonical in aliases:
        if legacy not in normalized:
            continue
        if canonical in normalized and normalized[canonical] != normalized[legacy]:
            raise LocalRuntimeError(
                "ambiguous-identity",
                f"Conflicting {legacy} and {canonical} values",
            )
        normalized.setdefault(canonical, normalized[legacy])
        normalized.pop(legacy, None)
    return normalized


class LocalAssignmentRuntimeApplication:
    """CLI, Agent, and KFX application edge over the versioned Runtime v1 API."""

    def __init__(
        self,
        runtime_dir: str | Path,
        *,
        client_id: str,
        kind: str,
        source: str | Path | None = None,
    ) -> None:
        self.runtime_dir = Path(runtime_dir).expanduser().resolve()
        self.client_id = _stable(client_id, "clientId")
        self.kind = kind
        self.source = source or profile_source()
        self.realm_id, self.generation = _workspace_realm(self.runtime_dir)

    def _runtime(self) -> EmbeddedLocalAssignmentRuntime:
        return EmbeddedLocalAssignmentRuntime(
            self.runtime_dir,
            realm_id=self.realm_id,
            generation=self.generation,
            profile_source=self.source,
        )

    def status(self, initiative_id: str, assignment_id: str) -> dict[str, Any]:
        with self._runtime() as runtime:
            client = EmbeddedAssignmentRuntimeClient(
                runtime, client_id=self.client_id, kind=self.kind
            )
            result = _runtime_result(
                client.get_assignment(initiative_id, assignment_id)
            )
        assignment = dict(result.get("assignment") or {})
        lifecycle = assignment.get("lifecycle")
        if not isinstance(lifecycle, Mapping):
            raise LocalRuntimeError(
                "backend-unavailable",
                "Assignment Runtime snapshot omitted the lifecycle projection",
            )
        return _copy_json(lifecycle)

    def authorize(
        self,
        intent_id: str,
        values: Mapping[str, Any],
        authorized_by: str,
    ) -> dict[str, Any]:
        command_type = _INTENT_COMMAND_TYPES.get(intent_id)
        if command_type is None:
            raise LocalRuntimeError(
                "invalid-command", "Runtime application intent is unsupported"
            )
        arguments = _normalize_action_values(values)
        initiative_id = str(arguments.get("initiativeId") or "")
        assignment_id = str(arguments.get("assignmentId") or "")
        action_root = _root(
            {
                "intentId": intent_id,
                "arguments": arguments,
                "authorizedBy": authorized_by,
            }
        )
        if not initiative_id:
            initiative_id = f"runtime:initiative:{action_root[7:31]}"
            arguments["_runtimeInitiativeId"] = initiative_id
        if not assignment_id:
            assignment_id = f"runtime:assignment:{action_root[7:31]}"
            arguments["_runtimeAssignmentId"] = assignment_id

        with self._runtime() as runtime:
            client = EmbeddedAssignmentRuntimeClient(
                runtime, client_id=self.client_id, kind=self.kind
            )
            snapshot_response = client.snapshot()
            snapshot = _runtime_result(snapshot_response)
            revision = dict(snapshot_response.get("revision") or {})
            attempt = None
            lease = None
            if command_type == "assignment.claim":
                attempt_id = arguments.get("attemptId")
                if not attempt_id:
                    attempt_id = f"attempt:{action_root[7:39]}"
                    arguments["attemptId"] = attempt_id
                attempt = {
                    "attemptId": _stable(attempt_id, "attemptId"),
                    "state": "claimed",
                }
                lease = {
                    "leaseId": _stable(arguments.get("leaseId"), "leaseId"),
                    "state": "active",
                    "expiresAt": str(arguments.get("leaseExpiresAt") or ""),
                }
            elif command_type == "assignment.stage":
                matches = [
                    row
                    for row in snapshot.get("assignments") or []
                    if row.get("initiativeId") == initiative_id
                    and row.get("assignmentId") == assignment_id
                ]
                if len(matches) != 1:
                    raise LocalRuntimeError(
                        "ambiguous-identity",
                        "Runtime stage target does not resolve exactly once",
                    )
                attempt = _copy_json(matches[0].get("attempt"))
                lease = _copy_json(matches[0].get("lease"))

            command_basis = {
                "clientId": self.client_id,
                "intentId": intent_id,
                "authorizedBy": authorized_by,
                "expectedRevision": revision,
                "arguments": arguments,
            }
            command_root = _root(command_basis)
            command = {
                "schema": COMMAND_SCHEMA,
                "commandId": f"command:{self.kind}:{command_root[7:39]}",
                "type": command_type,
                "target": {
                    "initiativeId": initiative_id,
                    "assignmentId": assignment_id,
                },
                "expectedRevision": revision,
                "idempotencyKey": f"idempotency:{command_root[7:]}",
                "attempt": attempt,
                "lease": lease,
                "warrant": None,
                "arguments": arguments,
            }
            result = _runtime_result(client.submit(command))

        authority_receipt = dict(result.get("authorityReceipt") or {})
        profile_result = dict(authority_receipt.get("result") or {})
        if "coreReceipt" not in profile_result:
            raise LocalRuntimeError(
                "backend-unavailable",
                "Assignment Runtime omitted the native authority receipt",
            )
        return _copy_json(profile_result["coreReceipt"])


__all__ = [
    "EVENT_SCHEMA",
    "SNAPSHOT_SCHEMA",
    "EmbeddedAssignmentRuntimeClient",
    "EmbeddedLocalAssignmentRuntime",
    "HOST_SCHEMA",
    "LocalAssignmentRuntimeApplication",
    "LocalRuntimeError",
    "WorkControlAuthority",
    "create_runtime_host_command",
    "error_envelope",
    "profile_source",
    "ready_envelope",
    "serve",
]
