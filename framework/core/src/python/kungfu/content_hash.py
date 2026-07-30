# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import kungfu

CONTENT_HASH_ALGORITHM_SHA256 = "sha256"
CONTENT_HASH_ALGORITHM_BLAKE3 = "blake3"


def _runtime():
    return kungfu.__binding__.runtime


def _bytes(payload: bytes | bytearray | memoryview | str) -> bytes:
    if isinstance(payload, str):
        return payload.encode("utf-8")
    return bytes(payload)


def compute_content_hash_value(
    payload: bytes | bytearray | memoryview | str,
    algorithm: str = CONTENT_HASH_ALGORITHM_SHA256,
) -> str:
    return _runtime().compute_content_hash_value(_bytes(payload), algorithm)


def compute_content_hash(
    payload: bytes | bytearray | memoryview | str,
    algorithm: str = CONTENT_HASH_ALGORITHM_SHA256,
) -> str:
    return _runtime().compute_content_hash(_bytes(payload), algorithm)


def format_content_hash(algorithm: str, value: str) -> str:
    return _runtime().format_content_hash(algorithm, value)


def parse_content_hash(formatted: str) -> tuple[str, str]:
    algorithm, value = _runtime().parse_content_hash(formatted)
    return str(algorithm), str(value)


def verify_content_hash(
    payload: bytes | bytearray | memoryview | str,
    expected: str,
    algorithm: str | None = None,
) -> bool:
    return bool(
        _runtime().verify_content_hash(_bytes(payload), expected, algorithm or "")
    )


def verify_content_hash_value(
    payload: bytes | bytearray | memoryview | str,
    expected: str,
    algorithm: str = CONTENT_HASH_ALGORITHM_SHA256,
) -> bool:
    return bool(_runtime().verify_content_hash(_bytes(payload), expected, algorithm))
