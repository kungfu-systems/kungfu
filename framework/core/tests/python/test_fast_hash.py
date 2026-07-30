# SPDX-License-Identifier: Apache-2.0

import kungfu


def _runtime():
    return kungfu.__binding__.runtime


def test_fast_hash_algorithm_labels_are_xxh3():
    runtime = _runtime()

    assert runtime.FAST_HASH_ALGORITHM == "xxh3_64"
    assert runtime.FAST_HASH_ALGORITHM_64 == "xxh3_64"
    assert runtime.FAST_HASH_ALGORITHM_128 == "xxh3_128"


def test_fast_hash_64_and_narrow_32_are_xxh3_family():
    runtime = _runtime()
    payload = b"kungfu-atlas-fast-hash"
    text = payload.decode("utf-8")

    h64 = runtime.fast_hash_64(payload)

    assert h64 == runtime.fast_hash_str_64(text)
    assert runtime.fast_hash_32(payload) == h64 & 0xFFFFFFFF
    assert runtime.fast_hash_str_32(text) == h64 & 0xFFFFFFFF
    assert runtime.hash_32(bytearray(payload)) == h64 & 0xFFFFFFFF
    assert runtime.hash_str_32(text) == h64 & 0xFFFFFFFF
    assert runtime.fast_hash_64(payload, seed=7) != h64


def test_fast_hash_canonical_digest_lengths():
    runtime = _runtime()

    assert len(runtime.fast_hash_string_32("kungfu")) == 4
    assert len(runtime.fast_hash_string_64("kungfu")) == 8
    assert len(runtime.fast_hash_string_128("kungfu")) == 16
    assert runtime.fast_hash_string_128("kungfu") == runtime.fast_hash_string_128(
        "kungfu"
    )
