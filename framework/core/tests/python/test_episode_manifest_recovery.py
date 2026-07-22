# SPDX-License-Identifier: Apache-2.0
#
# Episode manifest writer-guard and crash-recovery fixtures.
#
# These are the stage 2 fixtures required by ADR-0041 and
# docs/episode-manifest-trust-boundary.md §3: the data-root-scoped writer
# guard (acquire-or-fail), the enumerated crash points C1-C6 as journal-state
# constructions, and the explicit resume-or-abort recovery operation.
# Automatic lifecycle wiring must not land while any of these fail.

from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

from kungfu.storage import service


MANIFEST_SUBDIR = Path("journal/system/storage/episode-manifest/live")


def _manifest_dir(runtime_dir: Path) -> Path:
    return Path(runtime_dir) / MANIFEST_SUBDIR


def _lock_path(runtime_dir: Path) -> Path:
    return _manifest_dir(runtime_dir) / "writer.lock"


def _journal_files(runtime_dir: Path) -> list[Path]:
    return sorted(_manifest_dir(runtime_dir).glob("*.journal"))


def _zero_last_frame_length(journal_file: Path) -> None:
    """Simulate a crash mid-append: strip the publication token of the last
    visible frame. Frame `length` is written last (the ADR-0001 publication
    token), so a frame whose length is zero is exactly the on-disk state a
    torn append leaves behind."""
    data = bytearray(journal_file.read_bytes())
    page_header_length = struct.unpack_from("<I", data, 4)[0]
    offset = page_header_length
    last_frame_offset = None
    while offset + 4 <= len(data):
        frame_length = struct.unpack_from("<I", data, offset)[0]
        if frame_length == 0:
            break
        last_frame_offset = offset
        offset += frame_length
    assert last_frame_offset is not None, "journal has no published frame to tear"
    struct.pack_into("<I", data, last_frame_offset, 0)
    journal_file.write_bytes(data)


def _begin(runtime_dir: Path, episode_id: int, location_uid: int = 0) -> dict:
    return service.episode_begin(
        runtime_dir,
        episode_id=episode_id,
        title=f"episode {episode_id}",
        actor="pytest",
        source="recovery-fixture",
        location_uid=location_uid,
        begin_time=1000 + episode_id,
    )


def test_writer_guard_lock_file_lives_at_declared_path(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 1)
    assert _lock_path(runtime_dir).exists()


@pytest.mark.skipif(sys.platform == "win32", reason="fixture holds the guard via flock")
def test_writer_guard_blocks_concurrent_writer(tmp_path):
    import fcntl

    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 1)

    with open(_lock_path(runtime_dir), "a+") as holder:
        fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(RuntimeError, match="manifest_writer_busy"):
            service.episode_heartbeat(runtime_dir, episode_id=1, update_time=1100)
        with pytest.raises(RuntimeError, match="manifest_writer_busy"):
            service.episode_recover(runtime_dir)
        fcntl.flock(holder.fileno(), fcntl.LOCK_UN)

    heartbeat = service.episode_heartbeat(runtime_dir, episode_id=1, update_time=1200)
    assert heartbeat["episode_id"] == 1
    assert heartbeat["update_time"] == 1200
    # Reads never take the guard.
    assert len(service.episode_list(runtime_dir)["episodes"]) == 1


def test_c1_recover_on_empty_manifest_is_a_no_op(tmp_path):
    runtime_dir = tmp_path / "runtime"
    report = service.episode_recover(runtime_dir)
    assert report["runtime_dir"] == str(runtime_dir)
    assert report["recovered"] == []
    assert report["skipped_open"] == []
    assert service.fsck(runtime_dir)["ok"]


def test_c2_interrupted_open_episode_recovers_as_aborted(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 2)

    # The interrupted Episode stays open; it is never presented as complete.
    listed = service.episode_list(runtime_dir)["episodes"][0]
    assert listed["opened"] is True
    assert listed["closed"] is False
    assert service.fsck(runtime_dir)["ok"]

    report = service.episode_recover(runtime_dir, reason="crash recovery")
    assert len(report["recovered"]) == 1
    recovered = report["recovered"][0]
    assert recovered["close"]["episode_id"] == 2
    assert recovered["close"]["status"] == 3
    assert recovered["close"]["reason"] == "crash recovery"
    assert recovered["content_root"]["episode_id"] == 2

    inspected = service.episode_inspect(runtime_dir, episode_id=2)["episode"]
    assert inspected["close"]["status"] == 3
    assert inspected["closed"] is True

    # Recovery is idempotent: nothing left open.
    assert service.episode_recover(runtime_dir)["recovered"] == []


