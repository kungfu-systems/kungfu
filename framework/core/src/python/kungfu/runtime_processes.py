# SPDX-License-Identifier: Apache-2.0

"""Process identity and termination mechanics for the Python runtime host.

This module owns the operating-system process boundary only. Runtime routing,
leases, persisted state, and coordinator policy remain in ``runtime_service``.
Keeping the boundary this narrow lets the service orchestrator reuse one
PID-reuse fence and one descendant-reaping implementation on every platform.
"""

from __future__ import annotations

import subprocess
from typing import Any, Protocol, cast

import psutil


class CoordinatorProcess(Protocol):
    """The process-shaped surface used by the runtime service."""

    pid: int

    def poll(self) -> int | None: ...

    def terminate(self) -> None: ...

    def wait(self, timeout: float | None = None) -> int: ...

    def kill(self) -> None: ...


class RuntimeProcessControl:
    """Single owner for PID identity checks and bounded process-tree shutdown."""

    @staticmethod
    def is_pid_running(pid: int | None) -> bool:
        try:
            pid_value = cast(int, pid)
            if pid_value <= 0:
                return False
            return psutil.pid_exists(pid_value)
        except (psutil.Error, OSError, TypeError, ValueError):
            return False

    @staticmethod
    def start_identity(pid: int | None) -> str | None:
        """Return a portable PID-reuse fence, or None when it is unknowable."""

        try:
            pid_value = cast(int, pid)
            if pid_value <= 0:
                return None
            return format(psutil.Process(pid_value).create_time(), ".6f")
        except (psutil.Error, OSError, TypeError, ValueError):
            return None

    @staticmethod
    def terminate_if_matches(
        pid: int, start_identity: str, *, force: bool = False
    ) -> bool:
        """Signal only the process object bound to the recorded creation time."""

        try:
            process = psutil.Process(pid)
            if format(process.create_time(), ".6f") != start_identity:
                return False
            if force:
                process.kill()
            else:
                process.terminate()
            return True
        except (psutil.Error, OSError, ValueError):
            return False

    @staticmethod
    def terminate_tree_if_matches(
        pid: int, start_identity: str, *, timeout: float = 5.0
    ) -> bool:
        """Terminate a recorded process and every descendant bound to its tree."""

        try:
            process = psutil.Process(pid)
            if format(process.create_time(), ".6f") != start_identity:
                return False
            descendants = process.children(recursive=True)
        except (psutil.Error, OSError, ValueError):
            return False

        for descendant in reversed(descendants):
            try:
                descendant.terminate()
            except (psutil.Error, OSError, ValueError):
                pass
        try:
            process.terminate()
        except psutil.NoSuchProcess:
            return True
        except (psutil.Error, OSError, ValueError):
            return False

        _, alive = psutil.wait_procs([*descendants, process], timeout=timeout)
        for remaining in alive:
            try:
                remaining.kill()
            except (psutil.Error, OSError, ValueError):
                pass
        if alive:
            psutil.wait_procs(alive, timeout=timeout)
        return True

    @staticmethod
    def terminate_and_reap_child(
        process_host: Any,
        child: CoordinatorProcess,
        timeout: float = 5.0,
    ) -> None:
        """Stop a coordinator tree and wait until OS resources are released."""

        descendants: list[psutil.Process] = []
        try:
            descendants = psutil.Process(child.pid).children(recursive=True)
        except (psutil.Error, OSError, ValueError, AttributeError):
            pass

        for process in reversed(descendants):
            try:
                process.terminate()
            except (psutil.Error, OSError, ValueError):
                pass

        process_host.terminate_child(child)
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=timeout)

        if descendants:
            _, alive = psutil.wait_procs(descendants, timeout=timeout)
            for process in alive:
                try:
                    process.kill()
                except (psutil.Error, OSError, ValueError):
                    pass
            if alive:
                psutil.wait_procs(alive, timeout=timeout)
