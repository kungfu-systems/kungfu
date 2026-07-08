# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime, timezone

from kungfu.atlas import importer, payloads
from kungfu.sources import store as source_store


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def _atlas_fixture(root):
    _write_json(
        root / "agent-journal/missions/registry/active/mission-a.json",
        {
            "mission_id": "mission-a",
            "title": "Mission A",
            "status": "active",
            "updated_at": "2026-07-08T00:00:00Z",
            "active_lens": "principal-engineer",
            "current_stage": {"name": "stage-a", "next_review": "2026-07-08"},
            "large_body": {"kept": "full mission payload"},
        },
    )
    _write_json(
        root / "agent-journal/goals/registry/active/goal-a.json",
        {
            "goal_id": "goal-a",
            "status": "active",
            "updated_at": "2026-07-08T01:00:00Z",
            "title": "Goal A",
            "mission_id": "mission-a",
            "next_action": "implement",
            "large_body": ["full", "goal", "payload"],
        },
    )
    _write_json(
        root / "reviews/worktree-status/ai__codex__goal-a.json",
        {
            "branch": "ai/codex/goal-a",
            "status": "ready",
            "updated_at": "2026-07-08T02:00:00Z",
            "ready": True,
            "summary": "ready marker",
            "risk": "",
        },
    )


def _action_receipts(source_records):
    receipts = {}
    for index, record in enumerate(
        payloads.enrich_source_records(source_records), start=1
    ):
        journal_payload = f"journal-payload-{index}".encode("utf-8")
        receipts[(record["kind"], record["source_id"])] = {
            "frame_uid": index,
            "trigger_frame_uid": index - 1,
            "stream_id": 0,
            "gen_time": 1000 + index,
            "trigger_time": 0,
            "msg_type": 9000 + index,
            "source": 101,
            "initial_source": 101,
            "dest": 0,
            "data_length": len(journal_payload),
            "data_type": 0,
            "journal_payload_hash": payloads.payload_hash(journal_payload),
        }
    return receipts


def _action_frames_from_manifest(manifest):
    frames = {}
    for entry in manifest["entries"]:
        if "action" not in entry:
            continue
        journal = dict(entry["action"]["journal"])
        journal["_payload"] = f"journal-payload-{journal['frame_uid']}".encode("utf-8")
        frames[
            (
                entry["action"]["journal"]["frame_uid"],
                entry["action"]["journal"]["msg_type"],
                entry["action"]["journal"]["gen_time"],
            )
        ] = journal
    return frames


def test_atlas_source_records_keep_full_payloads(tmp_path):
    repo = tmp_path / "atlas"
    _atlas_fixture(repo)

    missions, goals, markers, source_records, warnings = (
        importer.read_control_plane_with_sources(str(repo))
    )

    assert warnings == []
    assert [card["mission_id"] for card in missions] == ["mission-a"]
    assert [card["goal_id"] for card in goals] == ["goal-a"]
    assert [card["branch"] for card in markers] == ["ai/codex/goal-a"]
    assert {(row["kind"], row["source_id"]) for row in source_records} == {
        ("mission", "mission-a"),
        ("goal", "goal-a"),
        ("marker", "ai/codex/goal-a"),
    }
    mission = next(row for row in source_records if row["kind"] == "mission")
    assert mission["payload"]["large_body"] == {"kept": "full mission payload"}
    assert mission["source_path"] == (
        "agent-journal/missions/registry/active/mission-a.json"
    )
    assert mission["source_time"] == "2026-07-08T00:00:00Z"


def test_atlas_source_records_filter_by_window(tmp_path):
    repo = tmp_path / "atlas"
    _atlas_fixture(repo)
    _write_json(
        repo / "agent-journal/goals/registry/archive/goal-old.json",
        {
            "goal_id": "goal-old",
            "status": "done",
            "updated_at": "2026-06-01T00:00:00Z",
            "title": "Old Goal",
        },
    )
    _write_json(
        repo / "agent-journal/missions/registry/archive/mission-b.json",
        {
            "mission_id": "mission-b",
            "title": "Mission B",
            "status": "active",
            "updated_at": "2026-06-01T00:00:00Z",
        },
    )
    _write_json(
        repo / "agent-journal/goals/registry/active/goal-b.json",
        {
            "goal_id": "goal-b",
            "status": "active",
            "updated_at": "2026-07-08T00:00:00Z",
            "title": "Goal B",
            "mission_id": "mission-b",
        },
    )

    missions, goals, _, source_records, warnings = (
        importer.read_control_plane_with_sources(
            str(repo),
            window={"since": "2026-07-01T00:00:00Z"},
        )
    )

    assert warnings == []
    assert [card["goal_id"] for card in goals] == ["goal-a", "goal-b"]
    assert [card["mission_id"] for card in missions] == ["mission-a", "mission-b"]
    assert ("goal", "goal-old") not in {
        (record["kind"], record["source_id"]) for record in source_records
    }
    assert ("mission", "mission-b") in {
        (record["kind"], record["source_id"]) for record in source_records
    }


def test_payload_manifest_fsck_export_and_verify(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    missions, goals, markers, source_records, _ = (
        importer.read_control_plane_with_sources(str(repo))
    )

    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-test",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={
            "missions": len(missions),
            "goals": len(goals),
            "markers": len(markers),
        },
        storage_source_id="atlas-local",
        range_filter={"since": "2026-07-01T00:00:00Z"},
        action_receipts=_action_receipts(source_records),
    )

    report = payloads.fsck_import(
        store, action_frames=_action_frames_from_manifest(manifest)
    )
    assert report["ok"]
    assert report["checked"] == {
        "payloads": 3,
        "missions": 1,
        "goals": 1,
        "markers": 1,
        "actions": 3,
    }

    records = payloads.export_records(store)
    assert len(records) == 3
    goal = next(row for row in records if row["kind"] == "goal")
    assert goal["payload"]["large_body"] == ["full", "goal", "payload"]
    assert goal["repo_head"] == "abc123"
    assert goal["storage_source_id"] == "atlas-local"
    assert goal["source_time"] == "2026-07-08T01:00:00Z"
    assert goal["action"]["schema"] == payloads.ACTION_ENVELOPE_SCHEMA
    assert goal["action"]["action_type"] == "atlas.goal.snapshot"
    assert goal["action"]["payload"]["hash"] == goal["payload_hash"]
    assert goal["action"]["journal"]["frame_uid"] > 0

    missing_frame = payloads.fsck_import(store, action_frames={})
    assert not missing_frame["ok"]
    assert any(
        error["code"] == "action_frame_missing" for error in missing_frame["errors"]
    )

    verify = payloads.verify_against_source(store, source_records)
    assert verify == {
        "ok": True,
        "scope": "atlas",
        "checked": 3,
        "missing": [],
        "extra": [],
        "hash_mismatch": [],
    }


def test_payload_fsck_reports_missing_payload(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    missions, goals, markers, source_records, _ = (
        importer.read_control_plane_with_sources(str(repo))
    )
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-test",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={
            "missions": len(missions),
            "goals": len(goals),
            "markers": len(markers),
        },
    )
    first = manifest["entries"][0]
    payloads.payload_path(store, first["payload_hash"]).unlink()

    report = payloads.fsck_import(store)

    assert not report["ok"]
    assert any(error["code"] == "payload_missing" for error in report["errors"])


def test_source_range_builder_supports_relative_since():
    window = source_store.build_range_filter(
        since="3d",
        now=datetime(2026, 7, 8, 12, 0, 0, tzinfo=timezone.utc),
    )

    assert window == {"since": "2026-07-05T12:00:00Z"}
