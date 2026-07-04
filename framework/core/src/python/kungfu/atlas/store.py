#  SPDX-License-Identifier: Apache-2.0
#
# The import store: one journal for Atlas control-plane snapshots, short-lived
# single-writer batches, and the projection folding the latest completed
# import. Same construction as the work store — standalone single writer,
# content-addressed schema manifest, state lives only in the fold.

import hashlib
import json
import os
import uuid

import kungfu

from kungfu.atlas import (
    MSG_GOAL_SNAPSHOT,
    MSG_IMPORT_BEGIN,
    MSG_IMPORT_END,
    MSG_MARKER_SNAPSHOT,
    MSG_MISSION_SNAPSHOT,
    MSG_TYPE_NAMES,
    SCHEMA_VERSION,
    events,
    importer,
)
from kungfu.atlas.fb.GoalSnapshot import GoalSnapshot
from kungfu.atlas.fb.ImportBegin import ImportBegin
from kungfu.atlas.fb.ImportEnd import ImportEnd
from kungfu.atlas.fb.MarkerSnapshot import MarkerSnapshot
from kungfu.atlas.fb.MissionSnapshot import MissionSnapshot

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

PUBLIC_DEST = 0
ATLAS_GROUP = "atlas"
ATLAS_NAME = "import"

_BFBS_FILE = __import__("kungfu").schema_data_path(__file__, "atlas_events.bfbs")


def _location(runtime_dir):
    locator = yjj.locator(runtime_dir)
    return yjj.location(
        lf.enums.mode.LIVE,
        lf.enums.category.SYSTEM,
        ATLAS_GROUP,
        ATLAS_NAME,
        locator,
    )


def _text(value):
    return value.decode() if value is not None else None


class ImportStore:
    """Append side. One instance = one short-lived writer = one batch."""

    def __init__(self, runtime_dir):
        self.runtime_dir = runtime_dir
        self.location = _location(runtime_dir)
        # keep every piece alive on self — the writer borrows them without
        # owning their lifetime (same as the work store)
        self.publisher = yjj.noop_publisher()
        self.bus = yjj.bus(False)
        self.writer = yjj.writer(
            self.location, PUBLIC_DEST, True, self.publisher, False, self.bus, 0
        )

    def _append(self, msg_type, data):
        # the binding takes the payload as a byte sequence (list[int])
        self.writer.write_bytes(0, msg_type, list(data), len(data))

    def run_import(self, repo_root):
        """Import one snapshot batch from repo_root. Returns a result dict."""
        repo_root = os.path.abspath(repo_root)
        import_id = "imp" + uuid.uuid4().hex[:8]
        missions, goals, markers, warnings = importer.read_control_plane(repo_root)
        self._append(
            MSG_IMPORT_BEGIN,
            events.import_begin(
                import_id,
                repo_root,
                importer.repo_head(repo_root),
                SCHEMA_VERSION,
            ),
        )
        for card in missions:
            self._append(MSG_MISSION_SNAPSHOT, events.mission_snapshot(import_id, card))
        for card in goals:
            self._append(MSG_GOAL_SNAPSHOT, events.goal_snapshot(import_id, card))
        for card in markers:
            self._append(MSG_MARKER_SNAPSHOT, events.marker_snapshot(import_id, card))
        self._append(
            MSG_IMPORT_END,
            events.import_end(
                import_id, len(missions), len(goals), len(markers), len(warnings)
            ),
        )
        self.emit_manifest()
        return {
            "import_id": import_id,
            "repo_root": repo_root,
            "missions": len(missions),
            "goals": len(goals),
            "markers": len(markers),
            "warnings": warnings,
        }

    def store_dir(self):
        return os.path.join(self.runtime_dir, "atlas", "store")

    def emit_manifest(self):
        """Pin the store's schema bindings (content-addressed .bfbs + manifest)."""
        with open(_BFBS_FILE, "rb") as f:
            blob = f.read()
        schema_hash = hashlib.sha256(blob).hexdigest()

        schemas_dir = os.path.join(self.store_dir(), "schemas")
        os.makedirs(schemas_dir, exist_ok=True)
        blob_path = os.path.join(schemas_dir, schema_hash + ".bfbs")
        if not os.path.exists(blob_path):
            with open(blob_path, "wb") as f:
                f.write(blob)

        manifest = {
            "spec_version": "0.1",
            "source": {
                "root": self.runtime_dir,
                "mode": "live",
                "category": "system",
                "group": ATLAS_GROUP,
                "name": ATLAS_NAME,
                "dest": PUBLIC_DEST,
            },
            "hash_algorithm": "sha256",
            "schema_bindings": {
                str(msg_type): {
                    "schema_kind": "flatbuffers",
                    "name": name,
                    "schema_version": SCHEMA_VERSION,
                    "schema_hash": schema_hash,
                }
                for msg_type, name in MSG_TYPE_NAMES.items()
            },
            "authority_boundary": "this store is a read-only projection of an "
            "external control-plane repository; that repository's files remain "
            "the source of truth",
        }
        manifest_path = os.path.join(self.store_dir(), "manifest.json")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2, sort_keys=True)
        return manifest_path


