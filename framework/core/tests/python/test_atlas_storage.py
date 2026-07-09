# SPDX-License-Identifier: Apache-2.0

import json
import sqlite3
from datetime import datetime, timezone

import kungfu

from kungfu.atlas import importer, payloads
from kungfu.atlas import CARRIER_ATLAS_ACTION
from kungfu.sources import store as source_store
from kungfu.storage import service as storage_service


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


def _atlas_window_context_fixture(root):
    _write_json(
        root / "agent-journal/goals/registry/archive/goal-old.json",
        {
            "goal_id": "goal-old",
            "status": "done",
            "updated_at": "2026-06-01T00:00:00Z",
            "title": "Old Goal",
        },
    )
    _write_json(
        root / "agent-journal/missions/registry/archive/mission-b.json",
        {
            "mission_id": "mission-b",
            "title": "Mission B",
            "status": "active",
            "updated_at": "2026-06-01T00:00:00Z",
        },
    )
    _write_json(
        root / "agent-journal/goals/registry/active/goal-b.json",
        {
            "goal_id": "goal-b",
            "status": "active",
            "updated_at": "2026-07-08T00:00:00Z",
            "title": "Goal B",
            "mission_id": "mission-b",
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
            "carrier_type": CARRIER_ATLAS_ACTION,
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
                entry["action"]["journal"]["gen_time"],
            )
        ] = journal
    return frames


def _action_frames_with_checksums(manifest, payload_checksum, frame_checksum):
    frames = _action_frames_from_manifest(manifest)
    for frame in frames.values():
        frame["_payload_checksum_for"] = (
            lambda _length, _algorithm, checksum=payload_checksum: checksum
        )
        frame["_frame_checksum_for"] = (
            lambda _length, _algorithm, checksum=frame_checksum: checksum
        )
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
    _atlas_window_context_fixture(repo)

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


def test_atlas_range_export_preserves_context_closure(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    window = {"since": "2026-07-01T00:00:00Z"}
    _atlas_fixture(repo)
    _atlas_window_context_fixture(repo)

    missions, goals, markers, source_records, warnings = (
        importer.read_control_plane_with_sources(str(repo), window=window)
    )
    assert warnings == []

    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-range-closure",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={
            "missions": len(missions),
            "goals": len(goals),
            "markers": len(markers),
        },
        range_filter=window,
        action_receipts=_action_receipts(source_records),
    )

    exported = payloads.export_records(store, range_filter=window)
    exported_keys = {(row["kind"], row["source_id"]) for row in exported}
    source_keys = {(row["kind"], row["source_id"]) for row in source_records}

    assert exported_keys == source_keys
    assert ("mission", "mission-b") in exported_keys
    assert (
        payloads.export_sync_root(store, range_filter=window) == manifest["sync_root"]
    )
    assert payloads.verify_against_source(store, source_records)["ok"]


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
        "sync_roots": 1,
        "storage_manifests": 1,
    }
    assert manifest["sync_root"] == payloads.compute_sync_root(manifest["entries"])
    assert manifest["sync_root"]["schema"] == payloads.SYNC_ROOT_SCHEMA
    assert (
        manifest["sync_root"]["scope"] == payloads.SYNC_ROOT_SCOPE_ATLAS_IMPORT_MANIFEST
    )
    assert manifest["sync_root"]["value"].startswith("sha256:")

    records = payloads.export_records(store)
    assert len(records) == 3
    goal = next(row for row in records if row["kind"] == "goal")
    assert goal["payload"]["large_body"] == ["full", "goal", "payload"]
    assert goal["repo_head"] == "abc123"
    assert goal["storage_source_id"] == "atlas-local"
    assert goal["source_time"] == "2026-07-08T01:00:00Z"
    assert goal["action"]["schema"] == payloads.ACTION_ENVELOPE_SCHEMA
    assert goal["action"]["action_type"] == "atlas.goal.snapshot"
    assert goal["action"]["schema_ref"]["id"] == "kungfu.atlas.GoalSnapshot"
    assert goal["action"]["payload"]["hash"] == goal["payload_hash"]
    assert goal["action"]["journal"]["frame_uid"] > 0
    assert goal["action"]["journal"]["carrier_type"] == CARRIER_ATLAS_ACTION

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


