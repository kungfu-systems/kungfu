# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest


pytestmark = pytest.mark.filterwarnings(
    "error::pytest.PytestUnhandledThreadExceptionWarning"
)


MODULE_PATH = Path(__file__).with_name("workload.py")
SPEC = importlib.util.spec_from_file_location(
    "python_kfx_performance_workload", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
workload = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workload)


def test_percentile_retains_tail_observations():
    values = list(range(1, 101))
    assert workload.percentile(values, 0.50) == 50
    assert workload.percentile(values, 0.95) == 95
    assert workload.percentile(values, 0.99) == 99


def test_quick_workload_covers_every_required_service_plane_facet():
    profile = workload.load_profile(
        MODULE_PATH.parent / "profiles" / "cross-platform-v1.json"
    )
    records = asyncio.run(workload.execute(profile, quick=True))
    observed = {record["workload"] for record in records}
    assert observed == set(profile["required_workloads"])
    assert all(record["status"] == "passed" for record in records)
    assert any(record["cancelled_operations"] == 2 for record in records)
    assert any(record["error_operations"] == 1 for record in records)
    assert any(record["shutdown_milliseconds"] > 0 for record in records)
    assert any(record["backpressure_peak_inflight"] >= 8 for record in records)
