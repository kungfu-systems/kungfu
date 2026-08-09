#  SPDX-License-Identifier: Apache-2.0
#
# kungfu.atlas — the Atlas control-plane import profile (read-only slice).
#
# Layout:
#   importer.py        read-only reader over an Atlas-style control-plane repo
#   payloads.py        blob payload store + action envelope helpers
#   store.py           the import store: journal appends and the projection
#                      folding the latest completed import batch
#
# Authority boundary: the source repository's files remain the source of
# truth. This profile imports snapshots into a local journal so Kungfu can
# display and query them; it never writes back to the source repository.

# v4 carrier allocation: the journal header keeps one generic carrier and
# Atlas business semantics live in the FlatBuffers action envelope's
# action_type/schema metadata. Do not allocate one carrier per business event.
from kungfu.action_envelope import CARRIER_ACTION_ENVELOPE

CARRIER_ATLAS_ACTION = CARRIER_ACTION_ENVELOPE

ACTION_IMPORT_BEGIN = "atlas.import.begin"
ACTION_MISSION_SNAPSHOT = "atlas.mission.snapshot"
ACTION_GOAL_SNAPSHOT = "atlas.goal.snapshot"
ACTION_MARKER_SNAPSHOT = "atlas.marker.snapshot"
ACTION_IMPORT_END = "atlas.import.end"

# Event-model version marker carried in ImportBegin (belt and braces beside
# the store manifest's schema binding, which remains decode authority).
SCHEMA_VERSION = 1

CARRIER_TYPE_NAMES = {
    CARRIER_ATLAS_ACTION: "ActionEnvelope",
}

ACTION_TYPE_NAMES = {
    ACTION_IMPORT_BEGIN: "ImportBegin",
    ACTION_MISSION_SNAPSHOT: "MissionSnapshot",
    ACTION_GOAL_SNAPSHOT: "GoalSnapshot",
    ACTION_MARKER_SNAPSHOT: "MarkerSnapshot",
    ACTION_IMPORT_END: "ImportEnd",
}
