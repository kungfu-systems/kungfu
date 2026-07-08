# SPDX-License-Identifier: Apache-2.0

import json
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
    assert set(capabilities["operations"]) == {
        "status",
        "fsck",
        "export_bundle",
        "import_bundle",
        "rebuild_index",
        "gc_plan",
        "compact_plan",
        "verify_sync",
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
        "scope": "source",
        "source_id": "local-synth",
        "dry_run": True,
        "verify": True,
        "range": {},
        "artifact_uri": "",
    }


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

    calls = []

    def spy_request(operation, runtime_dir_arg, options):
        calls.append((operation, runtime_dir_arg, dict(options)))
        return {
            "schema": "kungfu.runtime.storage-service/v1",
            "owner": "libkungfu",
            "operation": operation,
            "runtime_dir": runtime_dir_arg,
        }

    monkeypatch.setattr(
        kungfu.__binding__.runtime,
        "make_storage_service_request",
        spy_request,
    )

    storage_service.status(runtime_dir, source_id="local-synth")
    storage_service.fsck(runtime_dir, source_id="local-synth")
    storage_service.rebuild_index(runtime_dir, source_id="local-synth", dry_run=True)
    storage_service.gc_plan(runtime_dir, dry_run=True)
    storage_service.compact_plan(runtime_dir, dry_run=True)
    storage_service.build_export_bundle(runtime_dir, source_id="local-synth")
    storage_service.import_bundle(
        tmp_path / "imported-runtime",
        storage_service.build_export_bundle(runtime_dir, source_id="local-synth"),
    )
    storage_service.verify_local_sync(runtime_dir, source_id="local-synth")

    entered = {operation for operation, _, _ in calls}
    assert {
        "status",
        "fsck",
        "rebuild_index",
        "gc_plan",
        "compact_plan",
        "export_bundle",
        "import_bundle",
        "verify_sync",
    } <= entered


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
    assert storage_service.status(runtime_dir, source_id="local-synth")["ok"]

    orphan_hash = "0" * 64
    storage_service.write_payload_bytes(runtime_dir, orphan_hash, b'{"orphan":true}')
    gc = storage_service.gc_plan(runtime_dir, dry_run=True)
    assert gc["candidate_count"] == 1
    assert gc["candidates"][0]["payload_hash"] == orphan_hash
    assert gc["candidates"][0]["safe_to_delete"] is True
    assert storage_service.payload_path(runtime_dir, orphan_hash).exists()

    compact = storage_service.compact_plan(runtime_dir, dry_run=True)
    assert compact["ok"]
    assert compact["gc"]["candidate_count"] == 1
    assert any(row["name"] == "backend-compact" for row in compact["unsupported"])

    fsck = storage_service.fsck(runtime_dir)
    assert fsck["ok"]
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
