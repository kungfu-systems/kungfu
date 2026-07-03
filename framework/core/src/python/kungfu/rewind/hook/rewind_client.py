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
# carries the active span across process boundaries: child processes spawned
# inside a tool invocation inherit it, and the other runtime's hook roots its
# spans under it — one causal chain across runtimes in the same journal
ENV_PARENT_SPAN = "KUNGFU_REWIND_PARENT_SPAN"


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
        outer_span = os.environ.get(ENV_PARENT_SPAN)
        os.environ[ENV_PARENT_SPAN] = self.span_id
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
        finally:
            if outer_span is None:
                os.environ.pop(ENV_PARENT_SPAN, None)
            else:
                os.environ[ENV_PARENT_SPAN] = outer_span
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


def _patch_langchain(module):
    # LangChain's tool seam: every tool execution — whether an agent's tool
    # node calls `tool.invoke(...)`, `tool.ainvoke(...)`, or user code calls
    # `tool.run(...)` — funnels through `BaseTool.run`. `invoke`/`ainvoke`
    # dispatch to it, and the async path runs the sync `run` in an executor,
    # so wrapping this one method captures the whole tool call (including the
    # subclass `_run` beneath it) as a single span across sync and async
    # agents. The model turns that drive these calls are captured upstream at
    # the wire proxy, so the in-process adapter only owns tool semantics.
    base_tool = getattr(module, "BaseTool", None)
    if base_tool is None or getattr(base_tool, "_kungfu_rewind_patched", False):
        return
    original_run = base_tool.run

    def traced_run(self, *args, **kwargs):
        tool_input = args[0] if args else kwargs.get("tool_input")
        name = getattr(self, "name", None) or type(self).__name__
        # root under the ambient span so a langchain tool invoked inside an
        # outer captured span (including across a runtime boundary) nests
        capture = _CallCapture(name, parent_span_id=os.environ.get(ENV_PARENT_SPAN))
        return capture.run(
            lambda: original_run(self, *args, **kwargs), _render(tool_input)
        )

    base_tool.run = traced_run
    base_tool._kungfu_rewind_patched = True


ADAPTERS = {
    "rewind_demo_toolkit": _patch_demo_toolkit,
    # BaseTool lives in `langchain_core.tools.base`; older layouts exposed it
    # from the `langchain_core.tools` package itself. Register both — the
    # patcher no-ops when BaseTool is absent or already wrapped.
    "langchain_core.tools.base": _patch_langchain,
    "langchain_core.tools": _patch_langchain,
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