def test_storage_core_binding_owns_sync_root_and_payload_checks(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))

    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-runtime-core",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
    )
    runtime = kungfu.__binding__.runtime

    assert (
        runtime.compute_storage_sync_root(manifest["entries"]) == manifest["sync_root"]
    )
    assert (
        runtime.verify_storage_sync_root(manifest["sync_root"], manifest["entries"])
        == []
    )

    tampered = dict(manifest["sync_root"])
    tampered["value"] = payloads.SYNC_ROOT_INITIAL
    issues = runtime.verify_storage_sync_root(tampered, manifest["entries"])
    assert issues[0]["code"] == "sync_root_mismatch"
    assert issues[0]["field"] == "value"

    first = manifest["entries"][0]
    raw = payloads.payload_path(store, first["payload_hash"]).read_bytes()
    assert (
        runtime.verify_storage_payload(raw, first["payload_hash"], first["byte_len"])
        == ""
    )
    assert (
        runtime.verify_storage_payload(
            raw + b"extra", first["payload_hash"], first["byte_len"]
        )
        == "byte_len_mismatch"
    )


def test_runtime_storage_service_surface_is_bound_from_libkungfu(tmp_path):
    runtime = kungfu.__binding__.runtime
    capabilities = storage_service.service_capabilities()

    assert capabilities["schema"] == "kungfu.runtime.storage-service/v1"
    assert capabilities["owner"] == "libkungfu"
    assert capabilities["backend"] == "content-addressed-file"
    assert capabilities["provider"] == "content-addressed-file"
    assert capabilities["provider_config_source"] == "default"
    assert {provider["name"] for provider in capabilities["providers"]} == {
        "content-addressed-file",
        "rocksdb",
    }
    assert any(
        provider["name"] == "rocksdb"
        and provider["runtime"]["lifecycle"] == "provider-instance-owned"
        for provider in capabilities["providers"]
    )
    assert set(capabilities["operations"]) == {
        "status",
        "fsck",
        "repair_plan",
        "export_bundle",
        "import_bundle",
        "rebuild_index",
        "gc_plan",
        "compact_plan",
        "verify_sync",
        "query",
        "layout",
        "episode_begin",
        "episode_heartbeat",
        "episode_end",
        "episode_abort",
        "episode_attach_frame",
        "episode_attach_ref",
        "episode_list",
        "episode_inspect",
        "source_register",
        "source_update_head",
        "source_record_accepted_range",
        "source_list",
        "source_inspect",
        "source_registry_fsck",
    }

    request = runtime.make_storage_service_request(
        "status",
        str(tmp_path),
        {"scope": "source", "source_id": "local-synth", "dry_run": True},
    )
    assert request == {
        "schema": "kungfu.runtime.storage-service/v1",
        "owner": "libkungfu",
        "operation": "status",
        "runtime_dir": str(tmp_path),
        "provider": "content-addressed-file",
        "provider_config_source": "default",
        "scope": "source",
        "source_id": "local-synth",
        "dry_run": True,
        "verify": True,
        "range": {},
        "artifact_uri": "",
    }
    status = runtime.run_storage_service_operation(
        "status",
        str(tmp_path),
        {"scope": "all"},
    )
    assert status["ok"]
    assert status["backend"] == "content-addressed-file"
    assert status["provider"] == "content-addressed-file"
    assert status["provider_config_source"] == "default"
    assert status["provider_runtime"]["lifecycle"] == "stateless-filesystem"
    assert status["sources"] == []

    request = runtime.make_storage_service_request(
        "status",
        str(tmp_path),
        {"provider": "rocksdb", "scope": "all"},
    )
    assert request["provider"] == "rocksdb"
    assert request["provider_config_source"] == "option"

    workspace_home = tmp_path / ".kungfu"
    runtime_dir = workspace_home / "runtime"
    config_home = tmp_path / ".kungfu-config"
    layout = storage_service.layout(
        runtime_dir,
        runtime_home=workspace_home,
        config_home=config_home,
    )
    assert layout["schema"] == "kungfu.workspace.episode-layout/v1"
    assert layout["owner"] == "libkungfu"
    assert layout["workspace_data_home"] == str(workspace_home)
    assert layout["runtime_home"] == str(workspace_home)
    assert layout["runtime_home_source"] == "option"
    assert layout["runtime_dir"] == str(runtime_dir)
    assert layout["config_home"] == str(config_home)
    assert layout["paths"]["data_home"] == str(workspace_home)
    assert layout["paths"]["storage_dir"] == str(runtime_dir / "storage")
    assert layout["paths"]["sqlite_projection"] == str(
        runtime_dir / "storage/projections/storage.sqlite"
    )
    assert layout["paths"]["episode_manifest_journal"] == str(
        runtime_dir / "journal/system/storage/episode-manifest/live/*.journal"
    )
    assert layout["episodes"]["authority"] == "yijinjing-journal"
    assert layout["episodes"]["query_tables"] == [
        "episodes",
        "episode_records",
        "episode_frames",
        "episode_refs",
    ]


