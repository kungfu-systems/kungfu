#  SPDX-License-Identifier: Apache-2.0
#
# kungfu.rewind — the Kungfu Rewind capture layer.
#
# Layout:
#   rewind_events.fbs   the event contract (welded surface rewind-event-schema)
#   rewind_events.bfbs  reflection schema, checked in; regenerate with
#                       `flatc -b --schema` whenever the .fbs changes
#   fb/                 flatc --python generated accessors/builders (do not edit)
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

# Event-model version marker carried in RunBegin (belt and braces beside the
# bundle's schema binding, which remains the decode authority).
SCHEMA_VERSION = 1

MSG_TYPE_NAMES = {
    MSG_RUN_BEGIN: "RunBegin",
    MSG_RUN_END: "RunEnd",
    MSG_MODEL_REQUEST: "ModelRequest",
    MSG_MODEL_RESPONSE: "ModelResponse",
    MSG_TOOL_CALL: "ToolCall",
    MSG_TOOL_RESULT: "ToolResult",
    MSG_RETRY_MARKER: "RetryMarker",
}
