# SPDX-License-Identifier: Apache-2.0

"""Bounded, authority-preserving Work projection for native Agent sessions."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import json
import time
from typing import Any

from kungfu.agent.session_contract import semantic_root, validate_work_ref


class WorkProjectionPort:
    """Cache full Work status independently from high-frequency liveness.

    The port is read-only. It polls only on first binding, explicit invalidation,
    or a bounded fallback deadline and retains the last coherent projection if
    a later authority query is temporarily unavailable.
    """

    def __init__(
        self,
        resolver: Callable[[Mapping[str, Any]], Mapping[str, Any]],
        *,
        fallback_seconds: float = 2.0,
        monotonic: Callable[[], float] = time.monotonic,
        wall_time_ms: Callable[[], int] = lambda: int(time.time() * 1000),
    ) -> None:
        if fallback_seconds <= 0:
            raise ValueError("Work projection fallback must be positive")
        self._resolver = resolver
        self._fallback_seconds = fallback_seconds
        self._monotonic = monotonic
        self._wall_time_ms = wall_time_ms
        self._entries: dict[str, dict[str, Any]] = {}
        self.query_count = 0

    @staticmethod
    def _key(work_ref: Mapping[str, Any]) -> str:
        value = validate_work_ref(work_ref)
        identity = {
            "workspaceId": value["workspaceId"],
            "profileId": value["profileId"],
            "entityType": value["entityType"],
            "entityId": value["entityId"],
            **(
                {"initiativeId": value["initiativeId"]}
                if value.get("initiativeId")
                else {}
            ),
        }
        return semantic_root(identity)

    def invalidate(self, work_ref: Mapping[str, Any]) -> None:
        entry = self._entries.get(self._key(work_ref))
        if entry is not None:
            entry["invalidated"] = True

    def refresh(
        self, work_ref: Mapping[str, Any], *, force: bool = False
    ) -> dict[str, Any] | None:
        work = validate_work_ref(work_ref)
        key = self._key(work)
        now = self._monotonic()
        prior = self._entries.get(key)
        invalidated = bool(prior and prior.get("invalidated"))
        if (
            not force
            and not invalidated
            and prior is not None
            and now < float(prior["nextRefreshAt"])
        ):
            return None

        source = (
            "initial"
            if prior is None
            else "invalidation"
            if invalidated
            else "bounded-fallback"
        )
        self.query_count += 1
        observed_at = self._wall_time_ms()
        try:
            result = dict(self._resolver(work))
            projected_work = result.get("work")
            if projected_work is not None and not isinstance(projected_work, Mapping):
                raise ValueError("Work projection resolver returned invalid work")
            state = str(result.get("state") or "unknown")
            if state not in {"fresh", "degraded", "unknown"}:
                raise ValueError("Work projection resolver returned invalid state")
            retained = prior.get("snapshot") if prior else None
            if state != "fresh" and retained and retained.get("work"):
                projected_work = retained["work"]
                state = "stale"
            snapshot = {
                "schema": "kungfu.native-work-projection/v1",
                "workRefRoot": semantic_root(work),
                "state": state,
                "observedAt": observed_at,
                "source": source,
                "queryCount": self.query_count,
                "queryProofRoot": (
                    projected_work.get("queryProofRoot")
                    if isinstance(projected_work, Mapping)
                    else None
                ),
                "work": dict(projected_work) if projected_work is not None else None,
                "diagnostic": result.get("diagnostic"),
            }
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            retained = prior.get("snapshot") if prior else None
            snapshot = {
                "schema": "kungfu.native-work-projection/v1",
                "workRefRoot": semantic_root(work),
                "state": "stale" if retained and retained.get("work") else "degraded",
                "observedAt": observed_at,
                "source": source,
                "queryCount": self.query_count,
                "queryProofRoot": (
                    retained.get("queryProofRoot") if retained else None
                ),
                "work": retained.get("work") if retained else None,
                "diagnostic": str(error),
            }
        self._entries[key] = {
            "snapshot": snapshot,
            "nextRefreshAt": now + self._fallback_seconds,
            "invalidated": False,
        }
        return dict(snapshot)
