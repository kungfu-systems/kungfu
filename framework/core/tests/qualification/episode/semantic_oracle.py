# SPDX-License-Identifier: Apache-2.0
"""Small independent state oracle for Episode qualification.

This module deliberately has no Kungfu imports.  It models only externally
observable Episode obligations and never reads journals, calls the production
fold, or duplicates its serialization rules.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from itertools import product


class Lifecycle(str, Enum):
    ABSENT = "absent"
    OPEN = "open"
    ENDED = "ended"
    ABORTED = "aborted"


class Evidence(str, Enum):
    PRESENT = "present"
    MISSING = "missing"
    CORRUPT = "corrupt"
    UNADDRESSABLE = "unaddressable"


@dataclass(frozen=True)
class Observation:
    lifecycle: str
    status: str
    issue_classes: tuple[str, ...]
    safe_capabilities: tuple[str, ...]
    projection: str


@dataclass
class EpisodeOracle:
    """Reference state for one Episode and its directly required evidence."""

    lifecycle: Lifecycle = Lifecycle.ABSENT
    payloads: dict[str, Evidence] = field(default_factory=dict)
    missing_dependencies: set[int] = field(default_factory=set)
    projection: str = "absent"

    def begin(self) -> None:
        if self.lifecycle is not Lifecycle.ABSENT:
            raise ValueError("episode_already_opened")
        self.lifecycle = Lifecycle.OPEN
        self._journal_changed()

    def attach_payload(self, ref_id: str, evidence: Evidence) -> None:
        self._require_open()
        self.payloads[ref_id] = evidence
        self._journal_changed()

    def restore_payload(self, ref_id: str) -> None:
        if ref_id not in self.payloads:
            raise ValueError("payload_ref_unknown")
        self.payloads[ref_id] = Evidence.PRESENT

    def require_episode(self, episode_id: int) -> None:
        self._require_open()
        self.missing_dependencies.add(episode_id)
        self._journal_changed()

    def resolve_episode(self, episode_id: int) -> None:
        self.missing_dependencies.discard(episode_id)

    def end(self) -> None:
        self._require_open()
        self.lifecycle = Lifecycle.ENDED
        self._journal_changed()

    def abort(self) -> None:
        self._require_open()
        self.lifecycle = Lifecycle.ABORTED
        self._journal_changed()

    def recover(self) -> bool:
        if self.lifecycle is Lifecycle.OPEN:
            self.abort()
            return True
        return False

    def rebuild_projection(self) -> None:
        self.projection = "current"

    def mark_projection_stale(self) -> None:
        if self.projection == "current":
            self.projection = "stale"

    def observe(self) -> Observation:
        issue_classes: list[str] = []
        payload_issues = {
            evidence
            for evidence in self.payloads.values()
            if evidence is not Evidence.PRESENT
        }
        if payload_issues:
            issue_classes.extend(
                f"payload_{item.value}" for item in sorted(payload_issues, key=str)
            )
        if self.missing_dependencies:
            issue_classes.append("episode_dependency_missing")
        if self.projection == "stale":
            issue_classes.append("projection_stale")

        sealed = self.lifecycle in (Lifecycle.ENDED, Lifecycle.ABORTED)
        if sealed and payload_issues:
            status = "failed"
        elif issue_classes:
            status = "degraded"
        else:
            status = "ok"

        capabilities = ["inspect", "export_evidence"]
        if status != "failed":
            capabilities.append("continue_independent_work")
        if issue_classes:
            capabilities.append("plan_repair")
        if self.lifecycle is Lifecycle.OPEN and status != "failed":
            capabilities.append("append")

        return Observation(
            lifecycle=self.lifecycle.value,
            status=status,
            issue_classes=tuple(sorted(issue_classes)),
            safe_capabilities=tuple(sorted(capabilities)),
            projection=self.projection,
        )

    def _require_open(self) -> None:
        if self.lifecycle is not Lifecycle.OPEN:
            raise ValueError("episode_not_open")

    def _journal_changed(self) -> None:
        self.mark_projection_stale()


STATUS_RANK = {"ok": 0, "degraded": 1, "failed": 2}


def repair_is_monotonic(before: Observation, after: Observation) -> bool:
    """A repair may improve or preserve trust status, never make it worse."""

    return STATUS_RANK[after.status] <= STATUS_RANK[before.status]


def exhaust_bounded_histories() -> int:
    """Check the complete first-order Semantic v1 state cross-product."""

    checked = 0
    for evidence, dependency_missing, terminal, repair in product(
        Evidence,
        (False, True),
        ("open", "ended", "aborted"),
        (False, True),
    ):
        oracle = EpisodeOracle()
        oracle.begin()
        oracle.attach_payload("artifact", evidence)
        if dependency_missing:
            oracle.require_episode(77)
        if terminal == "ended":
            oracle.end()
        elif terminal == "aborted":
            oracle.abort()

        before = oracle.observe()
        if repair:
            oracle.restore_payload("artifact")
            oracle.resolve_episode(77)
            after = oracle.observe()
            if not repair_is_monotonic(before, after):
                raise AssertionError("repair worsened bounded-history trust status")
            if after.lifecycle != before.lifecycle:
                raise AssertionError("repair changed bounded-history lifecycle")

        observed = oracle.observe()
        if observed.lifecycle != terminal:
            raise AssertionError("bounded-history lifecycle mismatch")
        if terminal != "open" and evidence is not Evidence.PRESENT and not repair:
            if observed.status != "failed":
                raise AssertionError("sealed missing evidence was not failed")
        checked += 1
    return checked
