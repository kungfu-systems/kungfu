# SPDX-License-Identifier: Apache-2.0

"""Independent Python projection of the Kungfu Fact Root KFR2 protocol.

This module intentionally does not call the native Fact kernel.  The checked-in
conformance corpus compares its preimage bytes with the C++ authority.
"""

from __future__ import annotations

import hashlib
import re
import struct
from typing import Any, NoReturn

PROTOCOL = "kungfu.fact-root.canonical/v2"
MAGIC = b"KFR2"

_SCHEMA_FIELDS = {
    "kungfu.fact.object/v2": {1, 2, 3, 4},
    "kungfu.fact.version/v2": {1, 2, 3, 4, 5, 6, 7},
    "kungfu.fact.relation-endpoint/v2": {1, 2, 3},
    "kungfu.fact.relation-add/v2": {1, 2, 3, 4, 5, 6, 7},
    "kungfu.fact.relation-revoke/v2": {1, 2, 3},
    "kungfu.fact.cut/v2": {1, 2, 3, 4, 5, 6, 7, 8, 9},
    "kungfu.fact.ref-transition/v2": {1, 2, 3, 4, 5, 6, 7, 8},
    "kungfu.fact.operation-receipt/v2": {1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
    "kungfu.fact.operation-request/v2": {1, 2},
    "kungfu.fact.root-set/v2": {1, 2},
    "kungfu.fact.authority-bundle/v2": {1, 2, 3, 4},
    "kungfu.fact.root-mapping-receipt/v1": {1, 2, 3, 4, 5, 6},
}

_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_SIGNED_DECIMAL = re.compile(r"(?:0|-?[1-9][0-9]*)\Z")


class CanonicalEncodingError(ValueError):
    """Stable KFR2 rejection with a machine-facing failure code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> NoReturn:
    raise CanonicalEncodingError(code, message)


def _u64(value: int) -> bytes:
    return value.to_bytes(8, "big", signed=False)


def _hex(value: Any, field: str) -> bytes:
    if (
        not isinstance(value, str)
        or len(value) % 2
        or not re.fullmatch(r"[0-9a-f]*", value)
    ):
        _fail("canonical-invalid-hex", f"{field} must be even lower-case hex")
    return bytes.fromhex(value)


def _valid_scalar_utf8(raw: bytes) -> None:
    try:
        value = raw.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        _fail("canonical-invalid-unicode", str(error))
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        _fail("canonical-invalid-unicode", "surrogate code points are forbidden")


def _text_bytes(value: dict[str, Any]) -> bytes:
    if "utf8_hex" in value:
        raw = _hex(value["utf8_hex"], "utf8_hex")
    else:
        text = value.get("value")
        if not isinstance(text, str):
            _fail("canonical-invalid-descriptor", "text value must be a string")
        try:
            raw = text.encode("utf-8", "strict")
        except UnicodeEncodeError as error:
            _fail("canonical-invalid-unicode", str(error))
    _valid_scalar_utf8(raw)
    return raw


def _typed(value: Any) -> bytes:
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        _fail("canonical-invalid-descriptor", "typed value requires a type")
    kind = value["type"]

    if kind == "absent":
        _fail("canonical-absent", "absent is a schema condition, not a value")
    if kind == "null":
        return b"\x00"
    if kind == "bool":
        if not isinstance(value.get("value"), bool):
            _fail("canonical-invalid-descriptor", "bool value must be boolean")
        return b"\x02" if value["value"] else b"\x01"
    if kind in {"u64", "i64"}:
        raw = value.get("value")
        pattern = _DECIMAL if kind == "u64" else _SIGNED_DECIMAL
        if not isinstance(raw, str) or not pattern.fullmatch(raw):
            _fail("canonical-invalid-descriptor", f"{kind} must use canonical decimal")
        number = int(raw)
        lower, upper = (0, 2**64 - 1) if kind == "u64" else (-(2**63), 2**63 - 1)
        if not lower <= number <= upper:
            _fail("canonical-integer-range", f"{kind} is out of range")
        return (
            (b"\x10" + _u64(number))
            if kind == "u64"
            else (b"\x11" + number.to_bytes(8, "big", signed=True))
        )
    if kind == "f64":
        bits = _hex(value.get("bits"), "bits")
        if len(bits) != 8:
            _fail("canonical-invalid-hex", "f64 bits must contain 8 bytes")
        number = struct.unpack(">d", bits)[0]
        if number != number or number in {float("inf"), float("-inf")}:
            _fail("canonical-non-finite-float", "NaN and infinity are forbidden")
        return b"\x12" + bits
    if kind == "text":
        raw = _text_bytes(value)
        return b"\x20" + _u64(len(raw)) + raw
    if kind == "bytes":
        raw = _hex(value.get("hex"), "hex")
        return b"\x21" + _u64(len(raw)) + raw
    if kind in {"array", "set"}:
        items = value.get("items")
        if not isinstance(items, list):
            _fail("canonical-invalid-descriptor", f"{kind} items must be an array")
        encoded_items = [_typed(item) for item in items]
        if kind == "set":
            encoded_items.sort()
            if any(
                left == right for left, right in zip(encoded_items, encoded_items[1:])
            ):
                _fail("canonical-duplicate-item", "set contains equal canonical items")
        return (
            (b"\x30" if kind == "array" else b"\x31")
            + _u64(len(encoded_items))
            + b"".join(encoded_items)
        )
    if kind == "map":
        entries = value.get("entries")
        if not isinstance(entries, list):
            _fail("canonical-invalid-descriptor", "map entries must be an array")
        encoded_entries: list[tuple[bytes, bytes]] = []
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"key", "value"}:
                _fail(
                    "canonical-invalid-descriptor", "map entry requires key and value"
                )
            key = entry["key"]
            if not isinstance(key, dict) or key.get("type") != "text":
                _fail("canonical-invalid-descriptor", "map keys must be text")
            encoded_entries.append((_typed(key), _typed(entry["value"])))
        encoded_entries.sort(key=lambda pair: pair[0])
        if any(
            left[0] == right[0]
            for left, right in zip(encoded_entries, encoded_entries[1:])
        ):
            _fail("canonical-duplicate-key", "map contains equal canonical keys")
        return (
            b"\x32"
            + _u64(len(encoded_entries))
            + b"".join(key + child for key, child in encoded_entries)
        )
    if kind == "record":
        schema = value.get("schema")
        fields = value.get("fields")
        if not isinstance(schema, str):
            _fail("canonical-invalid-descriptor", "record schema must be a string")
        allowed = _SCHEMA_FIELDS.get(schema)
        if allowed is None:
            _fail("canonical-unknown-schema", "record schema is not registered")
        if not isinstance(fields, list):
            _fail("canonical-invalid-descriptor", "record fields must be an array")
        encoded_fields: list[tuple[int, bytes]] = []
        for field in fields:
            if not isinstance(field, dict) or set(field) != {"id", "value"}:
                _fail(
                    "canonical-invalid-descriptor", "record field requires id and value"
                )
            raw_id = field["id"]
            if not isinstance(raw_id, str) or not _DECIMAL.fullmatch(raw_id):
                _fail(
                    "canonical-invalid-descriptor", "field id must be canonical decimal"
                )
            field_id = int(raw_id)
            if field_id not in allowed:
                _fail("canonical-unknown-field", f"field {field_id} is not registered")
            encoded_fields.append((field_id, _typed(field["value"])))
        encoded_fields.sort(key=lambda pair: pair[0])
        if any(
            left[0] == right[0]
            for left, right in zip(encoded_fields, encoded_fields[1:])
        ):
            _fail("canonical-duplicate-field", "record contains a duplicate field id")
        schema_value = _typed({"type": "text", "value": schema})
        return (
            b"\x40"
            + schema_value
            + _u64(len(encoded_fields))
            + b"".join(_u64(field_id) + child for field_id, child in encoded_fields)
        )
    _fail("canonical-unsupported-type", f"unsupported canonical type: {kind}")


def canonical_bytes(value: Any) -> bytes:
    """Return the exact KFR2 preimage for one typed logical value."""

    return MAGIC + _typed(value)


def canonical_root(value: Any) -> str:
    """Return the lowercase SHA-256 content root for one KFR2 value."""

    return f"sha256:{hashlib.sha256(canonical_bytes(value)).hexdigest()}"
