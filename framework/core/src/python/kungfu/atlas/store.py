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
    payloads,
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


def store_dir(runtime_dir):
    return os.path.join(runtime_dir, "atlas", "store")


def _text(value):
    return value.decode() if value is not None else None


class ImportStore:
    """Append side. One instance = one short-lived writer = one batch."""

    def __init__(self, runtime_dir):
        self.runtime_dir = runtime_dir
        self.recorder = yjj.action_recorder(
            runtime_dir, ATLAS_GROUP, ATLAS_NAME, PUBLIC_DEST, 0
        )

    def _append(self, msg_type, data):
        receipt = self.recorder.record_bytes(msg_type, data)
        return {
            "frame_uid": receipt.frame_uid,
            "trigger_frame_uid": receipt.trigger_frame_uid,
            "stream_id": receipt.stream_id,
            "gen_time": receipt.gen_time,
            "trigger_time": receipt.trigger_time,
            "msg_type": receipt.msg_type,
            "source": receipt.source,
            "initial_source": receipt.initial_source,
            "dest": receipt.dest,
            "data_length": receipt.data_length,
            "data_type": receipt.data_type,
            "journal_payload_hash": payloads.payload_hash(data),
        }

    def run_import(
        self,
        repo_root,
        *,
        storage_source_id="atlas",
        range_filter=None,
    ):
        """Import one snapshot batch from repo_root. Returns a result dict."""
        repo_root = os.path.abspath(repo_root)
        import_id = "imp" + uuid.uuid4().hex[:8]
        repo_head = importer.repo_head(repo_root)
        missions, goals, markers, source_records, warnings = (
            importer.read_control_plane_with_sources(repo_root, window=range_filter)
        )
        action_receipts = {}
        self._append(
            MSG_IMPORT_BEGIN,
            events.import_begin(
                import_id,
                repo_root,
                repo_head,
                SCHEMA_VERSION,
            ),
        )
        for card in missions:
            action_receipts[("mission", card["mission_id"])] = self._append(
                MSG_MISSION_SNAPSHOT, events.mission_snapshot(import_id, card)
            )
        for card in goals:
            action_receipts[("goal", card["goal_id"])] = self._append(
                MSG_GOAL_SNAPSHOT, events.goal_snapshot(import_id, card)
            )
        for card in markers:
            action_receipts[("marker", card["branch"])] = self._append(
                MSG_MARKER_SNAPSHOT, events.marker_snapshot(import_id, card)
            )
        self._append(
            MSG_IMPORT_END,
            events.import_end(
                import_id, len(missions), len(goals), len(markers), len(warnings)
            ),
        )
        payloads.write_import_payloads(
            self.store_dir(),
            import_id=import_id,
            repo_root=repo_root,
            repo_head=repo_head,
            source_records=source_records,
            counts={
                "missions": len(missions),
                "goals": len(goals),
                "markers": len(markers),
            },
            storage_source_id=storage_source_id,
            source_type="atlas",
            range_filter=range_filter,
            action_receipts=action_receipts,
        )
        self.emit_manifest()
        return {
            "import_id": import_id,
            "storage_source_id": storage_source_id,
            "source_type": "atlas",
            "repo_root": repo_root,
            "repo_head": repo_head,
            "source_head": repo_head,
            "range": payloads._serialize_range(range_filter),
            "missions": len(missions),
            "goals": len(goals),
            "markers": len(markers),
            "payloads": len(source_records),
            "warnings": warnings,
        }

    def store_dir(self):
        return store_dir(self.runtime_dir)

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


def _frame_data_type_value(header):
    value = getattr(header, "data_type", 0)
    try:
        return int(value)
    except (TypeError, ValueError):
        name = str(value).split(".")[-1].lower()
        return 0 if name == "raw" else str(value)


def read_action_frame_index(runtime_dir):
    """Action frame identity index keyed by (frame_uid, msg_type, gen_time)."""
    location = _location(runtime_dir)
    index = {}
    for msg_type in MSG_TYPE_NAMES:
        try:
            for header, frame_payload in yjj.assemble(location, 0).read_bytes(msg_type):
                data = bytes(frame_payload)
                index[(header.frame_uid, header.msg_type, header.gen_time)] = {
                    "frame_uid": header.frame_uid,
                    "trigger_frame_uid": header.trigger_frame_uid,
                    "stream_id": header.stream_id,
                    "gen_time": header.gen_time,
                    "trigger_time": header.trigger_time,
                    "msg_type": header.msg_type,
                    "source": header.source,
                    "initial_source": header.initial_source,
                    "dest": header.dest,
                    "data_length": len(data),
                    "data_type": _frame_data_type_value(header),
                    "journal_payload_hash": payloads.payload_hash(data),
                    "_payload": data,
                }
        except (RuntimeError, ValueError, FileNotFoundError):
            continue
    return index


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


def status(runtime_dir):
    projection = load(runtime_dir)
    manifest = payloads.load_latest_manifest(store_dir(runtime_dir))
    if manifest is None:
        return {
            "ok": False,
            "scope": "atlas",
            "reason": "no completed payload manifest",
        }
    return {
        "ok": projection is not None,
        "scope": "atlas",
        "import_id": manifest.get("import_id"),
        "storage_source_id": manifest.get("storage_source_id", "atlas"),
        "source_type": manifest.get("source_type", "atlas"),
        "range": manifest.get("range"),
        "repo_root": manifest.get("repo_root"),
        "repo_head": manifest.get("repo_head"),
        "source_head": manifest.get("source_head", manifest.get("repo_head")),
        "payloads": len(manifest.get("entries", [])),
        "missions": len(projection.get("missions", {})) if projection else 0,
        "goals": len(projection.get("goals", {})) if projection else 0,
        "markers": len(projection.get("markers", {})) if projection else 0,
    }


def fsck(runtime_dir):
    return payloads.fsck_import(
        store_dir(runtime_dir),
        load(runtime_dir),
        action_frames=read_action_frame_index(runtime_dir),
    )


def export_jsonl(
    runtime_dir,
    out_path,
    *,
    range_filter=None,
    storage_source_id=None,
):
    records = payloads.export_records(
        store_dir(runtime_dir),
        range_filter=range_filter,
        storage_source_id=storage_source_id,
    )
    payloads.write_jsonl(records, out_path)
    return {
        "ok": True,
        "scope": "atlas",
        "storage_source_id": storage_source_id,
        "range": payloads._serialize_range(range_filter),
        "format": "jsonl",
        "out": os.path.abspath(out_path),
        "records": len(records),
    }


def verify_against_repo(
    runtime_dir, repo_root, *, range_filter=None, storage_source_id=None
):
    repo_root = os.path.abspath(repo_root)
    _, _, _, source_records, warnings = importer.read_control_plane_with_sources(
        repo_root, window=range_filter
    )
    report = payloads.verify_against_source(
        store_dir(runtime_dir),
        source_records,
        storage_source_id=storage_source_id,
    )
    report["repo_root"] = repo_root
    report["repo_head"] = importer.repo_head(repo_root)
    report["storage_source_id"] = storage_source_id
    report["range"] = payloads._serialize_range(range_filter)
    report["warnings"] = warnings
    return report
