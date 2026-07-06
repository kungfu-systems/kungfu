# SPDX-License-Identifier: Apache-2.0

import os
import sys

import kungfu
from kungfu.rewind import MSG_APPROVAL_DECISION, MSG_COST_SNAPSHOT
from kungfu.rewind.fb.ApprovalDecision import ApprovalDecision
from kungfu.rewind.fb.Attribution import Attribution
from kungfu.rewind.fb.CostSnapshot import CostSnapshot
from kungfu.rewind.fb.Decision import Decision
from kungfu.work import store as work_store

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

home, run_id, work_id = sys.argv[1:4]
failures = []


def check(name, ok, detail=""):
    if not ok:
        failures.append(name + (f" ({detail})" if detail else ""))


items = work_store.load(home)
entry = items.get(work_id)
check("work item exists", entry is not None)
if entry:
    linked = [row["run_id"] for row in entry["runs"]]
    check("reported run linked to work", run_id in linked, str(linked))

loc = yjj.location(
    lf.enums.mode.LIVE,
    lf.enums.category.SYSTEM,
    "rewind",
    run_id,
    yjj.locator(home),
)


def frames(msg_type):
    return [
        bytes(payload) for _header, payload in yjj.assemble(loc, 0).read_bytes(msg_type)
    ]


cost_frames = frames(MSG_COST_SNAPSHOT)
check("one CostSnapshot frame", len(cost_frames) == 1, str(len(cost_frames)))
if cost_frames:
    cost = CostSnapshot.GetRootAs(cost_frames[0], 0)
    check("cost run_id", cost.RunId() == run_id.encode())
    check("cost work_id", cost.WorkId() == work_id.encode())
    check("cost provider", cost.Provider() == b"codex")
    check("cost attribution manual", cost.Attribution() == Attribution.ManualEstimate)
    check("cost usd known", cost.CostUsdKnown())
    check("cost input tokens", cost.InputTokens() == 123)
    check("cost output tokens", cost.OutputTokens() == 45)
    check("manual estimate ambiguous", cost.AmbiguousAttribution())

approval_frames = frames(MSG_APPROVAL_DECISION)
check(
    "one ApprovalDecision frame",
    len(approval_frames) == 1,
    str(len(approval_frames)),
)
if approval_frames:
    approval = ApprovalDecision.GetRootAs(approval_frames[0], 0)
    check("approval run_id", approval.RunId() == run_id.encode())
    check("approval decision", approval.Decision() == Decision.Approve)
    check("approval request_id", approval.RequestId() == b"req-1")
    check("approval reason", approval.Reason() == b"human approved")

manifest = os.path.join(home, "rewind", run_id, "bundle", "manifest.json")
events = os.path.join(home, "rewind", run_id, "bundle", "report-events.jsonl")
check("manifest exists", os.path.exists(manifest))
check("reported event file exists", os.path.exists(events))

if failures:
    print("\n".join(f"- {failure}" for failure in failures), file=sys.stderr)
    sys.exit(1)

print("ok report bridge")
