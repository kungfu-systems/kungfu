#  SPDX-License-Identifier: Apache-2.0
#
# kungfu.work — the default work profile (work items over the journal).
#
# Native authority:
#   ../../../libkungfu/schemas/work_events.{fbs,bfbs}
#   libkungfu runtime/action/work_journal owns persistent bytes and replay.
#
# Compatibility projection:
#   fb/        flatc-generated historical readers/builders (do not edit)
#   events.py  independent Python replay implementation used by golden vectors
#   store.py   thin native client plus the compatibility fold

from kungfu.action_envelope import CARRIER_ACTION_ENVELOPE

CARRIER_WORK_ACTION = CARRIER_ACTION_ENVELOPE

ACTION_WORK_ITEM_CREATED = "work.item.created"
ACTION_WORK_STATUS_CHANGED = "work.status.changed"
ACTION_NEXT_ACTION_SET = "work.next_action.set"
ACTION_CHECKPOINT_RECORDED = "work.checkpoint.recorded"
ACTION_DECISION_RECORDED = "work.decision.recorded"
ACTION_VALIDATION_RECORDED = "work.validation.recorded"
ACTION_ARTIFACT_RECORDED = "work.artifact.recorded"
ACTION_RUN_LINKED = "work.run.linked"

# Event-model version marker carried in WorkItemCreated (belt and braces
# beside the store manifest's schema binding, which remains decode authority).
SCHEMA_VERSION = 1

ACTION_TYPE_NAMES = {
    ACTION_WORK_ITEM_CREATED: "WorkItemCreated",
    ACTION_WORK_STATUS_CHANGED: "WorkStatusChanged",
    ACTION_NEXT_ACTION_SET: "NextActionSet",
    ACTION_CHECKPOINT_RECORDED: "CheckpointRecorded",
    ACTION_DECISION_RECORDED: "DecisionRecorded",
    ACTION_VALIDATION_RECORDED: "ValidationRecorded",
    ACTION_ARTIFACT_RECORDED: "ArtifactRecorded",
    ACTION_RUN_LINKED: "RunLinked",
}

ACTION_SCHEMA_REFS = {
    action_type: {"id": f"kungfu.work.{name}", "version": SCHEMA_VERSION}
    for action_type, name in ACTION_TYPE_NAMES.items()
}
