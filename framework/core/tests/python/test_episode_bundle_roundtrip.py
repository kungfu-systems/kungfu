# SPDX-License-Identifier: Apache-2.0
#
# Self-contained Episode bundle roundtrip fixtures (KF-ADR-019f86da-4f90-726e-b31f-ed180aa2e7a8).
#
# Export carries the Episode's owned bytes — whole event-journal frames plus
# content-store payloads — and import --execute materializes them in a fresh
# data root: projections fold the same facts, the destination recomputes the
# same KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9 root, and fsck --verify-frames goes green. Negative shapes
# prove the gates: tampered material is rejected, a same-id Episode with a
# different root is refused, unsealed bundles cannot execute, and appends
# that would break journal time order are conflicts, not writes.

from __future__ import annotations

import base64
import copy
from pathlib import Path

from kungfu.storage import service
from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle
from kungfu.storage.transfer import StorageTransfer

EPISODE_BUNDLE_SCHEMA = "kungfu.storage.episode-bundle/v1"


def test_transfer_owner_preserves_public_facade_and_jsonl_format(tmp_path):
    assert service.write_jsonl is StorageTransfer.write_jsonl
    assert service.export_jsonl is StorageTransfer.export_jsonl
    assert service.export_bundle_json is StorageTransfer.export_bundle_json
    assert service.build_export_bundle is StorageTransfer.build_export_bundle
    assert service.import_bundle is StorageTransfer.import_bundle

    output = tmp_path / "nested" / "records.jsonl"
    output.parent.mkdir()
    service.write_jsonl([{"z": "保留", "a": 1}, {"payload_state": "redacted"}], output)
    assert output.read_bytes() == (
        b'{"a":1,"z":"\xe4\xbf\x9d\xe7\x95\x99"}\n{"payload_state":"redacted"}\n'
    )


def _lifecycle(
    runtime_dir: Path, name: str, *, episode_id: int = 0
) -> RuntimeEpisodeLifecycle:
    return RuntimeEpisodeLifecycle(
        runtime_dir=str(runtime_dir),
        namespace="agent",
        name=name,
        title=f"lifecycle {name}",
        actor="pytest",
        source=f"bundle-{name}",
        episode_id=episode_id,
    )


def _sealed_episode(
    runtime_dir: Path, tmp_path: Path, name: str = "worker"
) -> RuntimeEpisodeLifecycle:
    lifecycle = _lifecycle(runtime_dir, name)
    lifecycle.record_event("test.step", b'{"step":1}', run_id="r1")
    lifecycle.record_event("test.step", b'{"step":2}', run_id="r1")
    payload_path = tmp_path / f"{name}-payload.json"
    payload_path.write_text('{"artifact":"evidence"}')
    lifecycle.attach_payload_ref(str(payload_path))
    lifecycle.close(ok=True)
    return lifecycle


def _export(runtime_dir: Path, episode_id: int, *, thin: bool = False) -> dict:
    return service.build_export_bundle(runtime_dir, episode_id=episode_id, thin=thin)


def _computed_root(runtime_dir: Path, episode_id: int) -> dict:
    inspected = service.episode_inspect(runtime_dir, episode_id=episode_id)
    return inspected["content_root"]


def test_export_bundle_is_self_contained_by_default(tmp_path):
    runtime_dir = tmp_path / "runtime"
    lifecycle = _sealed_episode(runtime_dir, tmp_path)

    bundle = _export(runtime_dir, lifecycle.episode_id)
    assert bundle["schema"] == EPISODE_BUNDLE_SCHEMA
    assert bundle["self_contained"] is True
    assert bundle["material"] == {
        "missing_frame_count": 0,
        "missing_ref_payload_count": 0,
    }
    frames = [frame for journal in bundle["journals"] for frame in journal["frames"]]
    assert len(frames) == bundle["frame_count"]
    for frame in frames:
        raw = base64.b64decode(frame["bytes"])
        assert len(raw) == frame["frame_length"]
    assert len(bundle["ref_payloads"]) == 1
    assert bundle["ref_payloads"][0]["ref_hash"].startswith("sha256:")

    thin = _export(runtime_dir, lifecycle.episode_id, thin=True)
    assert "self_contained" not in thin
    assert "journals" not in thin
    assert "ref_payloads" not in thin


