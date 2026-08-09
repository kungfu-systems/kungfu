# SPDX-License-Identifier: Apache-2.0

"""Owner boundary for the Initiative-family v1 state protocol."""

from __future__ import annotations

import json
from typing import Any, Mapping

from kungfu.initiative_family.canonical import (
    _root,
    _sorted_unique_strings,
    _strict_object,
    _timestamp,
    canonical_json,
    semantic_root,
)

FAMILY_BLUEPRINT_SCHEMA = "kungfu.work-control.initiative-family-blueprint/v1"
FAMILY_STATE_SCHEMA = "kungfu.work-control.initiative-family-state/v1"
FAMILY_TRANSITION_SCHEMA = "kungfu.work-control.initiative-family-transition/v1"
FAMILY_DELIVERY_CLASSES = (
    "non-native-fast",
    "native-proof-required",
    "cross-platform",
    "release",
)
FAMILY_TERMINAL_STATES = ("merged", "continued", "deferred", "failed")
FAMILY_ACCEPTANCE_STATES = ("proved", "partial", "missing", "invalidated")


def _family_state_root(value: Mapping[str, Any]) -> str:
    preimage = dict(value)
    preimage.pop("stateRoot", None)
    return semantic_root(preimage)


def family_contract() -> dict[str, Any]:
    """Return the versioned native Initiative-family protocol surface."""

    body = {
        "schema": "kungfu.work-control.initiative-family-contract/v1",
        "blueprintSchema": FAMILY_BLUEPRINT_SCHEMA,
        "stateSchema": FAMILY_STATE_SCHEMA,
        "transitionSchema": FAMILY_TRANSITION_SCHEMA,
        "deliveryClasses": list(FAMILY_DELIVERY_CLASSES),
        "terminalStates": list(FAMILY_TERMINAL_STATES),
        "acceptanceStates": list(FAMILY_ACCEPTANCE_STATES),
        "waveChildBounds": {"minimum": 3, "maximum": 6},
        "continuationDeadlineSeconds": 300,
        "authority": {
            "initiativeParent": "inert",
            "waveGate": "membership-only-terminal",
            "assignment": "bounded-execution-unit",
        },
        "parentDeniedAuthorities": [
            "execution-claim",
            "execution-lease",
            "task-worktree",
            "code-pull-request",
            "merge-queue-lease",
        ],
    }
    return {**body, "contractRoot": semantic_root(body)}


def _validate_family_terminal(
    terminal: Any, child: Mapping[str, Any]
) -> dict[str, Any]:
    if not isinstance(terminal, dict):
        raise ValueError("child.terminal must be null or an object")
    state = str(terminal.get("state") or "")
    field_sets = {
        "merged": {
            "state",
            "recordedAt",
            "sourceRoot",
            "pullRequestRoot",
            "mergeCommitRoot",
            "finalAncestryRoot",
            "proofRoot",
            "sloRoot",
        },
        "continued": {
            "state",
            "recordedAt",
            "boundExceededAt",
            "sourceRoot",
            "decisionRoot",
            "completedEvidenceRoots",
            "completedResponsibilitySlices",
            "residualSuccessor",
        },
        "deferred": {"state", "recordedAt", "sourceRoot", "decisionRoot"},
        "failed": {"state", "recordedAt", "sourceRoot", "failureRoot"},
    }
    if state not in field_sets:
        raise ValueError("child terminal state is unsupported")
    _strict_object(terminal, field_sets[state], "child.terminal")
    recorded_at = _timestamp(terminal["recordedAt"], "terminal.recordedAt")
    for field, value in terminal.items():
        if field.endswith("Root"):
            _root(value, f"terminal.{field}")
    if state != "continued":
        return terminal

    exceeded_at = _timestamp(terminal["boundExceededAt"], "terminal.boundExceededAt")
    elapsed = (recorded_at - exceeded_at).total_seconds()
    if elapsed < 0 or elapsed > 300:
        raise ValueError(
            "continued terminal state must be recorded within five minutes"
        )
    completed_evidence = _sorted_unique_strings(
        terminal["completedEvidenceRoots"], "terminal.completedEvidenceRoots"
    )
    for root in completed_evidence:
        _root(root, "terminal.completedEvidenceRoots")
    completed = _sorted_unique_strings(
        terminal["completedResponsibilitySlices"],
        "terminal.completedResponsibilitySlices",
    )
    responsibility = list(child["responsibilitySlices"])
    if any(row not in responsibility for row in completed):
        raise ValueError("completed responsibility is outside the original child scope")
    residual = [row for row in responsibility if row not in completed]
    if not residual:
        raise ValueError("continued terminal state requires residual responsibility")
    successor = _strict_object(
        terminal["residualSuccessor"],
        {
            "assignmentId",
            "requestRoot",
            "captureReceiptRoots",
            "responsibilitySlices",
        },
        "terminal.residualSuccessor",
    )
    if (
        not isinstance(successor["assignmentId"], str)
        or not successor["assignmentId"]
        or successor["assignmentId"] == child["assignmentId"]
    ):
        raise ValueError("residual successor must have one new Assignment identity")
    _root(successor["requestRoot"], "terminal.residualSuccessor.requestRoot")
    captures = _sorted_unique_strings(
        successor["captureReceiptRoots"],
        "terminal.residualSuccessor.captureReceiptRoots",
    )
    for root in captures:
        _root(root, "terminal.residualSuccessor.captureReceiptRoots")
    successor_slices = _sorted_unique_strings(
        successor["responsibilitySlices"],
        "terminal.residualSuccessor.responsibilitySlices",
    )
    if successor_slices != residual:
        raise ValueError(
            "residual successor must contain exactly the uncompleted responsibility"
        )
    return terminal


