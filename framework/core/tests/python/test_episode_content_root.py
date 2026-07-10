# SPDX-License-Identifier: Apache-2.0
#
# ADR-0043 Episode identity fixtures: the sealed content root.
#
# The seal path commits one EpisodeRootCommitted record — a linear hash chain
# over the Episode's owned claim sequence (first open, every frame/ref attach
# in append order, the first terminal close). These fixtures prove the four
# contract properties: determinism (re-fold yields the same root), sensitivity
# (covered claims change the root, heartbeats do not), honest absence (a
# sealed Episode whose root append was lost stays healthy with root absent),
# and cross-store invariance (re-appending identical claims in a fresh runtime
# dir yields the same root).

from __future__ import annotations

import struct
from pathlib import Path

from kungfu.storage import service

MANIFEST_SUBDIR = Path("journal/system/storage/episode-manifest/live")
LOCATION_UID = 777


def _manifest_journal(runtime_dir: Path) -> Path:
    files = sorted((Path(runtime_dir) / MANIFEST_SUBDIR).glob("*.journal"))
    assert len(files) == 1
    return files[0]


def _walk_frames(data: bytearray) -> list[int]:
    page_header_length = struct.unpack_from("<I", data, 4)[0]
    offsets = []
    offset = page_header_length
    while offset + 4 <= len(data):
        frame_length = struct.unpack_from("<I", data, offset)[0]
        if frame_length == 0:
            break
        offsets.append(offset)
        offset += frame_length
    return offsets


def _drop_last_frame(journal_file: Path) -> None:
    # Zero the last frame's length header: the reader stops there, exactly the
    # shape of a crash between the seal and its root append.
    data = bytearray(journal_file.read_bytes())
    offsets = _walk_frames(data)
    assert offsets, "journal has no published frame"
    struct.pack_into("<I", data, offsets[-1], 0)
    journal_file.write_bytes(data)


def _tamper_recorded_root(journal_file: Path, recorded_hex: str) -> None:
    data = bytearray(journal_file.read_bytes())
    needle = recorded_hex.encode()
    index = data.find(needle)
    assert index >= 0, "recorded root value not found in manifest journal"
    original = chr(data[index])
    data[index] = ord("0" if original != "0" else "1")
    journal_file.write_bytes(data)


def _build_episode(
    runtime_dir: Path,
    *,
    episode_id: int = 7,
    heartbeats: tuple[int, ...] = (),
    extra_frame: bool = False,
    seal: bool = True,
) -> None:
    # Every field explicit and deterministic, so replaying this sequence in a
    # fresh runtime dir records byte-identical claims.
    service.episode_begin(
        runtime_dir,
        episode_id=episode_id,
        title="identity fixture",
        actor="pytest",
        source="content-root",
        location_uid=LOCATION_UID,
        begin_time=1000,
    )
    service.episode_attach_frame(
        runtime_dir,
        episode_id=episode_id,
        frame_uid=11,
        location_uid=LOCATION_UID,
        stream_id=1,
        gen_time=1100,
        carrier_type=1000,
        source=1,
        dest=0,
        data_length=16,
        integrity_version=2,
        payload_checksum=12345,
        frame_checksum=67890,
    )
    for update_time in heartbeats:
        service.episode_heartbeat(
            runtime_dir,
            episode_id=episode_id,
            location_uid=LOCATION_UID,
            update_time=update_time,
            last_frame_uid=11,
            frame_count=1,
        )
    if extra_frame:
        service.episode_attach_frame(
            runtime_dir,
            episode_id=episode_id,
            frame_uid=12,
            location_uid=LOCATION_UID,
            stream_id=1,
            gen_time=1150,
            carrier_type=1000,
            source=1,
            dest=0,
            data_length=16,
            integrity_version=2,
            payload_checksum=12346,
            frame_checksum=67891,
        )
    service.episode_attach_ref(
        runtime_dir,
        episode_id=episode_id,
        ref_kind="input_frame",
        ref_uid=5,
        ref_id="fixtures/input",
        ref_hash="",
        location_uid=LOCATION_UID,
        update_time=1200,
    )
    if seal:
        service.episode_end(
            runtime_dir,
            episode_id=episode_id,
            location_uid=LOCATION_UID,
            end_time=2000,
            last_frame_uid=12 if extra_frame else 11,
            frame_count=2 if extra_frame else 1,
            reason="done",
        )


