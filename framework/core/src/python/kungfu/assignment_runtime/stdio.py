# SPDX-License-Identifier: Apache-2.0

"""Private stdio host for the GUI Assignment Runtime client.

The line transport is an implementation detail.  Every application request and
response remains the public ``kungfu.assignment-runtime/v1`` envelope.
"""

from __future__ import annotations

import json
from typing import Any, TextIO

from .authority import PROFILE_ID, PROFILE_VERSION, PROTOCOL, LocalRuntimeError
from .local import EmbeddedLocalAssignmentRuntime

HOST_SCHEMA = "kungfu.gui.assignment-runtime-host/v1"


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
    except LocalRuntimeError as error:
        _write_line(output_stream, error_envelope(error))
        raise
    except Exception as cause:
        error = LocalRuntimeError(
            "backend-unavailable",
            "Local Assignment Runtime writer failed to start",
        )
        _write_line(output_stream, error_envelope(error))
        raise error from cause
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
        except LocalRuntimeError as error:
            _write_line(output_stream, error_envelope(error))
            raise
        except Exception as cause:
            error = LocalRuntimeError(
                "backend-unavailable",
                "Local Assignment Runtime transport failed",
            )
            _write_line(output_stream, error_envelope(error))
            raise error from cause
    finally:
        runtime.close()


__all__ = ["HOST_SCHEMA", "error_envelope", "ready_envelope", "serve"]
