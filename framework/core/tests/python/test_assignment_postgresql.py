# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from kungfu.assignment_runtime.postgresql import (
    COMMAND_SCHEMA,
    PSQL_ARGV_ENV,
    PostgresAssignmentClient,
    PostgresAssignmentError,
    PsqlJsonTransport,
    psql_argv_from_environment,
)


ROOT = Path(__file__).resolve().parents[4]
SQL = ROOT / "framework" / "assignment-runtime" / "postgresql-authority.sql"
REQUEST_ROOT = "sha256:" + "1" * 64
RECEIPT_ROOT = "sha256:" + "2" * 64


def _request(command_type="assignment.lease.acquire"):
    return {
        "schema": COMMAND_SCHEMA,
        "commandId": "command:test:1",
        "idempotencyKey": "idempotency:test:1",
        "commandType": command_type,
        "actor": "agent:test",
        "target": {
            "initiativeId": "initiative:test",
            "assignmentId": "assignment:test",
        },
        "expectedVersion": 0,
        "arguments": {"holder": "agent:test", "ttlSeconds": 60},
    }


def _receipt():
    return {
        "schema": "kungfu.assignment-transaction.receipt/v1",
        "authority": "kungfu-native-postgresql",
        "requestRoot": REQUEST_ROOT,
        "receiptRoot": RECEIPT_ROOT,
    }


def test_psql_environment_is_an_argv_boundary():
    assert psql_argv_from_environment(
        {PSQL_ARGV_ENV: '["ssh","worker","psql","-XAt"]'}
    ) == ["ssh", "worker", "psql", "-XAt"]
    with pytest.raises(PostgresAssignmentError, match="JSON argv array"):
        psql_argv_from_environment({PSQL_ARGV_ENV: "ssh worker psql"})


def test_transport_uses_stdin_without_shell_and_accepts_one_json_row(monkeypatch):
    observed = {}

    def run(argv, **kwargs):
        observed.update(argv=argv, kwargs=kwargs)
        return subprocess.CompletedProcess(argv, 0, json.dumps(_receipt()), "")

    monkeypatch.setattr(subprocess, "run", run)
    result = PsqlJsonTransport(["psql", "-XAt"]).execute("select 1;\n")
    assert result == _receipt()
    assert observed["argv"] == ["psql", "-XAt"]
    assert observed["kwargs"]["input"] == "select 1;\n"
    assert "shell" not in observed["kwargs"]


def test_client_submits_only_the_public_function_and_validates_receipt():
    class Transport:
        sql = ""

        def execute(self, sql):
            self.sql = sql
            return _receipt()

    transport = Transport()
    assert PostgresAssignmentClient(transport).apply(_request()) == _receipt()
    assert transport.sql.startswith("SELECT kungfu_work.command(")
    assert transport.sql.endswith("::jsonb)::text;\n")
    assert "assignment.lease.acquire" in transport.sql


def test_client_fails_closed_on_transport_and_receipt_errors(monkeypatch):
    def rejected(argv, **kwargs):
        return subprocess.CompletedProcess(
            argv,
            1,
            "",
            "ERROR: stale-revision; password=must-not-be-reflected",
        )

    monkeypatch.setattr(subprocess, "run", rejected)
    with pytest.raises(PostgresAssignmentError) as error:
        PsqlJsonTransport(["psql"]).execute("select 1")
    assert error.value.code == "stale-revision"
    assert "password" not in error.value.message

    class InvalidReceipt:
        def execute(self, _sql):
            return {"schema": "wrong"}

    with pytest.raises(PostgresAssignmentError) as error:
        PostgresAssignmentClient(InvalidReceipt()).apply(_request())
    assert error.value.code == "backend-unavailable"


def test_sql_contract_owns_cas_fencing_idempotency_and_evidence():
    source = SQL.read_text(encoding="utf-8")
    for required in (
        "pg_advisory_xact_lock",
        "FOR UPDATE",
        "stale-revision",
        "generation-fenced",
        "idempotency-conflict",
        "assignment_evidence",
        "assignment.completion.record",
        "assignment.delivery.record",
        "kungfu-native-postgresql",
    ):
        assert required in source
    assert "DROP TABLE" not in source
    assert "TRUNCATE" not in source


def test_cli_module_is_a_thin_registered_edge():
    source = (
        ROOT
        / "framework"
        / "core"
        / "src"
        / "python"
        / "kungfu"
        / "cli"
        / "commands"
        / "assignment_postgresql.py"
    ).read_text(encoding="utf-8")
    assert '@click.group(\n    name="transaction"' in source
    assert "client_from_environment" in source
    assert "postgresql-authority.sql" not in source