def test_python_storage_operations_enter_runtime_service_surface(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    accepted = storage_service.write_synthetic_source(
        runtime_dir,
        source_id="local-synth",
        manifest_id="imp-synth",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload": {"title": "A", "body": "alpha"},
            }
        ],
    )
    assert accepted["source_id"] == "local-synth"

    runtime = kungfu.__binding__.runtime
    original_operation = runtime.run_storage_service_operation
    calls = []

    def spy_operation(operation, runtime_dir_arg, options):
        calls.append((operation, runtime_dir_arg, dict(options)))
        return original_operation(operation, runtime_dir_arg, options)

    monkeypatch.setattr(
        runtime,
        "run_storage_service_operation",
        spy_operation,
    )

    storage_service.status(runtime_dir, source_id="local-synth")
    storage_service.layout(runtime_dir)
    storage_service.fsck(runtime_dir, source_id="local-synth")
    storage_service.repair_plan(runtime_dir, source_id="local-synth", dry_run=True)
    storage_service.rebuild_index(runtime_dir, source_id="local-synth", dry_run=True)
    storage_service.rebuild_index(runtime_dir, source_id="local-synth", dry_run=False)
    storage_service.gc_plan(runtime_dir, dry_run=True)
    storage_service.compact_plan(runtime_dir, dry_run=True)
    storage_service.build_export_bundle(runtime_dir, source_id="local-synth")
    storage_service.import_bundle(
        tmp_path / "imported-runtime",
        storage_service.build_export_bundle(runtime_dir, source_id="local-synth"),
    )
    storage_service.verify_local_sync(runtime_dir, source_id="local-synth")
    query = storage_service.query_projection(
        runtime_dir,
        query="entries",
        source_id="local-synth",
        kind="note",
        limit=10,
    )
    assert query["ok"]
    assert query["row_count"] == 1
    assert query["rows"][0]["kind"] == "note"
    assert query["rows"][0]["storage_source_id"] == "local-synth"

    entered = {operation for operation, _, _ in calls}
    assert {
        "status",
        "layout",
        "fsck",
        "repair_plan",
        "rebuild_index",
        "gc_plan",
        "compact_plan",
        "export_bundle",
        "import_bundle",
        "verify_sync",
        "query",
    } <= entered


def test_episode_manifest_v1_is_yijinjing_backed_and_fscked(tmp_path):
    runtime_dir = tmp_path / "runtime"
    episode = storage_service.episode_begin(
        runtime_dir,
        episode_id=42,
        title="test episode",
        actor="pytest",
        source="unit-test",
        begin_time=1000,
    )
    assert episode["schema"] == "kungfu.episode.manifest/v1"
    assert episode["record_kind"] == "episode_open"
    assert episode["episode_id"] == 42

    input_ref = storage_service.episode_attach_ref(
        runtime_dir,
        episode_id=42,
        ref_kind="input_frame",
        ref_uid=99,
        ref_id="external-frame:99",
    )
    assert input_ref["record_kind"] == "episode_ref_attached"
    assert input_ref["ref_kind"] == "input_frame"

    attached = storage_service.episode_attach_frame(
        runtime_dir,
        episode_id=42,
        frame_uid=100,
        trigger_frame_uid=99,
        stream_id=7,
        gen_time=1100,
        carrier_type=10803,
        source=1,
        dest=0,
        data_length=12,
        integrity_version=2,
        payload_checksum=123,
        frame_checksum=456,
    )
    assert attached["record_kind"] == "episode_frame_attached"
    assert attached["frame_uid"] == 100

    ended = storage_service.episode_end(
        runtime_dir,
        episode_id=42,
        end_time=1200,
        last_frame_uid=100,
        frame_count=1,
        reason="done",
    )
    assert ended["status"] == "ended"

    listed = storage_service.episode_list(runtime_dir)
    assert listed["authority"] == "yijinjing-journal"
    assert listed["episode_count"] == 1
    assert listed["episodes"][0]["episode_id"] == 42
    assert listed["episodes"][0]["frame_count"] == 1

    inspected = storage_service.episode_inspect(runtime_dir, episode_id=42)
    assert inspected["ok"]
    assert inspected["episode"]["status"] == "ended"
    assert len(inspected["records"]) == 4
    assert inspected["frames"][0]["frame_uid"] == 100
    assert inspected["causal_graph"]["schema"] == "kungfu.episode.causal-graph/v1"
    assert inspected["causal_graph"]["degraded"] is False
    assert inspected["dependencies"][0]["kind"] == "frame"
    assert inspected["dependencies"][0]["status"] == "declared_external"

    fsck = storage_service.fsck(runtime_dir)
    assert fsck["ok"]
    assert fsck["status"] == "ok"
    assert fsck["checked"]["episode_manifest_records"] == 4
    assert fsck["checked"]["episodes"] == 1
    assert fsck["episode_manifest"]["authority"] == "yijinjing-journal"

    episode_fsck = storage_service.fsck(runtime_dir, episode_id=42)
    assert episode_fsck["ok"]
    assert episode_fsck["scope"] == "episode"
    assert episode_fsck["episode_id"] == 42
    assert episode_fsck["checked"]["episodes"] == 1

    episode_rows = storage_service.query_projection(
        runtime_dir,
        query="episodes",
        episode_id=42,
    )
    assert episode_rows["ok"]
    assert episode_rows["projection"]["authority"] == "yijinjing-journal"
    assert episode_rows["row_count"] == 1
    assert episode_rows["rows"][0]["episode_id"] == 42

    frame_rows = storage_service.query_projection(
        runtime_dir,
        query="episode_frames",
        episode_id=42,
    )
    assert frame_rows["ok"]
    assert frame_rows["row_count"] == 1
    assert frame_rows["rows"][0]["frame_uid"] == 100

    bundle = storage_service.build_export_bundle(runtime_dir, episode_id=42)
    assert bundle["schema"] == "kungfu.storage.episode-bundle/v1"
    assert bundle["scope"] == "episode"
    assert bundle["episode_id"] == 42
    assert bundle["manifest"]["episode_id"] == 42
    assert bundle["causal_graph"]["degraded"] is False
    assert bundle["dependencies"][0]["status"] == "declared_external"
    assert bundle["record_count"] == 4
    assert bundle["frame_count"] == 1


