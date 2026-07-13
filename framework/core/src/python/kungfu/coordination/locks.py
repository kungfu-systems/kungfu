#  SPDX-License-Identifier: Apache-2.0
#
# File-backed, same-host named locks with crash-safe auto-release — the first
# slice of ADR-0077 (agent coordination on the live runtime).
#
# Reuses the route-lease pattern from `kungfu.runtime_service`: an atomic JSON
# table plus PID-liveness. A lock held by a process that is no longer alive is
# reclaimable, so a crashed holder never deadlocks the workspace (the auto-
# release invariant of ADR-0077). The whole read-modify-write is serialized
# across processes by an advisory `flock` over a sidecar lock file, so two
# racing acquirers never both win.
#
# Value delivered: an agent takes the workspace lock by running one blocking
# `with_lock` (or `acquire`) call. The agent's model never runs the retry loop
# — the wait happens inside this call — so contending on the shared mainline no
# longer burns model tokens.
#
# Deliberate prototype simplifications, tracked as the ADR-0077 next increment:
#   - A waiter blocks by polling the table on a short interval rather than by a
#     `coloop` coroutine awaiting an nng-notify grant frame. The poll is a cheap
#     same-process file read; the expensive poll (model tokens) is already gone.
#   - Grants and releases are not yet recorded as Episodes.
# Both are pure additions over this table and change no semantics here.

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Iterable

SCHEMA = "kungfu.coordination.locks/v1"
DEFAULT_POLL_SECONDS = 0.1
_TABLE_NAME = "locks.json"


def _now() -> float:
    return time.time()


def _pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def table_path(root: str | os.PathLike[str]) -> Path:
    return Path(root) / _TABLE_NAME


@contextlib.contextmanager
def _table_guard(path: Path):
    """Serialize the read-modify-write across processes via a sidecar flock."""
    path.parent.mkdir(parents=True, exist_ok=True)
    guard = path.with_suffix(".guard")
    fd = os.open(str(guard), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _read(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"schema": SCHEMA, "locks": {}}
    if not isinstance(payload.get("locks"), dict):
        return {"schema": SCHEMA, "locks": {}}
    return payload


def _write(path: Path, payload: dict[str, Any]) -> None:
    payload["schema"] = SCHEMA
    payload["updatedAt"] = _now()
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", "utf-8")
    os.replace(tmp, path)


def _try_claim(path: Path, name: str, pid: int, label: str) -> bool:
    """Claim `name` for `pid` if it is free or its holder is dead. Atomic."""
    with _table_guard(path):
        payload = _read(path)
        locks = payload.setdefault("locks", {})
        holder = locks.get(name)
        if (
            isinstance(holder, dict)
            and holder.get("pid") != pid
            and _pid_alive(holder.get("pid"))
        ):
            return False
        locks[name] = {"pid": pid, "label": label, "acquiredAt": _now()}
        _write(path, payload)
        return True


def _release(path: Path, name: str, pid: int) -> bool:
    with _table_guard(path):
        payload = _read(path)
        locks = payload.get("locks", {})
        holder = locks.get(name)
        if isinstance(holder, dict) and holder.get("pid") == pid:
            del locks[name]
            _write(path, payload)
            return True
        return False


def acquire(
    root: str | os.PathLike[str],
    name: str,
    *,
    label: str | None = None,
    pid: int | None = None,
    poll: float = DEFAULT_POLL_SECONDS,
    on_wait: Callable[[], None] | None = None,
) -> bool:
    """Block until `name` is held by this process. Returns True if it waited."""
    pid = pid or os.getpid()
    label = label or f"pid:{pid}"
    path = table_path(root)
    waited = False
    while not _try_claim(path, name, pid, label):
        if on_wait is not None and not waited:
            on_wait()
        waited = True
        time.sleep(poll)
    return waited


def release(root: str | os.PathLike[str], name: str, *, pid: int | None = None) -> bool:
    """Release `name` if this process holds it. Returns True if it did."""
    return _release(table_path(root), name, pid or os.getpid())


@contextlib.contextmanager
def held(
    root: str | os.PathLike[str],
    name: str,
    *,
    on_acquire: Callable[[bool], None] | None = None,
    on_release: Callable[[bool], None] | None = None,
    **kwargs: Any,
):
    """Hold `name` for the duration of the block; always released on exit.

    `on_acquire(waited)` fires once the lock is held (``waited`` is True if the
    call blocked); `on_release(released)` fires after the release attempt. Both
    are how a caller layers side effects such as Episode audit records onto the
    otherwise dependency-free lock (ADR-0077).
    """
    waited = acquire(root, name, **kwargs)
    if on_acquire is not None:
        on_acquire(waited)
    try:
        yield
    finally:
        released = release(root, name, pid=kwargs.get("pid"))
        if on_release is not None:
            on_release(released)


def with_lock(
    root: str | os.PathLike[str],
    name: str,
    argv: Iterable[str],
    *,
    label: str | None = None,
) -> int:
    """Run `argv` while holding `name`; release on exit or crash. Returns rc."""
    argv = list(argv)
    with held(root, name, label=label or f"cmd:{argv[0] if argv else '?'}"):
        return subprocess.call(argv)


def status(root: str | os.PathLike[str]) -> dict[str, dict[str, Any]]:
    """Current locks with holder liveness (a dead holder is reclaimable)."""
    path = table_path(root)
    with _table_guard(path):
        payload = _read(path)
    return {
        name: {
            **holder,
            "holderState": "alive" if _pid_alive(holder.get("pid")) else "dead",
        }
        for name, holder in payload.get("locks", {}).items()
        if isinstance(holder, dict)
    }
