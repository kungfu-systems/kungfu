#  SPDX-License-Identifier: Apache-2.0
#
# kungfu.work — the default work profile (work items over the journal).
#
# Layout:
#   work_events.fbs   the event contract (welded surface work-event-schema)
#   work_events.bfbs  reflection schema, checked in; regenerate with
#                     `flatc -b --schema` whenever the .fbs changes
#   fb/               flatc --python generated accessors/builders (do not edit)
#   events.py         serializers: python values -> FlatBuffers event bytes
#   store.py          the work store: single shared journal, appenders, and
#                     the projection that folds events into current items

# Open-layer msg_type allocation — docs/msg-type-ranges.md, 30101-30199.
MSG_WORK_ITEM_CREATED = 30101
MSG_WORK_STATUS_CHANGED = 30102
MSG_NEXT_ACTION_SET = 30103
MSG_CHECKPOINT_RECORDED = 30104
MSG_DECISION_RECORDED = 30105
MSG_VALIDATION_RECORDED = 30106
MSG_ARTIFACT_RECORDED = 30107
MSG_RUN_LINKED = 30108

# Event-model version marker carried in WorkItemCreated (belt and braces
# beside the store manifest's schema binding, which remains decode authority).
SCHEMA_VERSION = 1

MSG_TYPE_NAMES = {
    MSG_WORK_ITEM_CREATED: "WorkItemCreated",
    MSG_WORK_STATUS_CHANGED: "WorkStatusChanged",
    MSG_NEXT_ACTION_SET: "NextActionSet",
    MSG_CHECKPOINT_RECORDED: "CheckpointRecorded",
    MSG_DECISION_RECORDED: "DecisionRecorded",
    MSG_VALIDATION_RECORDED: "ValidationRecorded",
    MSG_ARTIFACT_RECORDED: "ArtifactRecorded",
    MSG_RUN_LINKED: "RunLinked",
}