def test_episode_fsck_reports_degraded_causal_dependencies(tmp_path):
    runtime_dir = tmp_path / "runtime"
    storage_service.episode_begin(
        runtime_dir,
        episode_id=7,
        parent_episode_id=999,
        root_trigger_frame_uid=77,
        title="degraded episode",
        actor="pytest",
        source="unit-test",
        begin_time=1000,
    )
    storage_service.episode_attach_frame(
        runtime_dir,
        episode_id=7,
        frame_uid=101,
        trigger_frame_uid=77,
        stream_id=7,
        gen_time=1100,
        carrier_type=10803,
        source=1,
        dest=0,
        data_length=12,
        integrity_version=2,
        payload_checksum=123,
        frame_checksum=456,
    )
    storage_service.episode_attach_ref(
        runtime_dir,
        episode_id=7,
        ref_kind="payload",
        ref_id="missing/payload.json",
        ref_hash="sha256:missing",
    )
    storage_service.episode_attach_ref(
        runtime_dir,
        episode_id=7,
        ref_kind="episode",
        ref_uid=998,
    )
    storage_service.episode_end(
        runtime_dir,
        episode_id=7,
        end_time=1200,
        last_frame_uid=101,
        frame_count=1,
        reason="done",
    )

    inspected = storage_service.episode_inspect(runtime_dir, episode_id=7)
    assert inspected["ok"]
    assert inspected["causal_graph"]["degraded"] is True
    assert {dependency["kind"] for dependency in inspected["dependencies"]} >= {
        "episode",
        "frame",
        "payload",
    }

    fsck = storage_service.fsck(runtime_dir, episode_id=7)
    assert fsck["ok"]
    assert fsck["status"] == "degraded"
    assert fsck["degraded"] is True
    warning_codes = {warning["code"] for warning in fsck["warnings"]}
    assert "episode_dependency_missing" in warning_codes
    assert "episode_root_trigger_frame_missing" in warning_codes
    assert "episode_trigger_frame_missing" in warning_codes
    assert "episode_payload_ref_missing" in warning_codes

    bundle = storage_service.build_export_bundle(runtime_dir, episode_id=7)
    assert bundle["degraded"] is True
    assert bundle["causal_graph"]["degraded"] is True
    assert bundle["dependency_count"] == len(bundle["dependencies"])

    imported = storage_service.import_bundle(tmp_path / "imported-runtime", bundle)
    assert imported["schema"] == "kungfu.storage.episode-import/v1"
    assert imported["scope"] == "episode"
    assert imported["accepted"] is False
    assert imported["degraded"] is True
    assert imported["causal_graph"]["degraded"] is True
    assert imported["dependency_count"] == len(bundle["dependencies"])

    repair = storage_service.repair_plan(runtime_dir, episode_id=7, dry_run=True)
    assert repair["schema"] == "kungfu.storage.repair-plan/v1"
    assert repair["scope"] == "episode"
    assert repair["episode_id"] == 7
    assert repair["dry_run"] is True
    assert repair["plan_only"] is True
    assert repair["status"] == "degraded"
    assert repair["degraded"] is True
    assert repair["candidate_count"] >= 4
    candidate_codes = {candidate["code"] for candidate in repair["candidates"]}
    assert "repair_episode_dependency" in candidate_codes
    assert "repair_episode_root_trigger_frame" in candidate_codes
    assert "repair_episode_trigger_frame" in candidate_codes
    assert "repair_episode_payload_ref" in candidate_codes
    assert {candidate["kind"] for candidate in repair["candidates"]} >= {
        "episode",
        "frame",
        "payload",
    }
    assert all(
        candidate["safe_to_apply"] is False for candidate in repair["candidates"]
    )


