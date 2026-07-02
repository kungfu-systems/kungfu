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

import json
import socketserver
import threading

from kungfu.rewind import (
    MSG_RETRY_MARKER,
    MSG_TOOL_CALL,
    MSG_TOOL_RESULT,
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
    def handle(self):
        server = self.server
        for line in self.rfile:
            line = line.strip()
            if not line:
                continue
            try:
                server.ingest.accept(json.loads(line))
            except (ValueError, KeyError, TypeError):
                # a malformed hook line must never take capture down
                continue


class IngestServer:
    def __init__(self, run_id, sink):
        self.run_id = run_id
        self.sink = sink
        self._server = socketserver.ThreadingTCPServer(
            ("127.0.0.1", 0), _Handler, bind_and_activate=True
        )
        self._server.daemon_threads = True
        self._server.ingest = self
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def endpoint(self):
        host, port = self._server.server_address
        return f"{host}:{port}"

    def start(self):
        self._thread.start()

    def stop(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def accept(self, message):
        kind = message.get("event")
        if kind == "tool_call":
            self.sink(
                MSG_TOOL_CALL,
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
                MSG_TOOL_RESULT,
                events.tool_result(
                    run_id=self.run_id,
                    span_id=message.get("span_id"),
                    layer=CaptureLayer.InProcessHook,
                    status=_STATUS.get(message.get("status"), CallStatus.Error),
                    output=message.get("output"),
                    error=message.get("error"),
                    latency_ns=int(message.get("latency_ns") or 0),
                ),
            )
        elif kind == "retry":
            self.sink(
                MSG_RETRY_MARKER,
                events.retry_marker(
                    run_id=self.run_id,
                    span_id=message.get("span_id"),
                    retry_of_span_id=message.get("retry_of_span_id"),
                    attempt=int(message.get("attempt") or 0),
                    reason=message.get("reason"),
                ),
            )
