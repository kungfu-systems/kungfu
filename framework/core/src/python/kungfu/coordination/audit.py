#  SPDX-License-Identifier: Apache-2.0
#
# Episode audit for coordination locks (ADR-0077, increment A). The stdlib lock
# in `locks.py` stays dependency-free; this layer records a lock run's wait /
# acquire / release as an Episode via the runtime storage service, so agent
# coordination becomes a replayable, tracked record instead of a git artifact.

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any

from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle

ACTION_WAIT = "coordination.lock.wait"
ACTION_ACQUIRE = "coordination.lock.acquire"
ACTION_RELEASE = "coordination.lock.release"


def _payload(**fields: Any) -> bytes:
    return json.dumps(fields, sort_keys=True).encode("utf-8")


class LockAudit:
    """Record one lock run's lifecycle as a `coordination` Episode."""

    def __init__(self, runtime_dir: str, name: str, run_id: str | None = None) -> None:
        self.name = name
        self.run_id = run_id or uuid.uuid4().hex
        self.pid = os.getpid()
        self.episode = RuntimeEpisodeLifecycle(
            runtime_dir=runtime_dir,
            namespace="coordination",
            name=f"lock/{name}",
            title=f"lock {name}",
            actor="kungfu lock",
            source=f"lock:{name}:{self.run_id}",
        )

    def _record(self, action: str, **fields: Any) -> None:
        self.episode.record_event(
            action,
            _payload(name=self.name, pid=self.pid, at=time.time(), **fields),
            run_id=self.run_id,
        )

    def waiting(self) -> None:
        self._record(ACTION_WAIT)

    def acquired(self, waited: bool) -> None:
        self._record(ACTION_ACQUIRE, waited=waited)

    def released(self, released: bool) -> None:
        self._record(ACTION_RELEASE, released=released)

    def close(self, *, ok: bool = True, reason: str = "") -> None:
        self.episode.close(ok=ok, reason=reason)
