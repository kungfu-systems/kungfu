# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import pytest

import kungfu
from kungfu.action_envelope import (
    CARRIER_ACTION_ENVELOPE,
    build_action_envelope,
    decode_action_envelope,
    decode_flatbuffer_payload,
    encode_action_envelope,
    flatbuffer_payload,
)
from kungfu.rewind.wire import unwrap_event as unwrap_rewind_event
from kungfu.rewind.wire import wrap_event as wrap_rewind_event
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


def test_binary_action_envelope_rejects_corruption_and_hash_mismatch():
    encoded = bytearray(encode_action_envelope(_fixture()))
    encoded[encoded.index(b"payload")] ^= 0xFF
    assert decode_action_envelope(encoded) is None

    invalid = _fixture()
    invalid["payload"]["hash"] = "0" * 64
    with pytest.raises(ValueError, match="payload hash mismatch"):
        encode_action_envelope(invalid)


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
