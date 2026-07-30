# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path

import pytest

from kungfu.canonical_json import (
    ACTION_CANONICAL_JSON_V1,
    CanonicalJsonError,
    canonical_json_text,
)


CORPUS = json.loads(
    (
        Path(__file__).parents[4] / "tests/fixtures/canonical-json/vectors.json"
    ).read_text(encoding="utf-8")
)


def _value(vector: dict[str, object]) -> object:
    special = vector.get("specialFloat")
    if special == "nan":
        return float("nan")
    if special == "positive-infinity":
        return float("inf")
    return vector["value"]


@pytest.mark.parametrize(
    ("protocol", "vector"),
    [
        (protocol, vector)
        for protocol, profile in CORPUS["profiles"].items()
        for vector in profile["accepted"]
    ],
)
def test_canonical_json_accepted_vectors(
    protocol: str, vector: dict[str, object]
) -> None:
    assert canonical_json_text(_value(vector), protocol=protocol) == vector["canonical"]


@pytest.mark.parametrize(
    ("protocol", "vector"),
    [
        (protocol, vector)
        for protocol, profile in CORPUS["profiles"].items()
        for vector in profile["rejected"]
    ],
)
def test_canonical_json_rejected_vectors(
    protocol: str, vector: dict[str, object]
) -> None:
    with pytest.raises(CanonicalJsonError) as raised:
        canonical_json_text(_value(vector), protocol=protocol)
    assert raised.value.code == vector["failureCode"]


def test_action_v1_admitted_values_preserve_legacy_python_bytes() -> None:
    profile = CORPUS["profiles"][ACTION_CANONICAL_JSON_V1]
    for vector in profile["accepted"]:
        value = _value(vector)
        legacy = json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        assert (
            canonical_json_text(value, protocol=ACTION_CANONICAL_JSON_V1) == legacy
        ), vector["id"]


@pytest.mark.parametrize("value", [0.25, -0.0, 1.0, 1e-7, 1e-6, 1e20, 1e21])
def test_action_v1_rejects_legacy_float_before_root_bytes(value: float) -> None:
    with pytest.raises(CanonicalJsonError) as raised:
        canonical_json_text(
            {"identityBearingValue": value}, protocol=ACTION_CANONICAL_JSON_V1
        )
    assert raised.value.code == "canonical-float-unsupported"
