# SPDX-License-Identifier: Apache-2.0

"""Canonical JSON and semantic-root primitives for Kungfu work control."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import datetime
from typing import Any

ROOT = "sha256:"
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
