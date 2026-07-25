# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib


PROTOCOL_ID = "kungfu.work.record-root/v1"


def preimage(envelope_bytes: bytes) -> bytes:
    """Build the language-neutral Work record Root preimage."""

    encoded = bytes(envelope_bytes)
    return (
        PROTOCOL_ID.encode("utf-8")
        + b"\x00"
        + len(encoded).to_bytes(8, byteorder="big", signed=False)
        + encoded
    )


def root(envelope_bytes: bytes) -> str:
    return f"sha256:{hashlib.sha256(preimage(envelope_bytes)).hexdigest()}"
