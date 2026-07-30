# SPDX-License-Identifier: Apache-2.0
#
# Capture assertions for the happy-path fixture (gate G2: one command produces
# a local run store). Runs inside the dev kfc environment (needs pykungfu).
#
# Usage: check_capture.py <runtime-dir> <run-id>

# ruff: noqa: E402

import hashlib
import json
import os
import sys

# Self-contained path bootstrap: the fixture runs outside the dev entry, so it
# wires the core python package and the built dist/kungfu (pykungfu) itself.
_core = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "framework", "core")
)
sys.path.insert(0, os.path.join(_core, "src", "python"))
sys.path.insert(0, os.path.join(_core, "dist", "kungfu"))

import kungfu

from kungfu.rewind import (
    ACTION_MODEL_REQUEST,
    ACTION_MODEL_RESPONSE,
    ACTION_RETRY_MARKER,
    ACTION_RUN_BEGIN,
    ACTION_RUN_END,
    ACTION_TOOL_CALL,
    ACTION_TOOL_RESULT,
    ACTION_TYPE_NAMES,
    CARRIER_REWIND_ACTION,
)
from kungfu.rewind.wire import unwrap_event
from kungfu.rewind.fb.CallStatus import CallStatus
from kungfu.rewind.fb.CaptureLayer import CaptureLayer
from kungfu.rewind.fb.ModelRequest import ModelRequest
from kungfu.rewind.fb.ModelResponse import ModelResponse
from kungfu.rewind.fb.RetryMarker import RetryMarker
from kungfu.rewind.fb.RunBegin import RunBegin
from kungfu.rewind.fb.RunEnd import RunEnd
from kungfu.rewind.fb.ToolCall import ToolCall
from kungfu.rewind.fb.ToolResult import ToolResult
from kungfu.storage import service as storage_service

schema = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime

runtime_dir, run_id = sys.argv[1], sys.argv[2]
failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


locator = yjj.locator(runtime_dir)
location = yjj.location(
    schema.enums.mode.LIVE, schema.enums.location_role.SYSTEM, "rewind", run_id, locator
)


def frames(action_type):
    result = []
    for header, payload in yjj.assemble(location, 0).read_bytes(CARRIER_REWIND_ACTION):
        event = unwrap_event(payload)
        if event is None:
            continue
        current_action_type, event_payload = event
        if current_action_type == action_type:
            result.append((header, event_payload))
    return result


begin_frames = frames(ACTION_RUN_BEGIN)
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

req_frames = frames(ACTION_MODEL_REQUEST)
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

resp_frames = frames(ACTION_MODEL_RESPONSE)
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

call_frames = frames(ACTION_TOOL_CALL)
check("two ToolCall frames (attempt + retry)", len(call_frames) == 2)
call_spans = []
for _, payload in call_frames:
    call = ToolCall.GetRootAs(bytes(payload), 0)
    call_spans.append((call.SpanId() or b"").decode())
    check("ToolCall.run_id matches", (call.RunId() or b"").decode() == run_id)
    check("ToolCall.layer == InProcessHook", call.Layer() == CaptureLayer.InProcessHook)
    check("ToolCall.tool_name == lookup", (call.ToolName() or b"").decode() == "lookup")
    check("ToolCall.input captured", "query" in (call.Input() or b"").decode())

result_frames = frames(ACTION_TOOL_RESULT)
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

retry_frames = frames(ACTION_RETRY_MARKER)
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

end_frames = frames(ACTION_RUN_END)
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
        "all rewind action_types bound",
        set(bindings.keys()) == set(ACTION_TYPE_NAMES),
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

episodes = storage_service.episode_list(runtime_dir, limit=0)
matching_episodes = [
    row
    for row in episodes.get("episodes", [])
    if row.get("open", {}).get("source") == f"rewind:{run_id}"
]
check("Episode created for traced run", len(matching_episodes) == 1)
if matching_episodes:
    episode = matching_episodes[0]
    check(
        "Episode status ended",
        episode.get("closed") is True and episode.get("close", {}).get("status") == 2,
    )
    check(
        "Episode actor is trace",
        episode.get("open", {}).get("actor") == "kungfu trace",
    )
    inspected = storage_service.episode_inspect(
        runtime_dir, episode_id=int(episode["episode_id"])
    )
    typed_episode = inspected["episode"]
    records = typed_episode.get("records", [])
    attached_gen_times = {
        records[index].get("body", {}).get("gen_time")
        for index in typed_episode.get("frame_indices", [])
        if 0 <= index < len(records)
    }
    expected_gen_times = {
        row[0].gen_time
        for rows in (
            begin_frames,
            req_frames,
            resp_frames,
            call_frames,
            result_frames,
            retry_frames,
            end_frames,
        )
        for row in rows
    }
    check(
        "Episode attached every run frame",
        attached_gen_times == expected_gen_times,
    )
    check("Episode has payload refs", len(typed_episode.get("ref_indices", [])) >= 1)
    fsck = storage_service.fsck(runtime_dir, episode_id=int(episode["episode_id"]))
    check("Episode fsck ok", fsck.get("ok") is True, str(fsck.get("errors", [])))
    exported = storage_service.build_export_bundle(
        runtime_dir, episode_id=int(episode["episode_id"])
    )
    check("Episode export bundle ok", exported.get("scope") == "episode")
    check(
        "Episode export has frames",
        exported.get("frame_count") == len(expected_gen_times),
    )

if failures:
    print(f"capture check failed: {failures}")
    sys.exit(1)
print("capture check passed")
