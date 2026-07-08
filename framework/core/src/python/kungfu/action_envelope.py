# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import base64
import json
from typing import Any

from kungfu.content_hash import (
    compute_content_hash_value,
    verify_content_hash_value,
)

CARRIER_ACTION_ENVELOPE = 1000
ACTION_ENVELOPE_SCHEMA = "kungfu.action-envelope/v1"
PAYLOAD_ENCODING_FLATBUFFERS = "flatbuffers"
PAYLOAD_ENCODING_JSON = "json"
CONTENT_TRANSFER_BASE64 = "base64"


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def payload_hash(payload: bytes) -> str:
    return compute_content_hash_value(payload)


def flatbuffer_payload(payload: bytes) -> dict[str, Any]:
    return {
        "encoding": PAYLOAD_ENCODING_FLATBUFFERS,
        "content_transfer_encoding": CONTENT_TRANSFER_BASE64,
        "data": base64.b64encode(payload).decode("ascii"),
        "byte_len": len(payload),
        "sha256": payload_hash(payload),
    }


def decode_flatbuffer_payload(payload: dict[str, Any]) -> bytes:
    if payload.get("encoding") != PAYLOAD_ENCODING_FLATBUFFERS:
        raise ValueError(
            f"expected flatbuffers payload, got {payload.get('encoding')!r}"
        )
    if payload.get("content_transfer_encoding") != CONTENT_TRANSFER_BASE64:
        raise ValueError(
            "expected base64 transfer encoding, got "
            f"{payload.get('content_transfer_encoding')!r}"
        )
    data = base64.b64decode(str(payload.get("data") or ""), validate=True)
    expected = payload.get("sha256")
    if expected and not verify_content_hash_value(data, str(expected)):
        raise ValueError("action envelope payload hash mismatch")
    return data


def build_action_envelope(
    *,
    action_type: str,
    schema_ref: dict[str, Any],
    payload: dict[str, Any] | None = None,
    actor: dict[str, Any] | None = None,
    session: dict[str, Any] | None = None,
    source: dict[str, Any] | None = None,
    batch: dict[str, Any] | None = None,
    journal: dict[str, Any] | None = None,
) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "schema": ACTION_ENVELOPE_SCHEMA,
        "action_type": action_type,
        "schema_ref": dict(schema_ref),
    }
    if actor is not None:
        envelope["actor"] = actor
    if session is not None:
        envelope["session"] = session
    if source is not None:
        envelope["source"] = source
    if batch is not None:
        envelope["batch"] = batch
    if payload is not None:
        envelope["payload"] = payload
    if journal is not None:
        envelope["journal"] = dict(journal)
    return envelope


def encode_action_envelope(envelope: dict[str, Any]) -> bytes:
    if envelope.get("schema") != ACTION_ENVELOPE_SCHEMA:
        raise ValueError("not a Kungfu action envelope")
    if not envelope.get("action_type"):
        raise ValueError("action envelope requires action_type")
    return canonical_json_bytes(envelope)


def decode_action_envelope(
    data: bytes | bytearray | memoryview | list[int],
) -> dict[str, Any] | None:
    raw = bytes(data).rstrip(b"\0")
    if not raw:
        return None
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(envelope, dict):
        return None
    if envelope.get("schema") != ACTION_ENVELOPE_SCHEMA:
        return None
    return envelope