def test_payload_fsck_verifies_versioned_frame_checksums(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))
    receipts = _action_receipts(source_records)
    payload_checksum = 1234
    frame_checksum = 5678
    for receipt in receipts.values():
        receipt.update(
            {
                "integrity_version": payloads.FRAME_INTEGRITY_VERSION_V2,
                "checksum_algorithm": payloads.FRAME_CHECKSUM_ALGORITHM_CRC32C,
                "payload_checksum": payload_checksum,
                "frame_checksum": frame_checksum,
            }
        )
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-checksum-v2",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
        action_receipts=receipts,
    )

    report = payloads.fsck_import(
        store,
        action_frames=_action_frames_with_checksums(
            manifest, payload_checksum, frame_checksum
        ),
    )
    assert report["ok"]

    for receipt in receipts.values():
        receipt["integrity_version"] = payloads.FRAME_INTEGRITY_VERSION_V1
        receipt["checksum_algorithm"] = payloads.FRAME_CHECKSUM_ALGORITHM_FNV1A64
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-checksum-v1",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
        action_receipts=receipts,
    )
    report = payloads.fsck_import(
        store,
        action_frames=_action_frames_with_checksums(
            manifest, payload_checksum, frame_checksum
        ),
    )
    assert report["ok"]


def test_payload_fsck_rejects_unknown_or_mismatched_frame_checksum_metadata(
    tmp_path,
):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))
    receipts = _action_receipts(source_records)
    for receipt in receipts.values():
        receipt.update(
            {
                "integrity_version": payloads.FRAME_INTEGRITY_VERSION_V2,
                "checksum_algorithm": payloads.FRAME_CHECKSUM_ALGORITHM_FNV1A64,
                "payload_checksum": 1234,
                "frame_checksum": 5678,
            }
        )
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-checksum-mismatch",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
        action_receipts=receipts,
    )
    report = payloads.fsck_import(
        store, action_frames=_action_frames_with_checksums(manifest, 1234, 5678)
    )
    assert not report["ok"]
    assert any(
        error.get("field") == "checksum_algorithm"
        and error.get("expected") == payloads.FRAME_CHECKSUM_ALGORITHM_CRC32C
        for error in report["errors"]
    )

    for receipt in receipts.values():
        receipt["checksum_algorithm"] = "mystery64"
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-checksum-unknown",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
        action_receipts=receipts,
    )
    report = payloads.fsck_import(
        store, action_frames=_action_frames_with_checksums(manifest, 1234, 5678)
    )
    assert not report["ok"]
    assert any(
        error.get("field") == "checksum_algorithm"
        and error.get("actual") == "mystery64"
        for error in report["errors"]
    )


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


def test_payload_fsck_rejects_missing_sync_root(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-test",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
    )
    del manifest["sync_root"]
    payloads.latest_manifest_path(store).write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    report = payloads.fsck_import(store)

    assert not report["ok"]
    assert any(error["code"] == "sync_root_missing" for error in report["errors"])


def test_payload_fsck_rejects_sync_root_entry_mutation(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-test",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
    )
    manifest["entries"][0]["source_path"] = "tampered.json"
    payloads.latest_manifest_path(store).write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    report = payloads.fsck_import(store)

    assert not report["ok"]
    assert any(
        error["code"] == "sync_root_mismatch" and error["field"] == "value"
        for error in report["errors"]
    )


def test_source_range_builder_supports_relative_since():
    window = source_store.build_range_filter(
        since="3d",
        now=datetime(2026, 7, 8, 12, 0, 0, tzinfo=timezone.utc),
    )

    assert window == {"since": "2026-07-05T12:00:00Z"}


