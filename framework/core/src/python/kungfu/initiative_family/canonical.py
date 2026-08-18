# SPDX-License-Identifier: Apache-2.0

"""Canonical JSON and semantic-root primitives for Kungfu work control."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import datetime
from typing import Any

from kungfu.canonical_json import (
    ACTION_CANONICAL_JSON_V1,
    CanonicalJsonError,
    canonical_json_bytes,
)

ROOT = "sha256:"
INITIATIVE_ASSIGNMENT_ROOT_PROTOCOL = "kungfu.initiative-assignment.root/v1"
INITIATIVE_SURFACE = "kungfu.initiative-assignment.initiative"
ASSIGNMENT_SURFACE = "kungfu.initiative-assignment.assignment"
_ROOT_INPUT_FIELDS = {"protocolId", "surfaceId", "subjectKey", "payload"}
_ROOT_PAYLOAD_FIELDS = {"record", "source", "links"}
_ROOT_SOURCE_REQUIRED = {
    "authority_mode",
    "source_id",
    "source_time",
    "payload_hash",
}
_ROOT_SOURCE_OPTIONAL = {
    "storage_source_id",
    "kind",
    "source_path",
    "repo_head",
    "import_id",
    "import_episode_id",
    "import_episode_root",
    "actor",
}
_ROOT_LINK_FIELDS = {"initiative_id", "assignment_id"}
_SHA256_ROOT = re.compile(r"sha256:[0-9a-f]{64}\Z")
_ISO_8601 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def _normalized(value: Any) -> Any:
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [_normalized(row) for row in value]
    if isinstance(value, dict):
        return {
            unicodedata.normalize("NFC", str(key)): _normalized(item)
            for key, item in value.items()
        }
    if value is None or isinstance(value, (bool, int)):
        return value
    raise ValueError(f"unsupported canonical JSON value: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(
        _normalized(value),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def semantic_root(value: Any) -> str:
    return ROOT + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


class InitiativeAssignmentRootError(ValueError):
    """Stable conformance failure for Initiative/Assignment Root v1."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _root_fail(code: str, message: str) -> None:
    raise InitiativeAssignmentRootError(code, message)


def _nonempty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _validated_root_input(value: Any) -> tuple[str, str, dict[str, Any]]:
    if not isinstance(value, dict) or set(value) != _ROOT_INPUT_FIELDS:
        _root_fail("protocol-field-set", "Root input has an invalid field set")
    if value["protocolId"] != INITIATIVE_ASSIGNMENT_ROOT_PROTOCOL:
        _root_fail("unsupported-protocol", "Root protocol id is unsupported")
    surface = value["surfaceId"]
    if surface not in {INITIATIVE_SURFACE, ASSIGNMENT_SURFACE}:
        _root_fail("invalid-domain", "Root surface is not Initiative or Assignment")
    subject = value["subjectKey"]
    if not _nonempty_text(subject):
        _root_fail("invalid-subject", "subjectKey must be a non-empty string")

    payload = value["payload"]
    if not isinstance(payload, dict) or set(payload) != _ROOT_PAYLOAD_FIELDS:
        _root_fail("invalid-payload-field-set", "payload has an invalid field set")
    record = payload["record"]
    if not isinstance(record, dict):
        _root_fail("invalid-record", "payload.record must be an object")
    identity_field = (
        "initiative_id" if surface == INITIATIVE_SURFACE else "assignment_id"
    )
    required_record_fields = {identity_field}
    if surface == ASSIGNMENT_SURFACE:
        required_record_fields.add("initiative_id")
    if any(not _nonempty_text(record.get(field)) for field in required_record_fields):
        _root_fail("invalid-record", "record identity fields must be non-empty strings")
    if subject != f"kungfu:{record[identity_field]}":
        _root_fail("invalid-subject", "subjectKey does not match the record identity")

    source = payload["source"]
    if (
        not isinstance(source, dict)
        or not _ROOT_SOURCE_REQUIRED.issubset(source)
        or not set(source).issubset(_ROOT_SOURCE_REQUIRED | _ROOT_SOURCE_OPTIONAL)
    ):
        _root_fail(
            "invalid-source-field-set", "payload.source has an invalid field set"
        )
    if any(not _nonempty_text(source[field]) for field in _ROOT_SOURCE_REQUIRED):
        _root_fail("invalid-source", "required source fields must be non-empty strings")
    if not _SHA256_ROOT.fullmatch(source["payload_hash"]):
        _root_fail("invalid-source", "source.payload_hash must be a sha256 Root")
    if any(not isinstance(item, str) for item in source.values()):
        _root_fail("invalid-source", "source fields must be strings")

    links = payload["links"]
    if (
        not isinstance(links, dict)
        or "initiative_id" not in links
        or not set(links).issubset(_ROOT_LINK_FIELDS)
    ):
        _root_fail("invalid-links-field-set", "payload.links has an invalid field set")
    if any(not _nonempty_text(item) for item in links.values()):
        _root_fail("invalid-links", "link fields must be non-empty strings")
    if links["initiative_id"] != f"kungfu:{record['initiative_id']}":
        _root_fail("invalid-links", "initiative link does not match the record")
    if "assignment_id" in links and links["assignment_id"] != subject:
        _root_fail("invalid-links", "assignment link does not match subjectKey")
    return surface, subject, payload


def initiative_assignment_root_evidence(value: Any) -> dict[str, str]:
    """Return exact canonical bytes, domain-separated preimage, and Root."""

    surface, subject, payload = _validated_root_input(value)
    try:
        encoded = canonical_json_bytes(
            {"payload": payload, "subjectKey": subject, "surfaceId": surface},
            protocol=ACTION_CANONICAL_JSON_V1,
        )
    except CanonicalJsonError as error:
        raise InitiativeAssignmentRootError(error.code, str(error)) from error
    preimage = INITIATIVE_ASSIGNMENT_ROOT_PROTOCOL.encode("utf-8") + b"\0" + encoded
    return {
        "canonicalHex": encoded.hex(),
        "preimageHex": preimage.hex(),
        "root": ROOT + hashlib.sha256(preimage).hexdigest(),
    }


def verify_initiative_assignment_root(
    value: Any, *, canonical_hex: str, preimage_hex: str, root: str
) -> dict[str, str]:
    """Fail closed unless every claimed byte and Root match exactly."""

    evidence = initiative_assignment_root_evidence(value)
    if canonical_hex != evidence["canonicalHex"]:
        _root_fail("canonical-byte-mismatch", "claimed canonical bytes do not match")
    if preimage_hex != evidence["preimageHex"]:
        _root_fail("preimage-byte-mismatch", "claimed preimage bytes do not match")
    if root != evidence["root"]:
        _root_fail("root-mismatch", "claimed Root does not match")
    return evidence


def _strict_object(value: Any, fields: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{label} has an invalid field set")
    return value


def _sorted_unique_strings(
    value: Any, field: str, *, allow_empty: bool = False
) -> list[str]:
    if (
        not isinstance(value, list)
        or not all(isinstance(row, str) and row for row in value)
        or value != sorted(set(value), key=lambda row: row.encode("utf-8"))
        or (not allow_empty and not value)
    ):
        qualifier = "" if allow_empty else " non-empty"
        raise ValueError(f"{field} must be a sorted unique{qualifier} string array")
    return value


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not _ISO_8601.fullmatch(value):
        raise ValueError(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{field} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed


def _root(value: Any, field: str, *, optional: bool = False) -> str:
    text = str(value or "")
    if optional and not text:
        return ""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", text):
        raise ValueError(f"{field} must be a sha256 root")
    return text
