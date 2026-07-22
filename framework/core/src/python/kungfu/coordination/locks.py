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
# Within one process, ownership also includes the current thread and a
# reentrancy depth: sibling threads serialize, while nested use by one thread
# releases the named lock only when its outermost holder exits.
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
import ctypes
import errno
import importlib
import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable

SCHEMA = "kungfu.coordination.locks/v1"
DEFAULT_POLL_SECONDS = 0.1
_TABLE_NAME = "locks.json"
_LOCK_BACKEND = importlib.import_module("msvcrt" if os.name == "nt" else "fcntl")


def _now() -> float:
    return time.time()


def _pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_alive(pid)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _windows_pid_alive(pid: int) -> bool:
    """Query a Windows process without signal 0, which is CTRL_C_EVENT."""
    process_query_limited_information = 0x1000
    still_active = 259
    win_dll = getattr(ctypes, "WinDLL", None)
    if win_dll is None:
        return False
    kernel32 = win_dll("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_ulong),
    ]
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        return False
    try:
        exit_code = ctypes.c_ulong()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and (
            exit_code.value == still_active
        )
    finally:
        kernel32.CloseHandle(handle)


def table_path(root: str | os.PathLike[str]) -> Path:
    return Path(root) / _TABLE_NAME


@contextlib.contextmanager
def _table_guard(path: Path):
    """Serialize the read-modify-write through a platform advisory lock."""
    path.parent.mkdir(parents=True, exist_ok=True)
    guard = path.with_suffix(".guard")
    fd = os.open(str(guard), os.O_CREAT | os.O_RDWR, 0o644)
    acquired = False
    try:
        if os.name == "nt":
            # ``msvcrt.locking`` locks bytes from the current file position.
            # Keep one stable byte in the sidecar and retry non-blocking claims
            # so the Windows behavior matches the indefinitely blocking flock.
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            while True:
                os.lseek(fd, 0, os.SEEK_SET)
                try:
                    _LOCK_BACKEND.locking(fd, _LOCK_BACKEND.LK_NBLCK, 1)
                    acquired = True
                    break
                except OSError as exc:
                    if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                        raise
                    time.sleep(DEFAULT_POLL_SECONDS)
        else:
            _LOCK_BACKEND.flock(fd, _LOCK_BACKEND.LOCK_EX)
            acquired = True
        yield
    finally:
        try:
            if acquired and os.name == "nt":
                os.lseek(fd, 0, os.SEEK_SET)
                _LOCK_BACKEND.locking(fd, _LOCK_BACKEND.LK_UNLCK, 1)
            elif acquired:
                _LOCK_BACKEND.flock(fd, _LOCK_BACKEND.LOCK_UN)
        finally:
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


def _owner(pid: int) -> str:
    return f"{pid}:{threading.get_ident()}"


def _try_claim(path: Path, name: str, pid: int, owner: str, label: str) -> bool:
    """Claim `name` for `pid` if it is free or its holder is dead. Atomic."""
    with _table_guard(path):
        payload = _read(path)
        locks = payload.setdefault("locks", {})
        holder = locks.get(name)
        if isinstance(holder, dict):
            if holder.get("owner") == owner:
                holder["depth"] = int(holder.get("depth") or 1) + 1
                _write(path, payload)
                return True
            if _pid_alive(holder.get("pid")):
                return False
        locks[name] = {
            "pid": pid,
            "owner": owner,
            "depth": 1,
            "label": label,
            "acquiredAt": _now(),
        }
        _write(path, payload)
        return True


def _release(path: Path, name: str, pid: int, owner: str) -> bool:
    with _table_guard(path):
        payload = _read(path)
        locks = payload.get("locks", {})
        holder = locks.get(name)
        if isinstance(holder, dict) and (
            holder.get("owner") == owner
            or (holder.get("owner") is None and holder.get("pid") == pid)
        ):
            depth = int(holder.get("depth") or 1)
            if depth > 1:
                holder["depth"] = depth - 1
            else:
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
    """Block until `name` is held by this thread. Returns True if it waited."""
    pid = pid or os.getpid()
    owner = _owner(pid)
    label = label or f"pid:{pid}"
    path = table_path(root)
    waited = False
    while not _try_claim(path, name, pid, owner, label):
        if on_wait is not None and not waited:
            on_wait()
        waited = True
        time.sleep(poll)
    return waited


def release(root: str | os.PathLike[str], name: str, *, pid: int | None = None) -> bool:
    """Release `name` if this thread holds it. Returns True if it did."""
    pid = pid or os.getpid()
    return _release(table_path(root), name, pid, _owner(pid))


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
