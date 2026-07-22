# SPDX-License-Identifier: Apache-2.0
#
# Episode manifest structural fsck fixtures (ADR-0041 stage 3).
#
# Fold-level checks: seal claims (frame_count / last_frame_uid) verified
# against the folded actual, invalid close status, the append-only tombstone
# path, and unknown/unknown-version record diagnostics.
#
# Deep verification (fsck verify_frames=True): the manifest's attached-frame
# receipts are verified against the actual event journal frames — presence,
# header fields, and recomputed payload/frame checksums (ADR-0023/0028). A
# sealed Episode with a missing or tampered frame fails; an open Episode is
# degraded with the missing side reported.

from __future__ import annotations

import hashlib
import struct
from pathlib import Path

import kungfu
from kungfu.storage import service
from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle

MANIFEST_SUBDIR = Path("journal/system/storage/episode-manifest/live")


def _manifest_journal(runtime_dir: Path) -> Path:
    files = sorted((Path(runtime_dir) / MANIFEST_SUBDIR).glob("*.journal"))
    assert len(files) == 1
    return files[0]


def _event_journals(runtime_dir: Path) -> list[Path]:
    manifest_dir = Path(runtime_dir) / MANIFEST_SUBDIR
    return [
        path
        for path in sorted(Path(runtime_dir).glob("journal/**/*.journal"))
        if path.parent != manifest_dir
    ]


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


def _bump_last_record_schema_version(journal_file: Path, version: int) -> None:
    data = bytearray(journal_file.read_bytes())
    offsets = _walk_frames(data)
    assert offsets, "journal has no published frame"
    last = offsets[-1]
    header_length = struct.unpack_from("<I", data, last + 4)[0]
    struct.pack_into("<I", data, last + header_length, version)
    journal_file.write_bytes(data)


def _flip_last_frame_payload_byte(journal_file: Path) -> None:
    data = bytearray(journal_file.read_bytes())
    offsets = _walk_frames(data)
    assert offsets, "journal has no published frame"
    last = offsets[-1]
    header_length = struct.unpack_from("<I", data, last + 4)[0]
    data[last + header_length] ^= 0xFF
    journal_file.write_bytes(data)


def _begin(runtime_dir: Path, episode_id: int) -> dict:
    return service.episode_begin(
        runtime_dir,
        episode_id=episode_id,
        title=f"episode {episode_id}",
        actor="pytest",
        source="fsck-fixture",
        begin_time=1000 + episode_id,
    )


def _lifecycle(runtime_dir: Path, name: str) -> RuntimeEpisodeLifecycle:
    return RuntimeEpisodeLifecycle(
        runtime_dir=str(runtime_dir),
        namespace="agent",
        name=name,
        title=f"lifecycle {name}",
        actor="pytest",
        source=f"fsck-{name}",
    )


def _issues(fsck: dict, severity: str) -> list[dict]:
    return [issue for issue in fsck["issues"] if issue["severity"] == severity]


def _evidence(qualification: dict, name: str) -> dict:
    return next(row for row in qualification["evidence"] if row["name"] == name)


def _safe_capabilities(qualification: dict) -> set[str]:
    return {row["name"] for row in qualification["capabilities"] if row["safe"] is True}


def test_sealed_claim_mismatch_fails_fsck(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 1)
    service.episode_attach_frame(
        runtime_dir,
        episode_id=1,
        frame_uid=9,
        stream_id=1,
        gen_time=1100,
        carrier_type=1000,
        source=1,
        dest=0,
        data_length=8,
        integrity_version=0,
        payload_checksum=0,
        frame_checksum=0,
    )
    # The seal claims two frames and a last frame the fold never saw.
    service.episode_end(
        runtime_dir, episode_id=1, end_time=1200, last_frame_uid=999, frame_count=2
    )

    fsck = service.fsck(runtime_dir, episode_id=1)
    assert not fsck["ok"]
    assert fsck["status"] == "failed"
    codes = [e["code"] for e in _issues(fsck, "error")]
    assert "episode_seal_frame_count_mismatch" in codes
    assert "episode_seal_last_frame_missing" in codes
    mismatch = next(
        e
        for e in _issues(fsck, "error")
        if e["code"] == "episode_seal_frame_count_mismatch"
    )
    assert mismatch["detail"]["claimed"] == 2
    assert mismatch["detail"]["actual"] == 1


