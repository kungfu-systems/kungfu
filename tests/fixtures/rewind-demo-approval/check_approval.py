# SPDX-License-Identifier: Apache-2.0
#
# Assertions for the approval bridge (msg_type 30009). Proves that a human
# control decision on a managed run becomes a journal fact AND yields the right
# process control action, without a real terminal or the native journal writer.
#
# It asserts:
#   1. apply_decision records an ApprovalDecision event with the decision label
#      and context (run_id, request_id, surface, decided_by, detail, reason);
#   2. each decision maps to the correct control action — Interrupt to a SIGINT
#      signal, Approve/Deny/Resume to input the session driver writes;
#   3. response strings are caller-overridable (providers differ);
#   4. the pinned rewind_events.bfbs carries the ApprovalDecision shape, so the
#      fact decodes from a bundle by reflection alone;
#   5. the msg_type is registered and SCHEMA_VERSION bumped.
#
# Needs flatbuffers (run under `uv run --frozen python`), not pykungfu: it stubs
# only the top-level kungfu package, like the cost-wire fixture.
#
# Usage: check_approval.py <fixture-dir>

import os
import sys
import types

fixture_dir = (
    sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
)
core_src = os.path.abspath(
    os.path.join(fixture_dir, "..", "..", "..", "framework", "core", "src", "python")
)
sys.path.insert(0, core_src)

if "kungfu" not in sys.modules:
    _m = types.ModuleType("kungfu")
    _m.__path__ = [os.path.join(core_src, "kungfu")]
    _m.schema_data_path = lambda module_file, name: os.path.join(
        os.path.dirname(module_file), name
    )
    sys.modules["kungfu"] = _m

from kungfu.rewind import (  # noqa: E402
    MSG_APPROVAL_DECISION,
    MSG_TYPE_NAMES,
    SCHEMA_VERSION,
    approvals,
    bundle,
    reflection_fb,
)
from kungfu.rewind.fb.ApprovalDecision import ApprovalDecision as FbApproval  # noqa: E402
from kungfu.rewind.fb.Decision import Decision  # noqa: E402

failures = []


def check(name, ok, detail=""):
    if not ok:
        failures.append(name + (f" ({detail})" if detail else ""))


def sink():
    events = []

    def emit(msg_type, data):
        events.append((msg_type, bytes(data)))

    return emit, events


def only(events):
    assert len(events) == 1, f"expected 1 event, got {len(events)}"
    msg_type, payload = events[0]
    assert msg_type == MSG_APPROVAL_DECISION
    return FbApproval.GetRootAs(payload, 0)


# --- registration and version -----------------------------------------------
check(
    "MSG_APPROVAL_DECISION is 30009",
    MSG_APPROVAL_DECISION == 30009,
    str(MSG_APPROVAL_DECISION),
)
check(
    "30009 registered as ApprovalDecision",
    MSG_TYPE_NAMES.get(MSG_APPROVAL_DECISION) == "ApprovalDecision",
)
check("SCHEMA_VERSION bumped to 3", SCHEMA_VERSION == 3, str(SCHEMA_VERSION))

# --- Approve: fact recorded + input action ----------------------------------
emit, events = sink()
action = approvals.apply_decision(
    emit,
    "run-1",
    Decision.Approve,
    request_id="req-7",
    detail="rm -rf build/",
    decided_by="user",
)
ev = only(events)
check("approve run_id", ev.RunId() == b"run-1")
check("approve request_id", ev.RequestId() == b"req-7")
check("approve decision label", ev.Decision() == Decision.Approve)
check("approve surface default", ev.Surface() == b"kungfu_gui")
check("approve decided_by", ev.DecidedBy() == b"user")
check("approve detail", ev.Detail() == b"rm -rf build/")
check(
    "approve action is input y",
    action.kind == "input" and action.data == "y\n",
    repr(action),
)

# --- Deny: fact + deny input, reason carried --------------------------------
emit, events = sink()
action = approvals.apply_decision(
    emit, "run-1", Decision.Deny, reason="destructive path"
)
ev = only(events)
check("deny decision label", ev.Decision() == Decision.Deny)
check("deny reason", ev.Reason() == b"destructive path")
check("deny action is input n", action.kind == "input" and action.data == "n\n")

# --- Interrupt: fact + SIGINT signal, not input -----------------------------
emit, events = sink()
action = approvals.apply_decision(emit, "run-1", Decision.Interrupt)
ev = only(events)
check("interrupt decision label", ev.Decision() == Decision.Interrupt)
check(
    "interrupt action is SIGINT signal",
    action.kind == "signal" and action.signal == "SIGINT",
    repr(action),
)

# --- Resume: fact + optional follow-up input --------------------------------
emit, events = sink()
action = approvals.apply_decision(
    emit, "run-1", Decision.Resume, resume_input="continue\n"
)
ev = only(events)
check("resume decision label", ev.Decision() == Decision.Resume)
check(
    "resume action carries follow-up input",
    action.kind == "input" and action.data == "continue\n",
)

emit, events = sink()
action = approvals.apply_decision(emit, "run-1", Decision.Resume)
check("resume default input is empty", action.kind == "input" and action.data == "")

# --- provider-specific override ---------------------------------------------
emit, events = sink()
action = approvals.apply_decision(emit, "run-1", Decision.Approve, approve_input="1\n")
check("approve input override", action.data == "1\n")

# --- unknown decision is a hard error ---------------------------------------
try:
    approvals.apply_decision(lambda *a: None, "run-1", 99)
    check("unknown decision raises", False, "no error")
except ValueError:
    check("unknown decision raises", True)

# --- moat: the pinned bfbs carries the ApprovalDecision shape ---------------
blob = bundle.read_schema_blob()
schema = reflection_fb.Schema.GetRootAs(blob, 0)
objects = {
    schema.Objects(i).Name().decode(): schema.Objects(i)
    for i in range(schema.ObjectsLength())
}
obj = objects.get("kungfu.rewind.fb.ApprovalDecision")
check("bfbs carries ApprovalDecision table", obj is not None)
if obj is not None:
    field_names = {obj.Fields(i).Name().decode() for i in range(obj.FieldsLength())}
    for required in (
        "run_id",
        "request_id",
        "decision",
        "surface",
        "decided_by",
        "detail",
        "reason",
    ):
        check(f"bfbs ApprovalDecision.{required}", required in field_names)

# --- bundle binds 30009 at version 3 ----------------------------------------
import json  # noqa: E402
import tempfile  # noqa: E402

bundle_dir = tempfile.mkdtemp(prefix="approval-")
manifest_path = bundle.emit(
    bundle_dir,
    "/fake/journal/root",
    {
        "mode": "LIVE",
        "category": "SYSTEM",
        "group": "rewind",
        "name": "run-1",
        "dest": 0,
    },
)
with open(manifest_path) as f:
    manifest = json.load(f)
binding = manifest.get("schema_bindings", {}).get(str(MSG_APPROVAL_DECISION), {})
check(
    "manifest binds 30009 -> ApprovalDecision",
    binding.get("name") == "ApprovalDecision",
)
check("manifest binding schema_version 3", binding.get("schema_version") == 3)

if failures:
    print(f"approval check failed: {failures}")
    sys.exit(1)
print("approval check passed")
