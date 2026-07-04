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

# Open-layer msg_type allocation — docs/msg-type-ranges.md, 30001-30099.
MSG_RUN_BEGIN = 30001
MSG_RUN_END = 30002
MSG_MODEL_REQUEST = 30003
MSG_MODEL_RESPONSE = 30004
MSG_TOOL_CALL = 30005
MSG_TOOL_RESULT = 30006
MSG_RETRY_MARKER = 30007
MSG_COST_SNAPSHOT = 30008

# Event-model version marker carried in RunBegin (belt and braces beside the
# bundle's schema binding, which remains the decode authority). Bumped 1->2 when
# CostSnapshot (msg_type 30008) was appended — an additive change: existing
# tables are untouched and old runs still decode through their own pinned blob.
SCHEMA_VERSION = 2

MSG_TYPE_NAMES = {
    MSG_RUN_BEGIN: "RunBegin",
    MSG_RUN_END: "RunEnd",
    MSG_MODEL_REQUEST: "ModelRequest",
    MSG_MODEL_RESPONSE: "ModelResponse",
    MSG_TOOL_CALL: "ToolCall",
    MSG_TOOL_RESULT: "ToolResult",
    MSG_RETRY_MARKER: "RetryMarker",
    MSG_COST_SNAPSHOT: "CostSnapshot",
}
