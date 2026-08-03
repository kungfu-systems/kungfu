# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio
import ctypes
import importlib.util
from pathlib import Path
from types import SimpleNamespace

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


class _FakeFunction:
    def __init__(self, implementation):
        self.implementation = implementation
        self.argtypes = None
        self.restype = None

    def __call__(self, *args):
        return self.implementation(*args)


def fake_windows_ctypes(*, peak_rss: int = 4096, ok: bool = True, error: int = 5):
    current_process = _FakeFunction(lambda: 0x1234)

    def memory_info(handle, counters_pointer, size):
        assert handle == 0x1234
        assert size == ctypes.sizeof(counters_pointer._obj)
        counters_pointer._obj.PeakWorkingSetSize = peak_rss
        return int(ok)

    get_process_memory_info = _FakeFunction(memory_info)
    libraries = {
        "kernel32": SimpleNamespace(GetCurrentProcess=current_process),
        "psapi": SimpleNamespace(GetProcessMemoryInfo=get_process_memory_info),
    }
    fake = SimpleNamespace(
        Structure=ctypes.Structure,
        POINTER=ctypes.POINTER,
        byref=ctypes.byref,
        c_int32=ctypes.c_int32,
        c_uint32=ctypes.c_uint32,
        c_size_t=ctypes.c_size_t,
        c_void_p=ctypes.c_void_p,
        sizeof=ctypes.sizeof,
        WinDLL=lambda name, use_last_error: libraries[name],
        get_last_error=lambda: error,
        FormatError=lambda code: f"fixture error {code}",
    )
    return fake, current_process, get_process_memory_info


def test_percentile_retains_tail_observations():
    values = list(range(1, 101))
    assert workload.percentile(values, 0.50) == 50
    assert workload.percentile(values, 0.95) == 95
    assert workload.percentile(values, 0.99) == 99


def test_windows_peak_rss_uses_typed_64_bit_process_memory_api():
    fake, current_process, get_process_memory_info = fake_windows_ctypes(
        peak_rss=8_388_608
    )
    assert workload._windows_peak_rss_bytes(fake) == 8_388_608
    assert current_process.argtypes == []
    assert current_process.restype is ctypes.c_void_p
    assert get_process_memory_info.restype is ctypes.c_int32
    assert get_process_memory_info.argtypes[0] is ctypes.c_void_p


def test_windows_peak_rss_surfaces_api_failure():
    fake, _current_process, _get_process_memory_info = fake_windows_ctypes(
        ok=False, error=5
    )
    with pytest.raises(OSError) as failure:
        workload._windows_peak_rss_bytes(fake)
    assert failure.value.errno == 5
    assert "GetProcessMemoryInfo failed" in str(failure.value)


def test_windows_peak_rss_rejects_zero_result():
    fake, _current_process, _get_process_memory_info = fake_windows_ctypes(peak_rss=0)
    with pytest.raises(RuntimeError, match="non-positive peak RSS"):
        workload._windows_peak_rss_bytes(fake)


def test_windows_peak_rss_surfaces_process_exit_race():
    fake, _current_process, _get_process_memory_info = fake_windows_ctypes(
        ok=False, error=6
    )
    with pytest.raises(OSError) as failure:
        workload._windows_peak_rss_bytes(fake)
    assert failure.value.errno == 6


def test_posix_peak_rss_normalizes_platform_units_and_rejects_zero():
    usage = SimpleNamespace(ru_maxrss=2048)
    resource = SimpleNamespace(RUSAGE_SELF=0, getrusage=lambda _target: usage)
    assert workload._posix_peak_rss_bytes(resource, "darwin") == 2048
    assert workload._posix_peak_rss_bytes(resource, "linux") == 2048 * 1024
    usage.ru_maxrss = 0
    with pytest.raises(RuntimeError, match="non-positive peak RSS"):
        workload._posix_peak_rss_bytes(resource, "linux")


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
