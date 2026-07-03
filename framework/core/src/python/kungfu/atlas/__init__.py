#  SPDX-License-Identifier: Apache-2.0
#
# kungfu.atlas — the Atlas control-plane import profile (read-only slice).
#
# Layout:
#   atlas_events.fbs   the event contract (welded surface atlas-import-schema)
#   atlas_events.bfbs  reflection schema, checked in; regenerate with
#                      `flatc -b --schema` whenever the .fbs changes
#   fb/                flatc --python generated accessors/builders (do not edit)
#   events.py          serializers: python values -> FlatBuffers event bytes
#   importer.py        read-only reader over an Atlas-style control-plane repo
#   store.py           the import store: journal appends and the projection
#                      folding the latest completed import batch
#
# Authority boundary: the source repository's files remain the source of
# truth. This profile imports snapshots into a local journal so Kungfu can
# display and query them; it never writes back to the source repository.

# Open-layer msg_type allocation — docs/msg-type-ranges.md, 30201-30299.
MSG_IMPORT_BEGIN = 30201
MSG_MISSION_SNAPSHOT = 30202
MSG_GOAL_SNAPSHOT = 30203
MSG_MARKER_SNAPSHOT = 30204
MSG_IMPORT_END = 30205

# Event-model version marker carried in ImportBegin (belt and braces beside
# the store manifest's schema binding, which remains decode authority).
SCHEMA_VERSION = 1

MSG_TYPE_NAMES = {
    MSG_IMPORT_BEGIN: "ImportBegin",
    MSG_MISSION_SNAPSHOT: "MissionSnapshot",
    MSG_GOAL_SNAPSHOT: "GoalSnapshot",
    MSG_MARKER_SNAPSHOT: "MarkerSnapshot",
    MSG_IMPORT_END: "ImportEnd",
}