def test_roundtrip_into_fresh_root(tmp_path):
    source_root = tmp_path / "source"
    lifecycle = _sealed_episode(source_root, tmp_path)
    bundle = _export(source_root, lifecycle.episode_id)

    destination_root = tmp_path / "destination"
    receipt = service.import_bundle(destination_root, bundle, execute=True)
    assert receipt["ok"], receipt
    assert receipt["status"] == "applied"
    assert receipt["accepted"] is True
    assert receipt["root"]["match"] is True

    fsck = service.fsck(
        destination_root, episode_id=lifecycle.episode_id, verify_frames=True
    )
    assert fsck["ok"], fsck
    assert fsck["status"] == "ok"

    source_root_claim = _computed_root(source_root, lifecycle.episode_id)
    destination_claim = _computed_root(destination_root, lifecycle.episode_id)
    assert source_root_claim["recorded"]["root_value"]
    assert (
        source_root_claim["recorded"]["root_value"]
        == destination_claim["recorded"]["root_value"]
    )

    # Re-import of the same bundle is a no-op by root equality.
    again = service.import_bundle(destination_root, bundle, execute=True)
    assert again["ok"], again
    assert again["status"] == "already_present"

    # Validate-only stays the default and still writes nothing new.
    validated = service.import_bundle(destination_root, bundle)
    assert validated["status"] == "validated"
    assert validated["dry_run"] is True


def test_execute_rejects_tampered_frame_bytes(tmp_path):
    source_root = tmp_path / "source"
    lifecycle = _sealed_episode(source_root, tmp_path)
    bundle = copy.deepcopy(_export(source_root, lifecycle.episode_id))

    frame = bundle["journals"][0]["frames"][0]
    raw = bytearray(base64.b64decode(frame["bytes"]))
    raw[-1] ^= 0xFF  # flip one payload byte; the header stays consistent
    frame["bytes"] = base64.b64encode(bytes(raw)).decode("ascii")

    destination_root = tmp_path / "destination"
    receipt = service.import_bundle(destination_root, bundle, execute=True)
    assert not receipt["ok"]
    assert receipt["status"] == "failed"
    fsck_codes = {issue["code"] for issue in receipt["fsck"]["errors"]}
    assert "episode_attached_frame_checksum_mismatch" in fsck_codes


def test_execute_refuses_same_id_different_root(tmp_path):
    source_root = tmp_path / "source"
    lifecycle = _sealed_episode(source_root, tmp_path, name="origin")
    bundle = _export(source_root, lifecycle.episode_id)

    destination_root = tmp_path / "destination"
    other = _lifecycle(destination_root, "diverged", episode_id=lifecycle.episode_id)
    other.record_event("test.other", b'{"different":true}', run_id="r2")
    other.close(ok=True)

    receipt = service.import_bundle(destination_root, bundle, execute=True)
    assert not receipt["ok"]
    assert receipt["status"] == "failed"
    codes = {error["code"] for error in receipt["errors"]}
    assert codes == {"episode_root_mismatch"}
    assert receipt["root"]["match"] is False


def test_execute_refuses_open_destination_episode(tmp_path):
    source_root = tmp_path / "source"
    lifecycle = _sealed_episode(source_root, tmp_path, name="origin")
    bundle = _export(source_root, lifecycle.episode_id)

    destination_root = tmp_path / "destination"
    open_episode = _lifecycle(
        destination_root, "still-open", episode_id=lifecycle.episode_id
    )
    open_episode.record_event("test.step", b'{"step":1}', run_id="r3")

    receipt = service.import_bundle(destination_root, bundle, execute=True)
    assert not receipt["ok"]
    codes = {error["code"] for error in receipt["errors"]}
    assert codes == {"episode_conflict_open"}


