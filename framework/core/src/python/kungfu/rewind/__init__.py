#  SPDX-License-Identifier: Apache-2.0
#
# kungfu.rewind — the Kungfu Rewind capture layer.
#
# Layout:
#   rewind_events.fbs   the event contract (welded surface rewind-event-schema)
#   rewind_events.bfbs  reflection schema, checked in; regenerate with
#                       `flatc -b --schema --bfbs-filenames . -o . rewind_events.fbs`
#                       (the `--bfbs-filenames .` keeps the `//rewind_events.fbs`
#                       decl path stable so the blob only changes on real edits)
#   fb/                 flatc --python generated accessors/builders (do not edit).
#                       Regenerate to a scratch dir and copy only fb/*.py back:
#                       `flatc --python -o "$tmp" rewind_events.fbs` then copy
#                       "$tmp/kungfu/rewind/fb/*.py" here. Never `-o ../../` in
#                       place: flatc writes empty namespace __init__.py files and
#                       would clobber this module and kungfu/__init__.py.
#   events.py           serializers: python values -> FlatBuffers event bytes
#   bundle.py           bundle format pieces: content-addressed schema blob +
#                       run manifest with per-run schema bindings
#   supervisor.py       the `kungfu trace` supervisor (single journal writer)

from kungfu.action_envelope import CARRIER_ACTION_ENVELOPE

CARRIER_REWIND_ACTION = CARRIER_ACTION_ENVELOPE

ACTION_RUN_BEGIN = "rewind.run.begin"
ACTION_RUN_END = "rewind.run.end"
ACTION_MODEL_REQUEST = "rewind.model.request"
ACTION_MODEL_RESPONSE = "rewind.model.response"
ACTION_TOOL_CALL = "rewind.tool.call"
ACTION_TOOL_RESULT = "rewind.tool.result"
ACTION_RETRY_MARKER = "rewind.retry.marker"
ACTION_COST_SNAPSHOT = "rewind.cost.snapshot"
ACTION_APPROVAL_DECISION = "rewind.approval.decision"

# Event-model version marker carried in RunBegin (belt and braces beside the
# bundle's schema binding, which remains the decode authority). Bumped on each
# additive append: 1->2 added CostSnapshot, 2->3 added ApprovalDecision.
# Existing tables are untouched and old runs still decode through their own
# pinned blob.
SCHEMA_VERSION = 3

ACTION_TYPE_NAMES = {
    ACTION_RUN_BEGIN: "RunBegin",
    ACTION_RUN_END: "RunEnd",
    ACTION_MODEL_REQUEST: "ModelRequest",
    ACTION_MODEL_RESPONSE: "ModelResponse",
    ACTION_TOOL_CALL: "ToolCall",
    ACTION_TOOL_RESULT: "ToolResult",
    ACTION_RETRY_MARKER: "RetryMarker",
    ACTION_COST_SNAPSHOT: "CostSnapshot",
    ACTION_APPROVAL_DECISION: "ApprovalDecision",
}

ACTION_SCHEMA_REFS = {
    action_type: {"id": f"kungfu.rewind.{name}", "version": SCHEMA_VERSION}
    for action_type, name in ACTION_TYPE_NAMES.items()
}

TABLE_ACTION_TYPES = {
    name: action_type for action_type, name in ACTION_TYPE_NAMES.items()
}
