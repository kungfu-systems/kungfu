# SPDX-License-Identifier: Apache-2.0

"""Deterministic read-only projections for Primitive management planes."""

from __future__ import annotations

from typing import Any


_ROOT_PREFIX = "sha256:"


def _root(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value.startswith(_ROOT_PREFIX)
        and len(value) == len(_ROOT_PREFIX) + 64
        and all(
            character in "0123456789abcdef" for character in value[len(_ROOT_PREFIX) :]
        )
    )


def _unknown(catalog: dict[str, Any], primitive_id: str, reason: str) -> dict[str, Any]:
    return {
        "schema": "kungfu.primitive-availability-report/v1",
        "catalogRoot": catalog["catalogRoot"],
        "primitiveId": primitive_id,
        "state": "unknown",
        "reasonCodes": [reason],
        "binding": None,
        "health": None,
        "evidenceRoots": [],
        "perspectiveBound": True,
        "nonMonotonic": True,
    }


def availability_report(
    catalog: dict[str, Any],
    primitive_id: str,
    observation: dict[str, Any] | None,
) -> dict[str, Any]:
    """Bind an explicit observation to a catalog Cut; never infer availability."""

    if observation is None:
        return _unknown(catalog, primitive_id, "observation-missing")
    if observation.get("schema") != "kungfu.availability-observation/v1":
        raise ValueError("unsupported Primitive availability observation")
    if observation.get("catalogRoot") != catalog.get("catalogRoot"):
        return _unknown(catalog, primitive_id, "observation-stale")
    if observation.get("primitiveId") != primitive_id:
        return _unknown(catalog, primitive_id, "binding-mismatch")

    runtime = observation.get("runtime")
    boundary = observation.get("boundary")
    cut = observation.get("cut")
    health = observation.get("health")
    profile_roots = observation.get("profileRoots")
    if (
        not isinstance(runtime, dict)
        or not all(
            isinstance(runtime.get(key), str) and runtime[key]
            for key in ("id", "workspace", "platform")
        )
        or not isinstance(boundary, dict)
        or not all(
            isinstance(boundary.get(key), bool)
            for key in (
                "authorityPresent",
                "capabilityPresent",
                "storageOwnerAvailable",
            )
        )
        or not isinstance(cut, dict)
        or not _root(cut.get("root"))
        or not isinstance(cut.get("observedAt"), str)
        or not isinstance(health, dict)
        or health.get("status") not in ("healthy", "degraded", "down")
        or not isinstance(profile_roots, list)
        or not all(_root(value) for value in profile_roots)
        or not isinstance(health.get("evidenceRoots"), list)
        or not all(_root(value) for value in health["evidenceRoots"])
    ):
        return _unknown(catalog, primitive_id, "binding-mismatch")

    reasons: list[str] = []
    if not boundary["authorityPresent"]:
        reasons.append("authority-missing")
    if not boundary["capabilityPresent"]:
        reasons.append("capability-missing")
    if not boundary["storageOwnerAvailable"]:
        reasons.append("storage-owner-unavailable")
    if health["status"] == "down" and not reasons:
        reasons.append("health-degraded")

    if reasons:
        state = "unavailable"
    elif health["status"] == "degraded":
        state = "degraded"
        reasons = ["health-degraded"]
    else:
        state = "available"
        reasons = ["healthy"]

    return {
        "schema": "kungfu.primitive-availability-report/v1",
        "catalogRoot": catalog["catalogRoot"],
        "primitiveId": primitive_id,
        "state": state,
        "reasonCodes": reasons,
        "binding": {
            "runtime": runtime,
            "profileRoots": profile_roots,
            "boundary": boundary,
            "cut": cut,
        },
        "health": health["status"],
        "evidenceRoots": sorted(set(health["evidenceRoots"])),
        "perspectiveBound": True,
        "nonMonotonic": True,
    }