def test_c3_resume_reattach_is_a_detectable_duplicate(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 3)
    frame = dict(
        episode_id=3,
        frame_uid=77,
        trigger_frame_uid=0,
        stream_id=1,
        gen_time=1300,
        carrier_type=1000,
        source=1,
        dest=0,
        data_length=8,
        integrity_version=2,
        payload_checksum=11,
        frame_checksum=22,
    )
    service.episode_attach_frame(runtime_dir, **frame)
    # A resuming writer that cannot prove its last attach landed re-attaches;
    # the primary key (episode_id, frame_uid) makes that a visible duplicate,
    # not silent corruption.
    service.episode_attach_frame(runtime_dir, **frame)

    fsck = service.fsck(runtime_dir, episode_id=3)
    assert fsck["ok"]
    warnings = [
        issue
        for issue in fsck["issues"]
        if issue["severity"] == "warning" and issue["code"] == "episode_frame_duplicate"
    ]
    assert len(warnings) == 1
    assert warnings[0]["detail"]["frame_uid"] == 77


def test_c4_recover_scopes_to_the_declared_owner_location(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 4, location_uid=111)
    _begin(runtime_dir, 5, location_uid=222)

    report = service.episode_recover(runtime_dir, location_uid=111)
    assert len(report["recovered"]) == 1
    assert report["recovered"][0]["close"]["episode_id"] == 4
    # The other location's open Episode is reported, never mutated.
    assert len(report["skipped_open"]) == 1
    assert report["skipped_open"][0] == {"episode_id": 5, "location_uid": 222}
    assert (
        service.episode_inspect(runtime_dir, episode_id=5)["episode"]["closed"] is False
    )

    report = service.episode_recover(runtime_dir)
    assert len(report["recovered"]) == 1
    assert report["recovered"][0]["close"]["episode_id"] == 5


def test_recover_rejects_changed_manifest_precondition(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 8, location_uid=333)
    inspected = service.episode_inspect(runtime_dir, episode_id=8)["episode"]
    expected_manifest_frame_uid = inspected["records"][-1]["manifest_frame_uid"]

    service.episode_heartbeat(
        runtime_dir,
        episode_id=8,
        location_uid=333,
        update_time=2000,
        note="writer is still live",
    )

    with pytest.raises(RuntimeError, match="episode_recovery_precondition_changed"):
        service.episode_recover(
            runtime_dir,
            episode_id=8,
            location_uid=333,
            expected_manifest_frame_uid=expected_manifest_frame_uid,
        )
    assert (
        service.episode_inspect(runtime_dir, episode_id=8)["episode"]["closed"] is False
    )


def test_c5_torn_manifest_tail_never_presents_a_partial_seal(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 6)
    service.episode_attach_frame(
        runtime_dir,
        episode_id=6,
        frame_uid=88,
        stream_id=1,
        gen_time=1400,
        carrier_type=1000,
        source=1,
        dest=0,
        data_length=8,
        integrity_version=2,
        payload_checksum=1,
        frame_checksum=2,
    )
    service.episode_end(
        runtime_dir, episode_id=6, end_time=1500, last_frame_uid=88, frame_count=1
    )
    assert (
        service.episode_inspect(runtime_dir, episode_id=6)["episode"]["close"]["status"]
        == 2
    )

    journal_files = _journal_files(runtime_dir)
    assert len(journal_files) == 1

    # ADR-0043 publication order: the seal appends EpisodeClosed, then the
    # content root. Crash point A — the root append is lost: the Episode
    # stays honestly sealed with its identity reported absent, never failed.
    _zero_last_frame_length(journal_files[0])
    inspected = service.episode_inspect(runtime_dir, episode_id=6)
    assert inspected["episode"]["close"]["status"] == 2
    assert inspected["content_root"]["status"] == 2
    fsck = service.fsck(runtime_dir, episode_id=6)
    assert fsck["ok"]

    # Crash point B — the seal itself is torn: the Episode regresses to open
    # instead of surfacing as a sealed-but-unverified object, nothing crashes.
    _zero_last_frame_length(journal_files[0])
    inspected = service.episode_inspect(runtime_dir, episode_id=6)["episode"]
    assert inspected["opened"] is True
    assert inspected["closed"] is False
    assert len(inspected["records"]) == 2
    fsck = service.fsck(runtime_dir, episode_id=6)
    assert fsck["ok"]

    # The recovery pass turns the interrupted Episode into an honest abort.
    report = service.episode_recover(runtime_dir, reason="torn seal recovered")
    assert len(report["recovered"]) == 1
    assert (
        service.episode_inspect(runtime_dir, episode_id=6)["episode"]["close"]["status"]
        == 3
    )


def test_c6_sealed_episode_is_stable_and_recover_leaves_it_alone(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 7)
    service.episode_end(
        runtime_dir, episode_id=7, end_time=1600, last_frame_uid=0, frame_count=0
    )

    assert service.episode_recover(runtime_dir)["recovered"] == []

    # Append-only duplicate close stays visible as a warning; the last close
    # wins the folded status.
    service.episode_abort(runtime_dir, episode_id=7, end_time=1700, reason="late")
    fsck = service.fsck(runtime_dir, episode_id=7)
    codes = [
        issue["code"] for issue in fsck["issues"] if issue["severity"] == "warning"
    ]
    assert "episode_closed_duplicate" in codes
    assert (
        service.episode_inspect(runtime_dir, episode_id=7)["episode"]["close"]["status"]
        == 3
    )
