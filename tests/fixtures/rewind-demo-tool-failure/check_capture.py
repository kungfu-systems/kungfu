# SPDX-License-Identifier: Apache-2.0
#
# Tool-failure assertions (gate G6/D2): the failed step must be explicit in
# the record — an errored ToolResult carrying the actual error detail, a
# failed run status, and the tree marking the node.
#
# Usage: check_capture.py <runtime-dir> <run-id>

import os
import sys

_core = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "framework", "core")
)
sys.path.insert(0, os.path.join(_core, "src", "python"))
sys.path.insert(0, os.path.join(_core, "dist", "kfc"))

import kungfu

from kungfu.rewind import MSG_RUN_END, MSG_TOOL_CALL, MSG_TOOL_RESULT
from kungfu.rewind.fb.CallStatus import CallStatus
from kungfu.rewind.fb.RunEnd import RunEnd
from kungfu.rewind.fb.RunStatus import RunStatus
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


calls = read(MSG_TOOL_CALL)
check("exactly one tool call (no retry loop)", len(calls) == 1)
if calls:
    call = ToolCall.GetRootAs(bytes(calls[0][1]), 0)
    check("tool is lookup", (call.ToolName() or b"").decode() == "lookup")
    check("input captured", "query" in (call.Input() or b"").decode())

results = read(MSG_TOOL_RESULT)
check("exactly one tool result", len(results) == 1)
if results:
    result = ToolResult.GetRootAs(bytes(results[0][1]), 0)
    check("result is an error", result.Status() == CallStatus.Error)
    error = (result.Error() or b"").decode()
    check("error names the broken contract", "missing field 'answer'" in error)
    check("error carries the query", "the demo answer" in error)

ends = read(MSG_RUN_END)
check("RunEnd present", len(ends) == 1)
if ends:
    end = RunEnd.GetRootAs(bytes(ends[0][1]), 0)
    check("run failed", end.Status() == RunStatus.Failed)
    check("exit code 1", end.ExitCode() == 1)

if failures:
    print(f"tool-failure check failed: {failures}")
    sys.exit(1)
print("tool-failure check passed")
