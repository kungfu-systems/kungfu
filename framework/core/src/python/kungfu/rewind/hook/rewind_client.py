# SPDX-License-Identifier: Apache-2.0
#
# Capture layer L2, child side — pure stdlib, zero kungfu dependencies.
#
# This module runs inside the *user's* interpreter. Two hard rules:
#   1. it must never break or slow the traced program: every operation is
#      best-effort, and the first failure disables emission for the run;
#   2. it must not import anything beyond the standard library — the traced
#      environment owes us nothing.
#
# Events go as line-delimited JSON to the local ingest endpoint the
# supervisor announced in KUNGFU_REWIND_INGEST.

import importlib
import importlib.abc
import importlib.util
import json
import os
import socket
import sys
import threading
import time
import uuid

ENV_INGEST = "KUNGFU_REWIND_INGEST"
ENV_RUN_ID = "KUNGFU_REWIND_RUN_ID"


class _Emitter:
    def __init__(self, endpoint):
        host, port = endpoint.rsplit(":", 1)
        self._address = (host, int(port))
        self._sock = None
        self._dead = False

    def emit(self, message):
        if self._dead:
            return
        try:
            if self._sock is None:
                self._sock = socket.create_connection(self._address, timeout=1)
            self._sock.sendall(json.dumps(message).encode() + b"\n")
        except OSError:
            self._dead = True
            self._sock = None

    def close(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None


_emitter = None


def enabled():
    return _emitter is not None


def setup():
    global _emitter
    endpoint = os.environ.get(ENV_INGEST)
    if endpoint and _emitter is None:
        _emitter = _Emitter(endpoint)
    return _emitter is not None


def emit(message):
    if _emitter is not None:
        _emitter.emit(message)


def new_span():
    return uuid.uuid4().hex


def tool_call(span_id, tool_name, input_body, parent_span_id=None):
    emit(
        {
            "event": "tool_call",
            "span_id": span_id,
            "parent_span_id": parent_span_id,
            "tool_name": tool_name,
            "input": input_body,
        }
    )


def tool_result(span_id, status, output=None, error=None, latency_ns=0):
    emit(
        {
            "event": "tool_result",
            "span_id": span_id,
            "status": status,
            "output": output,
            "error": error,
            "latency_ns": latency_ns,
        }
    )


def retry(span_id, retry_of_span_id, attempt, reason=None):
    emit(
        {
            "event": "retry",
            "span_id": span_id,
            "retry_of_span_id": retry_of_span_id,
            "attempt": attempt,
            "reason": reason,
        }
    )


class _CallCapture:
    """Wraps one tool invocation: call/result/error/retry facts around a fn."""

    def __init__(self, tool_name, retry_of=None, attempt=1, parent_span_id=None):
        self.span_id = new_span()
        self.tool_name = tool_name
        if retry_of is not None:
            retry(self.span_id, retry_of, attempt)
        self._parent = parent_span_id

    def run(self, fn, input_body, *args, **kwargs):
        tool_call(self.span_id, self.tool_name, input_body, self._parent)
        started = time.monotonic_ns()
        try:
            result = fn(*args, **kwargs)
        except Exception as e:
            tool_result(
                self.span_id,
                "error",
                error=f"{type(e).__name__}: {e}",
                latency_ns=time.monotonic_ns() - started,
            )
            raise
        tool_result(
            self.span_id,
            "ok",
            output=_render(result),
            latency_ns=time.monotonic_ns() - started,
        )
        return result


def _render(value):
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return repr(value)


# ── post-import adapters ────────────────────────────────────────────
#
# Frameworks are patched after they are imported, from a table of adapters.
# Detection must not import anything eagerly: a meta-path finder watches for
# the module names and applies the patch once the real import completes.


def _patch_demo_toolkit(module):
    # the toolkit's natural seams: Tool.run is the user-facing call, and
    # Tool._invoke is one attempt inside the retry loop — the same shape the
    # per-attempt boundary takes in real frameworks
    original_run = module.Tool.run
    original_invoke = module.Tool._invoke
    state = threading.local()

    def traced_run(self, tool_input):
        state.attempt = 0
        state.prev_span = None
        return original_run(self, tool_input)

    def traced_invoke(self, tool_input):
        state.attempt = getattr(state, "attempt", 0) + 1
        capture = _CallCapture(
            self.name,
            retry_of=getattr(state, "prev_span", None) if state.attempt > 1 else None,
            attempt=state.attempt,
        )
        state.prev_span = capture.span_id
        return capture.run(
            lambda: original_invoke(self, tool_input), _render(tool_input)
        )

    module.Tool.run = traced_run
    module.Tool._invoke = traced_invoke


ADAPTERS = {
    "rewind_demo_toolkit": _patch_demo_toolkit,
}


class _AdapterLoader(importlib.abc.Loader):
    def __init__(self, original_loader, patcher):
        self._original = original_loader
        self._patcher = patcher

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        self._original.exec_module(module)
        try:
            self._patcher(module)
        except Exception:  # noqa: BLE001 — adapters must never break imports
            pass


class _AdapterFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        patcher = ADAPTERS.get(fullname)
        if patcher is None:
            return None
        sys.meta_path.remove(self)
        try:
            spec = importlib.util.find_spec(fullname)
        finally:
            sys.meta_path.insert(0, self)
        if spec is None or spec.loader is None:
            return None
        spec.loader = _AdapterLoader(spec.loader, patcher)
        return spec


def install_adapters():
    if setup():
        sys.meta_path.insert(0, _AdapterFinder())
