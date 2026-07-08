# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from kungfu.action_envelope import (
    CARRIER_ACTION_ENVELOPE,
    build_action_envelope,
    decode_action_envelope,
    decode_flatbuffer_payload,
    encode_action_envelope,
    flatbuffer_payload,
)
from kungfu.work import ACTION_SCHEMA_REFS


def wrap_event(action_type: str, payload: bytes) -> tuple[int, bytes]:
    schema_ref = ACTION_SCHEMA_REFS.get(action_type, {"id": action_type, "version": 1})
    envelope = build_action_envelope(
        action_type=action_type,
        schema_ref=schema_ref,
        payload=flatbuffer_payload(payload),
    )
    return CARRIER_ACTION_ENVELOPE, encode_action_envelope(envelope)


def unwrap_event(
    data: bytes | bytearray | memoryview | list[int],
) -> tuple[str, bytes] | None:
    envelope = decode_action_envelope(data)
    if envelope is None:
        return None
    action_type = envelope.get("action_type")
    payload = envelope.get("payload")
    if not isinstance(action_type, str) or not isinstance(payload, dict):
        return None
    return action_type, decode_flatbuffer_payload(payload)