def read_frames(runtime_dir):
    """All import frames in gen_time order: (gen_time, msg_type, bytes)."""
    location = _location(runtime_dir)
    frames = []
    for msg_type in MSG_TYPE_NAMES:
        try:
            for header, payload in yjj.assemble(location, 0).read_bytes(msg_type):
                frames.append((header.gen_time, msg_type, bytes(payload)))
        except (RuntimeError, ValueError, FileNotFoundError):
            continue
    frames.sort(key=lambda f: f[0])
    return frames


def load(runtime_dir):
    """Fold the latest COMPLETED import batch into a projection dict.

    Returns {import_id, repo_root, repo_head, time, missions{}, goals{},
    markers{}} or None when no completed import exists.
    """
    batches = {}
    completed = []
    for gen_time, msg_type, payload in read_frames(runtime_dir):
        if msg_type == MSG_IMPORT_BEGIN:
            event = ImportBegin.GetRootAs(payload, 0)
            import_id = _text(event.ImportId())
            batches[import_id] = {
                "import_id": import_id,
                "repo_root": _text(event.RepoRoot()),
                "repo_head": _text(event.RepoHead()),
                "time": gen_time,
                "missions": {},
                "goals": {},
                "markers": {},
            }
        elif msg_type == MSG_MISSION_SNAPSHOT:
            event = MissionSnapshot.GetRootAs(payload, 0)
            batch = batches.get(_text(event.ImportId()))
            if batch is not None:
                card = {
                    "mission_id": _text(event.MissionId()),
                    "title": _text(event.Title()),
                    "status": _text(event.Status()),
                    "active_lens": _text(event.ActiveLens()),
                    "stage_name": _text(event.StageName()),
                    "next_review": _text(event.NextReview()),
                    "next_action": _text(event.NextAction()),
                }
                batch["missions"][card["mission_id"]] = card
        elif msg_type == MSG_GOAL_SNAPSHOT:
            event = GoalSnapshot.GetRootAs(payload, 0)
            batch = batches.get(_text(event.ImportId()))
            if batch is not None:
                card = {
                    "goal_id": _text(event.GoalId()),
                    "status": _text(event.Status()),
                    "title": _text(event.Title()),
                    "owner_agent": _text(event.OwnerAgent()),
                    "mission_id": _text(event.MissionId()),
                    "lens": _text(event.Lens()),
                    "mission_stage": _text(event.MissionStage()),
                    "source_branch": _text(event.SourceBranch()),
                    "worktree_path": _text(event.WorktreePath()),
                    "external_repo_path": _text(event.ExternalRepoPath()),
                    "external_branch": _text(event.ExternalBranch()),
                    "external_head": _text(event.ExternalHead()),
                    "external_ready_ref": _text(event.ExternalReadyRef()),
                    "latest_marker": _text(event.LatestMarker()),
                    "summary": _text(event.Summary()),
                    "next_action": _text(event.NextAction()),
                    "archived": bool(event.Archived()),
                }
                batch["goals"][card["goal_id"]] = card
        elif msg_type == MSG_MARKER_SNAPSHOT:
            event = MarkerSnapshot.GetRootAs(payload, 0)
            batch = batches.get(_text(event.ImportId()))
            if batch is not None:
                card = {
                    "branch": _text(event.Branch()),
                    "status": _text(event.Status()),
                    "ready": bool(event.Ready()),
                    "ready_scope": _text(event.ReadyScope()),
                    "keep_source_worktree": bool(event.KeepSourceWorktree()),
                    "worktree_path": _text(event.WorktreePath()),
                    "summary": _text(event.Summary()),
                    "risk": _text(event.Risk()),
                    "marker_path": _text(event.MarkerPath()),
                }
                batch["markers"][card["branch"]] = card
        elif msg_type == MSG_IMPORT_END:
            event = ImportEnd.GetRootAs(payload, 0)
            import_id = _text(event.ImportId())
            if import_id in batches:
                completed.append((gen_time, import_id))
    if not completed:
        return None
    completed.sort(key=lambda entry: entry[0])
    return batches[completed[-1][1]]
