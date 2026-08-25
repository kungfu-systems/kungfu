# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import psutil


def _terminate_process_if_matches(
    pid: int, start_identity: str, *, force: bool = False
) -> bool:
    """Signal only the psutil process object bound to the recorded creation time."""

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


def _terminate_process_tree_if_matches(
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
