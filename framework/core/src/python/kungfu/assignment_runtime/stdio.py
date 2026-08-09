# SPDX-License-Identifier: Apache-2.0

"""Private stdio host for the GUI Assignment Runtime client.

The line transport is an implementation detail.  Every application request and
response remains the public ``kungfu.assignment-runtime/v1`` envelope.
"""

from __future__ import annotations

from collections.abc import Callable
import json
from pathlib import Path
from typing import Any, TextIO

import click

from kungfu import assignment_orchestration as orchestration

from .authority import PROFILE_ID, PROFILE_VERSION, PROTOCOL, LocalRuntimeError
from .local import EmbeddedLocalAssignmentRuntime

HOST_SCHEMA = "kungfu.gui.assignment-runtime-host/v1"


def profile_source() -> Path:
    """Resolve the packaged Work Control Profile with source compatibility."""

    profiles = Path(orchestration.__file__).resolve().parent / "profiles"
    extensions = orchestration.source_root() / "extensions"
    for root in (profiles, extensions):
        for name in ("work-control", "mission-control"):
            source = root / name
            if source.is_dir():
                return source
    raise ValueError("Work Control Profile is absent from this Kungfu product")


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


__all__ = [
    "HOST_SCHEMA",
    "create_runtime_host_command",
    "error_envelope",
    "profile_source",
    "ready_envelope",
    "serve",
]
