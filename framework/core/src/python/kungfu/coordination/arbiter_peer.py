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
import uuid
from typing import Any

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

# Any so the native `yjj.peer` is usable as a base class under mypy (the
# binding is dynamic; matches kungfu/runtime/live/peer.py).
yjj: Any = kungfu.__binding__.runtime

ACTION_REAP = "coordination.lock.reap"

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

    def __init__(
        self,
        location,
        low_latency: bool = False,
        on_transition=None,
        runtime_dir: str | None = None,
    ):
        yjj.peer.__init__(self, location, low_latency=low_latency)
        self._table = LockTable()
        self._pids: dict[int, int] = {}
        self._on_transition = on_transition
        self._audit = self._open_audit(runtime_dir)
        self._run_id = uuid.uuid4().hex

    # --- native audit (subsumes coordination/audit.py) --------------------
    def _open_audit(self, runtime_dir):
        """Central replayable audit Episode for all coordination.

        The arbiter is the single authority for lock decisions, so it records the
        request / grant / release / reap stream as one `coordination` Episode —
        this replaces the first slice's per-lock-run `audit.py`, which recorded
        from each client because the file lock had no journal. Best-effort:
        coordination must never fail because storage is unavailable. A distinct
        location name keeps the audit journal off the peer's own grant journal.
        """
        if not runtime_dir:
            return None
        try:
            from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle

            return RuntimeEpisodeLifecycle(
                runtime_dir=runtime_dir,
                namespace="coordination",
                name="arbiter-audit",
                title="coordination arbiter",
                actor="coordination arbiter",
                source=f"arbiter:{int(self.get_home_uid())}",
            )
        except Exception:  # noqa: BLE001 - audit is additive, never load-bearing
            return None

    def _record_audit(self, action_type: str, payload: bytes):
        if self._audit is None:
            return
        try:
            self._audit.record_event(action_type, payload, run_id=self._run_id)
        except Exception:  # noqa: BLE001
            pass

    def close_audit(self):
        if self._audit is not None:
            try:
                self._audit.close(ok=True)
            except Exception:  # noqa: BLE001
                pass
            self._audit = None

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
        try:
            while self.is_live():
                if should_stop is not None and should_stop():
                    break
                self.step(0)
                now = time.time()
                if now >= next_reap:
                    self._reap_dead_holders()
                    next_reap = now + _REAP_INTERVAL
                time.sleep(_STEP_SLEEP)
        finally:
            self.close_audit()
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
            self._record_audit(ACTION_REQUEST, payload)
            grant = self._table.request(name, source)
            self._note(name, ACTION_REQUEST, source)
            if grant is not None:
                self._emit_grant(name, grant)
        elif action_type == ACTION_RELEASE:
            self._record_audit(ACTION_RELEASE, payload)
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
            transitions = self._table.forget(uid)
            for name, _nxt in transitions:
                self._record_audit(ACTION_REAP, grant_payload(name, uid))
            for name, nxt in transitions:
                self._note(name, "reap", uid)
                if nxt is not None:
                    self._emit_grant(name, nxt)
            self._pids.pop(uid, None)

    # --- outbound ---------------------------------------------------------
    def _emit_grant(self, name: str, holder: int):
        payload = grant_payload(name, holder)
        carrier, data = wrap_event(ACTION_GRANT, payload)
        writer = self.get_public_writer()
        writer.write_bytes(self.now(), carrier, list(data), len(data))
        self._record_audit(ACTION_GRANT, payload)
        self._note(name, ACTION_GRANT, holder)

    def _note(self, name, action, uid):
        if self._on_transition is not None:
            try:
                self._on_transition(name, action, uid, self._table.snapshot())
            except Exception:  # noqa: BLE001 - observation must never break serving
                pass
