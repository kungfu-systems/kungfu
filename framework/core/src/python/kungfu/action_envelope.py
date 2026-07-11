# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

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
        "data": bytes(payload),
        "byte_len": len(payload),
        "hash_algorithm": "sha256",
        "hash": payload_hash(payload),
    }


def decode_flatbuffer_payload(payload: dict[str, Any]) -> bytes:
    if payload.get("encoding") != PAYLOAD_ENCODING_FLATBUFFERS:
        raise ValueError(
            f"expected flatbuffers payload, got {payload.get('encoding')!r}"
        )
    data = bytes(payload.get("data") or b"")
    expected = payload.get("hash")
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
        envelope["payload"] = dict(payload)
        if "encoding" not in envelope["payload"]:
            envelope["payload"]["encoding"] = (
                "content-reference" if envelope["payload"].get("hash") else "opaque"
            )
    if journal is not None:
        envelope["journal"] = dict(journal)
    return envelope


def encode_action_envelope(envelope: dict[str, Any]) -> bytes:
    if envelope.get("schema") != ACTION_ENVELOPE_SCHEMA:
        raise ValueError("not a Kungfu action envelope")
    if not envelope.get("action_type"):
        raise ValueError("action envelope requires action_type")
    import kungfu

    return bytes(kungfu.__binding__.runtime.encode_action_envelope(envelope))


def decode_action_envelope(
    data: bytes | bytearray | memoryview | list[int],
) -> dict[str, Any] | None:
    raw = bytes(data)
    if not raw:
        return None
    import kungfu

    envelope = kungfu.__binding__.runtime.decode_action_envelope(raw)
    if not isinstance(envelope, dict):
        return None
    envelope["schema"] = ACTION_ENVELOPE_SCHEMA
    for key in ("actor", "session", "source", "batch", "journal", "payload"):
        if envelope.get(key) is None:
            envelope.pop(key, None)
    payload = envelope.get("payload")
    if isinstance(payload, dict):
        names = {
            0: "none",
            1: PAYLOAD_ENCODING_FLATBUFFERS,
            2: PAYLOAD_ENCODING_JSON,
            3: "content-reference",
            4: "opaque",
        }
        payload["encoding"] = names.get(payload.get("encoding"), "none")
        payload["data"] = bytes(payload.get("data") or b"")
    return envelope
