# SPDX-License-Identifier: Apache-2.0

from workload import evaluate_scale


def _measurement(records: int, p50_ns: int) -> dict[str, int]:
    return {"journal_records": records, "fold_p50_ns": p50_ns}


def test_scale_policy_defers_acceleration_within_frozen_linear_overhead():
    result = evaluate_scale(
        [_measurement(64, 10_000_000), _measurement(512, 120_000_000)], 2.0
    )

    assert result["status"] == "pass"
    assert result["record_ratio"] == 8.0
    assert result["allowed_latency_ratio"] == 16.0
    assert result["decision"] == "defer-fold-acceleration"


def test_scale_policy_requires_acceleration_when_threshold_is_exceeded():
    result = evaluate_scale(
        [_measurement(64, 10_000_000), _measurement(512, 170_000_000)], 2.0
    )

    assert result["status"] == "fail"
    assert result["latency_ratio"] == 17.0
    assert result["decision"] == "require-fold-acceleration"