def validate_family_state(value: Any) -> dict[str, Any]:
    """Validate one immutable Initiative-family state and its semantic root."""

    state = _strict_object(
        value,
        {
            "schema",
            "initiative",
            "wave",
            "children",
            "acceptance",
            "previousStateRoot",
            "stateRoot",
        },
        "Initiative-family state",
    )
    if state["schema"] != FAMILY_STATE_SCHEMA:
        raise ValueError(f"family state schema must be {FAMILY_STATE_SCHEMA}")
    previous = str(state["previousStateRoot"] or "")
    if previous:
        _root(previous, "previousStateRoot")
    initiative = _strict_object(
        state["initiative"],
        {"initiativeId", "versionRoot", "role"},
        "initiative",
    )
    if (
        not isinstance(initiative["initiativeId"], str)
        or not initiative["initiativeId"]
    ):
        raise ValueError("initiative.initiativeId must be a non-empty string")
    _root(initiative["versionRoot"], "initiative.versionRoot")
    if initiative["role"] != "inert-parent":
        raise ValueError("Initiative family parent must remain inert")
    wave = _strict_object(
        state["wave"],
        {"waveId", "ordinal", "gateAssignmentId", "gateState"},
        "wave",
    )
    if not all(
        isinstance(wave[field], str) and wave[field]
        for field in ("waveId", "gateAssignmentId")
    ):
        raise ValueError("Wave and Gate Assignment identities are required")
    if (
        not isinstance(wave["ordinal"], int)
        or isinstance(wave["ordinal"], bool)
        or wave["ordinal"] < 0
    ):
        raise ValueError("wave.ordinal must be a non-negative integer")
    if wave["gateState"] != "terminal":
        raise ValueError("Wave Gate must terminate after publishing membership")

    children = state["children"]
    if not isinstance(children, list) or not 3 <= len(children) <= 6:
        raise ValueError("Wave Gate must contain exactly three to six children")
    child_fields = {
        "assignmentId",
        "workDefinitionRoot",
        "deliveryClass",
        "responsibilitySlices",
        "dependsOn",
        "terminal",
    }
    child_ids: list[str] = []
    for child in children:
        _strict_object(child, child_fields, "child")
        assignment_id = child["assignmentId"]
        if not isinstance(assignment_id, str) or not assignment_id:
            raise ValueError("child.assignmentId must be a non-empty string")
        child_ids.append(assignment_id)
        _root(child["workDefinitionRoot"], "child.workDefinitionRoot")
        if child["deliveryClass"] not in FAMILY_DELIVERY_CLASSES:
            raise ValueError("child.deliveryClass is unsupported")
        _sorted_unique_strings(
            child["responsibilitySlices"], "child.responsibilitySlices"
        )
        _sorted_unique_strings(child["dependsOn"], "child.dependsOn", allow_empty=True)
    expected_ids = sorted(set(child_ids), key=lambda row: row.encode("utf-8"))
    if child_ids != expected_ids:
        raise ValueError("child membership must be sorted and duplicate-free")
    members = set(child_ids)
    graph: dict[str, list[str]] = {}
    for child in children:
        assignment_id = child["assignmentId"]
        dependencies = child["dependsOn"]
        if assignment_id in dependencies:
            raise ValueError("child cannot depend on itself")
        orphan = next((row for row in dependencies if row not in members), None)
        if orphan:
            raise ValueError(f"child dependency is not a Wave member: {orphan}")
        graph[assignment_id] = dependencies
        if child["terminal"] is not None:
            _validate_family_terminal(child["terminal"], child)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visiting:
            raise ValueError("child dependency graph contains a cycle")
        if node in visited:
            return
        visiting.add(node)
        for dependency in graph[node]:
            visit(dependency)
        visiting.remove(node)
        visited.add(node)

    for child_id in child_ids:
        visit(child_id)

    acceptance = state["acceptance"]
    if not isinstance(acceptance, list) or not acceptance:
        raise ValueError("family acceptance matrix must be non-empty")
    acceptance_ids: list[str] = []
    for row in acceptance:
        _strict_object(
            row, {"acceptanceId", "status", "evidenceRoots"}, "acceptance row"
        )
        acceptance_id = row["acceptanceId"]
        if not isinstance(acceptance_id, str) or not acceptance_id:
            raise ValueError("acceptance.acceptanceId must be a non-empty string")
        acceptance_ids.append(acceptance_id)
        if row["status"] not in FAMILY_ACCEPTANCE_STATES:
            raise ValueError("acceptance.status is unsupported")
        roots = _sorted_unique_strings(
            row["evidenceRoots"], "acceptance.evidenceRoots", allow_empty=True
        )
        for root in roots:
            _root(root, "acceptance.evidenceRoots")
        if row["status"] == "missing" and roots:
            raise ValueError("missing acceptance cannot claim evidence")
        if row["status"] != "missing" and not roots:
            raise ValueError(
                f"{row['status']} acceptance requires exact evidence roots"
            )
    if acceptance_ids != sorted(
        set(acceptance_ids), key=lambda row: row.encode("utf-8")
    ):
        raise ValueError("acceptance rows must be sorted and duplicate-free")
    declared = _root(state["stateRoot"], "stateRoot")
    if declared != _family_state_root(state):
        raise ValueError("Initiative-family state root does not verify")
    return state