def test_consistent_seal_passes_fsck(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 2)
    service.episode_attach_frame(
        runtime_dir,
        episode_id=2,
        frame_uid=9,
        stream_id=1,
        gen_time=1100,
        carrier_type=1000,
        source=1,
        dest=0,
        data_length=8,
        integrity_version=0,
        payload_checksum=0,
        frame_checksum=0,
    )
    service.episode_end(
        runtime_dir, episode_id=2, end_time=1200, last_frame_uid=9, frame_count=1
    )
    fsck = service.fsck(runtime_dir, episode_id=2)
    assert fsck["ok"]
    assert fsck["status"] == "ok"


def test_tombstone_after_seal_is_intentional_not_duplicate(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 3)
    service.episode_end(
        runtime_dir, episode_id=3, end_time=1200, last_frame_uid=0, frame_count=0
    )
    kungfu.__binding__.runtime.run_storage_service_operation(
        "episode_end",
        str(runtime_dir),
        {"episode_id": "3", "end_time": 1300, "status": "tombstoned"},
    )

    inspected = service.episode_inspect(runtime_dir, episode_id=3)["episode"]
    assert inspected["close"]["status"] == 4

    fsck = service.fsck(runtime_dir, episode_id=3)
    assert fsck["ok"]
    codes = [w["code"] for w in _issues(fsck, "warning")]
    assert "episode_tombstoned" in codes
    assert "episode_closed_duplicate" not in codes


def test_non_tombstone_duplicate_close_still_warns(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 4)
    service.episode_end(
        runtime_dir, episode_id=4, end_time=1200, last_frame_uid=0, frame_count=0
    )
    service.episode_abort(runtime_dir, episode_id=4, end_time=1300, reason="late")
    fsck = service.fsck(runtime_dir, episode_id=4)
    codes = [w["code"] for w in _issues(fsck, "warning")]
    assert "episode_closed_duplicate" in codes
    assert "episode_tombstoned" not in codes


def test_unknown_version_record_is_reported_not_folded(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 5)
    service.episode_heartbeat(
        runtime_dir, episode_id=5, update_time=1100, last_frame_uid=7, frame_count=1
    )
    _bump_last_record_schema_version(_manifest_journal(runtime_dir), 2)

    fsck = service.fsck(runtime_dir, episode_id=5)
    assert fsck["ok"]
    unknown = next(
        w for w in _issues(fsck, "warning") if w["code"] == "manifest_unknown_records"
    )
    assert unknown["detail"]["count"] == 1
    assert fsck["episode_manifest"]["unknown_records"] == 1

    # The newer-version heartbeat stays out of the fold instead of being
    # reinterpreted with the v1 layout.
    inspected = service.episode_inspect(runtime_dir, episode_id=5)["episode"]
    assert len(inspected["records"]) == 1
    assert inspected["heartbeat_seen"] is False


def test_verify_frames_confirms_real_recorded_frames(tmp_path):
    runtime_dir = tmp_path / "runtime"
    lifecycle = _lifecycle(runtime_dir, "worker-ok")
    lifecycle.record_event("test.step", b'{"step":1}', run_id="r1")
    lifecycle.record_event("test.step", b'{"step":2}', run_id="r1")
    lifecycle.close(ok=True)

    unchecked = service.fsck(runtime_dir, episode_id=lifecycle.episode_id)
    assert _evidence(unchecked["qualification"], "frames")["state"] == "not_checked"
    assert _capability(unchecked["qualification"], "replay")["safe"] is False

    fsck = service.fsck(
        runtime_dir, episode_id=lifecycle.episode_id, verify_frames=True
    )
    assert fsck["ok"]
    assert fsck["status"] == "ok"
    assert fsck["checked"]["episode_frames_verified"] == 2
    assert _evidence(fsck["qualification"], "frames")["state"] == "verified"
    assert _capability(fsck["qualification"], "replay")["safe"] is True


