#  SPDX-License-Identifier: Apache-2.0
#
# The arbiter lock client (ADR-0077 next increment). A client acquires a named
# lock by writing a `coordination.lock.request` frame to the arbiter and then
# waiting for the matching `coordination.lock.grant` frame on the arbiter's
# public journal — the wait is driven by the nng/reactor, not by polling a table
# on a timer, so a contending agent's model spends no tokens while it waits.
#
# The client reactor is driven manually (pre_setup/setup/step) rather than by a
# blocking run(), because acquiring requires acting *between* reactor steps:
# become live -> open the request channel + subscribe to grants -> write the
# request -> step until the grant lands. `is_started()` (not `is_live()`) is the
# gate: the coordinator command writer that `request_write_to` needs only exists
# after the register round-trip completes.

from __future__ import annotations

import os
import time
from typing import Any

import kungfu

from kungfu.action_envelope import CARRIER_ACTION_ENVELOPE
from kungfu.work.wire import unwrap_event, wrap_event
from kungfu.coordination.arbiter import (
    ACTION_GRANT,
    ACTION_INSTRUCT,
    ACTION_RELEASE,
    ACTION_REQUEST,
    instruct_payload,
    parse_instruct,
    request_payload,
)

# Any so the native `yjj.peer` is usable as a base class under mypy (the
# binding is dynamic; matches kungfu/runtime/live/peer.py).
yjj: Any = kungfu.__binding__.runtime

_STEP_SLEEP = 0.002


class LockClient(yjj.peer):
    """A peer that acquires named locks from the arbiter and tracks its grants.

    Grants land on the arbiter's public stream; the client subscribes once and
    records every grant addressed to itself (``holder == self_uid``) so the
    acquire loop just waits for the name to appear in ``self._granted``.
    """

    def __init__(self, location, arbiter_uid: int, low_latency: bool = False):
        yjj.peer.__init__(self, location, low_latency=low_latency)
        self._arbiter_uid = int(arbiter_uid)
        self._self_uid = int(location.uid)
        self._granted: set[str] = set()
        self._instructs: list[str] = []

    @property
    def instructs(self) -> list[str]:
        """Instruction texts this worker has received, in arrival order.

        A separate one-shot writer can address this worker's location and inject
        a `coordination.instruct` frame; because the worker already subscribes to
        the live stream for grants, it also reacts to instructions without any
        extra channel — this is the injection path an out-of-band controller uses
        to steer a worker that holds a lock across judgement steps."""
        return list(self._instructs)

    def on_exit(self):  # pragma: no cover - lifecycle glue
        pass

    def on_react(self):
        self.observe(CARRIER_ACTION_ENVELOPE, self._on_frame)

    def on_start(self):  # pragma: no cover - lifecycle glue
        pass

    def _on_frame(self, event):
        if event.carrier_type != CARRIER_ACTION_ENVELOPE:
            return
        decoded = unwrap_event(bytes(event.data_as_byte_array))
        if decoded is None:
            return
        action_type, payload = decoded
        if action_type == ACTION_GRANT:
            import json

            try:
                obj = json.loads(bytes(payload).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return
            if isinstance(obj, dict) and int(obj.get("holder", -1)) == self._self_uid:
                name = obj.get("name")
                if isinstance(name, str):
                    self._granted.add(name)
        elif action_type == ACTION_INSTRUCT:
            text = parse_instruct(payload)
            if text is not None:
                self._instructs.append(text)

    # --- driving ----------------------------------------------------------
    def start_manual(self, timeout: float = 8.0) -> bool:
        """Bring the reactor up and subscribe to the arbiter's grant stream.

        Returns True once the peer is started and the request channel + grant
        subscription are open. Idempotent enough for a harness to call once.
        """
        self.pre_setup()
        self.setup()
        deadline = time.time() + timeout
        while not self.is_started():
            if time.time() > deadline:
                return False
            self.step(0)
            time.sleep(_STEP_SLEEP)
        # Open the write channel to the arbiter and subscribe to its grants.
        self.request_write_to(self.now(), self._arbiter_uid, 0)
        self.request_read_from_public(self.now(), self._arbiter_uid, 0)
        while not self.has_writer(self._arbiter_uid):
            if time.time() > deadline:
                return False
            self.step(0)
            time.sleep(_STEP_SLEEP)
        return True

    def acquire(self, name: str, timeout: float = 8.0) -> bool:
        """Request ``name`` and step the reactor until it is granted to us.

        The step loop drains nng-delivered frames; the wait ends the moment the
        grant frame arrives (no timer poll). Returns True on grant, False on
        timeout.
        """
        self._write(ACTION_REQUEST, request_payload(name, pid=os.getpid()))
        deadline = time.time() + timeout
        while name not in self._granted:
            if time.time() > deadline or not self.is_live():
                return False
            self.step(0)
            time.sleep(_STEP_SLEEP)
        return True

    def release(self, name: str) -> None:
        """Release ``name``; the arbiter grants it to the next waiter, if any."""
        self._granted.discard(name)
        self._write(ACTION_RELEASE, request_payload(name))
        # Flush the release frame out through a few reactor steps.
        for _ in range(50):
            if not self.is_live():
                break
            self.step(0)
            time.sleep(_STEP_SLEEP)

    def pump(self, seconds: float) -> None:
        """Drive the reactor for a while (e.g. to keep holding / observe frames)."""
        deadline = time.time() + seconds
        while time.time() < deadline and self.is_live():
            self.step(0)
            time.sleep(_STEP_SLEEP)

    def _write(self, action_type: str, payload: bytes):
        carrier, data = wrap_event(action_type, payload)
        self.get_writer(self._arbiter_uid).write_bytes(
            self.now(), carrier, list(data), len(data)
        )


class _OneshotWriter(yjj.peer):
    """A throwaway peer used only to write one frame to a target location."""

    def on_exit(self):  # pragma: no cover - lifecycle glue
        pass

    def on_react(self):  # pragma: no cover - no subscriptions needed
        pass

    def on_start(self):  # pragma: no cover - lifecycle glue
        pass


def send_instruct(location, target_uid: int, text: str, timeout: float = 8.0) -> bool:
    """Inject one `coordination.instruct` frame into ``target_uid``'s stream.

    A short-lived peer becomes live, opens a write channel to the target, writes
    the instruction, flushes it through the reactor, and exits. The target reacts
    to the frame on its own live stream (see `LockClient.instructs`). Returns
    True once the frame has been written.
    """
    target_uid = int(target_uid)
    sender = _OneshotWriter(location, low_latency=False)
    sender.pre_setup()
    sender.setup()
    deadline = time.time() + timeout
    while not sender.is_started():
        if time.time() > deadline:
            return False
        sender.step(0)
        time.sleep(_STEP_SLEEP)
    sender.request_write_to(sender.now(), target_uid, 0)
    while not sender.has_writer(target_uid):
        if time.time() > deadline:
            return False
        sender.step(0)
        time.sleep(_STEP_SLEEP)
    carrier, data = wrap_event(ACTION_INSTRUCT, instruct_payload(text))
    sender.get_writer(target_uid).write_bytes(
        sender.now(), carrier, list(data), len(data)
    )
    for _ in range(100):
        if not sender.is_live():
            break
        sender.step(0)
        time.sleep(_STEP_SLEEP)
    return True