def create_family_state(blueprint: Any) -> dict[str, Any]:
    """Create the first immutable state from one bounded Wave blueprint."""

    value = _strict_object(
        blueprint,
        {"schema", "initiative", "wave", "children", "acceptanceIds"},
        "Initiative-family blueprint",
    )
    if value["schema"] != FAMILY_BLUEPRINT_SCHEMA:
        raise ValueError(f"family blueprint schema must be {FAMILY_BLUEPRINT_SCHEMA}")
    initiative = _strict_object(
        value["initiative"], {"initiativeId", "versionRoot"}, "initiative"
    )
    wave = _strict_object(
        value["wave"], {"waveId", "ordinal", "gateAssignmentId"}, "wave"
    )
    children = value["children"]
    if not isinstance(children, list):
        raise ValueError("blueprint.children must be an array")
    normalized_children = [
        {
            **_strict_object(
                child,
                {
                    "assignmentId",
                    "workDefinitionRoot",
                    "deliveryClass",
                    "responsibilitySlices",
                    "dependsOn",
                },
                "blueprint child",
            ),
            "terminal": None,
        }
        for child in children
    ]
    acceptance_ids = _sorted_unique_strings(
        value["acceptanceIds"], "blueprint.acceptanceIds"
    )
    state: dict[str, Any] = {
        "schema": FAMILY_STATE_SCHEMA,
        "initiative": {**initiative, "role": "inert-parent"},
        "wave": {**wave, "gateState": "terminal"},
        "children": normalized_children,
        "acceptance": [
            {"acceptanceId": row, "status": "missing", "evidenceRoots": []}
            for row in acceptance_ids
        ],
        "previousStateRoot": "",
    }
    state["stateRoot"] = _family_state_root(state)
    return validate_family_state(state)


