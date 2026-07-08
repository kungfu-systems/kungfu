# SPDX-License-Identifier: Apache-2.0
#
# Model-drift assertions (gate G6/D3): the drift must be visible as recorded
# semantics — the model node's response names a tool that does not exist, and
# the step right after it fails on exactly that name. Log files show only the
# KeyError; the trace shows where the wrongness began.
#
# Usage: check_capture.py <runtime-dir> <run-id>

# ruff: noqa: E402

import os
import sys

_core = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "framework", "core")
)
sys.path.insert(0, os.path.join(_core, "src", "python"))
sys.path.insert(0, os.path.join(_core, "dist", "kungfu"))

import kungfu

from kungfu.rewind import (
    ACTION_MODEL_RESPONSE,
    ACTION_RUN_END,
    ACTION_TOOL_CALL,
    ACTION_TOOL_RESULT,
    CARRIER_REWIND_ACTION,
)
from kungfu.rewind.wire import unwrap_event
from kungfu.rewind.fb.CallStatus import CallStatus
from kungfu.rewind.fb.ModelResponse import ModelResponse
from kungfu.rewind.fb.RunEnd import RunEnd
from kungfu.rewind.fb.RunStatus import RunStatus
from kungfu.rewind.fb.ToolCall import ToolCall
from kungfu.rewind.fb.ToolResult import ToolResult

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


def read(action_type):
    result = []
    for header, payload in yjj.assemble(location, 0).read_bytes(CARRIER_REWIND_ACTION):
        event = unwrap_event(payload)
        if event is None:
            continue
        current_action_type, event_payload = event
        if current_action_type == action_type:
            result.append((header, event_payload))
    return result


responses = read(ACTION_MODEL_RESPONSE)
check("model response present", len(responses) == 1)
drift_time = None
if responses:
    header, payload = responses[0]
    resp = ModelResponse.GetRootAs(bytes(payload), 0)
    body = (resp.ResponseBody() or b"").decode()
    check("drift visible in model output (web-search)", "web-search" in body)
    check("model itself reported no error", resp.Status() == CallStatus.Ok)
    drift_time = header.gen_time

calls = read(ACTION_TOOL_CALL)
check("routing step captured", len(calls) == 1)
if calls:
    header, payload = calls[0]
    call = ToolCall.GetRootAs(bytes(payload), 0)
    check(
        "router received the drifted selection",
        "web-search" in (call.Input() or b"").decode(),
    )
    if drift_time is not None:
        check(
            "consequence follows the drift on the timeline",
            header.gen_time > drift_time,
        )

results = read(ACTION_TOOL_RESULT)
check("routing result captured", len(results) == 1)
if results:
    result = ToolResult.GetRootAs(bytes(results[0][1]), 0)
    check("routing failed", result.Status() == CallStatus.Error)
    error = (result.Error() or b"").decode()
    check("failure names the drifted tool", "web-search" in error)
    check("failure lists what was actually available", "lookup" in error)

ends = read(ACTION_RUN_END)
check(
    "run failed with exit 1",
    len(ends) == 1
    and RunEnd.GetRootAs(bytes(ends[0][1]), 0).ExitCode() == 1
    and RunEnd.GetRootAs(bytes(ends[0][1]), 0).Status() == RunStatus.Failed,
)

if failures:
    print(f"model-drift check failed: {failures}")
    sys.exit(1)
print("model-drift check passed")
