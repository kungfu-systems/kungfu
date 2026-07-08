#  SPDX-License-Identifier: Apache-2.0
#
# The import store: one journal for Atlas control-plane snapshots, short-lived
# single-writer batches, and the projection folding the latest completed
# import. Same construction as the work store — standalone single writer,
# content-addressed schema manifest, state lives only in the fold.

import json
import os
import uuid

import kungfu

from kungfu.atlas import (
    ACTION_GOAL_SNAPSHOT,
    ACTION_IMPORT_BEGIN,
    ACTION_IMPORT_END,
    ACTION_MARKER_SNAPSHOT,
    ACTION_MISSION_SNAPSHOT,
    MSG_ACTION_ENVELOPE,
    MSG_TYPE_NAMES,
    SCHEMA_VERSION,
    importer,
    payloads,
)

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

PUBLIC_DEST = 0
ATLAS_GROUP = "atlas"
ATLAS_NAME = "import"


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
    if value is None:
        return None
    text = value.decode() if isinstance(value, bytes) else str(value)
    text = text.strip()
    return text or None


def _journal_payload(envelope):
    return payloads.canonical_json_bytes(envelope)


class ImportStore:
    """Append side. One instance = one short-lived writer = one batch."""

    def __init__(self, runtime_dir):
        self.runtime_dir = runtime_dir
        self.recorder = yjj.action_recorder(
            runtime_dir, ATLAS_GROUP, ATLAS_NAME, PUBLIC_DEST, 0
        )

    def _append_envelope(self, envelope):
        data = _journal_payload(envelope)
        receipt = self.recorder.record_json(MSG_ACTION_ENVELOPE, data.decode("utf-8"))
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
        enriched_records = payloads.enrich_source_records(source_records)
        action_receipts = {}
        self._append_envelope(
            payloads.build_action_envelope(
                import_id=import_id,
                storage_source_id=storage_source_id,
                source_type="atlas",
                action_type=ACTION_IMPORT_BEGIN,
                batch={
                    "repo_root": repo_root,
                    "repo_head": repo_head,
                    "schema_version": SCHEMA_VERSION,
                },
            )
        )
        for entry in enriched_records:
            action_type = payloads.action_type_for_kind(str(entry.get("kind") or ""))
            receipt = self._append_envelope(
                payloads.build_action_envelope(
                    import_id=import_id,
                    storage_source_id=storage_source_id,
                    source_type="atlas",
                    action_type=action_type,
                    source={
                        "kind": entry.get("kind"),
                        "source_id": entry.get("source_id"),
                        "source_path": entry.get("source_path"),
                        "source_time": entry.get("source_time"),
                        "schema_version": entry.get("schema_version"),
                    },
                    payload={
                        "content_type": entry.get(
                            "content_type", payloads.CONTENT_TYPE_JSON
                        ),
                        "hash_algorithm": "sha256",
                        "hash": entry.get("payload_hash"),
                        "byte_len": entry.get("byte_len"),
                        "state": entry.get(
                            "payload_state", payloads.PAYLOAD_STATE_PRESENT
                        ),
                    },
                )
            )
            action_receipts[
                (str(entry.get("kind") or ""), str(entry.get("source_id") or ""))
            ] = receipt
        self._append_envelope(
            payloads.build_action_envelope(
                import_id=import_id,
                storage_source_id=storage_source_id,
                source_type="atlas",
                action_type=ACTION_IMPORT_END,
                batch={
                    "missions": len(missions),
                    "goals": len(goals),
                    "markers": len(markers),
                    "warnings": len(warnings),
                },
            )
        )
        payloads.write_import_payloads(
            self.store_dir(),
            import_id=import_id,
            repo_root=repo_root,
            repo_head=repo_head,
            source_records=enriched_records,
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
        """Pin this store's v4 action-envelope binding."""

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
                    "schema_kind": "json",
                    "name": name,
                    "schema": payloads.ACTION_ENVELOPE_SCHEMA,
                    "schema_version": 1,
                }
                for msg_type, name in MSG_TYPE_NAMES.items()
            },
            "msg_type_epoch": "v4",
            "semantic_dispatch": "action_type",
            "authority_boundary": "this store is a read-only projection of an "
            "external control-plane repository; that repository's files remain "
            "the source of truth",
        }
        manifest_path = os.path.join(self.store_dir(), "manifest.json")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2, sort_keys=True)
        return manifest_path


def _decode_action_envelope(data):
    raw = bytes(data).rstrip(b"\0")
    if not raw:
        return None
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return envelope if isinstance(envelope, dict) else None


