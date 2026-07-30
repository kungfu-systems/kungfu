# SPDX-License-Identifier: Apache-2.0

"""Named canonical-JSON protocols shared by identity-bearing Python edges."""

from __future__ import annotations

import json
import math
import unicodedata
from typing import Any, Final

ACTION_CANONICAL_JSON_V1: Final = "kungfu.action.canonical-json/v1"
PYTHON_IDENTITY_CANONICAL_JSON_V1: Final = "kungfu.python-identity.canonical-json/v1"
WORKSPACE_CANONICAL_JSON_V1: Final = "kungfu.workspace.canonical-json/v1"
MAX_SAFE_INTEGER: Final = 9_007_199_254_740_991
MIN_SIGNED_64: Final = -(2**63)
MAX_SIGNED_64: Final = 2**63 - 1


class CanonicalJsonError(ValueError):
    """Stable conformance failure for a named canonical-JSON protocol."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _validate(value: Any, *, protocol: str) -> None:
    workspace = protocol == WORKSPACE_CANONICAL_JSON_V1
    python_identity = protocol == PYTHON_IDENTITY_CANONICAL_JSON_V1
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise CanonicalJsonError(
                "canonical-invalid-unicode", "canonical JSON requires valid UTF-8"
            ) from error
        if workspace and unicodedata.normalize("NFC", value) != value:
            raise CanonicalJsonError(
                "canonical-non-nfc",
                "workspace canonical JSON strings must be NFC-normalized",
            )
        return
    if isinstance(value, int):
        if python_identity:
            return
        minimum = 0 if workspace else MIN_SIGNED_64
        maximum = MAX_SAFE_INTEGER if workspace else MAX_SIGNED_64
        if value < minimum or value > maximum:
            raise CanonicalJsonError(
                "canonical-integer-range",
                "canonical JSON integers must be within the protocol safe range",
            )
        return
    if isinstance(value, float):
        if python_identity and math.isfinite(value):
            return
        raise CanonicalJsonError(
            (
                "canonical-non-finite-float"
                if python_identity
                else "canonical-float-unsupported"
            ),
            (
                "Python identity canonical JSON requires finite floating-point values"
                if python_identity
                else "this canonical JSON identity protocol does not admit floating-point values"
            ),
        )
    if isinstance(value, list):
        for item in value:
            _validate(item, protocol=protocol)
        return
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise CanonicalJsonError(
                "canonical-object-key", "canonical JSON object keys must be strings"
            )
        for key, item in value.items():
            _validate(key, protocol=protocol)
            _validate(item, protocol=protocol)
        return
    raise CanonicalJsonError(
        "canonical-unsupported-type", "unsupported canonical JSON value"
    )


def canonical_json_text(
    value: Any, *, protocol: str = PYTHON_IDENTITY_CANONICAL_JSON_V1
) -> str:
    """Encode one value under an explicitly named canonical-JSON protocol."""

    if protocol not in {
        ACTION_CANONICAL_JSON_V1,
        PYTHON_IDENTITY_CANONICAL_JSON_V1,
        WORKSPACE_CANONICAL_JSON_V1,
    }:
        raise ValueError(f"unknown canonical JSON protocol: {protocol}")
    _validate(value, protocol=protocol)
    if protocol == PYTHON_IDENTITY_CANONICAL_JSON_V1:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
    return _encode(value)


def _encode(value: Any) -> str:
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(_encode(item) for item in value) + "]"
    keys = sorted(value, key=lambda key: key.encode("utf-8"))
    return "{" + ",".join(f"{_encode(key)}:{_encode(value[key])}" for key in keys) + "}"


def canonical_json_bytes(
    value: Any, *, protocol: str = PYTHON_IDENTITY_CANONICAL_JSON_V1
) -> bytes:
    return canonical_json_text(value, protocol=protocol).encode("utf-8")
