# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import base64
import binascii
import json
from typing import Any

from kungfu.canonical_json import canonical_json_bytes
from kungfu.content_hash import (
    compute_content_hash_value,
    verify_content_hash_value,
)

CARRIER_ACTION_ENVELOPE = 1000
ACTION_ENVELOPE_SCHEMA = "kungfu.action-envelope/v1"
PAYLOAD_ENCODING_FLATBUFFERS = "flatbuffers"
PAYLOAD_ENCODING_JSON = "json"


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
        encoding = payload.get("encoding")
        payload["encoding"] = (
            names.get(encoding, "none") if isinstance(encoding, int) else "none"
        )
        payload["data"] = bytes(payload.get("data") or b"")
    return envelope


def render_action_envelope_edge_json(
    value: bytes | bytearray | memoryview | dict[str, Any],
) -> str:
    """Render a verified envelope for a true JSON interchange/debug edge."""

    if isinstance(value, dict):
        envelope = decode_action_envelope(encode_action_envelope(value))
    else:
        envelope = decode_action_envelope(value)
    if envelope is None:
        raise ValueError("invalid Kungfu action envelope")
    edge = dict(envelope)
    payload = edge.get("payload")
    if isinstance(payload, dict):
        payload = dict(payload)
        data = bytes(payload.get("data") or b"")
        payload["data"] = base64.b64encode(data).decode("ascii")
        payload["content_transfer_encoding"] = "base64"
        edge["payload"] = payload
    return canonical_json_bytes(edge).decode("utf-8")


def parse_action_envelope_edge_json(value: str | bytes) -> bytes:
    """Parse edge JSON and re-enter the authoritative FlatBuffers verifier."""

    try:
        edge = json.loads(value)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid action envelope edge JSON") from error
    if not isinstance(edge, dict) or edge.get("schema") != ACTION_ENVELOPE_SCHEMA:
        raise ValueError("not a Kungfu action envelope edge projection")
    payload = edge.get("payload")
    if isinstance(payload, dict):
        payload = dict(payload)
        transfer = payload.pop("content_transfer_encoding", None)
        data = payload.get("data")
        if data not in (None, ""):
            if transfer != "base64" or not isinstance(data, str):
                raise ValueError("action envelope edge payload must use base64")
            try:
                payload["data"] = base64.b64decode(data, validate=True)
            except (ValueError, binascii.Error) as error:
                raise ValueError(
                    "invalid action envelope edge payload base64"
                ) from error
        else:
            payload["data"] = b""
        edge["payload"] = payload
    return encode_action_envelope(edge)


def verify_flatbuffer_payload(
    schema_bfbs: bytes, payload: bytes, object_name: str = ""
) -> bool:
    """Verify nested domain bytes through the same C++ reflection boundary."""

    import kungfu

    return bool(
        kungfu.__binding__.runtime.verify_flatbuffer_payload(
            bytes(schema_bfbs), bytes(payload), object_name
        )
    )
