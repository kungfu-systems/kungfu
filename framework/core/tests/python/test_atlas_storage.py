# SPDX-License-Identifier: Apache-2.0

import json

from kungfu.atlas import importer, payloads


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
            "ready": True,
            "summary": "ready marker",
            "risk": "",
        },
    )


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


def test_payload_manifest_fsck_export_and_verify(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    missions, goals, markers, source_records, _ = (
        importer.read_control_plane_with_sources(str(repo))
    )

    payloads.write_import_payloads(
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

    report = payloads.fsck_import(store)
    assert report["ok"]
    assert report["checked"] == {
        "payloads": 3,
        "missions": 1,
        "goals": 1,
        "markers": 1,
    }

    records = payloads.export_records(store)
    assert len(records) == 3
    goal = next(row for row in records if row["kind"] == "goal")
    assert goal["payload"]["large_body"] == ["full", "goal", "payload"]
    assert goal["repo_head"] == "abc123"

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
