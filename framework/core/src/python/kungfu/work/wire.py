# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from typing import Any

from kungfu.action_envelope import (
    CARRIER_ACTION_ENVELOPE,
    build_action_envelope,
    decode_action_envelope,
    decode_flatbuffer_payload,
    encode_action_envelope,
    flatbuffer_payload,
)
from kungfu.work import ACTION_SCHEMA_REFS


def build_event_envelope(action_type: str, payload: bytes) -> dict[str, Any]:
    schema_ref = ACTION_SCHEMA_REFS.get(action_type, {"id": action_type, "version": 1})
    return build_action_envelope(
        action_type=action_type,
        schema_ref=schema_ref,
        payload=flatbuffer_payload(payload),
    )


def wrap_event(action_type: str, payload: bytes) -> tuple[int, bytes]:
    return CARRIER_ACTION_ENVELOPE, encode_action_envelope(
        build_event_envelope(action_type, payload)
    )


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