def _root_of(runtime_dir: Path, episode_id: int = 7) -> dict:
    return service.episode_inspect(runtime_dir, episode_id=episode_id)["content_root"]


def test_seal_commits_a_verified_deterministic_root(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _build_episode(runtime_dir)

    root = _root_of(runtime_dir)
    assert root["status"] == "verified"
    assert root["match"] is True
    assert root["recorded"]["record_kind"] == "episode_root_committed"
    assert root["recorded"]["algorithm"] == "sha256"
    assert root["recorded"]["root_value"] == root["computed"]["value"]
    # open + frame + ref + close are covered; heartbeats are not claims
    assert root["recorded"]["covered_record_count"] == 4

    # re-folding the same journal derives the same identity
    again = _root_of(runtime_dir)
    assert again["computed"]["value"] == root["computed"]["value"]

    # identity surfaces on the summary for list/inspect/fsck consumers
    episode = service.episode_inspect(runtime_dir, episode_id=7)["episode"]
    assert episode["content_root"] == root["recorded"]["root_value"]

    fsck = service.fsck(runtime_dir, episode_id=7)
    assert fsck["ok"]


def test_heartbeats_do_not_change_identity_but_claims_do(tmp_path):
    quiet = tmp_path / "quiet"
    noisy = tmp_path / "noisy"
    heavier = tmp_path / "heavier"
    _build_episode(quiet)
    _build_episode(noisy, heartbeats=(1300, 1400, 1500))
    _build_episode(heavier, extra_frame=True)

    quiet_root = _root_of(quiet)["recorded"]["root_value"]
    noisy_root = _root_of(noisy)["recorded"]["root_value"]
    heavier_root = _root_of(heavier)["recorded"]["root_value"]

    assert quiet_root == noisy_root
    assert heavier_root != quiet_root
    assert _root_of(heavier)["recorded"]["covered_record_count"] == 5


def test_identical_claims_in_a_fresh_store_yield_the_same_root(tmp_path):
    # ADR-0043 migration invariance: identity survives verbatim re-append
    # into another runtime dir.
    first = tmp_path / "first"
    second = tmp_path / "second"
    _build_episode(first)
    _build_episode(second)
    assert (
        _root_of(first)["recorded"]["root_value"]
        == _root_of(second)["recorded"]["root_value"]
    )


def test_sealed_episode_with_lost_root_reports_absent(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _build_episode(runtime_dir)
    _drop_last_frame(_manifest_journal(runtime_dir))

    root = _root_of(runtime_dir)
    assert root["status"] == "absent"
    assert root["recorded"] is None
    # the fold can still derive the identity for inspection or later backfill
    assert root["computed"]["value"]

    # absence is honest, not a failure
    fsck = service.fsck(runtime_dir, episode_id=7)
    assert fsck["ok"]


def test_tampered_root_fails_fsck(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _build_episode(runtime_dir)
    recorded = _root_of(runtime_dir)["recorded"]["root_value"]
    _tamper_recorded_root(_manifest_journal(runtime_dir), recorded)

    root = _root_of(runtime_dir)
    assert root["status"] == "mismatch"
    assert root["match"] is False

    fsck = service.fsck(runtime_dir, episode_id=7)
    assert not fsck["ok"]
    assert fsck["status"] == "failed"
    codes = [e["code"] for e in fsck["errors"]]
    assert "episode_root_mismatch" in codes


def test_open_episode_has_no_identity_yet(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _build_episode(runtime_dir, seal=False)

    root = _root_of(runtime_dir)
    assert root["status"] == "undefined"
    assert root["recorded"] is None
    assert root["computed"] is None


def test_abort_seals_identity_too(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _build_episode(runtime_dir, seal=False)
    service.episode_abort(
        runtime_dir,
        episode_id=7,
        location_uid=LOCATION_UID,
        end_time=2000,
        reason="interrupted",
    )
    root = _root_of(runtime_dir)
    assert root["status"] == "verified"


def test_projection_carries_the_root_record(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _build_episode(runtime_dir)
    rebuilt = service.episode_projection_rebuild(runtime_dir)
    assert rebuilt["ok"]
    assert rebuilt["rows"]["episode_root_committed"] == 1
