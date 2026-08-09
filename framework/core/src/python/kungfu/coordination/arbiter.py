#  SPDX-License-Identifier: Apache-2.0
#
# Journal-native coordination arbiter — the KF-ADR-019f86da-4f90-7332-a4cd-c9c9b549a5fb next increment over the
# file-backed `locks.py` prototype. A single resident peer (the arbiter) owns an
# in-memory lock table and is the sole writer of a grant stream. Clients write a
# `coordination.lock.request` frame TO the arbiter and block on a coroutine that
# resolves when the matching `coordination.lock.grant` frame arrives on the
# arbiter's public journal. This removes the two prototype simplifications at
# once:
#
#   * No poll. A waiter is woken by the nng/reactor when its grant frame lands,
#     instead of re-reading a JSON table on a timer.
#   * Native audit. request / grant / release are journal frames, i.e. Episodes,
#     so the coordination history is a replayable record with no bespoke audit
#     side-channel (this subsumes `audit.py`).
#
# The contention logic lives in `LockTable`, which is pure standard library and
# is unit-tested without the native runtime. `Arbiter` is the thin live layer
# that binds the table to the journal substrate (peer.observe / get_public_writer
# / request_write_to), validated by the PoC in the goal record.

from __future__ import annotations

import json
from typing import Any

# Custom action-envelope types. These need no C++ schema change: `wrap_event`
# falls back to an identity schema_ref and `unwrap_event(..., schema_bfbs=None)`
# skips domain verification, so a JSON payload rides inside the envelope.
ACTION_REQUEST = "coordination.lock.request"
ACTION_GRANT = "coordination.lock.grant"
ACTION_RELEASE = "coordination.lock.release"
ACTION_INSTRUCT = "coordination.instruct"


class LockTable:
    """In-memory arbiter lock table — pure logic, no runtime dependency.

    Every method returns the *grant decision* rather than performing any IO, so
    the live layer can turn a decision into a grant frame while this class stays
    unit-testable off the native runtime. A lock is identified by ``name`` and a
    holder / waiter by an opaque integer ``uid`` (the peer location uid on the
    live path). Waiters are served strictly FIFO, which gives bounded wait: a
    request never starves behind later arrivals.
    """

    def __init__(self) -> None:
        self._holders: dict[str, int] = {}
        self._waiters: dict[str, list[int]] = {}

    def request(self, name: str, uid: int) -> int | None:
        """``uid`` asks for ``name``.

        Return ``uid`` if it is granted now — either the lock was free, or
        ``uid`` already holds it (an idempotent re-grant so a client that missed
        its grant frame can re-request and be re-answered). Return ``None`` if
        ``uid`` is enqueued as a waiter (a duplicate request while waiting is a
        no-op, so a retry never enqueues twice).
        """
        holder = self._holders.get(name)
        if holder is None:
            self._holders[name] = uid
            return uid
        if holder == uid:
            return uid
        queue = self._waiters.setdefault(name, [])
        if uid not in queue:
            queue.append(uid)
        return None

    def release(self, name: str, uid: int) -> int | None:
        """``uid`` releases ``name``.

        If ``uid`` is the holder, hand the lock to the next waiter and return the
        new holder uid (or ``None`` if the lock is now free). A release from a
        non-holder only cancels that uid's pending wait, if any, and returns
        ``None`` — it never disturbs the current holder.
        """
        if self._holders.get(name) != uid:
            queue = self._waiters.get(name)
            if queue and uid in queue:
                queue.remove(uid)
                if not queue:
                    self._waiters.pop(name, None)
            return None
        return self._grant_next(name)

    def forget(self, uid: int) -> list[tuple[str, int | None]]:
        """A peer died or deregistered: reclaim everything tied to ``uid``.

        Drop ``uid`` from every waiter queue first (so it can never be granted a
        lock it will never take), then hand off every lock it currently holds to
        the next waiter. Return ``[(name, new_holder_or_None), ...]`` for exactly
        the locks whose holder changed, so the live layer emits one grant frame
        per real transition. This is the crash-safe auto-release invariant of
        KF-ADR-019f86da-4f90-7332-a4cd-c9c9b549a5fb, now driven by peer liveness instead of pid liveness.
        """
        for name in list(self._waiters):
            queue = self._waiters[name]
            if uid in queue:
                queue.remove(uid)
            if not queue:
                self._waiters.pop(name, None)
        transitions: list[tuple[str, int | None]] = []
        for name, holder in list(self._holders.items()):
            if holder == uid:
                transitions.append((name, self._grant_next(name)))
        return transitions

    def _grant_next(self, name: str) -> int | None:
        """Pass ``name`` to the head of its waiter queue, or free it."""
        queue = self._waiters.get(name)
        if queue:
            nxt = queue.pop(0)
            self._holders[name] = nxt
            if not queue:
                self._waiters.pop(name, None)
            return nxt
        self._holders.pop(name, None)
        self._waiters.pop(name, None)
        return None

    def holder(self, name: str) -> int | None:
        return self._holders.get(name)

    def waiters(self, name: str) -> list[int]:
        return list(self._waiters.get(name, []))

    def snapshot(self) -> dict[str, dict[str, Any]]:
        """Debug / status view of the whole table."""
        return {
            name: {"holder": holder, "waiters": list(self._waiters.get(name, []))}
            for name, holder in self._holders.items()
        }


def grant_payload(name: str, holder: int) -> bytes:
    """Canonical grant-frame payload. Clients match on ``holder == self_uid``."""
    return json.dumps({"name": name, "holder": holder}, sort_keys=True).encode("utf-8")


def request_payload(name: str, pid: int | None = None) -> bytes:
    """Request / release payload. ``pid`` lets the arbiter reap a holder that
    died without releasing (a hard kill sends no graceful deregister frame)."""
    obj: dict[str, Any] = {"name": name}
    if pid is not None:
        obj["pid"] = int(pid)
    return json.dumps(obj, sort_keys=True).encode("utf-8")


def _decode(payload: bytes) -> dict[str, Any] | None:
    try:
        obj = json.loads(bytes(payload).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return obj if isinstance(obj, dict) else None


def parse_name(payload: bytes) -> str | None:
    """Read the ``name`` field out of a request / release / grant payload."""
    obj = _decode(payload)
    name = obj.get("name") if obj else None
    return name if isinstance(name, str) else None


def parse_pid(payload: bytes) -> int | None:
    """Read the optional ``pid`` field out of a request / release payload."""
    obj = _decode(payload)
    if not obj or "pid" not in obj:
        return None
    try:
        return int(obj["pid"])
    except (TypeError, ValueError):
        return None


def instruct_payload(text: str) -> bytes:
    """Payload for a `coordination.instruct` frame addressed at a worker."""
    return json.dumps({"instruct": text}, sort_keys=True).encode("utf-8")


def parse_instruct(payload: bytes) -> str | None:
    """Read the instruction text out of a `coordination.instruct` payload."""
    obj = _decode(payload)
    text = obj.get("instruct") if obj else None
    return text if isinstance(text, str) else None