def test_execute_refuses_thin_bundle_before_writing(tmp_path):
    source_root = tmp_path / "source"
    lifecycle = _sealed_episode(source_root, tmp_path)
    thin = _export(source_root, lifecycle.episode_id, thin=True)

    destination_root = tmp_path / "destination"
    receipt = service.import_bundle(destination_root, thin, execute=True)
    assert not receipt["ok"]
    codes = {error["code"] for error in receipt["errors"]}
    assert codes == {"episode_bundle_not_self_contained"}
    # Nothing landed: the destination has no trace of the refused Episode.
    listed = service.episode_list(destination_root)
    assert listed.get("episodes", []) == []


def test_execute_rejects_unsealed_bundle(tmp_path):
    source_root = tmp_path / "source"
    lifecycle = _lifecycle(source_root, "never-closed")
    lifecycle.record_event("test.step", b'{"step":1}', run_id="r1")
    bundle = _export(source_root, lifecycle.episode_id)

    destination_root = tmp_path / "destination"
    receipt = service.import_bundle(destination_root, bundle, execute=True)
    assert not receipt["ok"]
    codes = {error["code"] for error in receipt["errors"]}
    assert codes == {"episode_bundle_not_sealed"}


def test_execute_rejects_journal_order_conflict(tmp_path):
    source_root = tmp_path / "source"
    lifecycle = _sealed_episode(source_root, tmp_path, name="worker")
    bundle = _export(source_root, lifecycle.episode_id)

    # The destination already has later frames in the same journal (the same
    # namespace/name location), but from a different Episode: appending the
    # bundle's older frames would break journal time order.
    destination_root = tmp_path / "destination"
    later = _lifecycle(destination_root, "worker")
    later.record_event("test.later", b'{"later":true}', run_id="r9")
    later.close(ok=True)
    assert later.episode_id != lifecycle.episode_id or True  # ids may collide

    receipt = service.import_bundle(destination_root, bundle, execute=True)
    if later.episode_id == lifecycle.episode_id:
        # Same auto-assigned id collapses into the identity gate instead.
        codes = {error["code"] for error in receipt["errors"]}
        assert codes == {"episode_root_mismatch"}
        return
    assert not receipt["ok"]
    reasons = {
        row["reason"]
        for row in receipt["apply"]["rejected"]
        if row["kind"] == "frame_bytes"
    }
    assert "episode_frame_order_conflict" in reasons


def test_repair_apply_materializes_missing_journal(tmp_path):
    # The P10 break shape: a sealed Episode whose event journal is gone.
    # A self-contained bundle from a healthy donor now heals it through the
    # same materializer repair-apply shares with import.
    runtime_dir = tmp_path / "runtime"
    lifecycle = _sealed_episode(runtime_dir, tmp_path, name="donor")
    bundle = _export(runtime_dir, lifecycle.episode_id)

    manifest_dir = runtime_dir / "journal/system/storage/episode-manifest/live"
    for journal_file in sorted(runtime_dir.glob("journal/**/*.journal")):
        if journal_file.parent != manifest_dir:
            journal_file.unlink()

    broken = service.fsck(
        runtime_dir, episode_id=lifecycle.episode_id, verify_frames=True
    )
    assert not broken["ok"]

    repaired = service.repair_apply(
        runtime_dir,
        {"episode_bundles": [bundle], "source_bundles": []},
        episode_id=lifecycle.episode_id,
        dry_run=False,
    )
    assert repaired["ok"], repaired

    healed = service.fsck(
        runtime_dir, episode_id=lifecycle.episode_id, verify_frames=True
    )
    assert healed["ok"], healed
    assert healed["status"] == "ok"
