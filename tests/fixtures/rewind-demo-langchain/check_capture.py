# SPDX-License-Identifier: Apache-2.0
#
# Capture assertions for the real-LangChain fixture. Proves that an unmodified
# third-party agent framework, run once under `kungfu trace`, lands a complete
# fact set in ONE journal: both model turns captured at the wire, the tool call
# captured in-process by the adapter, and the tool causally bracketed between
# the turns. Runs inside the dev kfc environment (needs pykungfu).
#
# Honest scope: this is a single-runtime run, so it upgrades the *zero-code-
# change real-framework capture* leg of the moat from the toy toolkit to a real
# framework. Cross-runtime causal edges and replay double-path are proved by
# their own fixtures; this one does not restate those claims.
#
# Usage: check_capture.py <runtime-dir> <run-id>

import hashlib
import json
import os
import sys

_core = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "framework", "core")
)
sys.path.insert(0, os.path.join(_core, "src", "python"))
sys.path.insert(0, os.path.join(_core, "dist", "kungfu"))

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


def frames(msg_type):
    return yjj.assemble(location, 0).read_bytes(msg_type)


# ── run bracket ──────────────────────────────────────────────────────
begin_frames = frames(MSG_RUN_BEGIN)
check("RunBegin frame present", len(begin_frames) == 1)
if begin_frames:
    header, payload = begin_frames[0]
    begin = RunBegin.GetRootAs(bytes(payload), 0)
    check("RunBegin.run_id matches", (begin.RunId() or b"").decode() == run_id)
    check("RunBegin.gen_time set", header.gen_time > 0)

# ── model turns, captured at the wire (framework-agnostic) ───────────
req_frames = frames(MSG_MODEL_REQUEST)
check("two ModelRequest frames (tool-call turn + final turn)", len(req_frames) == 2)
req_spans = []
req_times = []
for hdr, payload in req_frames:
    req = ModelRequest.GetRootAs(bytes(payload), 0)
    req_spans.append((req.SpanId() or b"").decode())
    req_times.append(hdr.gen_time)
    check("ModelRequest.run_id matches", (req.RunId() or b"").decode() == run_id)
    check("ModelRequest.layer == ModelWire", req.Layer() == CaptureLayer.ModelWire)
    check(
        "ModelRequest.provider == openai", (req.Provider() or b"").decode() == "openai"
    )
    check(
        "ModelRequest.model == fixture-model",
        (req.Model() or b"").decode() == "fixture-model",
    )
    body = json.loads((req.RequestBody() or b"{}").decode())
    check("ModelRequest.request_body has messages", bool(body.get("messages")))

resp_frames = frames(MSG_MODEL_RESPONSE)
check("two ModelResponse frames", len(resp_frames) == 2)
finish_reasons = []
resp_spans = []
resp_times = []
for hdr, payload in resp_frames:
    resp = ModelResponse.GetRootAs(bytes(payload), 0)
    resp_spans.append((resp.SpanId() or b"").decode())
    resp_times.append(hdr.gen_time)
    finish_reasons.append((resp.FinishReason() or b"").decode())
    check("ModelResponse.status == Ok", resp.Status() == CallStatus.Ok)
    check("ModelResponse.latency_ns > 0", resp.LatencyNs() > 0)
    check(
        "ModelResponse.tokens captured",
        resp.InputTokens() > 0 and resp.OutputTokens() > 0,
    )
check(
    "model turns are a tool-call turn then a stop turn",
    sorted(finish_reasons) == ["stop", "tool_calls"],
    ",".join(finish_reasons),
)
check(
    "each ModelResponse correlates to a ModelRequest",
    set(resp_spans) == set(req_spans) and len(set(resp_spans)) == 2,
)

# ── the tool call, captured in-process by the adapter (zero code change) ─
call_frames = frames(MSG_TOOL_CALL)
check("one ToolCall frame from the real BaseTool seam", len(call_frames) == 1)
call_span = None
call_time = None
if call_frames:
    hdr, payload = call_frames[0]
    call = ToolCall.GetRootAs(bytes(payload), 0)
    call_span = (call.SpanId() or b"").decode()
    call_time = hdr.gen_time
    check("ToolCall.run_id matches", (call.RunId() or b"").decode() == run_id)
    check(
        "ToolCall.layer == InProcessHook", call.Layer() == CaptureLayer.InProcessHook
    )
    check("ToolCall.tool_name == lookup", (call.ToolName() or b"").decode() == "lookup")
    check(
        "ToolCall.input carries the model's tool args",
        "kungfu rewind" in (call.Input() or b"").decode(),
    )

result_frames = frames(MSG_TOOL_RESULT)
check("one ToolResult frame", len(result_frames) == 1)
if result_frames:
    _, payload = result_frames[0]
    result = ToolResult.GetRootAs(bytes(payload), 0)
    check("ToolResult.status == Ok", result.Status() == CallStatus.Ok)
    check("ToolResult.latency_ns > 0", result.LatencyNs() > 0)
    check(
        "ToolResult correlates to the ToolCall span",
        (result.SpanId() or b"").decode() == call_span,
    )
    check(
        "ToolResult carries the tool's output",
        "KUNGFU REWIND" in (result.Output() or b"").decode(),
    )

# retries are not fabricated: a real agent loop's re-calls would be distinct
# tool spans, and this happy run has none
check("no RetryMarker fabricated for the real run", len(frames(MSG_RETRY_MARKER)) == 0)

# ── one journal, one causal timeline ─────────────────────────────────
# the tool call must sit between the model turn that requested it and the turn
# that consumed its result — the real agent's causal story, in event time
if call_time is not None and len(req_times) == 2 and len(resp_times) == 2:
    first_turn_end = min(resp_times)
    last_turn_start = max(req_times)
    check(
        "tool call is bracketed by the two model turns",
        first_turn_end <= call_time <= last_turn_start,
        f"resp0={first_turn_end} call={call_time} req1={last_turn_start}",
    )

end_frames = frames(MSG_RUN_END)
check("RunEnd frame present", len(end_frames) == 1)
if end_frames:
    _, payload = end_frames[0]
    end = RunEnd.GetRootAs(bytes(payload), 0)
    check("RunEnd.run_id matches", (end.RunId() or b"").decode() == run_id)
    check("RunEnd.exit_code == 0", end.ExitCode() == 0)

# ── self-describing bundle (decode without the writer) ───────────────
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
