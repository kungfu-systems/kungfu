# SPDX-License-Identifier: Apache-2.0

"""`kungfu work transaction` PostgreSQL authority client."""

from __future__ import annotations

import json
from pathlib import Path

import click

from kungfu.assignment_runtime.postgresql import (
    PostgresAssignmentError,
    client_from_environment,
)


def _emit(value):
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _run(operation):
    try:
        _emit(operation())
    except (
        OSError,
        ValueError,
        json.JSONDecodeError,
        PostgresAssignmentError,
    ) as error:
        _emit(
            {
                "schema": "kungfu.assignment-transaction.diagnosis/v1",
                "ok": False,
                "code": getattr(error, "code", "invalid-command"),
                "message": str(error),
            }
        )
        raise click.exceptions.Exit(2) from error


@click.group(
    name="transaction",
    help="use PostgreSQL as the authoritative Assignment transaction writer",
)
def transaction():
    """Submit and inspect backend-neutral Work transactions."""


@transaction.command(name="apply")
@click.option(
    "--request",
    "request_path",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--timeout-seconds", type=float, default=15.0, show_default=True)
def apply_command(request_path: Path, timeout_seconds: float):
    """Apply one canonical command through the Kungfu-owned SQL authority."""

    def operation():
        request = json.loads(request_path.read_text(encoding="utf-8"))
        return client_from_environment(timeout_seconds=timeout_seconds).apply(request)

    _run(operation)


@transaction.command(name="status")
@click.option("--initiative-id", required=True)
@click.option("--assignment-id", required=True)
@click.option("--timeout-seconds", type=float, default=15.0, show_default=True)
def status_command(initiative_id: str, assignment_id: str, timeout_seconds: float):
    """Read one authoritative Assignment head and evidence inventory."""

    _run(
        lambda: client_from_environment(timeout_seconds=timeout_seconds).status(
            initiative_id, assignment_id
        )
    )


@transaction.command(name="list")
@click.option("--timeout-seconds", type=float, default=15.0, show_default=True)
def list_command(timeout_seconds: float):
    """List authoritative PostgreSQL Assignment heads."""

    _run(lambda: client_from_environment(timeout_seconds=timeout_seconds).list())


__all__ = ["transaction"]
