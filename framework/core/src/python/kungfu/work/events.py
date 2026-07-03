#  SPDX-License-Identifier: Apache-2.0
#
# Serializers: python values -> FlatBuffers event bytes, ready for
# writer.write_bytes(...). One function per event table; string fields are
# optional throughout (the schema forbids `required`), so None simply omits
# the field.

import flatbuffers

from kungfu.work.fb import (
    ArtifactRecorded,
    CheckpointRecorded,
    DecisionRecorded,
    NextActionSet,
    RunLinked,
    ValidationRecorded,
    WorkItemCreated,
    WorkStatusChanged,
)


def _s(builder, value):
    return builder.CreateString(value) if value else None


def work_item_created(work_id, title, kind, summary, schema_version):
    b = flatbuffers.Builder(256)
    work_id_o = _s(b, work_id)
    title_o = _s(b, title)
    kind_o = _s(b, kind)
    summary_o = _s(b, summary)
    WorkItemCreated.Start(b)
    if work_id_o:
        WorkItemCreated.AddWorkId(b, work_id_o)
    if title_o:
        WorkItemCreated.AddTitle(b, title_o)
    if kind_o:
        WorkItemCreated.AddKind(b, kind_o)
    if summary_o:
        WorkItemCreated.AddSummary(b, summary_o)
    WorkItemCreated.AddSchemaVersion(b, schema_version)
    b.Finish(WorkItemCreated.End(b))
    return bytes(b.Output())


def work_status_changed(work_id, status, reason):
    b = flatbuffers.Builder(128)
    work_id_o = _s(b, work_id)
    reason_o = _s(b, reason)
    WorkStatusChanged.Start(b)
    if work_id_o:
        WorkStatusChanged.AddWorkId(b, work_id_o)
    WorkStatusChanged.AddStatus(b, status)
    if reason_o:
        WorkStatusChanged.AddReason(b, reason_o)
    b.Finish(WorkStatusChanged.End(b))
    return bytes(b.Output())


def next_action_set(work_id, next_action):
    b = flatbuffers.Builder(128)
    work_id_o = _s(b, work_id)
    next_action_o = _s(b, next_action)
    NextActionSet.Start(b)
    if work_id_o:
        NextActionSet.AddWorkId(b, work_id_o)
    if next_action_o:
        NextActionSet.AddNextAction(b, next_action_o)
    b.Finish(NextActionSet.End(b))
    return bytes(b.Output())


def checkpoint_recorded(work_id, note):
    b = flatbuffers.Builder(128)
    work_id_o = _s(b, work_id)
    note_o = _s(b, note)
    CheckpointRecorded.Start(b)
    if work_id_o:
        CheckpointRecorded.AddWorkId(b, work_id_o)
    if note_o:
        CheckpointRecorded.AddNote(b, note_o)
    b.Finish(CheckpointRecorded.End(b))
    return bytes(b.Output())


def decision_recorded(work_id, decision, decided_by):
    b = flatbuffers.Builder(128)
    work_id_o = _s(b, work_id)
    decision_o = _s(b, decision)
    decided_by_o = _s(b, decided_by)
    DecisionRecorded.Start(b)
    if work_id_o:
        DecisionRecorded.AddWorkId(b, work_id_o)
    if decision_o:
        DecisionRecorded.AddDecision(b, decision_o)
    if decided_by_o:
        DecisionRecorded.AddDecidedBy(b, decided_by_o)
    b.Finish(DecisionRecorded.End(b))
    return bytes(b.Output())


def validation_recorded(work_id, result, command, note):
    b = flatbuffers.Builder(256)
    work_id_o = _s(b, work_id)
    command_o = _s(b, command)
    note_o = _s(b, note)
    ValidationRecorded.Start(b)
    if work_id_o:
        ValidationRecorded.AddWorkId(b, work_id_o)
    ValidationRecorded.AddResult(b, result)
    if command_o:
        ValidationRecorded.AddCommand(b, command_o)
    if note_o:
        ValidationRecorded.AddNote(b, note_o)
    b.Finish(ValidationRecorded.End(b))
    return bytes(b.Output())


def artifact_recorded(work_id, ref, kind):
    b = flatbuffers.Builder(128)
    work_id_o = _s(b, work_id)
    ref_o = _s(b, ref)
    kind_o = _s(b, kind)
    ArtifactRecorded.Start(b)
    if work_id_o:
        ArtifactRecorded.AddWorkId(b, work_id_o)
    if ref_o:
        ArtifactRecorded.AddRef(b, ref_o)
    if kind_o:
        ArtifactRecorded.AddKind(b, kind_o)
    b.Finish(ArtifactRecorded.End(b))
    return bytes(b.Output())


def run_linked(work_id, run_id):
    b = flatbuffers.Builder(128)
    work_id_o = _s(b, work_id)
    run_id_o = _s(b, run_id)
    RunLinked.Start(b)
    if work_id_o:
        RunLinked.AddWorkId(b, work_id_o)
    if run_id_o:
        RunLinked.AddRunId(b, run_id_o)
    b.Finish(RunLinked.End(b))
    return bytes(b.Output())
