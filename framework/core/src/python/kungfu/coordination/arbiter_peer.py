#  SPDX-License-Identifier: Apache-2.0
#
# The live arbiter peer (ADR-0077 next increment). This is the thin journal
# layer over the pure `LockTable`: a single resident peer that is the sole
# writer of the grant stream. It keeps no lock state the journal does not — the
# frames it reads (requests) and writes (grants) ARE the coordination record, so
# the audit trail is the journal itself (the "native audit" that subsumes
# `audit.py`).
#
# Substrate (validated by the goal PoC, `poc_channel.py`):
#   * client -> arbiter: a client does `request_write_to(arbiter_uid)` and writes
#     a `coordination.lock.request` frame; the coordinator's Channel machinery
#     auto-joins the arbiter as a reader, so the arbiter's `observe` callback
#     fires with `event.source` = the requesting peer's uid. No client discovery.
#   * arbiter -> client: the arbiter writes a `coordination.lock.grant` frame to
#     its PUBLIC journal; each client does `request_read_from_public(arbiter_uid)`
#     and filters grants by `holder == self_uid`.
#
# Auto-release (crash safety) has two paths, so no lock outlives its holder:
#   * clean exit: the client sends a `coordination.lock.release` frame; the
#     arbiter grants the lock to the next waiter immediately (zero poll).
#   * hard kill: a SIGKILLed holder sends nothing, and the live runtime emits no
#     deregister for an ungraceful death, so the arbiter reaps it. Each request
#     carries the client pid; the arbiter checks holder liveness on a cheap
#     same-host interval (os.kill(pid, 0)) and reclaims a dead holder's locks.
#     This is a centralized, model-token-free check — one service polling pids,
#     not N agents polling a table — and preserves the ADR-0077 auto-release
#     invariant for the ungraceful case.

from __future__ import annotations

import os
import time

import kungfu

from kungfu.action_envelope import CARRIER_ACTION_ENVELOPE
from kungfu.work.wire import unwrap_event, wrap_event
from kungfu.coordination.arbiter import (
    ACTION_GRANT,
    ACTION_RELEASE,
    ACTION_REQUEST,
    LockTable,
    grant_payload,
    parse_name,
    parse_pid,
)

yjj = kungfu.__binding__.runtime

_REAP_INTERVAL = 0.5
_STEP_SLEEP = 0.002


def _pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _event_bytes(event) -> bytes:
    return bytes(event.data_as_byte_array)


class Arbiter(yjj.peer):
    """Resident single-writer lock arbiter over the live journal.

    Construct with a SERVICE location and call ``serve()`` to run. The instance
    owns a `LockTable`; every request / release frame drives one table transition
    and, when the holder changes, one grant frame on the public stream. An
    optional ``on_transition(name, action, uid, snapshot)`` callback lets a
    harness or the CLI observe decisions without re-reading the journal.
    """

    def __init__(self, location, low_latency: bool = False, on_transition=None):
        yjj.peer.__init__(self, location, low_latency=low_latency)
        self._table = LockTable()
        self._pids: dict[int, int] = {}
        self._on_transition = on_transition

    # --- peer hooks -------------------------------------------------------
    def on_exit(self):  # pragma: no cover - lifecycle glue
        pass

    def on_react(self):
        # Subscriptions must be installed in on_react(), before the reactor
        # connects the event stream (see peer::observe docstring).
        self.observe(CARRIER_ACTION_ENVELOPE, self._on_action)

    def on_start(self):  # pragma: no cover - lifecycle glue
        pass

    # --- serving loop -----------------------------------------------------
    def serve(self, should_stop=None, start_timeout: float = 10.0) -> bool:
        """Drive the reactor manually and reap dead holders on an interval.

        Manual driving (rather than the blocking ``run()``) is what lets the
        arbiter interleave the same-host liveness reap between reactor steps
        without a bound native timer. Returns False if the peer never started.
        """
        self.pre_setup()
        self.setup()
        deadline = time.time() + start_timeout
        while not self.is_started():
            if time.time() > deadline:
                return False
            self.step(0)
            time.sleep(_STEP_SLEEP)
        next_reap = time.time() + _REAP_INTERVAL
        while self.is_live():
            if should_stop is not None and should_stop():
                break
            self.step(0)
            now = time.time()
            if now >= next_reap:
                self._reap_dead_holders()
                next_reap = now + _REAP_INTERVAL
            time.sleep(_STEP_SLEEP)
        return True

    # --- frame handlers ---------------------------------------------------
    def _on_action(self, event):
        if event.carrier_type != CARRIER_ACTION_ENVELOPE:
            return
        decoded = unwrap_event(_event_bytes(event))
        if decoded is None:
            return
        action_type, payload = decoded
        name = parse_name(payload)
        if name is None:
            return
        source = int(event.source)
        if action_type == ACTION_REQUEST:
            pid = parse_pid(payload)
            if pid is not None:
                self._pids[source] = pid
            grant = self._table.request(name, source)
            self._note(name, ACTION_REQUEST, source)
            if grant is not None:
                self._emit_grant(name, grant)
        elif action_type == ACTION_RELEASE:
            nxt = self._table.release(name, source)
            self._note(name, ACTION_RELEASE, source)
            if nxt is not None:
                self._emit_grant(name, nxt)

    def _reap_dead_holders(self):
        """Reclaim locks whose holder process is gone (ungraceful death)."""
        dead: list[int] = []
        seen: set[int] = set()
        for name in list(self._table.snapshot()):
            holder = self._table.holder(name)
            if holder is None or holder in seen:
                continue
            seen.add(holder)
            if not _pid_alive(self._pids.get(holder)):
                dead.append(holder)
        for uid in dead:
            for name, nxt in self._table.forget(uid):
                self._note(name, "reap", uid)
                if nxt is not None:
                    self._emit_grant(name, nxt)
            self._pids.pop(uid, None)

    # --- outbound ---------------------------------------------------------
    def _emit_grant(self, name: str, holder: int):
        carrier, data = wrap_event(ACTION_GRANT, grant_payload(name, holder))
        writer = self.get_public_writer()
        writer.write_bytes(self.now(), carrier, list(data), len(data))
        self._note(name, ACTION_GRANT, holder)

    def _note(self, name, action, uid):
        if self._on_transition is not None:
            try:
                self._on_transition(name, action, uid, self._table.snapshot())
            except Exception:  # noqa: BLE001 - observation must never break serving
                pass
