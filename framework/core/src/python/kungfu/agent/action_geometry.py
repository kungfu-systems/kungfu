# SPDX-License-Identifier: Apache-2.0

"""Versioned KFD-7 Action Geometry without adopter-domain policy.

Public evaluate operations require native ``action_runtime``. The ``*_python``
functions are explicit conformance oracles, never a silent product fallback.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from kungfu import contract as contract_runtime
from kungfu.agent.native_authority import (
    require_action_runtime,
    require_conformance_oracle,
)
from kungfu.storage import service as storage_service


SURFACE = "action-geometry"
EVALUATION_SCHEMA = "kungfu.action-geometry.evaluation/v1"
SESSION_EVALUATION_SCHEMA = "kungfu.action-geometry.session-evaluation/v1"


def contract() -> dict[str, Any]:
    return contract_runtime.load_contract(SURFACE)


def metadata() -> dict[str, str | int]:
    return contract_runtime.contract_metadata(SURFACE)


def evaluate_python(
    responsibility_ids: Mapping[str, str],
    *,
    inference_claims: Sequence[str] = (),
    conformance: bool = False,
) -> dict[str, Any]:
    """Pure-Python conformance oracle for native geometry evaluation."""

    require_conformance_oracle(conformance=conformance)
    geometry = contract()
    required = list(geometry["responsibilities"])
    supplied = set(responsibility_ids)
    required_set = set(required)
    failures: list[dict[str, Any]] = []

    missing = sorted(required_set - supplied)
    unexpected = sorted(supplied - required_set)
    if missing or unexpected:
        failures.append(
            {
                "code": "responsibility-topology-mismatch",
                "missing": missing,
                "unexpected": unexpected,
            }
        )

    identities = [
        responsibility_ids[name]
        for name in required
        if isinstance(responsibility_ids.get(name), str) and responsibility_ids[name]
    ]
    if len(identities) != len(required) or len(set(identities)) != len(identities):
        failures.append({"code": "responsibility-identity-alias"})

    forbidden = {row["forbids"]: row["id"] for row in geometry["invariants"]}
    failures.extend(
        {"code": "non-substitution-invariant", "invariant": forbidden[claim]}
        for claim in inference_claims
        if claim in forbidden
    )

    return {
        "schema": EVALUATION_SCHEMA,
        "geometryRoot": metadata()["hash"],
        "admissible": not failures,
        "responsibilityIds": {
            name: responsibility_ids[name]
            for name in required
            if name in responsibility_ids
        },
        "failures": failures,
    }


def evaluate_session_refinement_python(
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    *,
    conformance: bool = False,
) -> dict[str, Any]:
    """Pure-Python conformance oracle for native session refinement."""

    require_conformance_oracle(conformance=conformance)
    geometry = contract()
    dimensions = list(geometry["sessionRefinement"]["semanticDimensions"])
    missing = [name for name in dimensions if name not in before or name not in after]
    changed = [
        name
        for name in dimensions
        if name in before and name in after and before[name] != after[name]
    ]
    return {
        "schema": SESSION_EVALUATION_SCHEMA,
        "geometryRoot": metadata()["hash"],
        "preserved": not missing and not changed,
        "missingDimensions": missing,
        "changedDimensions": changed,
    }


def evaluate(
    responsibility_ids: Mapping[str, str],
    *,
    inference_claims: Sequence[str] = (),
) -> dict[str, Any]:
    """Evaluate responsibility topology and non-substitution invariants."""

    require_action_runtime()
    return storage_service.action_runtime(
        "",
        "evaluate",
        {
            "responsibility_ids": dict(responsibility_ids),
            "inference_claims": list(inference_claims),
        },
    )


def evaluate_session_refinement(
    before: Mapping[str, Any],
    after: Mapping[str, Any],
) -> dict[str, Any]:
    """Check the geometry's conservative session round-trip dimensions."""

    require_action_runtime()
    return storage_service.action_runtime(
        "",
        "evaluate_session_refinement",
        {"before": dict(before), "after": dict(after)},
    )
