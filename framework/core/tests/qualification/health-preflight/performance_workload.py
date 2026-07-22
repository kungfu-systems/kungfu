# SPDX-License-Identifier: Apache-2.0

"""Portable incremental-latency qualification for command health preflight."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import tempfile
import time
import types
from typing import Any


ROOT = Path(__file__).parents[5]
sys.path.insert(0, str(ROOT / "framework" / "core" / "src" / "python"))


def _install_fake_pykungfu() -> None:
    fake = types.ModuleType("pykungfu")
    fake.__file__ = "/nonexistent/pykungfu.so"
    fake.yijinjing = types.SimpleNamespace(
        enums=types.SimpleNamespace(
            mode=types.SimpleNamespace(LIVE="LIVE", BACKTEST="BACKTEST"),
            location_role=types.SimpleNamespace(SYSTEM="SYSTEM"),
        )
    )
    runtime = types.ModuleType("pykungfu.runtime")
    runtime.coordinator = object
    fake.runtime = runtime
    sys.modules.setdefault("pykungfu", fake)
    sys.modules.setdefault("pykungfu.runtime", runtime)


_install_fake_pykungfu()

import kungfu  # noqa: E402

kungfu._build_info = {"version": "health-preflight-performance"}

from kungfu import diagnostics  # noqa: E402


WARM_BUDGET_MS = 100.0
COLD_BUDGET_MS = 250.0


def _ready_runtime() -> dict[str, Any]:
    return {
        "product": {
            "availability": "available",
            "liveState": "inactive",
            "error": None,
        },
        "route": {"registered": False, "stale": False},
        "lifecycle": {"state": "stopped"},
        "supervisor": {"running": False, "identityVerified": False},
        "coordinator": {"running": False, "identityVerified": False},
    }


def _install_ready_facts() -> None:
    diagnostics.runtime_service.route_status = lambda *_: _ready_runtime()
    diagnostics.peer_lifecycle.list_status = lambda *_: {"items": []}
    diagnostics.storage_service.status = lambda *_: {
        "ok": True,
        "provider": "content-addressed-file",
        "sources": [],
        "source_status": [],
    }
    diagnostics.storage_service.episode_list = lambda *_args, **_kwargs: {
        "episodes": [],
        "unknown_record_count": 0,
    }
    diagnostics.storage_service.fsck = lambda *_: (_ for _ in ()).throw(
        AssertionError("automatic preflight invoked storage fsck")
    )


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    index = max(0, math.ceil(quantile * len(ordered)) - 1)
    return ordered[index]


def _metric(values: list[float]) -> dict[str, Any]:
    return {
        "unit": "milliseconds",
        "count": len(values),
        "p50": statistics.median(values),
        "p95": _percentile(values, 0.95),
        "maximum": max(values),
        "samples": values,
    }


def _timed_preflight(home: Path, profile: str) -> float:
    started = time.perf_counter_ns()
    report = diagnostics.collect_preflight(
        str(home),
        str(home / "runtime"),
        str(home / "config"),
        profile,
        now_ns=1,
    )
    diagnostics.validate_preflight(report)
    if report["status"] != "ready" or report["decision"] != "allow":
        raise AssertionError(f"qualification fixture is not ready: {report}")
    return (time.perf_counter_ns() - started) / 1_000_000


def _scenario(root: Path, name: str, profile: str, initialized: bool) -> dict[str, Any]:
    cold = []
    for index in range(20):
        home = root / f"{name}-cold-{index}"
        if initialized:
            (home / "runtime").mkdir(parents=True)
        cold.append(_timed_preflight(home, profile))
    warm_home = root / f"{name}-warm"
    if initialized:
        (warm_home / "runtime").mkdir(parents=True)
    _timed_preflight(warm_home, profile)
    warm = [_timed_preflight(warm_home, profile) for _ in range(100)]
    return {
        "profile": profile,
        "workspace": "initialized" if initialized else "empty",
        "cold": _metric(cold),
        "warm": _metric(warm),
    }


def _worker_payload() -> dict[str, Any]:
    _install_ready_facts()
    with tempfile.TemporaryDirectory(prefix="kungfu-health-preflight-") as raw:
        root = Path(raw)
        return {
            "empty-runtime": _scenario(
                root, "empty-runtime", "runtime-activation", False
            ),
            "initialized-episode": _scenario(
                root, "initialized-episode", "episode-write", True
            ),
        }


def _spawn_worker() -> dict[str, Any]:
    result = subprocess.run(
        [sys.executable, __file__, "--worker"],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def _assert_budgets(scenarios: dict[str, Any]) -> None:
    for name, scenario in scenarios.items():
        if scenario["cold"]["p95"] > COLD_BUDGET_MS:
            raise AssertionError(f"{name} cold p95 exceeded {COLD_BUDGET_MS} ms")
        if scenario["warm"]["p95"] > WARM_BUDGET_MS:
            raise AssertionError(f"{name} warm p95 exceeded {WARM_BUDGET_MS} ms")


def _maximum_p95(reports: list[dict[str, Any]], phase: str) -> float:
    return max(
        scenario[phase]["p95"] for report in reports for scenario in report.values()
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    if args.worker:
        payload = _worker_payload()
        _assert_budgets(payload)
        print(json.dumps(payload, sort_keys=True))
        return

    single_shell = _worker_payload()
    _assert_budgets(single_shell)
    started = time.perf_counter_ns()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        shell_reports = list(pool.map(lambda _: _spawn_worker(), range(4)))
    concurrent_wall_ms = (time.perf_counter_ns() - started) / 1_000_000
    for report in shell_reports:
        _assert_budgets(report)
    all_reports = [single_shell, *shell_reports]
    observed = {
        "cold": _maximum_p95(all_reports, "cold"),
        "warm": _maximum_p95(all_reports, "warm"),
    }
    print(
        f"[health-preflight] cold p95 max={observed['cold']:.3f} ms; "
        f"warm p95 max={observed['warm']:.3f} ms; cache=disabled",
        file=sys.stderr,
    )
    print(
        json.dumps(
            {
                "schema": "kungfu.health-preflight.performance-report/v1",
                "surface": "incremental collect_preflight plus contract validation",
                "budgetsMs": {
                    "coldP95": COLD_BUDGET_MS,
                    "warmP95": WARM_BUDGET_MS,
                },
                "cache": "disabled",
                "observedMaxP95Ms": observed,
                "environment": {
                    "platform": platform.platform(),
                    "machine": platform.machine(),
                    "python": platform.python_version(),
                    "cpuCount": os.cpu_count(),
                    "processStartupIncluded": False,
                },
                "singleShell": single_shell,
                "concurrentShells": {
                    "count": len(shell_reports),
                    "wallMs": concurrent_wall_ms,
                    "reports": shell_reports,
                },
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