def read_frames(runtime_dir):
    """All import action frames in gen_time order: (gen_time, action_type, envelope)."""
    location = _location(runtime_dir)
    frames = []
    try:
        for header, frame_payload in yjj.assemble(location, 0).read_bytes(
            MSG_ACTION_ENVELOPE
        ):
            envelope = _decode_action_envelope(frame_payload)
            if envelope is not None:
                frames.append((header.gen_time, envelope.get("action_type"), envelope))
    except (RuntimeError, ValueError, FileNotFoundError):
        pass
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
    """Action frame identity index keyed by (frame_uid, gen_time)."""
    location = _location(runtime_dir)
    index = {}
    try:
        for header, frame_payload in yjj.assemble(location, 0).read_bytes(
            MSG_ACTION_ENVELOPE
        ):
            data = bytes(frame_payload)
            index[(header.frame_uid, header.gen_time)] = {
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
        pass
    return index


def _mission_card(payload):
    stage = payload.get("current_stage")
    stage = stage if isinstance(stage, dict) else {}
    return {
        "mission_id": _text(payload.get("mission_id")),
        "title": _text(payload.get("title")),
        "status": _text(payload.get("status")),
        "active_lens": _text(payload.get("active_lens")),
        "stage_name": _text(stage.get("name")),
        "next_review": _text(stage.get("next_review")),
        "next_action": _text(payload.get("next_action")),
    }


def _goal_card(payload):
    return {
        "goal_id": _text(payload.get("goal_id")),
        "status": _text(payload.get("status")),
        "title": _text(payload.get("title")),
        "owner_agent": _text(payload.get("owner_agent")),
        "mission_id": _text(payload.get("mission_id")),
        "lens": _text(payload.get("lens")),
        "mission_stage": _text(payload.get("mission_stage")),
        "source_branch": _text(payload.get("source_branch")),
        "worktree_path": _text(payload.get("worktree_path")),
        "external_repo_path": _text(payload.get("external_repo_path")),
        "external_branch": _text(payload.get("external_branch")),
        "external_head": _text(payload.get("external_head")),
        "external_ready_ref": _text(payload.get("external_ready_ref")),
        "latest_marker": _text(payload.get("latest_marker")),
        "summary": _text(payload.get("summary")),
        "next_action": _text(payload.get("next_action")),
        "archived": bool(payload.get("archived")),
    }


def _marker_card(payload, source):
    return {
        "branch": _text(payload.get("branch")),
        "status": _text(payload.get("status")),
        "ready": bool(payload.get("ready")),
        "ready_scope": _text(payload.get("ready_scope")),
        "keep_source_worktree": bool(payload.get("keep_source_worktree")),
        "worktree_path": _text(payload.get("worktree_path")),
        "summary": _text(payload.get("summary")),
        "risk": _text(payload.get("risk")),
        "marker_path": _text(source.get("source_path") or payload.get("marker_path")),
    }


def load(runtime_dir):
    """Fold the latest COMPLETED import batch into a projection dict.

    Returns {import_id, repo_root, repo_head, time, missions{}, goals{},
    markers{}} or None when no completed import exists.
    """
    batches = {}
    completed = []
    data_dir = store_dir(runtime_dir)
    for gen_time, action_type, envelope in read_frames(runtime_dir):
        session = envelope.get("session")
        session = session if isinstance(session, dict) else {}
        batch_info = envelope.get("batch")
        batch_info = batch_info if isinstance(batch_info, dict) else {}
        import_id = _text(session.get("import_id"))
        if action_type == ACTION_IMPORT_BEGIN and import_id:
            batches[import_id] = {
                "import_id": import_id,
                "repo_root": _text(batch_info.get("repo_root")),
                "repo_head": _text(batch_info.get("repo_head")),
                "time": gen_time,
                "missions": {},
                "goals": {},
                "markers": {},
            }
        elif action_type == ACTION_MISSION_SNAPSHOT and import_id:
            batch = batches.get(import_id)
            descriptor = envelope.get("payload")
            descriptor = descriptor if isinstance(descriptor, dict) else {}
            source_payload, _ = payloads.load_payload_descriptor(data_dir, descriptor)
            if batch is not None and source_payload is not None:
                card = _mission_card(source_payload)
                batch["missions"][card["mission_id"]] = card
        elif action_type == ACTION_GOAL_SNAPSHOT and import_id:
            batch = batches.get(import_id)
            descriptor = envelope.get("payload")
            descriptor = descriptor if isinstance(descriptor, dict) else {}
            source_payload, _ = payloads.load_payload_descriptor(data_dir, descriptor)
            if batch is not None and source_payload is not None:
                card = _goal_card(source_payload)
                batch["goals"][card["goal_id"]] = card
        elif action_type == ACTION_MARKER_SNAPSHOT and import_id:
            batch = batches.get(import_id)
            descriptor = envelope.get("payload")
            descriptor = descriptor if isinstance(descriptor, dict) else {}
            source = envelope.get("source")
            source = source if isinstance(source, dict) else {}
            source_payload, _ = payloads.load_payload_descriptor(data_dir, descriptor)
            if batch is not None and source_payload is not None:
                card = _marker_card(source_payload, source)
                batch["markers"][card["branch"]] = card
        elif action_type == ACTION_IMPORT_END and import_id:
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
