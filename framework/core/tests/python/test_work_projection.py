# SPDX-License-Identifier: Apache-2.0

from kungfu.agent import session_surface
from kungfu.agent.work_projection import WorkProjectionPort


ROOT = f"sha256:{'a' * 64}"


def work_ref():
    return {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "workspace:test",
        "profileId": "kungfu.work-control",
        "profileRoot": ROOT,
        "entityType": "assignment",
        "entityId": "assignment:test",
        "entityRoot": f"sha256:{'b' * 64}",
        "purpose": "continue-project-assignment",
        "systemTimeCut": "2026-08-02T00:00:00Z",
        "initiativeId": "initiative:test",
    }


def work_snapshot(phase="executing"):
    return {
        "schema": "kungfu.native-work-observation/v1",
        "state": "available",
        "initiativeId": "initiative:test",
        "assignmentId": "assignment:test",
        "title": "Projection contract",
        "objective": "Keep Work coherent",
        "acceptanceChecks": ["Bound queries"],
        "phase": phase,
        "queryProofRoot": ROOT,
        "nextActions": ["stage: Record the boundary"],
        "evidenceEpisodeRoots": [],
        "continuation": {
            "completionClaimCount": 0,
            "independentReviewCount": 0,
            "continuationDecisionCount": 0,
        },
        "remainingObligation": "finish projection",
        "nextAction": "stage: Record the boundary",
    }


def test_attempt_heartbeat_never_calls_or_contains_work_projection():
    binding = {"kind": "work", "workRef": work_ref()}

    def forbidden(_work):
        raise AssertionError("heartbeat must not query Work")

    heartbeat = session_surface.native_heartbeat_observation(binding, forbidden)

    assert heartbeat["schema"] == "kungfu.attempt-heartbeat/v1"
    assert heartbeat["state"] == "fresh"
    assert heartbeat["workRefRoot"].startswith("sha256:")
    assert "work" not in heartbeat


def test_work_projection_uses_initial_invalidation_and_bounded_fallback_only():
    clock = {"monotonic": 0.0, "wall": 1000}
    queries = []

    def resolve(value):
        queries.append(value)
        return {"state": "fresh", "work": work_snapshot(), "diagnostic": None}

    port = WorkProjectionPort(
        resolve,
        fallback_seconds=2.0,
        monotonic=lambda: clock["monotonic"],
        wall_time_ms=lambda: clock["wall"],
    )
    first = port.refresh(work_ref())
    assert first["source"] == "initial"
    for index in range(100):
        clock["monotonic"] = index / 100
        assert port.refresh(work_ref()) is None
    assert len(queries) == 1

    port.invalidate(work_ref())
    invalidated = port.refresh(work_ref())
    assert invalidated["source"] == "invalidation"
    assert len(queries) == 2

    clock["monotonic"] = 3.1
    fallback = port.refresh(work_ref())
    assert fallback["source"] == "bounded-fallback"
    assert fallback["queryCount"] == 3
    assert len(queries) == 3


def test_failed_refresh_retains_the_last_coherent_work_snapshot():
    clock = {"monotonic": 0.0}
    failing = {"value": False}

    def resolve(_value):
        if failing["value"]:
            raise RuntimeError("temporary Work authority outage")
        return {"state": "fresh", "work": work_snapshot("stage-ready")}

    port = WorkProjectionPort(
        resolve,
        monotonic=lambda: clock["monotonic"],
        wall_time_ms=lambda: 1000,
    )
    first = port.refresh(work_ref())
    failing["value"] = True
    port.invalidate(work_ref())
    retained = port.refresh(work_ref())

    assert retained["state"] == "stale"
    assert retained["work"] == first["work"]
    assert retained["work"]["phase"] == "stage-ready"
    assert retained["diagnostic"] == "temporary Work authority outage"


def test_degraded_authority_result_does_not_erase_settled_work():
    calls = {"count": 0}

    def resolve(_value):
        calls["count"] += 1
        if calls["count"] == 1:
            return {"state": "fresh", "work": work_snapshot("sealed")}
        return {
            "state": "degraded",
            "work": None,
            "diagnostic": "bounded fallback unavailable",
        }

    port = WorkProjectionPort(resolve)
    first = port.refresh(work_ref())
    port.invalidate(work_ref())
    retained = port.refresh(work_ref())

    assert retained["state"] == "stale"
    assert retained["work"] == first["work"]
    assert retained["work"]["phase"] == "sealed"
