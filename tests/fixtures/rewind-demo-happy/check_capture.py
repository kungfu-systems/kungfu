# SPDX-License-Identifier: Apache-2.0
#
# Capture assertions for the happy-path fixture (gate G2: one command produces
# a local run store). Runs inside the dev kfc environment (needs pykungfu).
#
# Usage: check_capture.py <runtime-dir> <run-id>

import hashlib
import json
import os
import sys

# Self-contained path bootstrap: the fixture runs outside the dev entry, so it
# wires the core python package and the built dist/kfc (pykungfu) itself.
_core = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "framework", "core")
)
sys.path.insert(0, os.path.join(_core, "src", "python"))
sys.path.insert(0, os.path.join(_core, "dist", "kfc"))

import kungfu

from kungfu.rewind import (
    MSG_MODEL_REQUEST,
    MSG_MODEL_RESPONSE,
    MSG_RETRY_MARKER,
    MSG_RUN_BEGIN,
    MSG_RUN_END,
    MSG_TOOL_CALL,
    MSG_TOOL_RESULT,
    MSG_TYPE_NAMES,
)
from kungfu.rewind.fb.CallStatus import CallStatus
from kungfu.rewind.fb.CaptureLayer import CaptureLayer
from kungfu.rewind.fb.ModelRequest import ModelRequest
from kungfu.rewind.fb.ModelResponse import ModelResponse
from kungfu.rewind.fb.RetryMarker import RetryMarker
from kungfu.rewind.fb.RunBegin import RunBegin
from kungfu.rewind.fb.RunEnd import RunEnd
from kungfu.rewind.fb.ToolCall import ToolCall
from kungfu.rewind.fb.ToolResult import ToolResult

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

runtime_dir, run_id = sys.argv[1], sys.argv[2]
failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


locator = yjj.locator(runtime_dir)
location = yjj.location(
    lf.enums.mode.LIVE, lf.enums.category.SYSTEM, "rewind", run_id, locator
)
asm = yjj.assemble(location, 0)

begin_frames = asm.read_bytes(MSG_RUN_BEGIN)
check("RunBegin frame present", len(begin_frames) == 1)
if begin_frames:
    header, payload = begin_frames[0]
    begin = RunBegin.GetRootAs(bytes(payload), 0)
    check(
        "RunBegin.run_id matches",
        (begin.RunId() or b"").decode() == run_id,
        (begin.RunId() or b"").decode(),
    )
    check("RunBegin.gen_time set", header.gen_time > 0)

req_frames = yjj.assemble(location, 0).read_bytes(MSG_MODEL_REQUEST)
check("ModelRequest frame present", len(req_frames) == 1)
req_span = None
if req_frames:
    _, payload = req_frames[0]
    req = ModelRequest.GetRootAs(bytes(payload), 0)
    req_span = (req.SpanId() or b"").decode()
    check("ModelRequest.run_id matches", (req.RunId() or b"").decode() == run_id)
    check("ModelRequest.layer == ModelWire", req.Layer() == CaptureLayer.ModelWire)
    check(
        "ModelRequest.provider == openai", (req.Provider() or b"").decode() == "openai"
    )
    check(
        "ModelRequest.model == demo-model",
        (req.Model() or b"").decode() == "demo-model",
    )
    req_body = json.loads((req.RequestBody() or b"{}").decode())
    check("ModelRequest.request_body has messages", bool(req_body.get("messages")))

resp_frames = yjj.assemble(location, 0).read_bytes(MSG_MODEL_RESPONSE)
check("ModelResponse frame present", len(resp_frames) == 1)
if resp_frames:
    _, payload = resp_frames[0]
    resp = ModelResponse.GetRootAs(bytes(payload), 0)
    check(
        "ModelResponse.span_id matches request",
        req_span and (resp.SpanId() or b"").decode() == req_span,
    )
    check("ModelResponse.status == Ok", resp.Status() == CallStatus.Ok)
    check(
        "ModelResponse.finish_reason == stop",
        (resp.FinishReason() or b"").decode() == "stop",
    )
    check(
        "ModelResponse.tokens captured",
        resp.InputTokens() == 7 and resp.OutputTokens() == 3,
    )
    check("ModelResponse.latency_ns > 0", resp.LatencyNs() > 0)
    resp_body = json.loads((resp.ResponseBody() or b"{}").decode())
    check(
        "ModelResponse.response_body has answer",
        resp_body.get("choices", [{}])[0].get("message", {}).get("content")
        == "the demo answer",
    )