def test_verify_frames_fails_sealed_episode_with_missing_journal(tmp_path):
    runtime_dir = tmp_path / "runtime"
    lifecycle = _lifecycle(runtime_dir, "worker-lost")
    lifecycle.record_event("test.step", b'{"step":1}', run_id="r1")
    lifecycle.close(ok=True)

    event_journals = _event_journals(runtime_dir)
    assert event_journals
    for path in event_journals:
        path.unlink()

    fsck = service.fsck(
        runtime_dir, episode_id=lifecycle.episode_id, verify_frames=True
    )
    assert not fsck["ok"]
    assert fsck["status"] == "failed"
    codes = [e["code"] for e in _issues(fsck, "error")]
    assert "episode_attached_frame_missing" in codes
    qualification = fsck["qualification"]
    assert _evidence(qualification, "frames")["state"] == "failed"
    assert "inspect" in _safe_capabilities(qualification)
    assert _capability(qualification, "replay")["safe"] is False
    assert {
        (row["issue_code"], row["action"])
        for row in qualification["repair_prerequisites"]
    } >= {("episode_attached_frame_missing", "fetch_frame")}


def test_verify_frames_degrades_open_episode_with_missing_journal(tmp_path):
    runtime_dir = tmp_path / "runtime"
    lifecycle = _lifecycle(runtime_dir, "worker-open")
    lifecycle.record_event("test.step", b'{"step":1}', run_id="r1")
    # No close: the Episode is interrupted, not sealed.

    for path in _event_journals(runtime_dir):
        path.unlink()

    fsck = service.fsck(
        runtime_dir, episode_id=lifecycle.episode_id, verify_frames=True
    )
    assert fsck["ok"]
    assert fsck["status"] == "degraded"
    assert fsck["degraded"] is True
    codes = [w["code"] for w in _issues(fsck, "warning")]
    assert "episode_attached_frame_missing" in codes
    assert _evidence(fsck["qualification"], "frames")["state"] == "degraded"
    assert "append" in _safe_capabilities(fsck["qualification"])


def test_verify_frames_detects_tampered_payload(tmp_path):
    runtime_dir = tmp_path / "runtime"
    lifecycle = _lifecycle(runtime_dir, "worker-tampered")
    lifecycle.record_event("test.step", b'{"step":1}', run_id="r1")
    lifecycle.close(ok=True)

    event_journals = _event_journals(runtime_dir)
    assert len(event_journals) == 1
    _flip_last_frame_payload_byte(event_journals[0])

    fsck = service.fsck(
        runtime_dir, episode_id=lifecycle.episode_id, verify_frames=True
    )
    assert not fsck["ok"]
    assert fsck["status"] == "failed"
    codes = [e["code"] for e in _issues(fsck, "error")]
    assert "episode_attached_frame_checksum_mismatch" in codes


# ---- stage 4: payload refs resolve through the ADR-0040 content store ----
#
# ref_hash is the resolution key (verified read through the immutable
# content store, namespace "payloads"); ref_id is an edge label. A sealed
# Episode with a missing / mismatched / unaddressable payload ref fails;
# an open Episode is degraded.


def _publish_payload(runtime_dir: Path, raw: bytes) -> str:
    digest = hashlib.sha256(raw).hexdigest()
    service.write_payload_bytes(runtime_dir, digest, raw)
    return digest


def _attach_payload_ref(runtime_dir: Path, episode_id: int, ref_hash: str) -> None:
    service.episode_attach_ref(
        runtime_dir,
        episode_id=episode_id,
        ref_kind="payload",
        ref_id="fixtures/payload.bin",
        ref_hash=ref_hash,
    )


def _seal(runtime_dir: Path, episode_id: int) -> None:
    service.episode_end(
        runtime_dir,
        episode_id=episode_id,
        end_time=2000,
        frame_count=0,
        reason="done",
    )


def _payload_object(runtime_dir: Path, digest: str) -> Path:
    return Path(runtime_dir) / "storage" / "payloads" / digest[:2] / digest


def test_published_payload_ref_verifies_through_content_store(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 41)
    digest = _publish_payload(runtime_dir, b"stage-4 payload body")
    _attach_payload_ref(runtime_dir, 41, f"sha256:{digest}")
    _seal(runtime_dir, 41)

    fsck = service.fsck(runtime_dir, episode_id=41)
    assert fsck["ok"]
    assert fsck["status"] == "ok"

    inspected = service.episode_inspect(runtime_dir, episode_id=41)
    payload_deps = [
        dep
        for dep in inspected["causal_graph"]["dependencies"]
        if dep["kind"] == "payload"
    ]
    assert payload_deps and payload_deps[0]["status"] == "present"


