# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

import pytest

import kungfu
from kungfu.action_envelope import (
    CARRIER_ACTION_ENVELOPE,
    build_action_envelope,
    decode_action_envelope,
    decode_flatbuffer_payload,
    encode_action_envelope,
    flatbuffer_payload,
    parse_action_envelope_edge_json,
    render_action_envelope_edge_json,
)
from kungfu.rewind.wire import unwrap_event as unwrap_rewind_event
from kungfu.rewind.wire import wrap_event as wrap_rewind_event
from kungfu.rewind import replay as rewind_replay
from kungfu.rewind import reporting as rewind_reporting
from kungfu.rewind.export import export_run, open_export
from kungfu.storage import service as storage_service
from kungfu.work.store import WorkStore, load as load_work
from kungfu.work.wire import unwrap_event as unwrap_work_event
from kungfu.work.wire import wrap_event as wrap_work_event


def _fixture(payload: bytes = b"payload") -> dict:
    return build_action_envelope(
        action_type="rewind.model.response",
        schema_ref={"id": "kungfu.rewind.ModelResponse", "version": 3},
        actor={"id": "agent-1", "kind": "agent"},
        session={"run_id": "run-1"},
        source={"kind": "trace", "source_id": "source-1", "schema_version": 2},
        batch={"repo_head": "abc123", "goals": 2},
        payload=flatbuffer_payload(payload),
    )


def test_binary_action_envelope_roundtrip_uses_declared_identifier():
    encoded = encode_action_envelope(_fixture())
    assert encoded[:1] != b"{"
    assert encoded[4:8] == b"KFAE"

    decoded = decode_action_envelope(encoded)
    assert decoded is not None
    assert decoded["schema"] == "kungfu.action-envelope/v1"
    assert decoded["action_type"] == "rewind.model.response"
    assert decoded["schema_ref"] == {
        "id": "kungfu.rewind.ModelResponse",
        "version": 3,
    }
    assert decoded["actor"]["id"] == "agent-1"
    assert decoded["session"]["run_id"] == "run-1"
    assert decoded["source"]["schema_version"] == 2
    assert decoded["batch"]["goals"] == 2
    assert decode_flatbuffer_payload(decoded["payload"]) == b"payload"
    schema_path = Path(__file__).parents[2] / "src/libkungfu/schema/ActionEnvelope.bfbs"
    schema_bfbs = schema_path.read_bytes()
    runtime = kungfu.__binding__.runtime
    assert runtime.verify_flatbuffer_payload(schema_bfbs, encoded)
    assert not runtime.verify_flatbuffer_payload(schema_bfbs, encoded[:16])


def test_binary_action_envelope_rejects_corruption_and_hash_mismatch():
    encoded = bytearray(encode_action_envelope(_fixture()))
    encoded[encoded.index(b"payload")] ^= 0xFF
    assert decode_action_envelope(encoded) is None

    invalid = _fixture()
    invalid["payload"]["hash"] = "0" * 64
    with pytest.raises(ValueError, match="payload hash mismatch"):
        encode_action_envelope(invalid)


def test_json_is_an_explicit_verified_edge_projection_only():
    encoded = encode_action_envelope(_fixture())
    rendered = render_action_envelope_edge_json(encoded)
    edge = json.loads(rendered)

    assert edge["schema"] == "kungfu.action-envelope/v1"
    assert edge["payload"]["content_transfer_encoding"] == "base64"
    assert edge["payload"]["data"] == "cGF5bG9hZA=="
    assert parse_action_envelope_edge_json(rendered) == encoded

    edge["payload"]["data"] = "not-base64!"
    with pytest.raises(ValueError, match="base64"):
        parse_action_envelope_edge_json(json.dumps(edge))


@pytest.mark.parametrize(
    ("wrap", "unwrap", "action_type"),
    [
        (wrap_rewind_event, unwrap_rewind_event, "rewind.model.response"),
        (wrap_work_event, unwrap_work_event, "work.item.created"),
    ],
)
def test_first_party_wire_helpers_use_binary_envelope(wrap, unwrap, action_type):
    carrier_type, encoded = wrap(action_type, b"domain-fb")
    assert carrier_type == CARRIER_ACTION_ENVELOPE
    assert encoded[4:8] == b"KFAE"
    assert unwrap(encoded) == (action_type, b"domain-fb")


def test_cpp_action_recorder_writes_binary_raw_carrier(tmp_path):
    runtime = kungfu.__binding__.runtime
    yijinjing = kungfu.__binding__.yijinjing
    recorder = runtime.action_recorder(str(tmp_path), "action", "binary")
    receipt = recorder.record_action(_fixture())

    assert receipt.carrier_type == CARRIER_ACTION_ENVELOPE
    assert int(receipt.data_type) == 0
    location = runtime.location(
        yijinjing.enums.mode.LIVE,
        yijinjing.enums.location_role.SYSTEM,
        "action",
        "binary",
        runtime.locator(str(tmp_path)),
    )
    frames = list(runtime.assemble(location, 0).read_bytes(CARRIER_ACTION_ENVELOPE))
    assert len(frames) == 1
    decoded = decode_action_envelope(frames[0][1])
    assert decoded is not None
    assert decoded["action_type"] == "rewind.model.response"


def test_work_store_uses_native_action_recorder_and_binary_fold(tmp_path):
    store = WorkStore(str(tmp_path))
    work_id = store.create("typed envelope", "test", "native recorder")
    store.checkpoint(work_id, "binary")

    item = load_work(str(tmp_path))[work_id]
    assert item["title"] == "typed envelope"
    assert item["checkpoints"][0]["note"] == "binary"


def test_rewind_replay_export_and_fsck_accept_binary_envelopes(tmp_path):
    runtime_dir = str(tmp_path / "runtime")
    run_id = "binary-rewind"
    rewind_reporting.begin_run(
        runtime_dir,
        run_id=run_id,
        provider="test",
        cwd=None,
        work_id=None,
    )
    rewind_reporting.end_run(
        runtime_dir,
        run_id=run_id,
        status="succeeded",
        exit_code=0,
    )

    count, differences = rewind_replay.verify(
        runtime_dir,
        run_id,
        rewind_reporting.bundle_dir(runtime_dir, run_id),
    )
    assert count == 2
    assert differences == []

    episodes = storage_service.episode_list(runtime_dir)["episodes"]
    episode = next(
        row for row in episodes if row["open"]["source"] == f"rewind:{run_id}"
    )
    report = storage_service.fsck(
        runtime_dir, episode_id=int(episode["episode_id"]), verify_frames=True
    )
    assert report["ok"] is True

    archive = export_run(runtime_dir, run_id, str(tmp_path / "run.rewind.zip"))
    opened_run_id, opened_runtime = open_export(archive, str(tmp_path / "opened"))
    opened_count, opened_differences = rewind_replay.verify(
        opened_runtime,
        opened_run_id,
        rewind_reporting.bundle_dir(opened_runtime, opened_run_id),
    )
    assert opened_count == 2
    assert opened_differences == []
