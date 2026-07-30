# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
import platform
import statistics
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from kungfu.storage import service


DEFAULT_JOURNAL_LENGTHS = (32, 128, 256)
DEFAULT_SAMPLES = 7
DEFAULT_LINEAR_OVERHEAD = 2.0


def _root(digit: str) -> str:
    return "sha256:" + digit * 64


def _journal_record_count(counts: dict[str, int]) -> int:
    return sum(counts.values())


def _percentile(values: list[int], percentile: float) -> int:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * percentile)))
    return ordered[index]


def evaluate_scale(
    measurements: list[dict[str, Any]], linear_overhead: float
) -> dict[str, Any]:
    baseline = measurements[0]
    largest = measurements[-1]
    record_ratio = largest["journal_records"] / baseline["journal_records"]
    latency_ratio = largest["fold_p50_ns"] / baseline["fold_p50_ns"]
    allowed_latency_ratio = record_ratio * linear_overhead
    passed = latency_ratio <= allowed_latency_ratio
    return {
        "status": "pass" if passed else "fail",
        "record_ratio": record_ratio,
        "latency_ratio": latency_ratio,
        "linear_overhead": linear_overhead,
        "allowed_latency_ratio": allowed_latency_ratio,
        "decision": (
            "defer-fold-acceleration" if passed else "require-fold-acceleration"
        ),
        "decision_detail": (
            "Current full replay remains within the frozen scale threshold; "
            "defer checkpoint, snapshot, and incremental-fold machinery."
            if passed
            else "Full replay exceeded the frozen scale threshold; require a "
            "checkpoint, snapshot, or incremental-fold design before claiming "
            "support for larger journals."
        ),
    }


def run_workload(
    journal_lengths: tuple[int, ...], samples: int, linear_overhead: float
) -> dict[str, Any]:
    if len(journal_lengths) < 2 or any(length <= 0 for length in journal_lengths):
        raise ValueError("journal lengths must contain at least two positive values")
    if tuple(sorted(set(journal_lengths))) != journal_lengths:
        raise ValueError("journal lengths must be strictly increasing")
    if samples < 3 or samples % 2 == 0:
        raise ValueError("samples must be an odd integer of at least 3")
    if linear_overhead < 1.0:
        raise ValueError("linear overhead must be at least 1.0")

    measurements: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="kungfu-fact-fold-performance-") as root:
        runtime = Path(root)
        populated = 0
        for target_length in journal_lengths:
            while populated < target_length:
                response = service.fact_kernel(
                    runtime,
                    "object-put",
                    {
                        "object_id": f"fact:{populated:032x}",
                        "object_type": "fold-performance-probe",
                        "created_by_receipt_root": _root("1"),
                    },
                )
                if not response.get("ok"):
                    raise RuntimeError(f"Fact append failed: {response}")
                populated += 1

            durations: list[int] = []
            state: dict[str, Any] = {}
            for _ in range(samples):
                started = time.perf_counter_ns()
                state = service.fact_kernel(
                    runtime, "query", {"include_inventory": False}
                )
                durations.append(time.perf_counter_ns() - started)
                if not state.get("ok"):
                    raise RuntimeError(f"Fact fold failed: {state}")

            journal_records = _journal_record_count(state["counts"])
            measurements.append(
                {
                    "requested_objects": target_length,
                    "journal_records": journal_records,
                    "samples": samples,
                    "fold_p50_ns": int(statistics.median(durations)),
                    "fold_p95_ns": _percentile(durations, 0.95),
                    "fold_min_ns": min(durations),
                    "fold_max_ns": max(durations),
                    "fold_p50_ns_per_record": int(
                        statistics.median(durations) / journal_records
                    ),
                }
            )

    scale = evaluate_scale(measurements, linear_overhead)
    return {
        "schema": "kungfu.fact-kernel.fold-performance/v1",
        "authority": "native-kfr2-full-journal-replay",
        "host": {
            "platform": platform.system().lower(),
            "machine": platform.machine().lower(),
            "python": platform.python_version(),
        },
        "policy": {
            "metric": "p50-fold-latency-vs-journal-record-count",
            "threshold": "largest/baseline latency ratio <= record ratio * linear overhead",
            "absolute_slo": False,
            "samples_per_length": samples,
        },
        "measurements": measurements,
        "scale": scale,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Qualify Fact Kernel full-fold scaling against journal length."
    )
    parser.add_argument(
        "--journal-lengths",
        default=",".join(str(value) for value in DEFAULT_JOURNAL_LENGTHS),
        help="strictly increasing comma-separated object counts",
    )
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES)
    parser.add_argument(
        "--linear-overhead", type=float, default=DEFAULT_LINEAR_OVERHEAD
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        journal_lengths = tuple(
            int(value.strip()) for value in args.journal_lengths.split(",")
        )
        report = run_workload(journal_lengths, args.samples, args.linear_overhead)
    except (RuntimeError, ValueError) as error:
        print(f"fact-kernel-fold-performance: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["scale"]["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
