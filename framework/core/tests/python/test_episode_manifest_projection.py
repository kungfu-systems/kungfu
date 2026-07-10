# SPDX-License-Identifier: Apache-2.0
#
# Episode manifest SQLite projection fixtures (ADR-0041 stage 5).
#
# The manifest journal is the authority; the projection is a rebuildable
# derived view for indexed / SQL access. Fsck verifies the projection against
# the journal's distinct-primary-key counts: drift degrades, an absent
# projection is an honest distinct state, and a rebuild converges back to ok.

from __future__ import annotations

import sqlite3
from pathlib import Path

from kungfu.storage import service


PROJECTION_SUBPATH = Path("storage/projections/episode-manifest.sqlite")


def _seed_episode(runtime_dir: Path, episode_id: int) -> None:
    service.episode_begin(
        runtime_dir,
        episode_id=episode_id,
        title=f"episode {episode_id}",
        actor="pytest",
        source="projection-fixture",
        begin_time=1000 + episode_id,
    )
    service.episode_attach_frame(
        runtime_dir,
        episode_id=episode_id,
        frame_uid=episode_id * 100,
        stream_id=1,
        gen_time=1100 + episode_id,
        carrier_type=1000,
        source=1,
        dest=0,
        data_length=8,
        integrity_version=0,
        payload_checksum=0,
        frame_checksum=0,
    )
    payload = Path(runtime_dir) / "payloads" / f"{episode_id}.bin"
    payload.parent.mkdir(parents=True, exist_ok=True)
    payload.write_bytes(b"payload")
    service.episode_attach_ref(
        runtime_dir,
        episode_id=episode_id,
        ref_kind="payload",
        ref_id=f"payloads/{episode_id}.bin",
        ref_hash="sha256:test",
    )
    service.episode_end(
        runtime_dir,
        episode_id=episode_id,
        end_time=1200 + episode_id,
        last_frame_uid=episode_id * 100,
        frame_count=1,
    )


def test_rebuild_builds_sqlite_at_declared_path(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _seed_episode(runtime_dir, 1)
    _seed_episode(runtime_dir, 2)

    report = service.episode_projection_rebuild(runtime_dir)
    assert report["ok"]
    assert report["authority"] == "yijinjing-journal"
    assert report["rows"] == {
        "episode_open": 2,
        "episode_heartbeat": 0,
        "episode_frame_attached": 2,
        "episode_ref_attached": 2,
        "episode_closed": 2,
    }
    assert (runtime_dir / PROJECTION_SUBPATH).exists()

    # The projection is plain SQLite: indexed / SQL access works without the
    # journal reader.
    with sqlite3.connect(runtime_dir / PROJECTION_SUBPATH) as db:
        tables = {
            row[0]
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "EpisodeOpen" in tables
        count = db.execute("SELECT COUNT(*) FROM EpisodeOpen").fetchone()[0]
        assert count == 2


def test_fsck_reports_absent_then_ok_then_drift(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _seed_episode(runtime_dir, 3)

    # Absent projection: honest distinct state, not a failure.
    fsck = service.fsck(runtime_dir, episode_id=3)
    assert fsck["ok"]
    assert fsck["status"] == "ok"
    assert fsck["episode_projection"]["status"] == "absent"
    assert fsck["episode_projection"]["projection_present"] is False

    # Rebuilt projection verifies clean.
    service.episode_projection_rebuild(runtime_dir)
    fsck = service.fsck(runtime_dir, episode_id=3)
    assert fsck["ok"]
    assert fsck["status"] == "ok"
    assert fsck["episode_projection"]["status"] == "ok"

    # New journal records after the rebuild: the projection has drifted; fsck
    # degrades but does not fail the journal, and a rebuild converges.
    _seed_episode(runtime_dir, 4)
    fsck = service.fsck(runtime_dir, episode_id=4)
    assert fsck["status"] == "degraded"
    assert fsck["degraded"] is True
    assert fsck["episode_projection"]["status"] == "degraded"
    drift_tables = {d["table"] for d in fsck["episode_projection"]["drift"]}
    assert "episode_open" in drift_tables

    service.episode_projection_rebuild(runtime_dir)
    fsck = service.fsck(runtime_dir, episode_id=4)
    assert fsck["ok"]
    assert fsck["status"] == "ok"


def test_rebuild_keeps_first_open_identity(tmp_path):
    runtime_dir = tmp_path / "runtime"
    service.episode_begin(
        runtime_dir,
        episode_id=5,
        title="first identity",
        actor="pytest",
        source="projection-fixture",
        begin_time=1000,
    )
    # A duplicate open is an anomaly the fold resolves first-wins; the
    # projection must agree with the fold, not with raw last-write-wins.
    service.episode_begin(
        runtime_dir,
        episode_id=5,
        title="second identity",
        actor="pytest",
        source="projection-fixture",
        begin_time=2000,
    )

    service.episode_projection_rebuild(runtime_dir)
    with sqlite3.connect(Path(runtime_dir) / PROJECTION_SUBPATH) as db:
        rows = db.execute(
            "SELECT title, begin_time FROM EpisodeOpen WHERE episode_id = 5"
        ).fetchall()
    assert rows == [("first identity", 1000)]


def test_rebuild_on_empty_manifest_is_ok(tmp_path):
    runtime_dir = tmp_path / "runtime"
    report = service.episode_projection_rebuild(runtime_dir)
    assert report["ok"]
    assert report["journal_records"] == 0
    fsck = service.fsck(runtime_dir, episode_id=0)
    # episode_id=0 keeps the all-scope; the projection state for an empty
    # manifest verifies clean either way.
    assert fsck["ok"]
