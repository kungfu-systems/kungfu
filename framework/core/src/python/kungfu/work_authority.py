# SPDX-License-Identifier: Apache-2.0

"""Typed semantic authority roles shared by Work recovery surfaces."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import Any

from kungfu import initiative_family

JsonObject = dict[str, Any]
RETAINED_ASSIGNMENT_AUTHORITY_SCHEMA = "kungfu.work.retained-assignment-authority/v1"
PLANNED_PROFILE_SOURCE_SCHEMA = "kungfu.work.planned-profile-source/v1"
PLANNED_TARGET_SCHEMA = "kungfu.work.planned-target/v1"
PLANNED_CONSOLE_BINDING_SCHEMA = "kungfu.work.planned-console-binding/v1"
CURRENT_RECOVERY_OBSERVATIONS_SCHEMA = "kungfu.work.current-recovery-observations/v1"
CONTINUATION_DECISION_SCHEMA = "kungfu.work.continuation-decision/v1"

# This is deliberately an allowlist. Reader proofs, active lease observations,
# Work semantics, Console/process state, and next-action projections never
# become retained Assignment authority merely because a reader adds a field.
_RETAINED_FIELDS = (
    "initiative_id",
    "assignment_id",
    "initiative_subject",
    "assignment_subject",
    "assignment",
    "phase",
    "execution_claims",
    "phase_transitions",
    "completion_claim_count",
    "completion_claims",
    "independent_review_count",
    "independent_reviews",
    "continuation_decision_count",
    "continuation_decisions",
)


def semantic_root(value: Any) -> str:
    """Return the canonical semantic root used by all authority roles."""

    return initiative_family.semantic_root(value)


def retained_assignment_authority(status: Mapping[str, Any]) -> JsonObject:
    """Project only admitted Assignment identity and lifecycle facts."""

    return {
        "schema": RETAINED_ASSIGNMENT_AUTHORITY_SCHEMA,
        **{
            field: deepcopy(status[field])
            for field in _RETAINED_FIELDS
            if field in status
        },
    }


def rooted(role: Mapping[str, Any], root_field: str) -> JsonObject:
    """Attach one self-verifying root to a typed role body."""

    body = deepcopy(dict(role))
    return {**body, root_field: semantic_root(body)}


def verify_rooted(
    role: Mapping[str, Any], *, schema: str, root_field: str, label: str
) -> JsonObject:
    """Validate a typed role without selecting or rebuilding its authority."""

    value = deepcopy(dict(role))
    body = {key: item for key, item in value.items() if key != root_field}
    if value.get("schema") != schema or value.get(root_field) != semantic_root(body):
        raise ValueError(f"{label} does not verify")
    return value


def continuation_actions(decision: Mapping[str, Any]) -> list[str]:
    """Project the canonical decision's sole action without rediscovery."""

    next_action = decision.get("nextAction")
    if not isinstance(next_action, Mapping):
        return []
    return [str(next_action.get("action", ""))]


def continuation_decision(
    status: Mapping[str, Any], actions: Sequence[Mapping[str, Any]]
) -> JsonObject:
    """Root the only semantic next action against retained Assignment authority."""

    if len(actions) > 1:
        raise ValueError("Work continuation has more than one semantic next action")
    semantics = status.get("work_semantics")
    body = {
        "schema": CONTINUATION_DECISION_SCHEMA,
        "retainedAuthorityRoot": semantic_root(retained_assignment_authority(status)),
        "workSemanticsRoot": (
            semantic_root(semantics) if isinstance(semantics, Mapping) else None
        ),
        "nextAction": dict(actions[0]) if actions else None,
    }
    return {**body, "decisionRoot": semantic_root(body)}
