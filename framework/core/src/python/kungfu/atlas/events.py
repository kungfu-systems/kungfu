#  SPDX-License-Identifier: Apache-2.0
#
# Serializers: python values -> FlatBuffers event bytes, ready for
# writer.write_bytes(...). One function per event table; string fields are
# optional throughout (the schema forbids `required`), so None simply omits
# the field.

import flatbuffers

from kungfu.atlas.fb import (
    GoalSnapshot,
    ImportBegin,
    ImportEnd,
    MarkerSnapshot,
    MissionSnapshot,
)


def _s(builder, value):
    return builder.CreateString(value) if value else None


def import_begin(import_id, repo_root, repo_head, schema_version):
    b = flatbuffers.Builder(256)
    import_id_o = _s(b, import_id)
    repo_root_o = _s(b, repo_root)
    repo_head_o = _s(b, repo_head)
    ImportBegin.Start(b)
    if import_id_o:
        ImportBegin.AddImportId(b, import_id_o)
    if repo_root_o:
        ImportBegin.AddRepoRoot(b, repo_root_o)
    if repo_head_o:
        ImportBegin.AddRepoHead(b, repo_head_o)
    ImportBegin.AddSchemaVersion(b, schema_version)
    b.Finish(ImportBegin.End(b))
    return bytes(b.Output())


def mission_snapshot(import_id, card):
    b = flatbuffers.Builder(512)
    offsets = {
        name: _s(b, card.get(name))
        for name in (
            "mission_id",
            "title",
            "status",
            "active_lens",
            "stage_name",
            "next_review",
            "next_action",
        )
    }
    import_id_o = _s(b, import_id)
    MissionSnapshot.Start(b)
    if import_id_o:
        MissionSnapshot.AddImportId(b, import_id_o)
    adders = {
        "mission_id": MissionSnapshot.AddMissionId,
        "title": MissionSnapshot.AddTitle,
        "status": MissionSnapshot.AddStatus,
        "active_lens": MissionSnapshot.AddActiveLens,
        "stage_name": MissionSnapshot.AddStageName,
        "next_review": MissionSnapshot.AddNextReview,
        "next_action": MissionSnapshot.AddNextAction,
    }
    for name, add in adders.items():
        if offsets[name]:
            add(b, offsets[name])
    b.Finish(MissionSnapshot.End(b))
    return bytes(b.Output())


_GOAL_STRING_FIELDS = (
    "goal_id",
    "status",
    "title",
    "owner_agent",
    "mission_id",
    "lens",
    "mission_stage",
    "source_branch",
    "worktree_path",
    "external_repo_path",
    "external_branch",
    "external_head",
    "external_ready_ref",
    "latest_marker",
    "summary",
    "next_action",
)


def goal_snapshot(import_id, card):
    b = flatbuffers.Builder(1024)
    offsets = {name: _s(b, card.get(name)) for name in _GOAL_STRING_FIELDS}
    import_id_o = _s(b, import_id)
    GoalSnapshot.Start(b)
    if import_id_o:
        GoalSnapshot.AddImportId(b, import_id_o)
    adders = {
        "goal_id": GoalSnapshot.AddGoalId,
        "status": GoalSnapshot.AddStatus,
        "title": GoalSnapshot.AddTitle,
        "owner_agent": GoalSnapshot.AddOwnerAgent,
        "mission_id": GoalSnapshot.AddMissionId,
        "lens": GoalSnapshot.AddLens,
        "mission_stage": GoalSnapshot.AddMissionStage,
        "source_branch": GoalSnapshot.AddSourceBranch,
        "worktree_path": GoalSnapshot.AddWorktreePath,
        "external_repo_path": GoalSnapshot.AddExternalRepoPath,
        "external_branch": GoalSnapshot.AddExternalBranch,
        "external_head": GoalSnapshot.AddExternalHead,
        "external_ready_ref": GoalSnapshot.AddExternalReadyRef,
        "latest_marker": GoalSnapshot.AddLatestMarker,
        "summary": GoalSnapshot.AddSummary,
        "next_action": GoalSnapshot.AddNextAction,
    }
    for name, add in adders.items():
        if offsets[name]:
            add(b, offsets[name])
    GoalSnapshot.AddArchived(b, bool(card.get("archived")))
    b.Finish(GoalSnapshot.End(b))
    return bytes(b.Output())


_MARKER_STRING_FIELDS = (
    "branch",
    "status",
    "ready_scope",
    "worktree_path",
    "summary",
    "risk",
    "marker_path",
)


def marker_snapshot(import_id, card):
    b = flatbuffers.Builder(1024)
    offsets = {name: _s(b, card.get(name)) for name in _MARKER_STRING_FIELDS}
    import_id_o = _s(b, import_id)
    MarkerSnapshot.Start(b)
    if import_id_o:
        MarkerSnapshot.AddImportId(b, import_id_o)
    adders = {
        "branch": MarkerSnapshot.AddBranch,
        "status": MarkerSnapshot.AddStatus,
        "ready_scope": MarkerSnapshot.AddReadyScope,
        "worktree_path": MarkerSnapshot.AddWorktreePath,
        "summary": MarkerSnapshot.AddSummary,
        "risk": MarkerSnapshot.AddRisk,
        "marker_path": MarkerSnapshot.AddMarkerPath,
    }
    for name, add in adders.items():
        if offsets[name]:
            add(b, offsets[name])
    MarkerSnapshot.AddReady(b, bool(card.get("ready")))
    MarkerSnapshot.AddKeepSourceWorktree(b, bool(card.get("keep_source_worktree")))
    b.Finish(MarkerSnapshot.End(b))
    return bytes(b.Output())


def import_end(import_id, missions, goals, markers, warnings):
    b = flatbuffers.Builder(128)
    import_id_o = _s(b, import_id)
    ImportEnd.Start(b)
    if import_id_o:
        ImportEnd.AddImportId(b, import_id_o)
    ImportEnd.AddMissions(b, missions)
    ImportEnd.AddGoals(b, goals)
    ImportEnd.AddMarkers(b, markers)
    ImportEnd.AddWarnings(b, warnings)
    b.Finish(ImportEnd.End(b))
    return bytes(b.Output())
