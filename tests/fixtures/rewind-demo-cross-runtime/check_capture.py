# SPDX-License-Identifier: Apache-2.0
#
# Cross-runtime single-journal assertions (gate G7, the machine-checkable half
# of G-Moat): python and node events from one traced run must land in ONE
# journal with a shared run id, a causal edge crossing the runtime boundary,
# and one nanosecond timeline — not two logs stitched offline. A generic
# baseline (per-runtime logs joined afterwards) cannot satisfy these facts.
#
# Usage: check_capture.py <runtime-dir> <run-id>

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
    MSG_RUN_BEGIN,
    MSG_RUN_END,
    MSG_TOOL_CALL,
    MSG_TOOL_RESULT,
)
from kungfu.rewind.fb.CallStatus import CallStatus
from kungfu.rewind.fb.ModelRequest import ModelRequest
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


def read(msg_type):
    return yjj.assemble(location, 0).read_bytes(msg_type)


# run bracket
begin = read(MSG_RUN_BEGIN)
end = read(MSG_RUN_END)
check("RunBegin/RunEnd present", len(begin) == 1 and len(end) == 1)
check(
    "run ids match",
    (RunBegin.GetRootAs(bytes(begin[0][1]), 0).RunId() or b"").decode() == run_id
    and (RunEnd.GetRootAs(bytes(end[0][1]), 0).RunId() or b"").decode() == run_id,
)

# one model call at the wire
reqs = read(MSG_MODEL_REQUEST)
check("ModelRequest present", len(reqs) == 1)

# tool calls: the python delegate and the node lookup — in the SAME journal
calls = {}
call_times = {}
for header, payload in read(MSG_TOOL_CALL):
    c = ToolCall.GetRootAs(bytes(payload), 0)
    name = (c.ToolName() or b"").decode()
    calls[name] = {
        "span": (c.SpanId() or b"").decode(),
        "parent": (c.ParentSpanId() or b"").decode(),
        "run_id": (c.RunId() or b"").decode(),
    }
    call_times[name] = header.gen_time

check("python delegate tool captured", "delegate" in calls)
check("node tool captured in same journal", "node-lookup" in calls)

if "delegate" in calls and "node-lookup" in calls:
    check(
        "shared run id across runtimes",
        calls["delegate"]["run_id"] == run_id
        and calls["node-lookup"]["run_id"] == run_id,
    )
    check(
        "cross-runtime causal edge (node parent == python span)",
        calls["node-lookup"]["parent"] == calls["delegate"]["span"]
        and calls["delegate"]["span"] != "",
        f"node.parent={calls['node-lookup']['parent'][:12]} py.span={calls['delegate']['span'][:12]}",
    )
    check(
        "single timeline orders the boundary (python call before node call)",
        call_times["delegate"] < call_times["node-lookup"],
    )

# results for both, ok, with latency
results = {}
for _, payload in read(MSG_TOOL_RESULT):
    r = ToolResult.GetRootAs(bytes(payload), 0)
    results[(r.SpanId() or b"").decode()] = (r.Status(), r.LatencyNs())
check(
    "both tool results present and ok",
    len(results) == 2
    and all(
        status == CallStatus.Ok and latency > 0 for status, latency in results.values()
    ),
)
if "delegate" in calls and "node-lookup" in calls:
    check(
        "results correlate to calls across runtimes",
        set(results) == {calls["delegate"]["span"], calls["node-lookup"]["span"]},
    )

# G-Moat counter-assertion: the whole causal chain lives in one location's
# frames (one store, one writer, natively re-readable) — nothing was stitched
all_msg_types = [
    MSG_RUN_BEGIN,
    MSG_MODEL_REQUEST,
    MSG_TOOL_CALL,
    MSG_TOOL_RESULT,
    MSG_RUN_END,
]
total = sum(len(read(t)) for t in all_msg_types)
check("entire chain in one journal location", total >= 7, f"{total} frames")

bundle_dir = os.path.join(runtime_dir, "rewind", run_id, "bundle")
check(
    "bundle manifest exists", os.path.exists(os.path.join(bundle_dir, "manifest.json"))
)

if failures:
    print(f"cross-runtime check failed: {failures}")
    sys.exit(1)
print("cross-runtime check passed")
