# SPDX-License-Identifier: Apache-2.0

"""Thin PostgreSQL transport for the Kungfu Assignment transaction authority."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any


COMMAND_SCHEMA = "kungfu.assignment-transaction.command/v1"
RECEIPT_SCHEMA = "kungfu.assignment-transaction.receipt/v1"
STATUS_SCHEMA = "kungfu.assignment-transaction.status/v1"
LIST_SCHEMA = "kungfu.assignment-transaction.list/v1"
AUTHORITY = "kungfu-native-postgresql"
PSQL_ARGV_ENV = "KUNGFU_ASSIGNMENT_PSQL_ARGV"

_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
_IDENTITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$")
_ERROR_CODES = (
    "generation-fenced",
    "idempotency-conflict",
    "identity-conflict",
    "initiative-not-found",
    "assignment-not-found",
    "invalid-transition",
    "lease-required",
    "malformed-identity",
    "root-mismatch",
    "stale-revision",
    "invalid-command",
)


class PostgresAssignmentError(RuntimeError):
    """Stable, redacted Assignment transaction failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _canonical(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def content_root(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _dollar_quote(value: str) -> str:
    marker = "kf_" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]
    delimiter = f"${marker}$"
    if delimiter in value:
        raise PostgresAssignmentError(
            "invalid-command", "Request cannot be framed for PostgreSQL"
        )
    return f"{delimiter}{value}{delimiter}"


def psql_argv_from_environment(
    environ: Mapping[str, str] | None = None,
) -> list[str]:
    raw = (environ or os.environ).get(PSQL_ARGV_ENV, "")
    if not raw:
        raise PostgresAssignmentError(
            "backend-unavailable", f"{PSQL_ARGV_ENV} is not configured"
        )
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise PostgresAssignmentError(
            "backend-unavailable", f"{PSQL_ARGV_ENV} must be a JSON argv array"
        ) from error
    if (
        not isinstance(value, list)
        or not value
        or any(not isinstance(item, str) or not item for item in value)
    ):
        raise PostgresAssignmentError(
            "backend-unavailable",
            f"{PSQL_ARGV_ENV} must be a non-empty JSON argv array",
        )
    return list(value)


@dataclass(frozen=True)
class PsqlJsonTransport:
    """Execute exact SQL through an argv-only psql-compatible transport."""

    argv: Sequence[str]
    timeout_seconds: float = 15.0

    def _validated_argv(self) -> list[str]:
        if not self.argv or any(
            not isinstance(item, str) or not item for item in self.argv
        ):
            raise PostgresAssignmentError(
                "backend-unavailable", "PostgreSQL transport argv is invalid"
            )
        return list(self.argv)

    def _run(self, sql: str) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                self._validated_argv(),
                input=sql,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PostgresAssignmentError(
                "backend-unavailable", "PostgreSQL authority is unavailable"
            ) from error

    @staticmethod
    def _raise_rejection(result: subprocess.CompletedProcess[str]) -> None:
        if result.returncode != 0:
            diagnostic = "\n".join((result.stderr, result.stdout)).lower()
            code = next((item for item in _ERROR_CODES if item in diagnostic), None)
            raise PostgresAssignmentError(
                code or "backend-unavailable",
                "PostgreSQL authority rejected the request"
                if code
                else "PostgreSQL authority is unavailable",
            )

    @staticmethod
    def _parse_row(stdout: str) -> dict[str, Any]:
        rows = [line.strip() for line in stdout.splitlines() if line.strip()]
        if len(rows) != 1:
            raise PostgresAssignmentError(
                "backend-unavailable",
                "PostgreSQL authority returned an invalid row set",
            )
        try:
            value = json.loads(rows[0])
        except json.JSONDecodeError as error:
            raise PostgresAssignmentError(
                "backend-unavailable", "PostgreSQL authority returned invalid JSON"
            ) from error
        if not isinstance(value, dict):
            raise PostgresAssignmentError(
                "backend-unavailable", "PostgreSQL authority returned a non-object"
            )
        return value

    def execute(self, sql: str) -> dict[str, Any]:
        result = self._run(sql)
        self._raise_rejection(result)
        return self._parse_row(result.stdout)


class PostgresAssignmentClient:
    """Backend-thin client; all lifecycle decisions execute inside Kungfu SQL."""

    def __init__(self, transport: PsqlJsonTransport):
        self.transport = transport

    @staticmethod
    def _validate_identity(value: str, field: str) -> str:
        if not _IDENTITY.fullmatch(value):
            raise PostgresAssignmentError(
                "malformed-identity", f"{field} is not a stable identity"
            )
        return value

    def apply(self, request: Mapping[str, Any]) -> dict[str, Any]:
        value = json.loads(_canonical(dict(request)))
        if value.get("schema") != COMMAND_SCHEMA:
            raise PostgresAssignmentError(
                "invalid-command", f"Request schema must be {COMMAND_SCHEMA}"
            )
        target = value.get("target")
        if not isinstance(target, dict):
            raise PostgresAssignmentError("invalid-command", "target must be an object")
        self._validate_identity(str(target.get("initiativeId") or ""), "initiativeId")
        assignment_id = str(target.get("assignmentId") or "")
        if assignment_id:
            self._validate_identity(assignment_id, "assignmentId")
        encoded = _dollar_quote(_canonical(value))
        response = self.transport.execute(
            "SELECT kungfu_work.command(" + encoded + "::jsonb)::text;\n"
        )
        if (
            response.get("schema") != RECEIPT_SCHEMA
            or response.get("authority") != AUTHORITY
        ):
            raise PostgresAssignmentError(
                "backend-unavailable", "PostgreSQL authority receipt is invalid"
            )
        for field in ("requestRoot", "receiptRoot"):
            if not _ROOT.fullmatch(str(response.get(field) or "")):
                raise PostgresAssignmentError(
                    "backend-unavailable", f"PostgreSQL authority omitted {field}"
                )
        return response

    def status(self, initiative_id: str, assignment_id: str) -> dict[str, Any]:
        initiative = _dollar_quote(
            self._validate_identity(initiative_id, "initiativeId")
        )
        assignment = _dollar_quote(
            self._validate_identity(assignment_id, "assignmentId")
        )
        response = self.transport.execute(
            "SELECT kungfu_work.assignment_status("
            + initiative
            + "::text,"
            + assignment
            + "::text)::text;\n"
        )
        if (
            response.get("schema") != STATUS_SCHEMA
            or response.get("authority") != AUTHORITY
        ):
            raise PostgresAssignmentError(
                "assignment-not-found", "Assignment status is unavailable"
            )
        return response

    def list(self) -> dict[str, Any]:
        response = self.transport.execute(
            "SELECT kungfu_work.assignment_list()::text;\n"
        )
        if (
            response.get("schema") != LIST_SCHEMA
            or response.get("authority") != AUTHORITY
        ):
            raise PostgresAssignmentError(
                "backend-unavailable", "Assignment list response is invalid"
            )
        return response


def client_from_environment(
    environ: Mapping[str, str] | None = None, *, timeout_seconds: float = 15.0
) -> PostgresAssignmentClient:
    return PostgresAssignmentClient(
        PsqlJsonTransport(
            psql_argv_from_environment(environ), timeout_seconds=timeout_seconds
        )
    )


__all__ = [
    "AUTHORITY",
    "COMMAND_SCHEMA",
    "LIST_SCHEMA",
    "PSQL_ARGV_ENV",
    "PostgresAssignmentClient",
    "PostgresAssignmentError",
    "PsqlJsonTransport",
    "RECEIPT_SCHEMA",
    "STATUS_SCHEMA",
    "client_from_environment",
    "content_root",
    "psql_argv_from_environment",
]
