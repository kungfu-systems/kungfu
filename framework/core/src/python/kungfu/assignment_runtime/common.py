# SPDX-License-Identifier: Apache-2.0

"""Embedded Local Assignment Runtime Profile.

The runtime owns transport fencing, idempotency, resumable events, and durable
receipts.  Assignment state remains owned by the active Work Control Profile;
this module never interprets its private storage layout or appends a Fact
directly.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from collections.abc import Mapping
from typing import Any, Protocol
from kungfu.canonical_json import canonical_json_text


PROTOCOL = "kungfu.assignment-runtime/v1"
PROFILE_ID = "kungfu.assignment-runtime.local"
PROFILE_VERSION = "1"
STATE_SCHEMA = "kungfu.assignment-runtime.local-state/v1"
REQUEST_SCHEMA = "kungfu.assignment-runtime.request/v1"
RESPONSE_SCHEMA = "kungfu.assignment-runtime.response/v1"
SNAPSHOT_SCHEMA = "kungfu.assignment-runtime.snapshot/v1"
EVENT_SCHEMA = "kungfu.assignment-runtime.event/v1"
RECEIPT_SCHEMA = "kungfu.assignment-runtime.receipt/v1"
DISCOVERY_SCHEMA = "kungfu.assignment-runtime.discovery/v1"
STREAM_ID = "assignment-events"

_STABLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$")
_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
_FORBIDDEN_ARGUMENT_KEYS = {
    "directStorageMutation",
    "electronChannel",
    "filesystemPath",
    "journalPath",
    "postgresTable",
    "sqliteTable",
    "storagePath",
}
_ERROR_RETRYABLE = {
    "stale-revision": True,
    "generation-fenced": True,
    "idempotency-conflict": False,
    "unsupported-capability": False,
    "malformed-identity": False,
    "ambiguous-identity": False,
    "backend-unavailable": True,
    "event-resume-gap": True,
    "authority-bypass": False,
    "lease-required": True,
    "warrant-invalid": False,
    "unauthorized": False,
    "invalid-command": False,
    "internal": True,
}
_COMMAND_OPERATIONS = {
    "assignment.create": "create-assignment",
    "assignment.claim": "claim-assignment",
    "assignment.stage": "advance-assignment",
    "assignment.completion.claim": "claim-completion",
    "assignment.completion.review": "review-completion",
    "assignment.continuation.decide": "decide-continuation",
}
_LEASE_COMMANDS = {"assignment.claim", "assignment.stage"}
_PROCESS_WRITERS: set[str] = set()
_PROCESS_WRITERS_GUARD = threading.Lock()


def _root(value: Any) -> str:
    raw = canonical_json_text(value).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _stable(value: Any, field: str) -> str:
    text = str(value or "")
    if not _STABLE_ID.fullmatch(text):
        raise LocalRuntimeError(
            "malformed-identity",
            f"{field} must be a stable logical identity",
            details={"field": field},
        )
    return text


def _contains_forbidden_argument(value: Any) -> str:
    if not isinstance(value, Mapping):
        return ""
    for key, child in value.items():
        if str(key) in _FORBIDDEN_ARGUMENT_KEYS:
            return str(key)
        nested = _contains_forbidden_argument(child)
        if nested:
            return nested
    return ""


def _copy_json(value: Any) -> Any:
    return json.loads(json.dumps(value))


def _find_values(value: Any, key: str) -> list[Any]:
    found: list[Any] = []
    if isinstance(value, Mapping):
        for current, child in value.items():
            if current == key:
                found.append(child)
            found.extend(_find_values(child, key))
    elif isinstance(value, list):
        for child in value:
            found.extend(_find_values(child, key))
    return found


class LocalRuntimeError(RuntimeError):
    """Stable public Runtime error."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
        diagnostics: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = dict(details or {})
        self.diagnostics = list(diagnostics or [])


class AssignmentAuthority(Protocol):
    """Private adapter boundary to the one native transition authority."""

    def inspect(self) -> dict[str, Any]: ...

    def apply(self, command: Mapping[str, Any]) -> dict[str, Any]: ...

    def diagnostics(self) -> list[dict[str, Any]]: ...
