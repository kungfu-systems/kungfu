# SPDX-License-Identifier: Apache-2.0

import pytest

from kungfu import content_hash


ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def test_content_hash_value_uses_sha256_from_runtime_binding():
    assert content_hash.compute_content_hash_value(b"abc") == ABC_SHA256
    assert content_hash.compute_content_hash_value(b"") == EMPTY_SHA256


def test_content_hash_canonical_format_parse_and_verify():
    formatted = content_hash.compute_content_hash(b"abc")

    assert formatted == f"sha256:{ABC_SHA256}"
    assert content_hash.parse_content_hash(formatted) == ("sha256", ABC_SHA256)
    assert content_hash.format_content_hash("SHA256", ABC_SHA256.upper()) == formatted
    assert content_hash.verify_content_hash(b"abc", formatted)
    assert content_hash.verify_content_hash_value(bytearray(b"abc"), ABC_SHA256)
    assert not content_hash.verify_content_hash(b"abcd", formatted)


def test_content_hash_rejects_reserved_but_unimplemented_algorithm():
    with pytest.raises(ValueError):
        content_hash.compute_content_hash_value(b"abc", "blake3")