call_frames = yjj.assemble(location, 0).read_bytes(MSG_TOOL_CALL)
check("two ToolCall frames (attempt + retry)", len(call_frames) == 2)
call_spans = []
for _, payload in call_frames:
    call = ToolCall.GetRootAs(bytes(payload), 0)
    call_spans.append((call.SpanId() or b"").decode())
    check("ToolCall.run_id matches", (call.RunId() or b"").decode() == run_id)
    check("ToolCall.layer == InProcessHook", call.Layer() == CaptureLayer.InProcessHook)
    check("ToolCall.tool_name == lookup", (call.ToolName() or b"").decode() == "lookup")
    check("ToolCall.input captured", "query" in (call.Input() or b"").decode())

result_frames = yjj.assemble(location, 0).read_bytes(MSG_TOOL_RESULT)
check("two ToolResult frames", len(result_frames) == 2)
statuses = {}
for _, payload in result_frames:
    result = ToolResult.GetRootAs(bytes(payload), 0)
    statuses[(result.SpanId() or b"").decode()] = result.Status()
    check("ToolResult.latency_ns > 0", result.LatencyNs() > 0)
    if result.Status() == CallStatus.Error:
        check(
            "failed attempt has error detail",
            "transient lookup failure" in (result.Error() or b"").decode(),
        )
    else:
        check(
            "retried attempt has output",
            "THE DEMO ANSWER" in (result.Output() or b"").decode(),
        )
check(
    "one attempt errored and one succeeded",
    sorted(statuses.values()) == sorted([CallStatus.Ok, CallStatus.Error]),
)
check("tool results correlate to tool calls", set(statuses) == set(call_spans))

retry_frames = yjj.assemble(location, 0).read_bytes(MSG_RETRY_MARKER)
check("one RetryMarker frame", len(retry_frames) == 1)
if retry_frames and len(call_spans) == 2:
    _, payload = retry_frames[0]
    marker = RetryMarker.GetRootAs(bytes(payload), 0)
    check("RetryMarker.attempt == 2", marker.Attempt() == 2)
    check(
        "RetryMarker links retry to first attempt",
        (marker.RetryOfSpanId() or b"").decode() == call_spans[0]
        and (marker.SpanId() or b"").decode() == call_spans[1],
    )

asm2 = yjj.assemble(location, 0)
end_frames = asm2.read_bytes(MSG_RUN_END)
check("RunEnd frame present", len(end_frames) == 1)
if end_frames:
    _, payload = end_frames[0]
    end = RunEnd.GetRootAs(bytes(payload), 0)
    check("RunEnd.run_id matches", (end.RunId() or b"").decode() == run_id)
    check("RunEnd.exit_code == 0", end.ExitCode() == 0)

bundle_dir = os.path.join(runtime_dir, "rewind", run_id, "bundle")
manifest_path = os.path.join(bundle_dir, "manifest.json")
check("bundle manifest exists", os.path.exists(manifest_path), manifest_path)
if os.path.exists(manifest_path):
    with open(manifest_path) as f:
        manifest = json.load(f)
    bindings = manifest.get("schema_bindings", {})
    check(
        "all rewind msg_types bound",
        set(bindings.keys()) == {str(t) for t in MSG_TYPE_NAMES},
    )
    hashes = {b["schema_hash"] for b in bindings.values()}
    check("single schema hash across bindings", len(hashes) == 1)
    if len(hashes) == 1:
        schema_hash = hashes.pop()
        blob_path = os.path.join(bundle_dir, "schemas", schema_hash + ".bfbs")
        check("schema blob exists", os.path.exists(blob_path))
        if os.path.exists(blob_path):
            with open(blob_path, "rb") as f:
                check(
                    "schema blob content-addressed",
                    hashlib.sha256(f.read()).hexdigest() == schema_hash,
                )

if failures:
    print(f"capture check failed: {failures}")
    sys.exit(1)
print("capture check passed")