def transition_family_state(current: Any, transition: Any) -> dict[str, Any]:
    """Append one exact-root family transition without mutating prior state."""

    prior = validate_family_state(current)
    update = _strict_object(
        transition,
        {
            "schema",
            "expectedStateRoot",
            "terminalUpdates",
            "acceptanceUpdates",
        },
        "Initiative-family transition",
    )
    if update["schema"] != FAMILY_TRANSITION_SCHEMA:
        raise ValueError(f"family transition schema must be {FAMILY_TRANSITION_SCHEMA}")
    expected = _root(update["expectedStateRoot"], "expectedStateRoot")
    if expected != prior["stateRoot"]:
        raise ValueError("Initiative-family state changed before transition")
    terminal_updates = update["terminalUpdates"]
    acceptance_updates = update["acceptanceUpdates"]
    if not isinstance(terminal_updates, list) or not isinstance(
        acceptance_updates, list
    ):
        raise ValueError("family transition updates must be arrays")
    if not terminal_updates and not acceptance_updates:
        raise ValueError("family transition must change at least one field")
    result = json.loads(canonical_json(prior))
    children = {row["assignmentId"]: row for row in result["children"]}
    semantic_change = bool(terminal_updates)
    terminal_ids: list[str] = []
    for row in terminal_updates:
        _strict_object(row, {"assignmentId", "terminal"}, "terminal update")
        assignment_id = row["assignmentId"]
        terminal_ids.append(assignment_id)
        if assignment_id not in children:
            raise ValueError(f"terminal update names an orphan child: {assignment_id}")
        child = children[assignment_id]
        if child["terminal"] is not None:
            raise ValueError("terminal child state is immutable")
        _validate_family_terminal(row["terminal"], child)
        child["terminal"] = row["terminal"]
    if terminal_ids != sorted(set(terminal_ids), key=lambda row: row.encode("utf-8")):
        raise ValueError("terminal updates must be sorted and duplicate-free")
    for assignment_id in terminal_ids:
        child = children[assignment_id]
        if any(children[row]["terminal"] is None for row in child["dependsOn"]):
            raise ValueError("child cannot terminate before all dependencies")

    coverage = {row["acceptanceId"]: row for row in result["acceptance"]}
    coverage_ids: list[str] = []
    allowed = {
        "missing": {"missing", "partial", "proved", "invalidated"},
        "partial": {"partial", "proved", "invalidated"},
        "proved": {"proved", "invalidated"},
        "invalidated": {"invalidated"},
    }
    for row in acceptance_updates:
        _strict_object(
            row, {"acceptanceId", "status", "evidenceRoots"}, "acceptance update"
        )
        acceptance_id = row["acceptanceId"]
        coverage_ids.append(acceptance_id)
        if acceptance_id not in coverage:
            raise ValueError(
                f"acceptance update names an unknown item: {acceptance_id}"
            )
        current_coverage = coverage[acceptance_id]
        if row["status"] not in allowed[current_coverage["status"]]:
            raise ValueError("acceptance coverage transition is invalid")
        if row != current_coverage:
            semantic_change = True
        current_coverage.clear()
        current_coverage.update(row)
    if coverage_ids != sorted(set(coverage_ids), key=lambda row: row.encode("utf-8")):
        raise ValueError("acceptance updates must be sorted and duplicate-free")
    if not semantic_change:
        raise ValueError("family transition produced no semantic change")
    result["previousStateRoot"] = prior["stateRoot"]
    result.pop("stateRoot", None)
    result["stateRoot"] = _family_state_root(result)
    return validate_family_state(result)


def verify_family_state(value: Any) -> dict[str, Any]:
    state = validate_family_state(value)
    terminal_counts = {
        terminal: sum(
            1
            for child in state["children"]
            if (child.get("terminal") or {}).get("state") == terminal
        )
        for terminal in FAMILY_TERMINAL_STATES
    }
    return {
        "schema": "kungfu.work-control.initiative-family-verification/v1",
        "ok": True,
        "stateRoot": state["stateRoot"],
        "previousStateRoot": state["previousStateRoot"],
        "waveGateTerminal": True,
        "parentInert": True,
        "childCount": len(state["children"]),
        "terminalCounts": terminal_counts,
        "waveDrained": sum(terminal_counts.values()) == len(state["children"]),
        "acceptance": [
            {
                "acceptanceId": row["acceptanceId"],
                "status": row["status"],
            }
            for row in state["acceptance"]
        ],
    }
