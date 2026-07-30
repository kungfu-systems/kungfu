# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import statistics
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).parents[5]
sys.path.insert(0, str(ROOT / "framework" / "core" / "build" / "Release"))
sys.path.insert(0, str(ROOT / "framework" / "core" / "src" / "python"))

from kungfu import runtime_broker  # noqa: E402


def cut(sequence: int = 1) -> dict[str, str]:
    return {
        "stream_id": "1",
        "container_epoch": "1",
        "sequence": str(sequence),
        "frame_uid": str(sequence),
    }


class FakeHost:
    def __init__(self) -> None:
        self.running = False
        self.supervisor_pid = 4000
        self.coordinator_pid = 4001
        self.activations = 0

    def diagnostics(self) -> dict[str, object]:
        return {
            "supervisor": {
                "pid": self.supervisor_pid if self.running else None,
                "running": self.running,
            },
            "coordinator": {
                "pid": self.coordinator_pid if self.running else None,
                "running": self.running,
            },
        }

    def inspect(self, home: str, runtime_dir: str) -> dict[str, object]:
        return self.diagnostics()

    def activate(self, home: str, runtime_dir: str) -> dict[str, object]:
        self.activations += 1
        self.running = True
        return self.diagnostics()

    def replace(self) -> None:
        self.supervisor_pid += 2
        self.coordinator_pid += 2


class FakeReadinessAuthority:
    def establish(self, requirement, generation, diagnostics):
        minimum = requirement.get("minimumCut") or cut()
        projection = (
            minimum
            if "runtime.live-projection" in requirement["requiredCapabilities"]
            else None
        )
        return {
            "schema": "kungfu.runtime.readiness/v1",
            "state": "ready",
            "durableCut": minimum,
            "projectionCut": projection,
            "evidence": [
                {
                    "kind": "durability-receipt",
                    "ref": f"receipt:qualification:{generation}",
                }
            ],
            "observedAtNs": str(time.time_ns()),
        }


def percentile(values: list[int], quantile: float) -> int:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * quantile) - 1))
    return ordered[index]


def metric(values: list[int]) -> dict[str, int | str]:
    return {
        "unit": "microseconds",
        "samples": len(values),
        "median": int(statistics.median(values)),
        "p95": percentile(values, 0.95),
        "maximum": max(values),
    }


def timed(callable_) -> tuple[object, int]:
    started = time.perf_counter_ns()
    value = callable_()
    return value, (time.perf_counter_ns() - started) // 1000


def daemonless_samples(count: int) -> list[int]:
    def forbidden_host():
        raise AssertionError("daemonless operation constructed a process host")

    broker = runtime_broker.RuntimeCapabilityBroker(forbidden_host)
    values = []
    for index in range(count):
        plan = broker.plan(
            "episode.inspect",
            workspace="workspace-qualification-daemonless",
            request_source="python",
            request_id=f"daemonless-{index}",
        )
        result, elapsed = timed(
            lambda plan=plan: broker.invoke(plan, lambda receipt: receipt["outcome"])
        )
        if result["result"] != "daemonless":
            raise AssertionError("daemonless benchmark accepted an unexpected outcome")
        values.append(elapsed)
    return values


def live_samples(root: Path, warm_count: int, recovery_count: int):
    runtime_dir = root / "home" / "runtime"
    config_home = root / "config"
    host = FakeHost()
    client = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=host,
        readiness_authority=FakeReadinessAuthority(),
    )
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=cut(),
        request_id="qualification-live",
    )["requirement"]

    cold_receipt, cold = timed(lambda: client.activate(requirement, "python"))
    if cold_receipt["outcome"] != "activated" or host.activations != 1:
        raise AssertionError("cold activation did not establish exactly one host")

    warm = []
    for _ in range(warm_count):
        receipt, elapsed = timed(lambda: client.activate(requirement, "python"))
        if receipt["outcome"] != "reused" or host.activations != 1:
            raise AssertionError("warm activation did not reuse the fenced generation")
        warm.append(elapsed)

    recovery = []
    previous_generation = int(cold_receipt["handle"]["generation"])
    for _ in range(recovery_count):
        host.replace()
        receipt, elapsed = timed(lambda: client.activate(requirement, "python"))
        generation = int(receipt["handle"]["generation"])
        if receipt["outcome"] != "activated" or generation <= previous_generation:
            raise AssertionError("replacement recovery did not advance the generation")
        previous_generation = generation
        recovery.append(elapsed)
    if host.activations != recovery_count + 1:
        raise AssertionError("recovery activation count does not match replacements")
    return [cold], warm, recovery


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="kungfu-runtime-activation-") as temporary:
        cold, warm, recovery = live_samples(Path(temporary), 50, 10)
    resource_snapshot = None
    try:
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF)
        resource_snapshot = {
            "maxResidentSetSize": usage.ru_maxrss,
            "maxResidentSetSizeUnit": (
                "bytes" if sys.platform == "darwin" else "kibibytes"
            ),
            "userCpuSeconds": usage.ru_utime,
            "systemCpuSeconds": usage.ru_stime,
        }
    except ImportError:
        pass
    report = {
        "schema": "kungfu.runtime-activation.performance-report/v1",
        "envelope": "temporary-workspace-fake-process-host-v1",
        "thresholdPolicy": "report-only-no-universal-slo",
        "metrics": {
            "daemonless": metric(daemonless_samples(500)),
            "coldActivation": metric(cold),
            "warmReuse": metric(warm),
            "replacementRecovery": metric(recovery),
        },
        "processResourceSnapshot": resource_snapshot,
        "invariants": {
            "daemonlessConstructedNoHost": True,
            "coldEstablishedOneHost": True,
            "warmReusedGeneration": True,
            "recoveryAdvancedGeneration": True,
        },
        "nonClaims": [
            "production process latency",
            "physical-host recovery latency",
            "universal performance SLO",
            "production EmbeddedRuntimeHost",
        ],
    }
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
