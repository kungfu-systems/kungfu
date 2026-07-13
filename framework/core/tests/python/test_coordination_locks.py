#  SPDX-License-Identifier: Apache-2.0
#
# Cross-process tests for the ADR-0077 first-slice named lock. The lock module
# depends only on the standard library, so these load it by file path and run
# without the native runtime binding. This file doubles as the worker process:
# `python test_coordination_locks.py worker <root> <name> <log> <hold>`.

import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

_LOCKS_PATH = (
    Path(__file__).resolve().parents[2]
    / "src"
    / "python"
    / "kungfu"
    / "coordination"
    / "locks.py"
)


def _load_locks():
    spec = importlib.util.spec_from_file_location("adr0077_locks", _LOCKS_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


locks = _load_locks()


def _run_worker(root, name, log, hold):
    """Acquire, bracket a critical section in the shared log, release."""
    with open(log, "a", encoding="utf-8") as fh:
        locks.acquire(root, name)
        fh.write(f"{os.getpid()} START {time.time():.6f}\n")
        fh.flush()
        time.sleep(hold)
        fh.write(f"{os.getpid()} END {time.time():.6f}\n")
        fh.flush()
        locks.release(root, name)


def _spawn_worker(root, name, log, hold):
    return subprocess.Popen(
        [sys.executable, __file__, "worker", str(root), name, str(log), str(hold)]
    )


def _critical_sections(log_text):
    """Return [(pid, start, end)] in log order; assert each is well-formed."""
    events = [line.split() for line in log_text.splitlines() if line.strip()]
    sections, open_start = [], {}
    for pid, kind, ts in events:
        if kind == "START":
            open_start[pid] = float(ts)
        else:
            sections.append((pid, open_start.pop(pid), float(ts)))
    return sections


def test_mutual_exclusion_serializes_contenders(tmp_path):
    root, name, log = tmp_path, "mainline-integration", tmp_path / "log.txt"
    procs = [_spawn_worker(root, name, log, 0.25) for _ in range(3)]
    for p in procs:
        assert p.wait(timeout=30) == 0

    sections = _critical_sections(log.read_text("utf-8"))
    assert len(sections) == 3, sections
    # Sorted by start, no critical section may overlap the next one.
    sections.sort(key=lambda s: s[1])
    for (_, _, prev_end), (_, next_start, _) in zip(sections, sections[1:]):
        assert prev_end <= next_start, f"overlap: {sections}"


def test_waiter_proceeds_after_release(tmp_path):
    root, name = tmp_path, "mainline-integration"
    # This (live) test process takes the lock, so a contender must actually wait.
    assert locks.acquire(root, name) is False  # free: no wait

    started = time.time()
    proc = _spawn_worker(root, name, tmp_path / "log.txt", 0.0)
    time.sleep(0.3)  # this live process still holds it
    assert proc.poll() is None, "waiter should still be blocked"
    locks.release(root, name)
    assert proc.wait(timeout=30) == 0
    assert time.time() - started >= 0.3


def test_dead_holder_is_reclaimed(tmp_path):
    root, name = tmp_path, "mainline-integration"
    # Forge a table whose holder PID is dead → crash auto-release.
    dead_pid = 2_147_480_000
    locks.table_path(root).write_text(
        json.dumps(
            {
                "schema": locks.SCHEMA,
                "locks": {name: {"pid": dead_pid, "label": "crashed"}},
            }
        ),
        "utf-8",
    )
    waited = locks.acquire(root, name, pid=4242, poll=0.05)
    assert waited is False, "a dead holder must be reclaimed without waiting"
    assert locks.status(root)[name]["pid"] == 4242


def test_with_lock_runs_command_and_releases(tmp_path):
    root, name = tmp_path, "mainline-integration"
    marker = tmp_path / "ran.txt"
    rc = locks.with_lock(
        root, name, [sys.executable, "-c", f"open({str(marker)!r},'w').write('ok')"]
    )
    assert rc == 0
    assert marker.read_text() == "ok"
    assert name not in locks.status(root), "lock must be released after with_lock"


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "worker":
        _, _, root, name, log, hold = sys.argv
        _run_worker(root, name, log, float(hold))
    else:
        sys.exit("usage: test_coordination_locks.py worker <root> <name> <log> <hold>")