def test_generic_storage_service_handles_non_atlas_source_bundle(tmp_path):
    runtime_dir = tmp_path / "runtime"
    accepted = storage_service.write_synthetic_source(
        runtime_dir,
        source_id="local-synth",
        manifest_id="imp-synth",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload": {"title": "A", "body": "alpha"},
            },
            {
                "kind": "note",
                "source_id": "note-b",
                "source_path": "notes/b.json",
                "source_time": "2026-07-09T00:00:00Z",
                "payload": {"title": "B", "body": "beta"},
            },
        ],
    )

    assert accepted["schema"] == "kungfu.storage.import-manifest/v1"
    assert accepted["source_id"] == "local-synth"
    assert accepted["accepted_ranges"][0]["status"] == "ok"
    assert len(accepted["payload_inventory"]["entries"]) == 2
    assert storage_service.status(runtime_dir, source_id="local-synth")["ok"]
    fsck = storage_service.fsck(runtime_dir, source_id="local-synth")
    assert fsck["ok"]
    assert fsck["checked"]["sources"] == 1
    assert fsck["checked"]["manifests"] == 1
    assert fsck["checked"]["payloads"] == 2

    exported = storage_service.export_records(
        runtime_dir,
        source_id="local-synth",
        range_filter={"since": "2026-07-09T00:00:00Z"},
    )
    assert [row["source_id"] for row in exported] == ["note-b"]
    bundle = storage_service.build_export_bundle(runtime_dir, source_id="local-synth")
    assert bundle["schema"] == "kungfu.storage.export-bundle/v1"
    assert len(bundle["records"]) == 2

    range_bundle = storage_service.build_export_bundle(
        runtime_dir,
        source_id="local-synth",
        range_filter={"since": "2026-07-09T00:00:00Z"},
    )
    assert len(range_bundle["manifest"]["entries"]) == 1
    assert len(range_bundle["records"]) == 1

    imported_runtime = tmp_path / "imported-runtime"
    import_result = storage_service.import_bundle(imported_runtime, bundle)
    assert import_result == {
        "ok": True,
        "scope": "source",
        "source_id": "local-synth",
        "manifest_id": "imp-synth",
        "records": 2,
    }
    assert storage_service.fsck(imported_runtime, source_id="local-synth")["ok"]

    imported_range_runtime = tmp_path / "imported-range-runtime"
    range_import = storage_service.import_bundle(imported_range_runtime, range_bundle)
    assert range_import["records"] == 1
    assert storage_service.fsck(imported_range_runtime, source_id="local-synth")["ok"]


def test_runtime_storage_service_operations_own_file_provider(tmp_path):
    runtime_dir = tmp_path / "runtime"
    storage_service.write_synthetic_source(
        runtime_dir,
        source_id="local-synth",
        manifest_id="imp-synth",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload": {"title": "A", "body": "alpha"},
            }
        ],
    )

    runtime = kungfu.__binding__.runtime
    status = runtime.run_storage_service_operation(
        "status",
        str(runtime_dir),
        {"scope": "source", "source_id": "local-synth"},
    )
    assert status["ok"]
    assert status["source_status"][0]["source_id"] == "local-synth"

    fsck = runtime.run_storage_service_operation(
        "fsck",
        str(runtime_dir),
        {"scope": "source", "source_id": "local-synth"},
    )
    assert fsck["ok"]
    assert fsck["checked"]["payloads"] == 1

    bundle = runtime.run_storage_service_operation(
        "export_bundle",
        str(runtime_dir),
        {"scope": "source", "source_id": "local-synth"},
    )
    assert bundle["schema"] == "kungfu.storage.export-bundle/v1"
    assert len(bundle["records"]) == 1

    imported_runtime = tmp_path / "imported-runtime"
    imported = runtime.run_storage_service_operation(
        "import_bundle",
        str(imported_runtime),
        {"scope": "source", "source_id": "local-synth", "bundle": bundle},
    )
    assert imported["ok"]
    assert imported["records"] == 1

    verify = runtime.run_storage_service_operation(
        "verify_sync",
        str(imported_runtime),
        {"scope": "source", "source_id": "local-synth"},
    )
    assert verify["ok"]
    assert verify["sync_roots_match"]


