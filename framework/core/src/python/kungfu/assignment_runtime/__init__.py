# SPDX-License-Identifier: Apache-2.0

"""Production Local Profile for the Assignment Runtime v1 contract."""

from __future__ import annotations

import threading
from collections.abc import Mapping
from typing import Any

from .local import (
    EVENT_SCHEMA,
    SNAPSHOT_SCHEMA,
    REQUEST_SCHEMA,
    EmbeddedLocalAssignmentRuntime,
    LocalRuntimeError,
    WorkControlAuthority,
    _copy_json,
    _stable,
)


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
    "LocalRuntimeError",
    "WorkControlAuthority",
]
