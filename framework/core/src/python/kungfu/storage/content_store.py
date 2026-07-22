# SPDX-License-Identifier: Apache-2.0
#
# ADR-0040 content-store facade: the immutable content contract
# (put-if-absent / get / has / verify, capability discovery) routed through
# the storage provider selected for the runtime dir, so Python speaks the
# same vocabulary as C++ over both the file and engine-backed profiles.
# This is a thin binding adapter, never an independent engine: every call
# goes straight to the libkungfu facade. Hashes accept "<algo>:<hex>" or
# bare hex.

from __future__ import annotations

from pathlib import Path
from typing import Any

import kungfu

PAYLOADS_NAMESPACE = "payloads"


def _runtime():
    return kungfu.__binding__.runtime


def put_if_absent(
    runtime_dir: str | Path,
    content_namespace: str,
    payload: bytes,
    *,
    expected_hash: str = "",
) -> dict[str, Any]:
    return dict(
        _runtime().content_store_put_if_absent(
            str(runtime_dir), content_namespace, payload, expected_hash
        )
    )


def has(runtime_dir: str | Path, content_namespace: str, content_hash: str) -> bool:
    return bool(
        _runtime().content_store_has(str(runtime_dir), content_namespace, content_hash)
    )


def verify(
    runtime_dir: str | Path, content_namespace: str, content_hash: str
) -> dict[str, Any]:
    return dict(
        _runtime().content_store_verify(
            str(runtime_dir), content_namespace, content_hash
        )
    )


def get(runtime_dir: str | Path, content_namespace: str, content_hash: str) -> bytes:
    # verified read: raises when the object is missing, corrupt, or
    # unaddressable, so corrupt bytes never reach a caller
    return bytes(
        _runtime().content_store_get(str(runtime_dir), content_namespace, content_hash)
    )


def capabilities(runtime_dir: str | Path) -> dict[str, Any]:
    return dict(_runtime().content_store_capabilities(str(runtime_dir)))