def test_storage_maintenance_rebuild_gc_compact_and_sync_check(tmp_path):
    runtime_dir = tmp_path / "runtime"
    accepted = storage_service.write_synthetic_source(
        runtime_dir,
        source_id="local-synth",
        manifest_id="imp-synth",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload": {"title": "A", "body": "alpha"},
            }
        ],
    )
    status = storage_service.status(runtime_dir, source_id="local-synth")
    assert status["source_status"][0]["accepted_cursor"]["source_head"] == "head-1"
    assert status["source_status"][0]["sync_root"] == accepted["sync_root"]

    storage_service.registry_path(runtime_dir).unlink()
    dry_rebuild = storage_service.rebuild_index(
        runtime_dir, source_id="local-synth", dry_run=True
    )
    assert dry_rebuild["ok"]
    assert dry_rebuild["would_write"]
    assert not storage_service.registry_path(runtime_dir).exists()

    rebuild = storage_service.rebuild_index(runtime_dir, source_id="local-synth")
    assert rebuild["ok"]
    assert rebuild["written"]
    sqlite_projection = next(
        row for row in rebuild["projections"] if row["name"] == "sqlite"
    )
    assert sqlite_projection["written"] is True
    assert sqlite_projection["rows"] == {"sources": 1, "manifests": 1, "entries": 1}
    sqlite_path = runtime_dir / "storage/projections/storage.sqlite"
    assert sqlite_path.exists()
    with sqlite3.connect(sqlite_path) as db:
        assert db.execute("select count(*) from storage_sources").fetchone()[0] == 1
        assert db.execute("select count(*) from storage_manifests").fetchone()[0] == 1
        assert db.execute("select count(*) from storage_entries").fetchone()[0] == 1
    assert storage_service.status(runtime_dir, source_id="local-synth")["ok"]
    status = storage_service.status(runtime_dir, source_id="local-synth")
    status_sqlite = next(
        row for row in status["projections"] if row["name"] == "sqlite"
    )
    assert status_sqlite["exists"] is True
    assert status_sqlite["counts"] == {"sources": 1, "manifests": 1, "entries": 1}

    orphan_raw = b'{"orphan":true}'
    orphan_hash = payloads.payload_hash(orphan_raw)
    storage_service.write_payload_bytes(runtime_dir, orphan_hash, orphan_raw)
    gc = storage_service.gc_plan(runtime_dir, dry_run=True)
    assert gc["candidate_count"] == 1
    assert gc["candidates"][0]["payload_hash"] == orphan_hash
    assert gc["candidates"][0]["safe_to_delete"] is True
    assert storage_service.payload_path(runtime_dir, orphan_hash).exists()

    compact = storage_service.compact_plan(runtime_dir, dry_run=True)
    assert compact["ok"]
    assert compact["gc"]["candidate_count"] == 1
    assert compact["projection_compact"]["name"] == "sqlite"
    assert compact["projection_compact"]["action"] == "rebuild-and-vacuum"
    assert any(row["name"] == "backend-compact" for row in compact["unsupported"])

    fsck = storage_service.fsck(runtime_dir)
    assert fsck["ok"]
    assert fsck["checked"]["projection_indexes"] == 2
    assert fsck["checked"]["sqlite_projection_rows"] == 3
    assert fsck["checked"]["orphan_payloads"] == 1
    assert any(warning["code"] == "orphan_payload" for warning in fsck["warnings"])

    sync_check = storage_service.verify_local_sync(runtime_dir, source_id="local-synth")
    assert sync_check["ok"]
    assert sync_check["sync_roots_match"]
    assert sync_check["exported_records"] == 1


def test_atlas_import_persists_generic_source_manifest(tmp_path):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    _atlas_fixture(repo)

    result = source_store.add_source(
        runtime_dir,
        source_id="atlas-local",
        source_type="atlas",
        repo=str(repo),
    )
    assert result["storage_record"]["schema"] == "kungfu.storage.source-record/v1"

    sync = source_store.sync_source(runtime_dir, "atlas-local")
    assert sync["ok"]
    generic = storage_service.load_latest_manifest(runtime_dir, "atlas-local")
    assert generic is not None
    assert generic["schema"] == "kungfu.storage.import-manifest/v1"
    assert generic["scope"] == "atlas"
    assert len(generic["payload_inventory"]["entries"]) == 3

    source_fsck = source_store.fsck_source(runtime_dir, "atlas-local")
    assert source_fsck["ok"]
    assert source_fsck["storage"]["ok"]


def test_storage_fsck_reports_degraded_status_for_recorded_payload_states(tmp_path):
    runtime_dir = tmp_path / "runtime"
    storage_service.write_synthetic_source(
        runtime_dir,
        source_id="degraded-synth",
        manifest_id="imp-degraded",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-present",
                "source_path": "notes/p.json",
                "source_time": "2026-07-07T00:00:00Z",
                "payload": {"body": "present"},
            },
            {
                "kind": "note",
                "source_id": "note-missing",
                "source_path": "notes/m.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload": {"body": "lost"},
                "payload_state": "missing",
            },
            {
                "kind": "note",
                "source_id": "note-redacted",
                "source_path": "notes/r.json",
                "source_time": "2026-07-09T00:00:00Z",
                "payload": {"body": "sensitive"},
                "payload_state": "redacted",
            },
        ],
    )

    report = storage_service.fsck(runtime_dir, source_id="degraded-synth")
    # A recorded-missing payload is incomplete, not corrupt: ok stays true, but the
    # tri-state verdict degrades so the loss is not hidden under ok=true. A redacted
    # body is an intentional withholding and does not degrade the verdict.
    assert report["ok"]
    assert report["status"] == "degraded"
    withheld = {
        warning["subject"]: (warning["state"], warning["intentional"])
        for warning in report["warnings"]
        if warning["code"] == "payload_not_present"
    }
    assert withheld["note:note-missing"] == ("missing", False)
    assert withheld["note:note-redacted"] == ("redacted", True)

    repair = storage_service.repair_plan(
        runtime_dir, source_id="degraded-synth", dry_run=True
    )
    assert repair["schema"] == "kungfu.storage.repair-plan/v1"
    assert repair["status"] == "degraded"
    assert repair["candidate_count"] == 1
    assert repair["candidates"][0]["code"] == "repair_source_payload"
    assert repair["candidates"][0]["subject"] == "note:note-missing"

    # A fully present source verifies as ok with an ok verdict.
    healthy_dir = tmp_path / "healthy"
    storage_service.write_synthetic_source(
        healthy_dir,
        source_id="healthy-synth",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-09T00:00:00Z",
                "payload": {"body": "a"},
            }
        ],
    )
    healthy = storage_service.fsck(healthy_dir, source_id="healthy-synth")
    assert healthy["ok"]
    assert healthy["status"] == "ok"