def test_bare_hex_ref_hash_is_accepted(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 42)
    digest = _publish_payload(runtime_dir, b"bare hex producer compat")
    _attach_payload_ref(runtime_dir, 42, digest)
    _seal(runtime_dir, 42)

    fsck = service.fsck(runtime_dir, episode_id=42)
    assert fsck["ok"]
    assert fsck["status"] == "ok"


def test_sealed_missing_payload_ref_fails_fsck(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 43)
    absent = hashlib.sha256(b"never published").hexdigest()
    _attach_payload_ref(runtime_dir, 43, f"sha256:{absent}")
    _seal(runtime_dir, 43)

    fsck = service.fsck(runtime_dir, episode_id=43)
    assert not fsck["ok"]
    assert fsck["status"] == "failed"
    assert "episode_payload_ref_missing" in [e["code"] for e in _issues(fsck, "error")]


def test_open_missing_payload_ref_degrades_fsck(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 44)
    absent = hashlib.sha256(b"never published either").hexdigest()
    _attach_payload_ref(runtime_dir, 44, f"sha256:{absent}")

    fsck = service.fsck(runtime_dir, episode_id=44)
    assert fsck["ok"]
    assert fsck["status"] == "degraded"
    assert "episode_payload_ref_missing" in [
        w["code"] for w in _issues(fsck, "warning")
    ]


def test_sealed_tampered_payload_fails_fsck(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 45)
    raw = b"authentic payload bytes"
    digest = _publish_payload(runtime_dir, raw)
    _attach_payload_ref(runtime_dir, 45, f"sha256:{digest}")
    _seal(runtime_dir, 45)

    # same-length corruption: presence and length survive, content does not
    tampered = b"Xuthentic payload bytes"
    _payload_object(runtime_dir, digest).write_bytes(tampered)

    fsck = service.fsck(runtime_dir, episode_id=45)
    assert not fsck["ok"]
    assert fsck["status"] == "failed"
    assert "episode_payload_ref_hash_mismatch" in [
        e["code"] for e in _issues(fsck, "error")
    ]


def test_unaddressable_ref_hash_is_reported(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 46)
    _attach_payload_ref(runtime_dir, 46, "sha256:not-a-digest")

    fsck = service.fsck(runtime_dir, episode_id=46)
    assert fsck["ok"]
    assert fsck["status"] == "degraded"
    assert "episode_payload_ref_hash_invalid" in [
        w["code"] for w in _issues(fsck, "warning")
    ]


def test_lifecycle_attach_publishes_into_content_store(tmp_path):
    runtime_dir = tmp_path / "runtime"
    lifecycle = _lifecycle(runtime_dir, "worker-payload")
    payload_file = tmp_path / "artifact.json"
    payload_file.write_text('{"result": "ok"}', encoding="utf-8")
    lifecycle.attach_payload_ref(str(payload_file))
    lifecycle.close(ok=True)

    digest = hashlib.sha256(payload_file.read_bytes()).hexdigest()
    assert _payload_object(runtime_dir, digest).exists()

    fsck = service.fsck(runtime_dir, episode_id=lifecycle.episode_id)
    assert fsck["ok"]
    assert fsck["status"] == "ok"


# ---- ADR-0042 Capability Contract v1 ----


def _capability(qualification: dict, name: str) -> dict:
    return next(row for row in qualification["capabilities"] if row["name"] == name)


