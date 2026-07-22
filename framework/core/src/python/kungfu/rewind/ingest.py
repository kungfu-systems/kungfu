#  SPDX-License-Identifier: Apache-2.0
#
# Capture layer L2, supervisor side — the in-process event ingest.
#
# In-process hooks run inside the *user's* interpreter, which has no kungfu
# dependencies by design (traced code needs no installation either); they
# speak line-delimited JSON over a local TCP endpoint the supervisor announces
# in the environment. This keeps the child-side shim pure stdlib; the channel
# framing is an implementation detail behind the announced endpoint and can be
# swapped (e.g. to nng) without touching the hook protocol. The supervisor
# stays the single journal writer: ingest validates, serializes, and enqueues.

from __future__ import annotations

import base64
import json
import socketserver
import threading
from typing import Any, Callable

from kungfu.rewind import (
    ACTION_RETRY_MARKER,
    ACTION_TOOL_CALL,
    ACTION_TOOL_RESULT,
)
from kungfu.rewind import events
from kungfu.rewind.fb.CallStatus import CallStatus
from kungfu.rewind.fb.CaptureLayer import CaptureLayer

_STATUS = {
    "ok": CallStatus.Ok,
    "error": CallStatus.Error,
    "timeout": CallStatus.Timeout,
    "cancelled": CallStatus.Cancelled,
}


class _Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        server = self.server
        for line in self.rfile:
            line = line.strip()
            if not line:
                continue
            try:
                server.ingest.accept(json.loads(line))  # type: ignore[attr-defined]
            except (ValueError, KeyError, TypeError):
                # a malformed hook line must never take capture down
                continue


class IngestServer:
    def __init__(
        self,
        run_id: str,
        sink: Callable[[str, bytes], None],
        schema_sink: Callable[[str, str, bytes, str], None] | None = None,
    ) -> None:
        self.run_id = run_id
        self.sink = sink
        # collects kfx open-layer schema registrations; None disables the channel
        self.schema_sink = schema_sink
        self._server = socketserver.ThreadingTCPServer(
            ("127.0.0.1", 0), _Handler, bind_and_activate=True
        )
        self._server.daemon_threads = True
        self._server.ingest = self  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def endpoint(self) -> str:
        # binds loopback IPv4, so server_address is a (host, port) pair
        addr = self._server.server_address
        host, port = addr[0], addr[1]
        return f"{host}:{port}"  # type: ignore[str-bytes-safe]

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def accept(self, message: dict[str, Any]) -> None:
        kind = message.get("event")
        if kind == "tool_call":
            self.sink(
                ACTION_TOOL_CALL,
                events.tool_call(
                    run_id=self.run_id,
                    span_id=message.get("span_id"),
                    parent_span_id=message.get("parent_span_id"),
                    layer=CaptureLayer.InProcessHook,
                    tool_name=message.get("tool_name"),
                    input_body=message.get("input"),
                ),
            )
        elif kind == "tool_result":
            self.sink(
                ACTION_TOOL_RESULT,
                events.tool_result(
                    run_id=self.run_id,
                    span_id=message.get("span_id"),
                    layer=CaptureLayer.InProcessHook,
                    status=_STATUS.get(message.get("status", ""), CallStatus.Error),
                    output=message.get("output"),
                    error=message.get("error"),
                    latency_ns=int(message.get("latency_ns") or 0),
                ),
            )
        elif kind == "retry":
            self.sink(
                ACTION_RETRY_MARKER,
                events.retry_marker(
                    run_id=self.run_id,
                    span_id=message.get("span_id"),
                    retry_of_span_id=message.get("retry_of_span_id"),
                    attempt=int(message.get("attempt") or 0),
                    reason=message.get("reason"),
                ),
            )
        elif kind == "kfx_schema":
            # register a kfx action schema for this run's bundle bindings
            if self.schema_sink is not None:
                self.schema_sink(
                    str(message["action_type"]),
                    message.get("name", ""),
                    base64.b64decode(message["bfbs_b64"]),
                    message.get("tier", "trusted"),
                )
        elif kind == "kfx_event":
            # a kfx event: write its payload verbatim under its own action type
            self.sink(
                str(message["action_type"]),
                base64.b64decode(message["payload_b64"]),
            )