def test_source_registry_records_round_trip_through_journal(tmp_path):
    # ADR-0037: source-registry records are Hana-core kernel metadata written to
    # an append-only yijinjing journal; JSON is only an edge projection. This
    # drives the runtime service surface end to end and asserts the journal
    # (not any JSON file) is the authority.
    runtime = kungfu.__binding__.runtime
    runtime_dir = str(tmp_path)

    registered = runtime.run_storage_service_operation(
        "source_register",
        runtime_dir,
        {
            "source_id": "atlas-local",
            "kind": "adapter",
            "coordinate": "/repo/atlas",
            "head": "head-0",
            "register_time": 1000,
        },
    )
    assert registered["record_kind"] == "source_registered"
    assert registered["source_id"] == "atlas-local"
    assert registered["kind"] == "adapter"
    source_uid = registered["source_uid"]
    assert source_uid != 0

    # A second, independent source proves per-source folding.
    runtime.run_storage_service_operation(
        "source_register",
        runtime_dir,
        {"source_id": "runtime-b", "kind": "kungfu_runtime", "register_time": 1001},
    )

    # Head moves forward via an append-only delta record.
    updated = runtime.run_storage_service_operation(
        "source_update_head",
        runtime_dir,
        {
            "source_id": "atlas-local",
            "head": "head-1",
            "first_frame_uid": 10,
            "last_frame_uid": 42,
            "inventory_hash_algo": "sha256",
            "inventory_hash": "abc123",
            "update_time": 2000,
        },
    )
    assert updated["record_kind"] == "source_head_updated"
    assert updated["head"] == "head-1"

    accepted = runtime.run_storage_service_operation(
        "source_record_accepted_range",
        runtime_dir,
        {
            "source_id": "atlas-local",
            "manifest_id": "manifest-1",
            "first_frame_uid": 10,
            "last_frame_uid": 42,
            "status": "ok",
            "accept_time": 3000,
        },
    )
    assert accepted["record_kind"] == "accepted_range_recorded"
    assert accepted["manifest_id"] == "manifest-1"

    listed = runtime.run_storage_service_operation("source_list", runtime_dir, {})
    assert listed["ok"]
    assert listed["authority"] == "yijinjing-journal"
    assert listed["source_count"] == 2
    by_uid = {source["source_uid"]: source for source in listed["sources"]}
    folded = by_uid[source_uid]
    # Current view folds the latest head delta over the registration.
    assert folded["head"] == "head-1"
    assert folded["registered"] is True
    assert folded["accepted_range_count"] == 1

    inspected = runtime.run_storage_service_operation(
        "source_inspect", runtime_dir, {"source_id": "atlas-local"}
    )
    assert inspected["ok"]
    assert inspected["authority"] == "yijinjing-journal"
    assert len(inspected["accepted_ranges"]) == 1
    assert inspected["accepted_ranges"][0]["manifest_id"] == "manifest-1"

    fsck = runtime.run_storage_service_operation(
        "source_registry_fsck", runtime_dir, {}
    )
    assert fsck["ok"]
    assert fsck["status"] == "ok"
    assert fsck["authority"] == "yijinjing-journal"
    assert fsck["checked"]["sources"] == 2

    # Authority is the append-only journal, not a JSON registry file. The legacy
    # JSON registry path (storage/sources.json) is not what these records use.
    assert not (tmp_path / "storage" / "sources.json").exists()


def test_source_registry_fsck_flags_dangling_head_without_registration(tmp_path):
    # A head update for a source that was never registered is dangling producer
    # output; fsck must record it honestly rather than silently dropping it.
    runtime = kungfu.__binding__.runtime
    runtime_dir = str(tmp_path)

    runtime.run_storage_service_operation(
        "source_update_head",
        runtime_dir,
        {"source_id": "ghost", "head": "h", "update_time": 5000},
    )
    fsck = runtime.run_storage_service_operation(
        "source_registry_fsck", runtime_dir, {}
    )
    assert fsck["ok"] is False
    assert fsck["status"] == "failed"
    assert any(err["code"] == "source_registration_missing" for err in fsck["errors"])