def test_healthy_sealed_episode_emits_versioned_safe_capabilities(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 51)
    _seal(runtime_dir, 51)

    fsck = service.fsck(runtime_dir, episode_id=51)
    qualification = fsck["qualification"]
    assert qualification["schema"] == "kungfu.episode.qualification/v1"
    assert qualification["policy_source"] == "cpp-typed-fold-fsck"
    assert qualification["lifecycle"] == "ended"
    assert qualification["status"] == "ok"
    assert _evidence(qualification, "manifest_records")["state"] == "verified"
    assert _evidence(qualification, "frames")["state"] == "not_applicable"
    assert _evidence(qualification, "content")["state"] == "not_applicable"
    assert {"inspect", "fsck", "export_evidence", "replay", "depend_on"} <= set(
        _safe_capabilities(qualification)
    )
    assert _capability(qualification, "append")["safe"] is False
    assert _capability(qualification, "append")["blocked_by"] == ["lifecycle=open"]

    inspected = service.episode_inspect(runtime_dir, episode_id=51)
    assert inspected["qualification"]["status"] == qualification["status"]
    assert _safe_capabilities(inspected["qualification"]) == _safe_capabilities(
        qualification
    )


def test_open_degradation_preserves_append_and_evidence_export(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 52)
    absent = hashlib.sha256(b"capability missing payload").hexdigest()
    _attach_payload_ref(runtime_dir, 52, f"sha256:{absent}")

    qualification = service.fsck(runtime_dir, episode_id=52)["qualification"]
    assert qualification["status"] == "degraded"
    assert _evidence(qualification, "content")["state"] == "degraded"
    assert {"inspect", "export_evidence", "append", "plan_repair"} <= set(
        _safe_capabilities(qualification)
    )
    assert _capability(qualification, "replay")["safe"] is False
    assert "lifecycle=ended" in _capability(qualification, "replay")["blocked_by"]
    assert (
        "content=verified|not_applicable"
        in _capability(qualification, "replay")["blocked_by"]
    )
    assert {
        (row["issue_code"], row["action"])
        for row in qualification["repair_prerequisites"]
    } >= {("episode_payload_ref_missing", "fetch_payload_by_hash")}


def test_failed_episode_contracts_consuming_capabilities_not_forensics(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 53)
    absent = hashlib.sha256(b"sealed capability missing payload").hexdigest()
    _attach_payload_ref(runtime_dir, 53, f"sha256:{absent}")
    _seal(runtime_dir, 53)

    qualification = service.fsck(runtime_dir, episode_id=53)["qualification"]
    assert qualification["status"] == "failed"
    assert _evidence(qualification, "content")["state"] == "failed"
    assert {"inspect", "fsck", "export_evidence", "plan_repair"} <= set(
        _safe_capabilities(qualification)
    )
    assert _capability(qualification, "replay")["safe"] is False
    assert _capability(qualification, "depend_on")["safe"] is False


def test_unverified_schema_claim_contracts_decode_consumers(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 55)
    service.episode_attach_ref(
        runtime_dir,
        episode_id=55,
        ref_kind="schema",
        ref_id="qualification/schema-v1",
        ref_hash="sha256:" + "1" * 64,
    )
    _seal(runtime_dir, 55)

    qualification = service.fsck(runtime_dir, episode_id=55)["qualification"]
    assert qualification["status"] == "ok"
    assert _evidence(qualification, "schemas")["state"] == "not_checked"
    assert "export_evidence" in _safe_capabilities(qualification)
    assert _capability(qualification, "replay")["safe"] is False
    assert (
        "schemas=verified|not_applicable"
        in _capability(qualification, "replay")["blocked_by"]
    )


def test_missing_episode_advertises_no_episode_capability(tmp_path):
    qualification = service.fsck(tmp_path / "runtime", episode_id=999)["qualification"]
    assert qualification["lifecycle"] == "missing"
    assert qualification["status"] == "failed"
    assert _safe_capabilities(qualification) == set()


def test_episode_qualification_typed_view_exposes_complete_contract(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _begin(runtime_dir, 54)
    _seal(runtime_dir, 54)
    qualification = service.fsck(runtime_dir, episode_id=54)["qualification"]
    assert {row["name"] for row in qualification["evidence"]} == {
        "manifest_records",
        "manifest_integrity",
        "causal_closure",
        "content",
        "frames",
        "schemas",
        "projection",
    }
    assert {row["name"] for row in qualification["capabilities"]} == {
        "inspect",
        "fsck",
        "export_evidence",
        "plan_repair",
        "rebuild_projection",
        "append",
        "replay",
        "depend_on",
    }
    assert all("required_evidence" in row for row in qualification["capabilities"])
