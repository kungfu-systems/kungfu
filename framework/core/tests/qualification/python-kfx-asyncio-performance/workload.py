# SPDX-License-Identifier: Apache-2.0

"""Deterministic CPython 3.13 service-plane performance workload.

Every scored repetition is emitted as one JSON line.  The harness deliberately
uses only public asyncio and Kungfu APIs; it never substitutes Python scheduling
for journal ordering or moves a journal/data-plane hot path into Python.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / "framework" / "core" / "build" / "Release"))
sys.path.insert(0, str(ROOT / "framework" / "core" / "src" / "python"))

from kungfu.capability import open_async_session  # noqa: E402
from kungfu.runtime.live.event_loop import JournalAsyncioBridge  # noqa: E402


def percentile(values: list[int], quantile: float) -> int:
    if not values:
        raise ValueError("percentile requires at least one value")
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int((len(ordered) - 1) * quantile)))
    return ordered[index]


def _positive_rss(value: int, source: str) -> int:
    if value <= 0:
        raise RuntimeError(f"{source} returned a non-positive peak RSS")
    return value


def _windows_peak_rss_bytes(ctypes_module: Any | None = None) -> int:
    if ctypes_module is None:
        import ctypes as ctypes_module

    # Win32 DWORD and BOOL are always 32-bit, including on 64-bit Windows.
    # Fixed-width declarations also let non-Windows unit tests verify the ABI
    # layout without inheriting the host C long width.
    dword = ctypes_module.c_uint32
    bool32 = ctypes_module.c_int32
    handle = ctypes_module.c_void_p

    class ProcessMemoryCounters(ctypes_module.Structure):
        _fields_ = [
            ("cb", dword),
            ("PageFaultCount", dword),
            ("PeakWorkingSetSize", ctypes_module.c_size_t),
            ("WorkingSetSize", ctypes_module.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes_module.c_size_t),
            ("QuotaPagedPoolUsage", ctypes_module.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes_module.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes_module.c_size_t),
            ("PagefileUsage", ctypes_module.c_size_t),
            ("PeakPagefileUsage", ctypes_module.c_size_t),
        ]

    kernel32 = ctypes_module.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes_module.WinDLL("psapi", use_last_error=True)
    get_current_process = kernel32.GetCurrentProcess
    get_current_process.argtypes = []
    get_current_process.restype = handle
    get_process_memory_info = psapi.GetProcessMemoryInfo
    get_process_memory_info.argtypes = [
        handle,
        ctypes_module.POINTER(ProcessMemoryCounters),
        dword,
    ]
    get_process_memory_info.restype = bool32

    counters = ProcessMemoryCounters()
    counters.cb = ctypes_module.sizeof(counters)
    if not get_process_memory_info(
        get_current_process(), ctypes_module.byref(counters), counters.cb
    ):
        error_code = ctypes_module.get_last_error()
        detail = ctypes_module.FormatError(error_code).strip()
        raise OSError(error_code, f"GetProcessMemoryInfo failed: {detail}")
    return _positive_rss(int(counters.PeakWorkingSetSize), "GetProcessMemoryInfo")


def _posix_peak_rss_bytes(
    resource_module: Any | None = None, platform_name: str | None = None
) -> int:
    if resource_module is None:
        import resource as resource_module

    platform_name = platform_name or sys.platform
    value = int(resource_module.getrusage(resource_module.RUSAGE_SELF).ru_maxrss)
    return _positive_rss(
        value if platform_name == "darwin" else value * 1024,
        "getrusage",
    )


def peak_rss_bytes() -> int:
    return (
        _windows_peak_rss_bytes()
        if sys.platform == "win32"
        else _posix_peak_rss_bytes()
    )


def observation(
    workload: str,
    case: str,
    repetition: int,
    concurrency: int,
    payload_bytes: int,
    latencies_ns: list[int],
    elapsed_ns: int,
    cpu_seconds: float,
    *,
    cancelled: int = 0,
    errors: int = 0,
    peak_inflight: int = 0,
    shutdown_ms: float = 0.0,
) -> dict[str, Any]:
    operations = len(latencies_ns)
    return {
        "schema": "kungfu.python-kfx-asyncio.performance-observation/v1",
        "workload": workload,
        "case": case,
        "repetition": repetition,
        "concurrency": concurrency,
        "payload_bytes": payload_bytes,
        "operations": operations,
        "elapsed_ns": elapsed_ns,
        "throughput_ops_per_second": (
            operations * 1_000_000_000 / elapsed_ns if elapsed_ns else 0.0
        ),
        "p50_microseconds": percentile(latencies_ns, 0.50) / 1000,
        "p95_microseconds": percentile(latencies_ns, 0.95) / 1000,
        "p99_microseconds": percentile(latencies_ns, 0.99) / 1000,
        "cpu_seconds": cpu_seconds,
        "peak_rss_bytes": peak_rss_bytes(),
        "shutdown_milliseconds": shutdown_ms,
        "cancelled_operations": cancelled,
        "error_operations": errors,
        "backpressure_peak_inflight": peak_inflight,
        "status": "passed",
    }


async def measure_async_case(
    factory: Callable[[], Awaitable[Any]], operations: int, concurrency: int
) -> tuple[list[int], int, float]:
    latencies: list[int] = []
    semaphore = asyncio.Semaphore(concurrency)

    async def one() -> None:
        async with semaphore:
            started = time.perf_counter_ns()
            await factory()
            latencies.append(time.perf_counter_ns() - started)

    cpu_started = time.process_time()
    started = time.perf_counter_ns()
    await asyncio.gather(*(one() for _ in range(operations)))
    return (
        latencies,
        time.perf_counter_ns() - started,
        time.process_time() - cpu_started,
    )


async def raw_asyncio_observations(
    repetitions: int, operations: int, concurrency_values: list[int]
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []

    async def one_yield() -> None:
        await asyncio.sleep(0)

    async def future_handoff() -> None:
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        loop.call_soon(future.set_result, None)
        await future

    for concurrency in concurrency_values:
        for case, factory in (
            ("one-yield", one_yield),
            ("future-handoff", future_handoff),
        ):
            for repetition in range(repetitions):
                latencies, elapsed, cpu = await measure_async_case(
                    factory, operations, concurrency
                )
                records.append(
                    observation(
                        "raw-asyncio-scheduling",
                        case,
                        repetition,
                        concurrency,
                        64,
                        latencies,
                        elapsed,
                        cpu,
                        peak_inflight=concurrency,
                    )
                )

        for repetition in range(repetitions):
            started = time.perf_counter_ns()
            cpu_started = time.process_time()
            cancelled = errors = 0

            async def never() -> None:
                await asyncio.Event().wait()

            task = asyncio.create_task(never())
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                cancelled += 1
            try:
                await asyncio.wait_for(never(), timeout=0.001)
            except TimeoutError:
                cancelled += 1

            async def fail() -> None:
                raise RuntimeError("expected qualification error")

            try:
                await fail()
            except RuntimeError:
                errors += 1
            elapsed = time.perf_counter_ns() - started
            records.append(
                observation(
                    "raw-asyncio-scheduling",
                    "cancel-timeout-error",
                    repetition,
                    concurrency,
                    64,
                    [elapsed],
                    elapsed,
                    time.process_time() - cpu_started,
                    cancelled=cancelled,
                    errors=errors,
                )
            )
    return records


class _Home:
    uid = 1
    uname = "qualification"


class _Reactor:
    def __init__(self) -> None:
        self.home = _Home()
        self.live = True
        self.steps = 0

    def now(self) -> int:
        return time.time_ns()

    def step(self, _limit: int) -> None:
        self.steps += 1

    def setup(self) -> None:
        pass

    def pre_setup(self) -> None:
        pass

    def on_exit(self) -> None:
        pass

    def get_home_uid(self) -> int:
        return 1

    def get_home_uname(self) -> str:
        return "qualification"

    def get_begin_time(self) -> int:
        return 0

    def get_end_time(self) -> int:
        return 0


def bridge_observations(repetitions: int, operations: int) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for repetition in range(repetitions):
        reactor = _Reactor()
        bridge = JournalAsyncioBridge(object(), reactor)
        latencies: list[int] = []
        started = time.perf_counter_ns()
        cpu_started = time.process_time()
        for _ in range(operations):
            queued = time.perf_counter_ns()
            bridge.submit_journal_callback(
                lambda queued=queued: latencies.append(time.perf_counter_ns() - queued)
            )
        bridge.step(0)
        empty_started = time.perf_counter_ns()
        bridge.step(0)
        empty_latency = time.perf_counter_ns() - empty_started
        elapsed = time.perf_counter_ns() - started
        bridge.close()
        if len(latencies) != operations or reactor.steps != 2:
            raise AssertionError("journal bridge dropped a callback or pump step")
        records.append(
            observation(
                "journal-asyncio-bridge",
                "journal-callback-and-empty-pump",
                repetition,
                1,
                64,
                latencies + [empty_latency],
                elapsed,
                time.process_time() - cpu_started,
                peak_inflight=operations,
            )
        )
    return records


async def relay_repetition(
    operations: int, concurrency: int, payload_bytes: int
) -> tuple[list[int], int, float, int]:
    guest_socket, host_socket = socket.socketpair()
    guest_read = guest_socket.makefile("r", encoding="utf-8", newline="\n")
    guest_write = guest_socket.makefile("w", encoding="utf-8", newline="\n")
    host_read = host_socket.makefile("r", encoding="utf-8", newline="\n")
    host_write = host_socket.makefile("w", encoding="utf-8", newline="\n")
    failures: list[BaseException] = []
    peak = 0

    def host() -> None:
        nonlocal peak
        pending: list[dict[str, Any]] = []
        try:
            for _ in range(operations):
                frame = json.loads(host_read.readline())
                pending.append(frame)
                peak = max(peak, len(pending))
                if len(pending) >= concurrency:
                    for item in reversed(pending):
                        host_write.write(
                            json.dumps(
                                {
                                    "t": "result",
                                    "id": item["id"],
                                    "ok": True,
                                    "value": len(item["args"][0]),
                                }
                            )
                            + "\n"
                        )
                    host_write.flush()
                    pending.clear()
            for item in reversed(pending):
                host_write.write(
                    json.dumps(
                        {
                            "t": "result",
                            "id": item["id"],
                            "ok": True,
                            "value": len(item["args"][0]),
                        }
                    )
                    + "\n"
                )
            host_write.flush()
        except BaseException as error:
            failures.append(error)
        finally:
            host_write.close()
            host_read.close()
            host_socket.close()

    thread = threading.Thread(target=host, daemon=True)
    thread.start()
    session = open_async_session(
        ["echo"], read_stream=guest_read, write_stream=guest_write
    )
    payload = "x" * payload_bytes
    latencies: list[int] = []
    semaphore = asyncio.Semaphore(concurrency)

    async def invoke() -> None:
        async with semaphore:
            started = time.perf_counter_ns()
            value = await session.caps["echo"].send(payload)
            latencies.append(time.perf_counter_ns() - started)
            if value != payload_bytes:
                raise AssertionError("capability relay corrupted its payload")

    cpu_started = time.process_time()
    started = time.perf_counter_ns()
    await asyncio.gather(*(invoke() for _ in range(operations)))
    elapsed = time.perf_counter_ns() - started
    try:
        guest_socket.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    thread.join(timeout=5)
    guest_write.close()
    guest_read.close()
    guest_socket.close()
    if thread.is_alive() or failures:
        raise AssertionError(f"capability relay host failed: {failures}")
    return latencies, elapsed, time.process_time() - cpu_started, peak


async def relay_observations(
    repetitions: int,
    operations: int,
    concurrency_values: list[int],
    payload_values: list[int],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for concurrency in concurrency_values:
        for payload_bytes in payload_values:
            for repetition in range(repetitions):
                latencies, elapsed, cpu, peak = await relay_repetition(
                    operations, concurrency, payload_bytes
                )
                records.append(
                    observation(
                        "async-capability-relay",
                        "round-trip",
                        repetition,
                        concurrency,
                        payload_bytes,
                        latencies,
                        elapsed,
                        cpu,
                        peak_inflight=peak,
                    )
                )
    return records


def _service_environment(entry: Path) -> dict[str, str]:
    python_path = os.pathsep.join(
        value
        for value in (
            str(ROOT / "framework" / "core" / "build" / "Release"),
            str(ROOT / "framework" / "core" / "src" / "python"),
            os.environ.get("PYTHONPATH", ""),
        )
        if value
    )
    return {
        **os.environ,
        "KFX_DECLARED": '["echo"]',
        "KFX_SERVICE_ENTRY": str(entry),
        "KFX_SERVICE_PACKAGE_KEY": "qualification.python-service",
        "KFX_SERVICE_AUTHORIZATION_ROOT": "sha256:" + "1" * 64,
        "KFX_SERVICE_CAPABILITY_GRANT_ROOT": "sha256:" + "2" * 64,
        "KFX_SERVICE_GENERATION_ROOT": "sha256:" + "3" * 64,
        "PYTHONPATH": python_path,
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def process_lifecycle_observations(repetitions: int) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="kungfu-python-kfx-performance-") as root:
        temporary = Path(root)
        returning = temporary / "returning.py"
        returning.write_text(
            "async def run(caps):\n    value = await caps['echo'].ping('x' * 64)\n    assert value == 64\n",
            encoding="utf-8",
        )
        waiting = temporary / "waiting.py"
        waiting.write_text(
            "import asyncio\nasync def run(caps):\n    await asyncio.Event().wait()\n",
            encoding="utf-8",
        )
        for repetition in range(repetitions):
            cpu_started = time.process_time()
            started = time.perf_counter_ns()
            process = subprocess.Popen(
                [sys.executable, "-m", "kungfu.kfx_host"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=_service_environment(returning),
            )
            assert process.stdout is not None and process.stdin is not None
            relay_line = process.stdout.readline()
            if not relay_line:
                _stdout, stderr = process.communicate(timeout=10)
                raise AssertionError(
                    f"Python service host stopped before relay invocation: {stderr}"
                )
            frame = json.loads(relay_line)
            if frame.get("t") != "invoke":
                raise AssertionError(
                    f"Python service host emitted invalid relay frame: {frame}"
                )
            process.stdin.write(
                json.dumps({"t": "result", "id": frame["id"], "ok": True, "value": 64})
                + "\n"
            )
            process.stdin.flush()
            _stdout, stderr = process.communicate(timeout=10)
            elapsed = time.perf_counter_ns() - started
            if (
                process.returncode != 0
                or '"state":"running"' not in stderr
                or '"state":"stopped"' not in stderr
            ):
                raise AssertionError(f"Python service host lifecycle failed: {stderr}")

            shutdown_process = subprocess.Popen(
                [sys.executable, "-m", "kungfu.kfx_host"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=_service_environment(waiting),
            )
            assert (
                shutdown_process.stdin is not None
                and shutdown_process.stderr is not None
            )
            status_lines: list[str] = []
            while True:
                line = shutdown_process.stderr.readline()
                if not line:
                    raise AssertionError("Python service host stopped before running")
                status_lines.append(line)
                if '"state":"running"' in line:
                    break
            shutdown_started = time.perf_counter_ns()
            shutdown_process.stdin.write('{"t":"control","action":"shutdown"}\n')
            shutdown_process.stdin.flush()
            _stdout, tail = shutdown_process.communicate(timeout=10)
            shutdown_ms = (time.perf_counter_ns() - shutdown_started) / 1_000_000
            stderr = "".join(status_lines) + tail
            if shutdown_process.returncode != 0 or '"state":"stopped"' not in stderr:
                raise AssertionError(
                    f"Python service graceful shutdown failed: {stderr}"
                )
            records.append(
                observation(
                    "python-service-process-lifecycle",
                    "cold-launch-relay-and-graceful-shutdown",
                    repetition,
                    1,
                    64,
                    [elapsed],
                    elapsed,
                    time.process_time() - cpu_started,
                    peak_inflight=1,
                    shutdown_ms=shutdown_ms,
                )
            )
    return records


async def soak_observation(seconds: float) -> dict[str, Any]:
    latencies: list[int] = []
    cpu_started = time.process_time()
    started = time.perf_counter_ns()
    deadline = time.monotonic() + seconds
    operations = 0
    while time.monotonic() < deadline:
        values, _elapsed, _cpu, _peak = await relay_repetition(64, 8, 1024)
        latencies.extend(values)
        operations += len(values)
    elapsed = time.perf_counter_ns() - started
    record = observation(
        "bounded-relay-soak",
        "relay-1024b-concurrency-8",
        0,
        8,
        1024,
        latencies,
        elapsed,
        time.process_time() - cpu_started,
        peak_inflight=8,
    )
    record["operations"] = operations
    record["throughput_ops_per_second"] = operations * 1_000_000_000 / elapsed
    return record


def load_profile(pathname: Path) -> dict[str, Any]:
    profile = json.loads(pathname.read_text(encoding="utf-8"))
    if profile.get("schema") != "kungfu.python-kfx-asyncio.performance-profile/v1":
        raise ValueError("unsupported performance profile")
    return profile


async def execute(profile: dict[str, Any], quick: bool = False) -> list[dict[str, Any]]:
    sampling = profile["sampling"]
    repetitions = 1 if quick else sampling["scored_repetitions"]
    operations = 16 if quick else sampling["operations_per_repetition"]
    concurrency_values = [1, 8] if quick else profile["matrix"]["concurrency"]
    payload_values = [64, 1024] if quick else profile["matrix"]["payload_bytes"]
    if not quick:
        warmups = sampling["warmup_repetitions"]
        await raw_asyncio_observations(warmups, operations, concurrency_values)
        await asyncio.to_thread(bridge_observations, warmups, operations)
        await relay_observations(
            warmups, operations, concurrency_values, payload_values
        )
        await asyncio.to_thread(process_lifecycle_observations, warmups)
    records = await raw_asyncio_observations(
        repetitions, operations, concurrency_values
    )
    records.extend(
        await asyncio.to_thread(bridge_observations, repetitions, operations)
    )
    records.extend(
        await relay_observations(
            repetitions, operations, concurrency_values, payload_values
        )
    )
    records.extend(await asyncio.to_thread(process_lifecycle_observations, repetitions))
    records.append(await soak_observation(0.05 if quick else sampling["soak_seconds"]))
    return records


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--quick", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if sys.version_info[:2] != (3, 13):
        print(
            json.dumps(
                {
                    "schema": "kungfu.python-kfx-asyncio.performance-failure/v1",
                    "error": f"CPython 3.13 required; found {platform.python_version()}",
                }
            )
        )
        return 2
    try:
        profile = load_profile(args.profile)
        for record in asyncio.run(execute(profile, args.quick)):
            print(json.dumps(record, sort_keys=True, separators=(",", ":")), flush=True)
        print(
            json.dumps(
                {
                    "schema": "kungfu.python-kfx-asyncio.performance-manifest/v1",
                    "python": platform.python_version(),
                    "implementation": platform.python_implementation(),
                    "platform": sys.platform,
                    "machine": platform.machine().lower(),
                    "quick": args.quick,
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
            flush=True,
        )
        return 0
    except BaseException as error:
        print(
            json.dumps(
                {
                    "schema": "kungfu.python-kfx-asyncio.performance-failure/v1",
                    "error_type": type(error).__name__,
                    "error": str(error),
                },
                sort_keys=True,
            ),
            flush=True,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
