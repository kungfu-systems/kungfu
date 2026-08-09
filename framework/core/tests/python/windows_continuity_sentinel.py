# SPDX-License-Identifier: Apache-2.0

"""Windows-native fast qualification for Peer crash and restart continuity."""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time
from pathlib import Path
from typing import Any, Callable

import psutil

from kungfu import peer_lifecycle


SCHEMA = "kungfu.windows-continuity-fast-sentinel/v1"
PEER_ID = "test.probe"
DEFAULT_PHASE_TIMEOUT_SECONDS = 10.0


class SentinelFailure(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _spec(probe: Path) -> dict[str, Any]:
    return {
        "schema": peer_lifecycle.SPEC_SCHEMA,
        "peerId": PEER_ID,
        "command": {"argv": [sys.executable, str(probe)]},
        "readiness": {"kind": "file-handshake", "timeoutSeconds": 30},
        "recovery": {
            "schema": peer_lifecycle.RECOVERY_SCHEMA,
            "processExit": "restart",
            "durableState": "declared",
            "maxRestarts": 3,
            "windowSeconds": 30,
            "guidance": "Rebuild the probe from its durable declaration.",
        },
    }


def _wait_status(
    runtime_dir: str,
    predicate: Callable[[dict[str, Any]], bool],
    *,
    phase: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    current = peer_lifecycle.status(runtime_dir, PEER_ID)
    while time.monotonic() < deadline and not predicate(current):
        time.sleep(0.05)
        current = peer_lifecycle.status(runtime_dir, PEER_ID)
    if not predicate(current):
        raise SentinelFailure(
            f"{phase}-timeout",
            f"{phase} did not satisfy the unchanged health oracle within "
            f"{timeout_seconds:.3f}s; lifecycleState="
            f"{current.get('lifecycleState', 'unknown')}",
        )
    return current


def _measure(
    timings: dict[str, dict[str, int]],
    phase: str,
    deadline_ms: int,
    operation: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    started = time.monotonic_ns()
    result = operation()
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    timings[phase] = {
        "durationMs": int(duration_ms),
        "deadlineMs": deadline_ms,
    }
    if duration_ms > deadline_ms:
        raise SentinelFailure(
            f"{phase}-deadline-exceeded",
            f"{phase} completed after its {deadline_ms}ms deadline",
        )
    return result


def _require_healthy(state: dict[str, Any], phase: str) -> None:
    if not state.get("healthy"):
        raise SentinelFailure(
            f"{phase}-unhealthy",
            f"{phase} did not satisfy the unchanged healthy=true oracle; "
            f"lifecycleState={state.get('lifecycleState', 'unknown')}",
        )


def run_scenario(
    runtime_dir: str | Path,
    *,
    probe: str | Path,
    phase_timeout_seconds: float = DEFAULT_PHASE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Run one bounded, self-cleaning real-process continuity scenario."""

    if phase_timeout_seconds <= 0:
        raise ValueError("phase_timeout_seconds must be positive")
    runtime = str(Path(runtime_dir))
    timeout_ms = int(phase_timeout_seconds * 1000)
    timings: dict[str, dict[str, int]] = {}
    spec = _spec(Path(probe))
    cleanup_complete = False
    try:
        started = _measure(
            timings,
            "initialReadiness",
            timeout_ms,
            lambda: peer_lifecycle.ensure(
                spec, runtime, wait_seconds=phase_timeout_seconds
            ),
        )
        _require_healthy(started, "initialReadiness")
        first_host_generation = started["host"]["generation"]
        first_peer_generation = started["peer"]["generation"]
        first_peer_pid = started["peer"]["pid"]

        def crash_host() -> dict[str, Any]:
            host_process = psutil.Process(started["host"]["pid"])
            host_process.kill()
            host_process.wait(timeout=min(5, phase_timeout_seconds))
            return _wait_status(
                runtime,
                lambda value: bool(value.get("orphaned")),
                phase="hostCrashAdoption",
                timeout_seconds=phase_timeout_seconds,
            )

        orphan = _measure(timings, "hostCrashAdoption", timeout_ms, crash_host)
        if not orphan.get("adoptable") or orphan["peer"]["pid"] != first_peer_pid:
            raise SentinelFailure(
                "host-crash-not-adoptable",
                "the orphaned Peer was not adoptable with its original process",
            )

        adopted = _measure(
            timings,
            "peerAdoption",
            timeout_ms,
            lambda: peer_lifecycle.ensure(
                spec, runtime, wait_seconds=phase_timeout_seconds
            ),
        )
        _require_healthy(adopted, "peerAdoption")
        if (
            adopted["host"]["generation"] != first_host_generation + 1
            or adopted["peer"]["pid"] != first_peer_pid
        ):
            raise SentinelFailure(
                "peer-adoption-generation-mismatch",
                "adoption did not advance only the host generation",
            )

        stale_started = time.monotonic_ns()
        try:
            peer_lifecycle.stop(
                runtime,
                PEER_ID,
                expected_host_generation=first_host_generation,
                timeout=0,
            )
        except peer_lifecycle.PeerLifecycleError as error:
            if error.code != "stale-host-generation":
                raise
        else:
            raise SentinelFailure(
                "stale-owner-not-fenced",
                "the stale host generation unexpectedly retained stop authority",
            )
        timings["staleOwnerFencing"] = {
            "durationMs": int((time.monotonic_ns() - stale_started) // 1_000_000),
            "deadlineMs": timeout_ms,
        }
        if timings["staleOwnerFencing"]["durationMs"] > timeout_ms:
            raise SentinelFailure(
                "staleOwnerFencing-deadline-exceeded",
                "stale-owner fencing exceeded its bounded deadline",
            )

        def crash_peer() -> dict[str, Any]:
            peer_process = psutil.Process(first_peer_pid)
            peer_process.kill()
            peer_process.wait(timeout=min(5, phase_timeout_seconds))
            return _wait_status(
                runtime,
                lambda value: (
                    bool(value.get("healthy"))
                    and value.get("peer", {}).get("generation")
                    == first_peer_generation + 1
                ),
                phase="peerRestartHealth",
                timeout_seconds=phase_timeout_seconds,
            )

        restarted = _measure(timings, "peerRestartHealth", timeout_ms, crash_peer)
        _require_healthy(restarted, "peerRestartHealth")
        if (
            restarted["peer"]["pid"] == first_peer_pid
            or restarted.get("restartAttempts") != 1
        ):
            raise SentinelFailure(
                "peer-restart-oracle-mismatch",
                "restart did not produce one healthy, newly owned Peer process",
            )
    finally:
        cleanup_started = time.monotonic_ns()
        peer_lifecycle.stop(runtime, PEER_ID, timeout=phase_timeout_seconds)
        stopped = peer_lifecycle.status(runtime, PEER_ID)
        cleanup_complete = (
            stopped.get("lifecycleState") in {"stopped", "ended"}
            and not stopped.get("host", {}).get("alive", False)
            and not stopped.get("peer", {}).get("alive", False)
        )
        timings["cleanup"] = {
            "durationMs": int((time.monotonic_ns() - cleanup_started) // 1_000_000),
            "deadlineMs": timeout_ms,
        }
    if timings["cleanup"]["durationMs"] > timeout_ms:
        raise SentinelFailure(
            "cleanup-deadline-exceeded",
            "cleanup completed after its bounded deadline",
        )
    if not cleanup_complete:
        raise SentinelFailure(
            "cleanup-incomplete",
            "the declared Peer process remained alive after bounded cleanup",
        )
    return {
        "schema": SCHEMA,
        "status": "passed",
        "phaseTimings": timings,
        "coverage": {
            "realHostCrash": True,
            "peerAdoption": True,
            "peerRestart": True,
            "restartedHealthy": True,
            "staleOwnerFenced": True,
            "cleanupComplete": True,
        },
        "oracle": {
            "healthy": True,
            "hostGenerationDelta": 1,
            "peerGenerationDelta": 1,
            "restartAttempts": 1,
        },
    }


def _failure_class(error: Exception) -> str:
    code = getattr(error, "code", "")
    if code.endswith("-timeout") or code.endswith("-deadline-exceeded"):
        return "bounded-timing-failure"
    return "deterministic-regression"


def run_campaign(
    output_dir: str | Path,
    *,
    probe: str | Path,
    repeat: int,
    phase_timeout_seconds: float = DEFAULT_PHASE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    if repeat < 1 or repeat > 3:
        raise ValueError("repeat must be between 1 and 3")
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=False)
    samples = []
    for index in range(repeat):
        try:
            sample = run_scenario(
                output / f"sample-{index + 1}" / "runtime",
                probe=probe,
                phase_timeout_seconds=phase_timeout_seconds,
            )
        except Exception as error:
            samples.append(
                {
                    "sample": index + 1,
                    "status": "failed",
                    "failureClass": _failure_class(error),
                    "failureCode": str(getattr(error, "code", type(error).__name__)),
                    "message": str(error),
                }
            )
            break
        samples.append({"sample": index + 1, **sample})
    passed = len(samples) == repeat and all(
        sample["status"] == "passed" for sample in samples
    )
    return {
        "schema": SCHEMA,
        "status": "passed" if passed else "failed",
        "platform": {
            "system": sys.platform,
            "machine": platform.machine() or "unknown",
            "python": platform.python_version(),
            "psutil": psutil.__version__,
        },
        "sampleCount": repeat,
        "samples": samples,
        "retryPolicy": "none; repeated samples are independent qualifications",
    }


def _write_json(pathname: Path, value: dict[str, Any]) -> None:
    pathname.parent.mkdir(parents=True, exist_ok=True)
    temporary = pathname.with_name(f".{pathname.name}.{os.getpid()}.tmp")
    with temporary.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, indent=2, sort_keys=True)
        output.write("\n")
    os.replace(temporary, pathname)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--probe", type=Path, required=True)
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument(
        "--phase-timeout-seconds",
        type=float,
        default=DEFAULT_PHASE_TIMEOUT_SECONDS,
    )
    args = parser.parse_args()
    report = run_campaign(
        args.runtime_root,
        probe=args.probe,
        repeat=args.repeat,
        phase_timeout_seconds=args.phase_timeout_seconds,
    )
    _write_json(args.out, report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
