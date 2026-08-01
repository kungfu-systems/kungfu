# SPDX-License-Identifier: Apache-2.0

"""Pure boundaries for captured Assignment admission and sealed work state."""

from __future__ import annotations

import hashlib
import json
import ntpath
import os
import re
import subprocess
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

ROOT = "sha256:"
REQUEST_SCHEMA = "kungfu.assignment-request/v1"
CAPTURE_RECEIPT_SCHEMA = "kungfu.assignment-capture.receipt/v1"
CAPTURE_RESPONSE_SCHEMA = "kungfu.assignment-capture.response/v1"
INITIATIVE_ADMISSION_SCHEMA = "kungfu.work-control.initiative-admission/v1"
INITIATIVE_SOURCE_SCHEMA = "kungfu.work-control.exact-source/v1"
RETENTION_POLICY = "explicit-expiry-retain-bytes-v1"
STATE_SCHEMA = "kungfu.assignment-orchestration.sealed-state/v1"
OUTCOME_SCHEMA = "kungfu.work-design.outcome/v1"
OUTCOME_BINDING_SCHEMA = (
    "kungfu.assignment-orchestration.work-design-outcome-binding/v1"
)
OUTCOME_INDEX_SCHEMA = "kungfu.assignment-orchestration.work-design-outcome-index/v1"
FAMILY_BLUEPRINT_SCHEMA = "kungfu.work-control.initiative-family-blueprint/v1"
FAMILY_STATE_SCHEMA = "kungfu.work-control.initiative-family-state/v1"
FAMILY_TRANSITION_SCHEMA = "kungfu.work-control.initiative-family-transition/v1"
FAMILY_CONTRACT_V2_SCHEMA = "kungfu.work-control.initiative-family-contract/v2"
FAMILY_STATE_V2_SCHEMA = "kungfu.work-control.initiative-family-state/v2"
FAMILY_TRANSITION_V2_SCHEMA = "kungfu.work-control.initiative-family-transition/v2"
FAMILY_BINDING_V2_SCHEMA = (
    "kungfu.work-control.initiative-family-typed-binding-manifest/v2"
)
FAMILY_UPGRADE_V2_SCHEMA = "kungfu.work-control.initiative-family-upgrade/v2"
CROSS_WORKSPACE_BINDING_SCHEMA = (
    "kungfu.assignment-orchestration.cross-workspace-binding/v1"
)
PRODUCT_MANIFEST_SCHEMA = "kungfu.product-upgrade.manifest/v1"
_GIT_REVISION = re.compile(r"^[0-9a-f]{40}$")
_ISO_8601 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
PHASES = (
    "admitted",
    "claimed",
    "executing",
    "stage-ready",
    "completion-claimed",
    "independently-reviewed",
    "continuation-decided",
)
FAMILY_DELIVERY_CLASSES = (
    "non-native-fast",
    "native-proof-required",
    "cross-platform",
    "release",
)
FAMILY_TERMINAL_STATES = ("merged", "continued", "deferred", "failed")
FAMILY_ACCEPTANCE_STATES = ("proved", "partial", "missing", "invalidated")
FAMILY_V2_REFERENCE_KINDS = (
    "acceptance-policy",
    "admission-receipt",
    "assessment",
    "assignment-state",
    "completion-claim",
    "decision",
    "delivery-evidence",
    "episode",
    "execution-warrant",
    "atlas",
    "project-cut",
    "publication-failure",
    "pursuit",
    "work-definition",
)


def _normalized(value: Any) -> Any:
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [_normalized(row) for row in value]
    if isinstance(value, dict):
        return {
            unicodedata.normalize("NFC", str(key)): _normalized(item)
            for key, item in value.items()
        }
    if value is None or isinstance(value, (bool, int)):
        return value
    raise ValueError(f"unsupported canonical JSON value: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(
        _normalized(value),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def semantic_root(value: Any) -> str:
    return ROOT + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _strict_object(value: Any, fields: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{label} has an invalid field set")
    return value


def _sorted_unique_strings(
    value: Any, field: str, *, allow_empty: bool = False
) -> list[str]:
    if (
        not isinstance(value, list)
        or not all(isinstance(row, str) and row for row in value)
        or value != sorted(set(value), key=lambda row: row.encode("utf-8"))
        or (not allow_empty and not value)
    ):
        qualifier = "" if allow_empty else " non-empty"
        raise ValueError(f"{field} must be a sorted unique{qualifier} string array")
    return value


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not _ISO_8601.fullmatch(value):
        raise ValueError(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{field} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed


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


def family_contract_v2() -> dict[str, Any]:
    """Return the additive typed-envelope contract without changing v1."""

    body = {
        "schema": FAMILY_CONTRACT_V2_SCHEMA,
        "predecessorContractRoot": family_contract()["contractRoot"],
        "stateSchema": FAMILY_STATE_V2_SCHEMA,
        "transitionSchema": FAMILY_TRANSITION_V2_SCHEMA,
        "typedBindingSchema": FAMILY_BINDING_V2_SCHEMA,
        "upgradeSchema": FAMILY_UPGRADE_V2_SCHEMA,
        "typedReferenceKinds": list(FAMILY_V2_REFERENCE_KINDS),
        "typedReferenceFields": [
            "cutRoot",
            "factWorld",
            "identity",
            "kind",
            "root",
            "schema",
            "status",
        ],
        "authority": {
            "familyState": "coordination-projection-only",
            "initiativeParent": "inert",
            "referencedAuthorities": "retained-by-owner",
            "upgradeBindings": "caller-supplied-no-inference",
        },
        "compatibility": {
            "v1ReaderState": "under-typed",
            "v1Projection": "exact-root-preserving",
            "rewritesExistingRoots": False,
        },
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


def _family_v2_state_root(value: Mapping[str, Any]) -> str:
    preimage = dict(value)
    preimage.pop("stateRoot", None)
    return semantic_root(preimage)


def _family_v2_binding_root(value: Mapping[str, Any]) -> str:
    preimage = dict(value)
    preimage.pop("bindingRoot", None)
    return semantic_root(preimage)


def _validate_family_v2_reference(
    value: Any,
    *,
    expected_kind: str,
    expected_fact_world: str,
    expected_cut_root: str,
    expected_status: str,
    label: str,
) -> dict[str, Any]:
    reference = _strict_object(
        value,
        {"kind", "identity", "root", "factWorld", "cutRoot", "schema", "status"},
        label,
    )
    if reference["kind"] != expected_kind:
        raise ValueError(f"{label}.kind must be {expected_kind}")
    if (
        not isinstance(reference["identity"], str)
        or not reference["identity"]
        or not isinstance(reference["schema"], str)
        or not reference["schema"]
        or not isinstance(reference["status"], str)
        or not reference["status"]
    ):
        raise ValueError(f"{label} identity, schema, and status are required")
    _root(reference["root"], f"{label}.root")
    _root(reference["cutRoot"], f"{label}.cutRoot")
    if reference["factWorld"] != expected_fact_world:
        raise ValueError(f"{label} belongs to the wrong fact world")
    if reference["cutRoot"] != expected_cut_root:
        raise ValueError(f"{label} belongs to the wrong cut")
    if expected_kind == "execution-warrant" and reference["status"] != "active":
        raise ValueError("execution Warrant must be active, not stale or revoked")
    if expected_kind == "admission-receipt" and reference["status"] != "admitted":
        raise ValueError("Admission receipt must record an admitted effect")
    if expected_kind == "publication-failure" and reference["status"] != "visible":
        raise ValueError("publication failure must remain visible")
    if reference["status"] != expected_status:
        raise ValueError(f"{label}.status must be {expected_status}")
    return reference


def _validate_family_v2_optional_reference(
    value: Any,
    *,
    expected_kind: str,
    expected_fact_world: str,
    expected_cut_root: str,
    expected_status: str,
    label: str,
) -> dict[str, Any]:
    optional = _strict_object(value, {"present", "reference"}, label)
    if not isinstance(optional["present"], bool):
        raise ValueError(f"{label}.present must be a boolean")
    if not optional["present"]:
        if optional["reference"] is not None:
            raise ValueError(f"{label} must not hide an undeclared reference")
        return optional
    if optional["reference"] is None:
        raise ValueError(f"{label} declares presence without a reference")
    _validate_family_v2_reference(
        optional["reference"],
        expected_kind=expected_kind,
        expected_fact_world=expected_fact_world,
        expected_cut_root=expected_cut_root,
        expected_status=expected_status,
        label=f"{label}.reference",
    )
    return optional


def _validate_family_v2_settlement(
    value: Any,
    *,
    expected_fact_world: str,
    expected_cut_root: str,
    label: str,
) -> dict[str, Any]:
    settlement = _strict_object(
        value,
        {"factWorld", "factCutRoot", "references", "publication"},
        label,
    )
    fact_world = settlement["factWorld"]
    if not isinstance(fact_world, str) or not fact_world:
        raise ValueError(f"{label}.factWorld must be a non-empty string")
    fact_cut_root = _root(settlement["factCutRoot"], f"{label}.factCutRoot")
    if fact_world != expected_fact_world:
        raise ValueError(f"{label}.factWorld does not match the family binding")
    if fact_cut_root != expected_cut_root:
        raise ValueError(f"{label}.factCutRoot does not match the family binding")
    references = _strict_object(
        settlement["references"],
        {
            "completionClaim",
            "assessment",
            "decision",
            "admissionReceipt",
            "episode",
            "projectCut",
            "deliveryEvidence",
        },
        f"{label}.references",
    )
    reference_contracts = {
        "completionClaim": ("completion-claim", "claimed-complete"),
        "assessment": ("assessment", "fit"),
        "decision": ("decision", "accepted"),
        "admissionReceipt": ("admission-receipt", "admitted"),
        "episode": ("episode", "sealed"),
        "projectCut": ("project-cut", "settled"),
        "deliveryEvidence": ("delivery-evidence", "verified"),
    }
    for field, (kind, status) in reference_contracts.items():
        _validate_family_v2_reference(
            references[field],
            expected_kind=kind,
            expected_fact_world=fact_world,
            expected_cut_root=fact_cut_root,
            expected_status=status,
            label=f"{label}.references.{field}",
        )

    publication = _strict_object(
        settlement["publication"],
        {"state", "lagStartedAt", "failure"},
        f"{label}.publication",
    )
    publication_state = publication["state"]
    if publication_state not in {"published", "pending", "failed"}:
        raise ValueError(f"{label}.publication.state is unsupported")
    lag_started_at = publication["lagStartedAt"]
    if publication_state == "published":
        if lag_started_at is not None:
            raise ValueError("published settlement cannot retain publication lag")
    else:
        _timestamp(lag_started_at, f"{label}.publication.lagStartedAt")
    failure = _validate_family_v2_optional_reference(
        publication["failure"],
        expected_kind="publication-failure",
        expected_fact_world=fact_world,
        expected_cut_root=fact_cut_root,
        expected_status="visible",
        label=f"{label}.publication.failure",
    )
    if failure["present"] != (publication_state == "failed"):
        raise ValueError("publication failure visibility does not match its state")
    return settlement


def validate_family_binding_v2(
    value: Any, v1_state: Mapping[str, Any]
) -> dict[str, Any]:
    """Validate caller-supplied semantic bindings against one exact v1 state."""

    projection = validate_family_state(v1_state)
    manifest = _strict_object(
        value,
        {
            "schema",
            "v1StateRoot",
            "factWorld",
            "factCutRoot",
            "initiative",
            "children",
            "bindingRoot",
        },
        "Initiative-family typed binding manifest",
    )
    if manifest["schema"] != FAMILY_BINDING_V2_SCHEMA:
        raise ValueError(f"typed binding schema must be {FAMILY_BINDING_V2_SCHEMA}")
    if manifest["v1StateRoot"] != projection["stateRoot"]:
        raise ValueError("typed binding names the wrong v1 predecessor state")
    fact_world = manifest["factWorld"]
    if not isinstance(fact_world, str) or not fact_world:
        raise ValueError("typed binding factWorld must be a non-empty string")
    fact_cut_root = _root(manifest["factCutRoot"], "typed binding factCutRoot")

    initiative = _strict_object(
        manifest["initiative"],
        {"initiativeId", "pursuit", "atlas", "acceptancePolicy"},
        "typed binding initiative",
    )
    if initiative["initiativeId"] != projection["initiative"]["initiativeId"]:
        raise ValueError("typed binding Initiative identity does not match v1")
    for field, kind, status in (
        ("pursuit", "pursuit", "active"),
        ("atlas", "atlas", "current"),
        ("acceptancePolicy", "acceptance-policy", "current"),
    ):
        _validate_family_v2_reference(
            initiative[field],
            expected_kind=kind,
            expected_fact_world=fact_world,
            expected_cut_root=fact_cut_root,
            expected_status=status,
            label=f"typed binding initiative.{field}",
        )

    children = manifest["children"]
    if not isinstance(children, list):
        raise ValueError("typed binding children must be an array")
    projected_children = {
        child["assignmentId"]: child for child in projection["children"]
    }
    child_ids: list[str] = []
    for child in children:
        bound = _strict_object(
            child,
            {
                "assignmentId",
                "assignmentState",
                "workDefinition",
                "pursuit",
                "atlas",
                "executionWarrant",
                "settlement",
            },
            "typed binding child",
        )
        assignment_id = bound["assignmentId"]
        child_ids.append(assignment_id)
        if assignment_id not in projected_children:
            raise ValueError(f"typed binding names an orphan child: {assignment_id}")
        projected = projected_children[assignment_id]
        reference_contracts = {
            "assignmentState": (
                "assignment-state",
                "terminal" if projected["terminal"] is not None else "active",
            ),
            "workDefinition": ("work-definition", "accepted"),
            "pursuit": ("pursuit", "active"),
            "atlas": ("atlas", "current"),
            "executionWarrant": ("execution-warrant", "active"),
        }
        for field, (kind, status) in reference_contracts.items():
            _validate_family_v2_reference(
                bound[field],
                expected_kind=kind,
                expected_fact_world=fact_world,
                expected_cut_root=fact_cut_root,
                expected_status=status,
                label=f"typed binding child.{assignment_id}.{field}",
            )
        if bound["assignmentState"]["identity"] != assignment_id:
            raise ValueError("Assignment-state reference identity does not match child")
        if bound["workDefinition"]["identity"] != f"{assignment_id}:work-definition":
            raise ValueError("work-definition reference identity does not match child")
        if bound["workDefinition"]["root"] != projected["workDefinitionRoot"]:
            raise ValueError("work-definition reference root does not match v1")

        optional = _strict_object(
            bound["settlement"], {"present", "value"}, "typed binding settlement"
        )
        if not isinstance(optional["present"], bool):
            raise ValueError("typed binding settlement.present must be a boolean")
        terminal_state = (projected["terminal"] or {}).get("state")
        if optional["present"] != (terminal_state == "merged"):
            raise ValueError(
                "typed settlement presence must exactly match a merged terminal child"
            )
        if optional["present"]:
            if optional["value"] is None:
                raise ValueError("typed settlement declares presence without a value")
            _validate_family_v2_settlement(
                optional["value"],
                expected_fact_world=fact_world,
                expected_cut_root=fact_cut_root,
                label=f"typed binding child.{assignment_id}.settlement",
            )
        elif optional["value"] is not None:
            raise ValueError("absent typed settlement must not hide a value")

    expected_ids = [child["assignmentId"] for child in projection["children"]]
    if child_ids != expected_ids:
        raise ValueError(
            "typed binding children must exactly match sorted v1 membership"
        )
    declared = _root(manifest["bindingRoot"], "typed binding bindingRoot")
    if declared != _family_v2_binding_root(manifest):
        raise ValueError("Initiative-family typed binding root does not verify")
    return manifest


def _create_family_state_v2(
    projection: Mapping[str, Any],
    bindings: Mapping[str, Any],
    *,
    predecessor_state_root: str,
    previous_state_root: str,
) -> dict[str, Any]:
    state: dict[str, Any] = {
        "schema": FAMILY_STATE_V2_SCHEMA,
        "predecessorStateRoot": predecessor_state_root,
        "v1ProjectionRoot": projection["stateRoot"],
        "v1Projection": json.loads(canonical_json(projection)),
        "typedBindingRoot": bindings["bindingRoot"],
        "typedBindings": json.loads(canonical_json(bindings)),
        "previousStateRoot": previous_state_root,
    }
    state["stateRoot"] = _family_v2_state_root(state)
    return validate_family_state_v2(state)


def validate_family_state_v2(value: Any) -> dict[str, Any]:
    """Validate a fully typed v2 state and its exact v1 projection."""

    state = _strict_object(
        value,
        {
            "schema",
            "predecessorStateRoot",
            "v1ProjectionRoot",
            "v1Projection",
            "typedBindingRoot",
            "typedBindings",
            "previousStateRoot",
            "stateRoot",
        },
        "Initiative-family state v2",
    )
    if state["schema"] != FAMILY_STATE_V2_SCHEMA:
        raise ValueError(f"family state v2 schema must be {FAMILY_STATE_V2_SCHEMA}")
    _root(state["predecessorStateRoot"], "predecessorStateRoot")
    previous = str(state["previousStateRoot"] or "")
    if previous:
        _root(previous, "previousStateRoot")
    projection = validate_family_state(state["v1Projection"])
    if state["v1ProjectionRoot"] != projection["stateRoot"]:
        raise ValueError("v2 state does not bind its exact v1 projection root")
    bindings = validate_family_binding_v2(state["typedBindings"], projection)
    if state["typedBindingRoot"] != bindings["bindingRoot"]:
        raise ValueError("v2 state does not bind its typed manifest root")
    declared = _root(state["stateRoot"], "stateRoot")
    if declared != _family_v2_state_root(state):
        raise ValueError("Initiative-family state v2 root does not verify")
    return state


def upgrade_family_state_v2(
    v1_state: Any, typed_binding_manifest: Any
) -> dict[str, Any]:
    """Explicitly upgrade one immutable v1 state with caller-supplied bindings."""

    predecessor = validate_family_state(v1_state)
    bindings = validate_family_binding_v2(typed_binding_manifest, predecessor)
    successor = _create_family_state_v2(
        predecessor,
        bindings,
        predecessor_state_root=predecessor["stateRoot"],
        previous_state_root="",
    )
    return {
        "schema": FAMILY_UPGRADE_V2_SCHEMA,
        "predecessorStateRoot": predecessor["stateRoot"],
        "typedBindingRoot": bindings["bindingRoot"],
        "v1ProjectionRoot": predecessor["stateRoot"],
        "successorStateRoot": successor["stateRoot"],
        "successorState": successor,
    }


def transition_family_state_v2(current: Any, transition: Any) -> dict[str, Any]:
    """Advance v2 only with a v1 transition and a complete successor manifest."""

    prior = validate_family_state_v2(current)
    update = _strict_object(
        transition,
        {
            "schema",
            "expectedStateRoot",
            "v1Transition",
            "typedBindingManifest",
        },
        "Initiative-family transition v2",
    )
    if update["schema"] != FAMILY_TRANSITION_V2_SCHEMA:
        raise ValueError(
            f"family transition v2 schema must be {FAMILY_TRANSITION_V2_SCHEMA}"
        )
    expected = _root(update["expectedStateRoot"], "expectedStateRoot")
    if expected != prior["stateRoot"]:
        raise ValueError("Initiative-family state v2 changed before transition")
    successor_projection = transition_family_state(
        prior["v1Projection"], update["v1Transition"]
    )
    bindings = validate_family_binding_v2(
        update["typedBindingManifest"], successor_projection
    )
    return _create_family_state_v2(
        successor_projection,
        bindings,
        predecessor_state_root=prior["predecessorStateRoot"],
        previous_state_root=prior["stateRoot"],
    )


def project_family_state_v1(value: Any) -> dict[str, Any]:
    """Return the exact v1-compatible state carried by a typed v2 envelope."""

    state = validate_family_state_v2(value)
    return json.loads(canonical_json(state["v1Projection"]))


def verify_family_state_v2(value: Any) -> dict[str, Any]:
    """Read v1 as under-typed or verify a complete v2 typed envelope."""

    if isinstance(value, dict) and value.get("schema") == FAMILY_STATE_SCHEMA:
        state = validate_family_state(value)
        return {
            "schema": "kungfu.work-control.initiative-family-verification/v2",
            "ok": True,
            "inputSchema": FAMILY_STATE_SCHEMA,
            "typingState": "under-typed-v1",
            "stateRoot": state["stateRoot"],
            "v1ProjectionRoot": state["stateRoot"],
            "fullyTyped": False,
            "completionQualified": False,
            "missingSemanticBindings": [
                "acceptance-policy",
                "admission-receipt",
                "assessment",
                "assignment-state",
                "completion-claim",
                "decision",
                "delivery-evidence",
                "episode",
                "execution-warrant",
                "atlas",
                "project-cut",
                "pursuit",
                "work-definition",
            ],
        }
    state = validate_family_state_v2(value)
    projection = state["v1Projection"]
    merged = [
        child
        for child in state["typedBindings"]["children"]
        if (
            next(
                row["terminal"]
                for row in projection["children"]
                if row["assignmentId"] == child["assignmentId"]
            )
            or {}
        ).get("state")
        == "merged"
    ]
    publication_states = [
        child["settlement"]["value"]["publication"]["state"] for child in merged
    ]
    v1_verification = verify_family_state(projection)
    acceptance_proved = all(
        row["status"] == "proved" for row in projection["acceptance"]
    )
    all_children_merged = len(merged) == len(projection["children"])
    publication_complete = all(row == "published" for row in publication_states)
    return {
        "schema": "kungfu.work-control.initiative-family-verification/v2",
        "ok": True,
        "inputSchema": FAMILY_STATE_V2_SCHEMA,
        "typingState": "fully-typed-v2",
        "stateRoot": state["stateRoot"],
        "previousStateRoot": state["previousStateRoot"],
        "predecessorStateRoot": state["predecessorStateRoot"],
        "v1ProjectionRoot": state["v1ProjectionRoot"],
        "typedBindingRoot": state["typedBindingRoot"],
        "fullyTyped": True,
        "waveDrained": v1_verification["waveDrained"],
        "mergedSettlementCount": len(merged),
        "publicationComplete": publication_complete,
        "pendingPublicationCount": publication_states.count("pending"),
        "failedPublicationCount": publication_states.count("failed"),
        "completionQualified": (
            v1_verification["waveDrained"]
            and all_children_merged
            and acceptance_proved
            and publication_complete
        ),
        "projectionMergeIsCompletion": False,
    }


def source_root(*starts: str | Path) -> Path:
    """Resolve the owning Kungfu checkout in source and assembled layouts."""

    candidates = [Path(value).expanduser().resolve() for value in starts]
    candidates.extend((Path(__file__).resolve(), Path.cwd().resolve()))
    for start in candidates:
        directory = start if start.is_dir() else start.parent
        for candidate in (directory, *directory.parents):
            if (candidate / ".git").exists() and (
                candidate / "framework" / "core"
            ).is_dir():
                return candidate
    return Path(__file__).resolve().parents[5]


def _same_or_descendant(path: Path, root: Path) -> bool:
    """Accept filesystem aliases without weakening the runtime-root boundary."""

    if path == root or root in path.parents:
        return True
    for candidate in (path, *path.parents):
        try:
            if candidate.samefile(root):
                return True
        except OSError:
            continue
    return False


def _installed_runtime_entrypoint(binding_file: Path) -> str:
    """Bind the manifest entrypoint to the packaged native runtime platform."""

    return "kungfu.exe" if binding_file.suffix.lower() == ".pyd" else "kungfu"


def binding_provenance(*, allow_foreign: bool = False) -> dict[str, Any]:
    """Fail closed unless pykungfu belongs to this source or installed product.

    Source admission binds the native extension to the exact Git checkout and
    build-info revision.  Installed admission instead binds the extension,
    packaged runtime, release manifest, and source revision without requiring a
    source checkout.  The two paths are explicit peers; a foreign binding is
    never silently upgraded to either authority.
    """

    import kungfu

    binding_file = Path(str(getattr(kungfu.__binding__, "__file__", ""))).resolve()
    checkout = source_root(binding_file)
    allowed_roots = [
        (checkout / "framework" / "core" / "build").resolve(),
        (checkout / "framework" / "core" / "dist").resolve(),
    ]
    compiled = binding_file.suffix.lower() in {".so", ".dylib", ".pyd"}
    build_info_path = binding_file.parent / "kungfubuildinfo.json"
    try:
        build_info = json.loads(build_info_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        build_info = {}
    build_revision = str(build_info.get("git", {}).get("revision") or "")
    source_layout = compiled and any(
        binding_file == root or root in binding_file.parents for root in allowed_roots
    )
    try:
        checkout_revision = subprocess.run(
            ["git", "-C", str(checkout), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        checkout_revision = ""
    current = bool(
        source_layout
        and _GIT_REVISION.fullmatch(build_revision)
        and build_revision == checkout_revision
        and build_info.get("git", {}).get("pristine") is True
    )

    install_source = os.environ.get("KUNGFU_INSTALL_SOURCE", "")
    runtime_value = os.environ.get("KUNGFU_DIR", "")
    manifest_value = os.environ.get("KUNGFU_UPGRADE_MANIFEST", "")
    runtime_root = Path(runtime_value).expanduser().resolve() if runtime_value else None
    manifest_path = (
        Path(manifest_value).expanduser().resolve() if manifest_value else None
    )
    manifest: dict[str, Any] = {}
    if manifest_path is not None:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    manifest_revision = str(manifest.get("sourceCommit") or "")
    installed = bool(
        compiled
        and install_source in {"archive", "desktop-companion"}
        and runtime_root is not None
        and _same_or_descendant(binding_file, runtime_root)
        and manifest.get("schema") == PRODUCT_MANIFEST_SCHEMA
        and _GIT_REVISION.fullmatch(manifest_revision)
        and manifest_revision == build_revision
        and str(manifest.get("runtimeEntrypoint") or "")
        == _installed_runtime_entrypoint(binding_file)
        and str(manifest.get("runtimeArtifactDigest") or "").startswith(ROOT)
    )
    override = (
        allow_foreign
        or os.environ.get("KUNGFU_ASSIGNMENT_ADMIT_ALLOW_FOREIGN_BINDING") == "1"
    )
    result = {
        "schema": "kungfu.assignment-orchestration.binding-provenance/v1",
        "ok": bool(current or installed or override),
        "state": (
            "current-checkout"
            if current
            else "installed-product"
            if installed
            else "degraded"
        ),
        "binding_file": str(binding_file),
        "checkout": str(checkout) if current else None,
        "compiled": compiled,
        "install_source": install_source or None,
        "runtime_root": str(runtime_root) if installed else None,
        "manifest_path": str(manifest_path) if installed else None,
        "source_revision": build_revision or None,
        "manifest_root": semantic_root(manifest) if installed else None,
        "build_info_root": semantic_root(build_info) if build_info else None,
        "override": bool(override and not current and not installed),
        "fail_closed": not current and not installed and not override,
    }
    result["provenance_root"] = semantic_root(result)
    return result


def _validate_capture_value(value: Any) -> None:
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        if unicodedata.normalize("NFC", value) != value:
            raise ValueError("canonical JSON strings must be NFC-normalized")
        return
    if isinstance(value, int):
        if value < 0 or value > 9_007_199_254_740_991:
            raise ValueError("canonical JSON integers must be non-negative and safe")
        return
    if isinstance(value, list):
        for item in value:
            _validate_capture_value(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("canonical JSON object keys must be strings")
            _validate_capture_value(key)
            _validate_capture_value(item)
        return
    raise ValueError(f"unsupported canonical JSON value: {type(value).__name__}")


def validate_assignment_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Assignment request must be a JSON object")
    expected = {"retention", "schema", "source", "workDefinition"}
    unknown = sorted(set(value) - expected)
    if unknown:
        raise ValueError(f"Assignment request has an unknown field: {unknown[0]}")
    if set(value) != expected or value.get("schema") != REQUEST_SCHEMA:
        raise ValueError(f"Assignment request schema must be {REQUEST_SCHEMA}")
    if not isinstance(value.get("workDefinition"), dict):
        raise ValueError("workDefinition must be a JSON object")
    source = value.get("source")
    if (
        not isinstance(source, dict)
        or not isinstance(source.get("kind"), str)
        or not source["kind"].strip()
    ):
        raise ValueError("source.kind must be a non-empty string")
    retention = value.get("retention")
    if (
        not isinstance(retention, dict)
        or set(retention) != {"policy", "expiresAt"}
        or retention.get("policy") != RETENTION_POLICY
    ):
        raise ValueError(f"retention must declare {RETENTION_POLICY} and expiresAt")
    expires_at = retention.get("expiresAt")
    if expires_at is not None:
        if not isinstance(expires_at, str) or not _ISO_8601.fullmatch(expires_at):
            raise ValueError(
                "retention.expiresAt must be null or an ISO-8601 timestamp"
            )
        try:
            datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(
                "retention.expiresAt must be null or an ISO-8601 timestamp"
            ) from error
    _validate_capture_value(value)
    return value


def _filesystem_path(path: Path, *, platform: str = os.name) -> str:
    value = os.fspath(path)
    if platform != "nt":
        return value
    absolute = os.path.abspath(value) if os.name == "nt" else ntpath.abspath(value)
    if absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def _write_exact(path: Path, content: bytes) -> bool:
    filesystem_path = _filesystem_path(path)
    if os.path.exists(filesystem_path):
        with open(filesystem_path, "rb") as source:
            existing = source.read()
        if existing != content:
            raise ValueError(f"content-addressed file differs: {path}")
        return False
    parent = os.path.dirname(filesystem_path)
    os.makedirs(parent, exist_ok=True)
    descriptor, temporary_value = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=parent
    )
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
        try:
            os.link(temporary_value, filesystem_path)
        except FileExistsError:
            with open(filesystem_path, "rb") as source:
                existing = source.read()
            if existing != content:
                raise ValueError(f"content-addressed file differs: {path}")
            return False
        return True
    finally:
        try:
            os.unlink(temporary_value)
        except FileNotFoundError:
            pass


def _read_text_exact(path: Path) -> str:
    with open(_filesystem_path(path), encoding="utf-8") as source:
        return source.read()


def capture_assignment_request(request: Any, target: Any) -> dict[str, Any]:
    request = validate_assignment_request(request)
    request_root = semantic_root(request)
    digest = request_root.removeprefix(ROOT)
    directory = (
        Path(target.identity.data_home)
        / "inbox"
        / "assignment-requests"
        / "sha256"
        / digest[:2]
        / digest
    )
    request_path = directory / "request.json"
    receipt_core = {
        "schema": CAPTURE_RECEIPT_SCHEMA,
        "operationClass": target.operation_class,
        "requestRoot": request_root,
        "requestPath": os.path.relpath(request_path, target.identity.data_home),
        "workspaceId": target.identity.workspace_id,
        "workspaceKind": target.identity.workspace_kind,
        "workspaceRoot": target.identity.workspace_root,
        "resolutionReason": target.identity.resolution_reason,
        "association": target.association,
        "sourceWorkingDirectory": target.source_working_directory,
        "effects": ["assignment-request-captured", "capture-receipt-recorded"],
        "skippedEffects": [
            "initiative-association",
            "assignment-admission",
            "assignment-claim",
            "runtime-initialization",
            "journal-write",
            "git-init",
            "git-stage",
            "git-commit",
            "git-push",
        ],
    }
    if target.association == "unassigned":
        receipt_core["skippedEffects"].insert(0, "project-association")
    receipt_root = semantic_root(receipt_core)
    receipt = {**receipt_core, "receiptRoot": receipt_root}
    receipt_path = (
        directory / "receipts" / "sha256" / f"{receipt_root.removeprefix(ROOT)}.json"
    )
    request_written = _write_exact(
        request_path, (canonical_json(request) + "\n").encode()
    )
    receipt_written = _write_exact(
        receipt_path, (canonical_json(receipt) + "\n").encode()
    )
    return {
        "schema": CAPTURE_RESPONSE_SCHEMA,
        "status": (
            "captured" if request_written or receipt_written else "already-present"
        ),
        "requestRoot": request_root,
        "receiptRoot": receipt_root,
        "requestPath": str(request_path),
        "receiptPath": str(receipt_path),
        "target": {
            "operationClass": target.operation_class,
            "workspaceId": target.identity.workspace_id,
            "workspaceKind": target.identity.workspace_kind,
            "workspaceRoot": target.identity.workspace_root,
            "dataHome": target.identity.data_home,
            "resolutionReason": target.identity.resolution_reason,
            "association": target.association,
            "sourceWorkingDirectory": target.source_working_directory,
            "runtimeInitialized": Path(target.runtime_dir).is_dir(),
        },
        "authority": "capture-material-only",
        "admitted": False,
        "claimed": False,
    }


def load_captured_request(request_file: str | Path) -> dict[str, Any]:
    path = Path(request_file).expanduser().resolve()
    request = json.loads(_read_text_exact(path))
    if not isinstance(request, dict) or request.get("schema") != REQUEST_SCHEMA:
        raise ValueError(f"request must use {REQUEST_SCHEMA}")
    if set(request) != {"schema", "source", "retention", "workDefinition"}:
        raise ValueError("captured request has an invalid top-level field set")
    if not isinstance(request.get("workDefinition"), dict):
        raise ValueError("captured request workDefinition must be an object")
    request_root = semantic_root(request)
    digest = request_root.removeprefix(ROOT)
    if path.name != "request.json" or path.parent.name != digest:
        raise ValueError("captured request path does not match its semantic root")
    receipt_dir = path.parent / "receipts" / "sha256"
    receipt_roots = []
    filesystem_receipt_dir = _filesystem_path(receipt_dir)
    if not os.path.isdir(filesystem_receipt_dir):
        raise ValueError("captured request has no capture receipt")
    receipt_names = sorted(
        entry.name
        for entry in os.scandir(filesystem_receipt_dir)
        if entry.name.endswith(".json")
    )
    for receipt_name in receipt_names:
        receipt_path = receipt_dir / receipt_name
        receipt = json.loads(_read_text_exact(receipt_path))
        declared = str(receipt.pop("receiptRoot", ""))
        if (
            receipt.get("schema") != CAPTURE_RECEIPT_SCHEMA
            or receipt.get("requestRoot") != request_root
            or declared != semantic_root(receipt)
            or receipt_path.name != f"{declared.removeprefix(ROOT)}.json"
        ):
            raise ValueError(f"capture receipt does not verify: {receipt_path}")
        receipt_roots.append(declared)
    if not receipt_roots:
        raise ValueError("captured request has no valid capture receipt")
    return {
        "request": request,
        "request_root": request_root,
        "capture_receipt_roots": receipt_roots,
        "request_path": str(path),
    }


def load_initiative_admission(
    admission_file: str | Path, *, stdin_text: str = ""
) -> dict[str, Any]:
    """Verify one explicit exact-source promotion into a native Initiative."""

    if str(admission_file) == "-":
        value = json.loads(stdin_text)
    else:
        value = json.loads(
            Path(admission_file).expanduser().read_text(encoding="utf-8")
        )
    if not isinstance(value, dict):
        raise ValueError("Initiative admission must be a JSON object")
    declared_root = _root(value.pop("admissionRoot", ""), "admissionRoot")
    source = value.get("source")
    if value.get("schema") != INITIATIVE_ADMISSION_SCHEMA:
        raise ValueError("Initiative admission schema is unsupported")
    if not isinstance(source, dict) or source.get("schema") != INITIATIVE_SOURCE_SCHEMA:
        raise ValueError("Initiative admission requires one exact source identity")
    allowed_source = {
        "schema",
        "authority",
        "kind",
        "sourceId",
        "versionRoot",
    }
    if set(source) != allowed_source:
        raise ValueError("Initiative source identity has unsupported fields")
    if not all(
        str(source.get(field) or "").strip()
        for field in ("authority", "kind", "sourceId")
    ):
        raise ValueError("Initiative source authority, kind, and id are required")
    _root(source.get("versionRoot"), "source.versionRoot")
    if not all(
        str(value.get(field) or "").strip()
        for field in ("initiativeId", "title", "intent")
    ):
        raise ValueError("Initiative id, title, and intent are required")
    if semantic_root(value) != declared_root:
        raise ValueError("Initiative admission root does not verify")
    return {
        **value,
        "source": dict(source),
        "admissionRoot": declared_root,
    }


def atlas_assignment_projection(
    captured: Mapping[str, Any],
    *,
    initiative_id: str = "",
    assignment_id: str = "",
    initiative_admission: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    work = dict(captured["request"]["workDefinition"])
    request_source = captured["request"].get("source") or {}
    hierarchy = work.get("hierarchy") or {}
    family_initiative_child = bool(
        isinstance(request_source, dict)
        and request_source.get("kind") == "kungfu-assignment-family-child"
        and isinstance(hierarchy, dict)
        and hierarchy.get("role") == "initiative-child"
        and str(hierarchy.get("parent_assignment_id") or "")
        == str(work.get("initiative_id") or "")
    )
    resource = work.get("resource_plan")
    resource = resource if isinstance(resource, dict) else {}
    dependencies = resource.get("depends_on") or work.get("depends_on") or []
    if not isinstance(dependencies, list):
        dependencies = []
    initiative = initiative_id or str(work.get("initiative_id") or "")
    assignment = (
        assignment_id
        or str(work.get("assignment_id") or "")
        or str(work.get("goal_id") or "")
    )
    context_binding = work.get("context_binding") or {}
    if not isinstance(context_binding, dict):
        raise ValueError("workDefinition context_binding must be an object")
    evidence_episode_roots = work.get("evidence_episode_roots") or []
    if not isinstance(evidence_episode_roots, list):
        raise ValueError("workDefinition evidence_episode_roots must be an array")
    if not initiative or not assignment:
        raise ValueError("admission requires initiative and assignment identities")
    initiative_ref = work.get("initiative_ref") or {}
    parent_assignment_ref = work.get("parent_assignment_ref") or {}
    dependency_refs = work.get("dependency_refs") or []
    if not isinstance(initiative_ref, dict):
        raise ValueError("workDefinition.initiative_ref must be an object")
    if not isinstance(parent_assignment_ref, dict):
        raise ValueError("workDefinition.parent_assignment_ref must be an object")
    if not isinstance(dependency_refs, list) or not all(
        isinstance(row, dict) for row in dependency_refs
    ):
        raise ValueError("workDefinition.dependency_refs must be an array of objects")
    if parent_assignment_ref and work.get("parent_goal"):
        raise ValueError(
            "workDefinition cannot mix parent Assignment ref and local shorthand"
        )
    if dependency_refs and dependencies:
        raise ValueError(
            "workDefinition cannot mix dependency refs and local shorthand"
        )
    explicit_initiative = dict(initiative_admission or {})
    if initiative_ref and explicit_initiative:
        raise ValueError(
            "admission cannot mix an exact Initiative WorkRef and source promotion"
        )
    if explicit_initiative:
        promoted_id = str(explicit_initiative.get("initiativeId") or "")
        source = explicit_initiative.get("source") or {}
        if promoted_id != initiative:
            raise ValueError(
                "explicit Initiative admission does not match requested identity"
            )
        if str(source.get("sourceId") or "") != initiative:
            raise ValueError(
                "Initiative source identity does not match requested identity"
            )
    atlas_request = (
        isinstance(request_source, dict)
        and request_source.get("kind") == "atlas-go-card"
    )
    if atlas_request and not initiative_ref and not explicit_initiative:
        raise ValueError(
            "Atlas admission requires an exact parent Initiative admission or WorkRef"
        )
    return {
        "initiative_id": initiative,
        "initiative_title": str(
            explicit_initiative.get("title")
            or work.get("initiative_title")
            or initiative
        ),
        "initiative_intent": str(
            explicit_initiative.get("intent")
            or work.get("initiative_intent")
            or work.get("objective")
            or assignment
        ),
        "initiative_source_identity": (
            {
                **dict(explicit_initiative.get("source") or {}),
                "admissionRoot": str(explicit_initiative.get("admissionRoot") or ""),
            }
            if explicit_initiative
            else {}
        ),
        "assignment_id": assignment,
        "title": str(work.get("title") or assignment),
        "objective": str(work.get("objective") or work.get("summary") or assignment),
        # Family child cards retain the inert Initiative parent in their
        # lossless work definition. It is not a workspace-local Assignment
        # shorthand; only an exact parent_assignment_ref may add that edge.
        "parent_assignment_id": (
            "" if family_initiative_child else str(work.get("parent_goal") or "")
        ),
        "depends_on": [str(row) for row in dependencies],
        "initiative_ref": initiative_ref,
        "parent_assignment_ref": parent_assignment_ref,
        "dependency_refs": [dict(row) for row in dependency_refs],
        "responsibility": str(
            work.get("mission_why_matters")
            or work.get("objective")
            or work.get("owner_agent")
            or ""
        ),
        "work_definition": work,
        "context_binding": context_binding,
        "project_cut_root": _root(
            work.get("project_cut_root"), "projectCutRoot", optional=True
        ),
        "evidence_episode_roots": sorted(
            {_root(value, "evidenceEpisodeRoots") for value in evidence_episode_roots}
        ),
        "request_root": str(captured["request_root"]),
        "capture_receipt_roots": list(captured["capture_receipt_roots"]),
    }


def next_actions(status: Mapping[str, Any]) -> list[dict[str, Any]]:
    identity = {
        "initiative_id": str(status.get("initiative_id") or ""),
        "assignment_id": str(status.get("assignment_id") or ""),
    }
    phase = str(status.get("phase") or "")
    table = {
        "admitted": [("claim", "Mint a bounded owner/agent/slot lease")],
        "claimed": [("kickoff", "Enter execution under the active lease")],
        "executing": [("stage", "Record the stage-ready boundary")],
        "stage-ready": [("claim-completion", "Publish proof-backed completion")],
        "completion-claimed": [("review", "Run independent completion review")],
        "independently-reviewed": [("decide", "Bind a continuation decision")],
        "continuation-decided": [("seal", "Seal portable orchestration state")],
    }
    return [
        {"action": action, "description": description, "input": identity}
        for action, description in table.get(phase, [])
    ]


def gate(status: Mapping[str, Any], target: str) -> dict[str, Any]:
    phase = str(status.get("phase") or "")
    has_lease = bool(status.get("active_lease"))
    if target == "run":
        ok = phase in {"claimed", "executing", "stage-ready"} and has_lease
        reason = (
            "active bounded execution lease"
            if ok
            else (
                "run requires claimed/executing/stage-ready phase and an active lease"
            )
        )
    elif target == "closeout":
        ok = phase == "continuation-decided"
        reason = (
            "continuation decision is recorded"
            if ok
            else "closeout requires continuation-decided phase"
        )
    else:
        raise ValueError("gate target must be run or closeout")
    response = {
        "schema": "kungfu.assignment-orchestration.gate/v1",
        "ok": ok,
        "phase": phase,
        "policy": "required",
        "reason": reason,
        "target": target,
        "assignment_subject": status.get("assignment_subject"),
        "query_proof_root": status.get("query_proof_root"),
        "next_actions": [] if ok else next_actions(status),
    }
    response["atlas_compatibility"] = {
        "schema": "atlas.project-cut-go-gate/v1",
        "ok": ok,
        "phase": phase,
        "policy": "required",
        "reason": reason,
        "state_path": "kungfu-native-fact-library",
        "target": target,
    }
    return response


def _git_common_dir(workspace_root: Path) -> Path | None:
    marker = workspace_root / ".git"
    if marker.is_dir():
        git_dir = marker.resolve()
    elif marker.is_file():
        declaration = marker.read_text(encoding="utf-8").strip()
        if not declaration.startswith("gitdir:"):
            return None
        declared = Path(declaration.removeprefix("gitdir:").strip())
        git_dir = (
            declared if declared.is_absolute() else workspace_root / declared
        ).resolve()
    else:
        return None
    common_marker = git_dir / "commondir"
    if not common_marker.is_file():
        return git_dir
    declared = Path(common_marker.read_text(encoding="utf-8").strip())
    return (declared if declared.is_absolute() else git_dir / declared).resolve()


def _sealed_state_storage(workspace_root: Path) -> tuple[Path, str]:
    common = _git_common_dir(workspace_root)
    if common is not None:
        return common / "kungfu", "git-common-dir"
    return workspace_root / ".kungfu", "workspace-fallback"


def sealed_state_plan(
    workspace_root: str | Path,
    status: Mapping[str, Any],
    *,
    workspace_identity: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    root = Path(workspace_root).expanduser().resolve()
    identity = dict(workspace_identity or {})
    portable_identity = {
        "workspace_id": identity.get("workspace_id"),
        "workspace_kind": identity.get("workspace_kind"),
    }
    portable_identity = {
        key: value for key, value in portable_identity.items() if value is not None
    }
    snapshot = {
        "schema": STATE_SCHEMA,
        "workspace": portable_identity,
        "initiative_subject": status.get("initiative_subject"),
        "assignment_subject": status.get("assignment_subject"),
        "assignment": status.get("assignment"),
        "phase": status.get("phase"),
        "active_lease": status.get("active_lease"),
        "query_proof_root": status.get("query_proof_root"),
        "counts": {
            "execution_claims": len(status.get("execution_claims") or []),
            "phase_transitions": len(status.get("phase_transitions") or []),
            "completion_claims": int(status.get("completion_claim_count") or 0),
            "independent_reviews": int(status.get("independent_review_count") or 0),
            "continuation_decisions": int(
                status.get("continuation_decision_count") or 0
            ),
        },
    }
    state_root = semantic_root(snapshot)
    digest = state_root.removeprefix(ROOT)
    if identity.get("workspace_kind") == "home":
        storage_root, storage_kind = root, "home-workspace"
    else:
        storage_root, storage_kind = _sealed_state_storage(root)
    relative = Path("assignment-states") / "sha256" / digest[:2] / digest
    return {
        "schema": "kungfu.assignment-orchestration.seal-plan/v1",
        "state_root": state_root,
        "state_path": str(relative / "state.json"),
        "receipt_path": str(relative / "receipt.json"),
        "storage_kind": storage_kind,
        "storage_root": str(storage_root),
        "workspace_root": str(root),
        "snapshot": snapshot,
    }


def apply_sealed_state(
    plan: Mapping[str, Any], expected_state_root: str
) -> dict[str, Any]:
    if plan.get("state_root") != expected_state_root:
        raise ValueError("sealed state changed before execution")
    storage_root = Path(str(plan["storage_root"]))
    state_path = storage_root / str(plan["state_path"])
    receipt_path = storage_root / str(plan["receipt_path"])
    state_bytes = (canonical_json(plan["snapshot"]) + "\n").encode("utf-8")
    receipt = {
        "schema": "kungfu.assignment-orchestration.seal-receipt/v1",
        "stateRoot": expected_state_root,
        "statePath": str(state_path),
        "storageKind": str(plan["storage_kind"]),
        "portable": True,
        "runtimeIndependentVerification": True,
        "worktreeDeletionSafe": plan["storage_kind"]
        in {
            "git-common-dir",
            "home-workspace",
        },
    }
    receipt_bytes = (canonical_json(receipt) + "\n").encode("utf-8")
    for path, content in ((state_path, state_bytes), (receipt_path, receipt_bytes)):
        if path.exists() and path.read_bytes() != content:
            raise ValueError(f"immutable sealed-state collision: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(content)
    return {**receipt, "next_actions": []}


def verify_sealed_state(state_file: str | Path) -> dict[str, Any]:
    path = Path(state_file).expanduser().resolve()
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    root = semantic_root(snapshot)
    receipt_path = path.with_name("receipt.json")
    receipt = (
        json.loads(receipt_path.read_text(encoding="utf-8"))
        if receipt_path.is_file()
        else {}
    )
    return {
        "schema": "kungfu.assignment-orchestration.seal-verification/v1",
        "ok": snapshot.get("schema") == STATE_SCHEMA
        and receipt.get("schema") == "kungfu.assignment-orchestration.seal-receipt/v1"
        and receipt.get("stateRoot") == root,
        "state_root": root,
        "phase": snapshot.get("phase"),
        "next_actions": [],
    }


def list_sealed_assignment_states(
    workspace_root: str | Path,
) -> dict[str, Any]:
    """Read the bounded worktree-deletion-safe Assignment seal index."""

    root = Path(workspace_root).expanduser().resolve()
    storage_root, storage_kind = _sealed_state_storage(root)
    index_root = storage_root / "assignment-states" / "sha256"
    states: list[dict[str, Any]] = []
    unqualified: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for state_path in sorted(index_root.glob("*/*/state.json")):
        try:
            snapshot = json.loads(state_path.read_text(encoding="utf-8"))
            verification = verify_sealed_state(state_path)
            assignment = snapshot.get("assignment") or {}
            subject = str(snapshot.get("assignment_subject") or "")
            owning_root = str(assignment.get("owning_workspace_identity_root") or "")
            query_root = str(snapshot.get("query_proof_root") or "")
            if not verification["ok"]:
                raise ValueError("sealed Assignment state does not verify")
            if (
                not subject
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", owning_root)
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", query_root)
            ):
                unqualified.append(
                    {
                        "assignment_subject": subject,
                        "state_root": verification["state_root"],
                        "phase": snapshot.get("phase"),
                        "reason": "legacy-seal-lacks-portable-work-coordinate",
                    }
                )
                continue
            states.append(
                {
                    "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
                    "assignment_subject": subject,
                    "workspace_identity_root": owning_root,
                    "state_root": verification["state_root"],
                    "query_proof_root": query_root,
                    "phase": snapshot.get("phase"),
                    "settled": snapshot.get("phase") == "continuation-decided",
                    "storage_kind": storage_kind,
                }
            )
        except (OSError, ValueError, json.JSONDecodeError) as error:
            issues.append(
                {
                    "code": "sealed-assignment-state-invalid",
                    "path": str(state_path.relative_to(storage_root)),
                    "message": str(error),
                }
            )
    states.sort(
        key=lambda row: (
            str(row["assignment_subject"]),
            str(row["workspace_identity_root"]),
            str(row["state_root"]),
        )
    )
    unqualified.sort(
        key=lambda row: (
            str(row["assignment_subject"]),
            str(row["state_root"]),
        )
    )
    body = {
        "schema": "kungfu.assignment-orchestration.sealed-work-index/v1",
        "states": states,
        "unqualified_states": unqualified,
        "issues": issues,
        "storage_kind": storage_kind,
        "writes": [],
    }
    return {**body, "index_root": semantic_root(body)}


def _validate_outcome_artifact(value: Any) -> dict[str, Any]:
    outcome = _strict_object(
        value,
        {
            "schema",
            "assignmentId",
            "asOf",
            "bindings",
            "cohort",
            "window",
            "metrics",
            "coverage",
            "evidence",
            "authority",
            "outcomeRoot",
        },
        "Work Design outcome",
    )
    if outcome.get("schema") != OUTCOME_SCHEMA:
        raise ValueError("unsupported Work Design outcome schema")
    if semantic_root(
        {key: value for key, value in outcome.items() if key != "outcomeRoot"}
    ) != outcome.get("outcomeRoot"):
        raise ValueError("Work Design outcome root mismatch")
    bindings = _strict_object(
        outcome.get("bindings"),
        {"workDefinitionRoot", "adviceRoot", "policyRoot"},
        "Work Design outcome bindings",
    )
    for field, root in bindings.items():
        if not isinstance(root, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", root):
            raise ValueError(f"Work Design outcome bindings.{field} is invalid")
    cohort = _strict_object(
        outcome.get("cohort"),
        {"deliveryClass", "workClass", "repositoryClass", "cohortRoot"},
        "Work Design outcome cohort",
    )
    if semantic_root(
        {key: value for key, value in cohort.items() if key != "cohortRoot"}
    ) != cohort.get("cohortRoot"):
        raise ValueError("Work Design outcome cohort root mismatch")
    coverage = _strict_object(
        outcome.get("coverage"),
        {"qualifiedMetrics", "unknownMetrics", "complete", "coverageRoot"},
        "Work Design outcome coverage",
    )
    if semantic_root(
        {key: value for key, value in coverage.items() if key != "coverageRoot"}
    ) != coverage.get("coverageRoot"):
        raise ValueError("Work Design outcome coverage root mismatch")
    if not isinstance(coverage.get("complete"), bool):
        raise ValueError("Work Design outcome coverage.complete must be boolean")
    qualified = _sorted_unique_strings(
        coverage.get("qualifiedMetrics"),
        "Work Design outcome coverage.qualifiedMetrics",
        allow_empty=True,
    )
    unknown = _sorted_unique_strings(
        coverage.get("unknownMetrics"),
        "Work Design outcome coverage.unknownMetrics",
        allow_empty=True,
    )
    metric_names = {"acceptanceFailure", "dependencyCorrection", "rework", "timeout"}
    if set(qualified) | set(unknown) != metric_names or set(qualified) & set(unknown):
        raise ValueError("Work Design outcome coverage must classify every metric once")
    if coverage["complete"] is not (not unknown):
        raise ValueError(
            "Work Design outcome coverage.complete contradicts unknown metrics"
        )
    window = _strict_object(
        outcome.get("window"),
        {"admittedAt", "settledAt", "attributableActiveSeconds", "excludedWaitSeconds"},
        "Work Design outcome window",
    )
    admitted = _timestamp(window.get("admittedAt"), "Work Design outcome admittedAt")
    settled = _timestamp(window.get("settledAt"), "Work Design outcome settledAt")
    if settled < admitted:
        raise ValueError("Work Design outcome settledAt precedes admittedAt")
    if (
        not isinstance(window.get("attributableActiveSeconds"), int)
        or isinstance(window.get("attributableActiveSeconds"), bool)
        or window["attributableActiveSeconds"] < 0
    ):
        raise ValueError("Work Design outcome attributableActiveSeconds is invalid")
    waits = _strict_object(
        window.get("excludedWaitSeconds"),
        {"ci-queue", "external-review", "human-decision", "platform-approval"},
        "Work Design outcome excluded waits",
    )
    if any(
        not isinstance(seconds, int) or isinstance(seconds, bool) or seconds < 0
        for seconds in waits.values()
    ):
        raise ValueError("Work Design outcome excluded wait seconds are invalid")
    metrics = _strict_object(
        outcome.get("metrics"), metric_names, "Work Design outcome metrics"
    )
    metric_fields = {
        "acceptanceFailure": {"status", "count", "assessmentRoots"},
        "dependencyCorrection": {"status", "count", "revisionRoots"},
        "rework": {"status", "count", "eventRoots"},
        "timeout": {
            "status",
            "plannedBudgetSeconds",
            "attributableActiveSeconds",
            "overrunSeconds",
            "exceeded",
        },
    }
    for name, fields in metric_fields.items():
        metric = _strict_object(
            metrics.get(name), fields, f"Work Design outcome {name}"
        )
        expected_status = "qualified" if name in qualified else "unknown"
        if metric.get("status") != expected_status:
            raise ValueError(f"Work Design outcome {name} status contradicts coverage")
        if name != "timeout":
            count = metric.get("count")
            if expected_status == "qualified" and (
                not isinstance(count, int) or isinstance(count, bool) or count < 0
            ):
                raise ValueError(f"Work Design outcome {name} count is invalid")
            if expected_status == "unknown" and count is not None:
                raise ValueError(
                    f"Work Design outcome {name} unknown count must be null"
                )
            root_field = next(field for field in fields if field.endswith("Roots"))
            roots = _sorted_unique_strings(
                metric.get(root_field),
                f"Work Design outcome {name}.{root_field}",
                allow_empty=True,
            )
            if not all(re.fullmatch(r"sha256:[0-9a-f]{64}", root) for root in roots):
                raise ValueError(f"Work Design outcome {name}.{root_field} is invalid")
        else:
            for field in (
                "plannedBudgetSeconds",
                "attributableActiveSeconds",
                "overrunSeconds",
            ):
                number = metric.get(field)
                if expected_status == "qualified" and (
                    not isinstance(number, int)
                    or isinstance(number, bool)
                    or number < 0
                ):
                    raise ValueError(f"Work Design outcome timeout.{field} is invalid")
                if expected_status == "unknown" and number is not None:
                    raise ValueError(
                        f"Work Design outcome timeout.{field} must be null"
                    )
            if expected_status == "qualified" and not isinstance(
                metric.get("exceeded"), bool
            ):
                raise ValueError("Work Design outcome timeout.exceeded is invalid")
            if expected_status == "unknown" and metric.get("exceeded") is not None:
                raise ValueError("Work Design outcome timeout.exceeded must be null")
    evidence = _strict_object(
        outcome.get("evidence"),
        {"settledStateRoot", "queryProofRoot", "sourceEvidenceRoots"},
        "Work Design outcome evidence",
    )
    for field in ("settledStateRoot", "queryProofRoot"):
        if not isinstance(evidence.get(field), str) or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", evidence[field]
        ):
            raise ValueError(f"Work Design outcome evidence.{field} is invalid")
    _sorted_unique_strings(
        evidence.get("sourceEvidenceRoots"), "Work Design outcome sourceEvidenceRoots"
    )
    if not all(
        re.fullmatch(r"sha256:[0-9a-f]{64}", root)
        for root in evidence["sourceEvidenceRoots"]
    ):
        raise ValueError("Work Design outcome sourceEvidenceRoots are invalid")
    expected_authority = {
        "mode": "settled-work-observation",
        "factAuthority": False,
        "episodeAuthority": False,
        "assignmentAuthority": False,
        "workControlAuthority": False,
        "policyAuthority": False,
        "mayMutate": False,
    }
    if outcome.get("authority") != expected_authority:
        raise ValueError("Work Design outcome authority boundary is invalid")
    if not isinstance(outcome.get("assignmentId"), str) or not outcome["assignmentId"]:
        raise ValueError("Work Design outcome assignmentId is invalid")
    _timestamp(outcome.get("asOf"), "Work Design outcome asOf")
    return outcome


def outcome_binding_plan(
    workspace_root: str | Path,
    sealed_state: Mapping[str, Any],
    outcome: Any,
    *,
    opening_estimate_root: str | None = None,
    published_at: str,
) -> dict[str, Any]:
    """Plan an additive immutable outcome binding beside portable Work seals."""

    root = Path(workspace_root).expanduser().resolve()
    coordinate = _strict_object(
        sealed_state,
        {
            "schema",
            "assignment_subject",
            "workspace_identity_root",
            "state_root",
            "query_proof_root",
            "phase",
            "settled",
            "storage_kind",
        },
        "sealed Work coordinate",
    )
    if (
        coordinate.get("schema")
        != "kungfu.assignment-orchestration.sealed-work-coordinate/v1"
    ):
        raise ValueError("unsupported sealed Work coordinate schema")
    if (
        coordinate.get("settled") is not True
        or coordinate.get("phase") != "continuation-decided"
    ):
        raise ValueError("outcome binding requires a settled Assignment state")
    artifact = _validate_outcome_artifact(outcome)
    evidence = artifact["evidence"]
    if evidence["settledStateRoot"] != coordinate.get("state_root"):
        raise ValueError("outcome settled state root mismatch")
    if evidence["queryProofRoot"] != coordinate.get("query_proof_root"):
        raise ValueError("outcome query proof root mismatch")
    expected_subject = f"kungfu:{artifact['assignmentId']}"
    if expected_subject != coordinate.get("assignment_subject"):
        raise ValueError("outcome Assignment subject mismatch")
    if opening_estimate_root is not None and not re.fullmatch(
        r"sha256:[0-9a-f]{64}", opening_estimate_root
    ):
        raise ValueError("opening estimate root is invalid")
    published = _timestamp(published_at, "published_at")
    if _timestamp(artifact["asOf"], "outcome asOf") > published:
        raise ValueError("outcome publication cannot precede outcome asOf")
    binding = {
        "schema": OUTCOME_BINDING_SCHEMA,
        "assignment_subject": coordinate["assignment_subject"],
        "workspace_identity_root": coordinate["workspace_identity_root"],
        "settled_state_root": coordinate["state_root"],
        "state_query_proof_root": coordinate["query_proof_root"],
        "opening_estimate_root": opening_estimate_root,
        "published_at": published_at,
        "outcome": artifact,
    }
    binding_root = semantic_root(binding)
    storage_root, storage_kind = _sealed_state_storage(root)
    digest = binding_root.removeprefix(ROOT)
    return {
        "schema": "kungfu.assignment-orchestration.work-design-outcome-binding-plan/v1",
        "binding": {**binding, "binding_root": binding_root},
        "binding_root": binding_root,
        "binding_path": str(
            Path("work-design-outcomes")
            / "sha256"
            / digest[:2]
            / digest
            / "binding.json"
        ),
        "storage_kind": storage_kind,
        "storage_root": str(storage_root),
        "workspace_root": str(root),
        "writes": ["immutable-content-addressed-outcome-binding"],
    }


def verify_outcome_binding(value: Any) -> dict[str, Any]:
    try:
        binding = _strict_object(
            value,
            {
                "schema",
                "assignment_subject",
                "workspace_identity_root",
                "settled_state_root",
                "state_query_proof_root",
                "opening_estimate_root",
                "published_at",
                "outcome",
                "binding_root",
            },
            "Work Design outcome binding",
        )
        if binding.get("schema") != OUTCOME_BINDING_SCHEMA:
            raise ValueError("unsupported Work Design outcome binding schema")
        for field in (
            "workspace_identity_root",
            "settled_state_root",
            "state_query_proof_root",
            "binding_root",
        ):
            if not isinstance(binding.get(field), str) or not re.fullmatch(
                r"sha256:[0-9a-f]{64}", binding[field]
            ):
                raise ValueError(f"outcome binding {field} is invalid")
        if binding.get("opening_estimate_root") is not None and not re.fullmatch(
            r"sha256:[0-9a-f]{64}", str(binding["opening_estimate_root"])
        ):
            raise ValueError("outcome binding opening_estimate_root is invalid")
        published = _timestamp(
            binding.get("published_at"), "outcome binding published_at"
        )
        outcome = _validate_outcome_artifact(binding.get("outcome"))
        if _timestamp(outcome["asOf"], "outcome asOf") > published:
            raise ValueError("outcome publication precedes outcome asOf")
        if binding["settled_state_root"] != outcome["evidence"]["settledStateRoot"]:
            raise ValueError("outcome binding settled state root mismatch")
        if binding["state_query_proof_root"] != outcome["evidence"]["queryProofRoot"]:
            raise ValueError("outcome binding query proof root mismatch")
        if binding["assignment_subject"] != f"kungfu:{outcome['assignmentId']}":
            raise ValueError("outcome binding Assignment subject mismatch")
        preimage = {key: item for key, item in binding.items() if key != "binding_root"}
        if semantic_root(preimage) != binding["binding_root"]:
            raise ValueError("outcome binding root mismatch")
        return {
            "schema": "kungfu.assignment-orchestration.work-design-outcome-binding-verification/v1",
            "ok": True,
            "binding_root": binding["binding_root"],
            "issues": [],
            "writes": [],
        }
    except (TypeError, ValueError) as error:
        return {
            "schema": "kungfu.assignment-orchestration.work-design-outcome-binding-verification/v1",
            "ok": False,
            "binding_root": value.get("binding_root")
            if isinstance(value, Mapping)
            else None,
            "issues": [{"code": "outcome-binding-invalid", "message": str(error)}],
            "writes": [],
        }


def apply_outcome_binding(
    plan: Mapping[str, Any], expected_binding_root: str
) -> dict[str, Any]:
    if plan.get("binding_root") != expected_binding_root:
        raise ValueError("outcome binding changed before execution")
    binding = plan.get("binding")
    verification = verify_outcome_binding(binding)
    if not verification["ok"]:
        raise ValueError(verification["issues"][0]["message"])
    path = Path(str(plan["storage_root"])) / str(plan["binding_path"])
    content = (canonical_json(binding) + "\n").encode("utf-8")
    if path.exists() and path.read_bytes() != content:
        raise ValueError(f"immutable outcome-binding collision: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(content)
    return {
        "schema": "kungfu.assignment-orchestration.work-design-outcome-binding-receipt/v1",
        "bindingRoot": expected_binding_root,
        "bindingPath": str(path),
        "storageKind": str(plan["storage_kind"]),
        "portable": True,
        "writes": [str(path)],
        "next_actions": [],
    }


def list_outcome_bindings(workspace_root: str | Path) -> dict[str, Any]:
    """Read and fail closed over additive rooted outcome bindings."""

    root = Path(workspace_root).expanduser().resolve()
    storage_root, storage_kind = _sealed_state_storage(root)
    index_root = storage_root / "work-design-outcomes" / "sha256"
    by_state: dict[str, list[dict[str, Any]]] = {}
    issues: list[dict[str, Any]] = []
    for binding_path in sorted(index_root.glob("*/*/binding.json")):
        try:
            binding = json.loads(binding_path.read_text(encoding="utf-8"))
            verification = verify_outcome_binding(binding)
            if not verification["ok"]:
                raise ValueError(verification["issues"][0]["message"])
            by_state.setdefault(str(binding["settled_state_root"]), []).append(binding)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            issues.append(
                {
                    "code": "outcome-binding-invalid",
                    "path": str(binding_path.relative_to(storage_root)),
                    "message": str(error),
                }
            )
    bindings: list[dict[str, Any]] = []
    for state_root, rows in sorted(by_state.items()):
        unique = {str(row["binding_root"]): row for row in rows}
        if len(unique) != 1:
            issues.append(
                {
                    "code": "conflicting-outcome-bindings",
                    "settled_state_root": state_root,
                    "binding_roots": sorted(unique),
                    "message": "one settled state has multiple distinct outcome bindings",
                }
            )
            continue
        bindings.append(next(iter(unique.values())))
    body = {
        "schema": OUTCOME_INDEX_SCHEMA,
        "bindings": bindings,
        "issues": sorted(issues, key=semantic_root),
        "storage_kind": storage_kind,
        "writes": [],
    }
    return {**body, "index_root": semantic_root(body)}


def _root(value: Any, field: str, *, optional: bool = False) -> str:
    text = str(value or "")
    if optional and not text:
        return ""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", text):
        raise ValueError(f"{field} must be a sha256 root")
    return text


def _binding_endpoint(
    admission: Mapping[str, Any], status: Mapping[str, Any]
) -> dict[str, Any]:
    workspace = dict(admission.get("workspace") or {})
    assignment = dict(status.get("assignment") or {})
    assignment_receipt = dict(admission.get("assignment_receipt") or {})
    receipt = dict(assignment_receipt.get("receipt") or {})
    workspace_id = str(workspace.get("workspace_id") or "")
    workspace_kind = str(workspace.get("workspace_kind") or "")
    initiative_id = str(status.get("initiative_id") or "")
    assignment_id = str(status.get("assignment_id") or "")
    if workspace_kind not in {"home", "project"} or not workspace_id:
        raise ValueError(
            "admission omitted a stable Home or project workspace identity"
        )
    if not initiative_id or not assignment_id:
        raise ValueError("status omitted Initiative or Assignment identity")
    evidence = sorted(
        {
            _root(row, "evidenceEpisodeRoots")
            for row in assignment.get("evidence_episode_roots") or []
        }
    )
    captures = sorted(
        {
            _root(row, "captureReceiptRoots")
            for row in assignment.get("capture_receipt_roots") or []
        }
    )
    return {
        "workspaceIdentity": {
            "workspaceId": workspace_id,
            "workspaceKind": workspace_kind,
        },
        "initiativeId": initiative_id,
        "assignmentId": assignment_id,
        "stateRoot": _root(status.get("query_proof_root"), "stateRoot"),
        "projectCutRoot": _root(
            assignment.get("project_cut_root"), "projectCutRoot", optional=True
        ),
        "evidenceRoots": evidence,
        "requestRoot": _root(assignment.get("request_root"), "requestRoot"),
        "captureReceiptRoots": captures,
        "admissionReceiptRoot": _root(
            receipt.get("payload_hash"), "admissionReceiptRoot"
        ),
    }


def cross_workspace_binding(
    parent_admission: Mapping[str, Any],
    parent_status: Mapping[str, Any],
    child_admission: Mapping[str, Any],
    child_status: Mapping[str, Any],
) -> dict[str, Any]:
    """Build one path-free parent/child relationship from public receipts."""

    binding: dict[str, Any] = {
        "schema": CROSS_WORKSPACE_BINDING_SCHEMA,
        "relationshipType": "parent-child",
        "parent": _binding_endpoint(parent_admission, parent_status),
        "child": _binding_endpoint(child_admission, child_status),
    }
    if binding["parent"]["workspaceIdentity"] == binding["child"]["workspaceIdentity"]:
        raise ValueError(
            "cross-workspace binding endpoints must name different workspaces"
        )
    if (
        binding["parent"]["initiativeId"],
        binding["parent"]["assignmentId"],
    ) == (
        binding["child"]["initiativeId"],
        binding["child"]["assignmentId"],
    ):
        raise ValueError("cross-workspace binding endpoints must name different work")
    return {**binding, "bindingRoot": semantic_root(binding)}


def verify_cross_workspace_binding(binding: Mapping[str, Any]) -> dict[str, Any]:
    value = dict(binding)
    declared = _root(value.pop("bindingRoot", ""), "bindingRoot")
    if set(value) != {"schema", "relationshipType", "parent", "child"}:
        raise ValueError("cross-workspace binding has an invalid field set")
    if (
        value.get("schema") != CROSS_WORKSPACE_BINDING_SCHEMA
        or value.get("relationshipType") != "parent-child"
    ):
        raise ValueError("cross-workspace binding contract mismatch")
    endpoint_fields = {
        "workspaceIdentity",
        "initiativeId",
        "assignmentId",
        "stateRoot",
        "projectCutRoot",
        "evidenceRoots",
        "requestRoot",
        "captureReceiptRoots",
        "admissionReceiptRoot",
    }
    for role in ("parent", "child"):
        endpoint = value.get(role)
        if not isinstance(endpoint, dict) or set(endpoint) != endpoint_fields:
            raise ValueError(f"{role} binding endpoint has an invalid field set")
        identity = endpoint.get("workspaceIdentity")
        if (
            not isinstance(identity, dict)
            or set(identity) != {"workspaceId", "workspaceKind"}
            or identity.get("workspaceKind") not in {"home", "project"}
            or not str(identity.get("workspaceId") or "")
        ):
            raise ValueError(f"{role} binding endpoint identity is invalid")
        if not endpoint.get("initiativeId") or not endpoint.get("assignmentId"):
            raise ValueError(f"{role} binding endpoint work identity is absent")
        for field in ("stateRoot", "requestRoot", "admissionReceiptRoot"):
            _root(endpoint.get(field), f"{role}.{field}")
        _root(endpoint.get("projectCutRoot"), f"{role}.projectCutRoot", optional=True)
        for field in ("evidenceRoots", "captureReceiptRoots"):
            roots = endpoint.get(field)
            if not isinstance(roots, list) or roots != sorted(set(roots)):
                raise ValueError(f"{role}.{field} must be sorted and unique")
            for root in roots:
                _root(root, f"{role}.{field}")
    if value["parent"]["workspaceIdentity"] == value["child"]["workspaceIdentity"]:
        raise ValueError("cross-workspace binding endpoints name the same workspace")
    return {
        "schema": "kungfu.assignment-orchestration.cross-workspace-binding-verification/v1",
        "ok": semantic_root(value) == declared,
        "bindingRoot": declared,
        "parentWorkspaceId": value["parent"]["workspaceIdentity"]["workspaceId"],
        "childWorkspaceId": value["child"]["workspaceIdentity"]["workspaceId"],
        "next_actions": [],
    }


def cross_workspace_binding_plan(
    workspace_root: str | Path,
    workspace_identity: Mapping[str, Any],
    status: Mapping[str, Any],
    binding: Mapping[str, Any],
) -> dict[str, Any]:
    verification = verify_cross_workspace_binding(binding)
    if not verification["ok"]:
        raise ValueError("cross-workspace binding root did not verify")
    identity = {
        "workspaceId": str(workspace_identity.get("workspace_id") or ""),
        "workspaceKind": str(workspace_identity.get("workspace_kind") or ""),
    }
    roles = [
        role
        for role in ("parent", "child")
        if binding[role]["workspaceIdentity"] == identity
        and binding[role]["initiativeId"] == status.get("initiative_id")
        and binding[role]["assignmentId"] == status.get("assignment_id")
        and binding[role]["stateRoot"] == status.get("query_proof_root")
    ]
    if len(roles) != 1:
        raise ValueError("local Assignment state does not match one binding endpoint")
    role = roles[0]
    root = Path(workspace_root).expanduser().resolve()
    if identity["workspaceKind"] == "home":
        storage_root, storage_kind = root, "home-workspace"
    else:
        storage_root, storage_kind = _sealed_state_storage(root)
    digest = str(binding["bindingRoot"]).removeprefix(ROOT)
    relative = Path("assignment-bindings") / "sha256" / digest[:2] / digest
    receipt = {
        "schema": "kungfu.assignment-orchestration.cross-workspace-binding-receipt/v1",
        "bindingRoot": binding["bindingRoot"],
        "localRole": role,
        "localWorkspaceIdentity": identity,
        "localEndpointRoot": semantic_root(binding[role]),
        "storageKind": storage_kind,
        "portable": True,
        "pathIsIdentity": False,
    }
    receipt["receiptRoot"] = semantic_root(receipt)
    return {
        "schema": "kungfu.assignment-orchestration.cross-workspace-binding-plan/v1",
        "bindingRoot": binding["bindingRoot"],
        "storageRoot": str(storage_root),
        "bindingPath": str(relative / "binding.json"),
        "receiptPath": str(relative / f"{role}-receipt.json"),
        "receipt": receipt,
        "executed": False,
    }


def apply_cross_workspace_binding(
    plan: Mapping[str, Any],
    binding: Mapping[str, Any],
    expected_binding_root: str,
) -> dict[str, Any]:
    if (
        plan.get("bindingRoot") != expected_binding_root
        or binding.get("bindingRoot") != expected_binding_root
    ):
        raise ValueError("cross-workspace binding changed before execution")
    storage_root = Path(str(plan["storageRoot"]))
    binding_path = storage_root / str(plan["bindingPath"])
    receipt_path = storage_root / str(plan["receiptPath"])
    for path, value in (
        (binding_path, binding),
        (receipt_path, plan["receipt"]),
    ):
        content = (canonical_json(value) + "\n").encode("utf-8")
        if path.exists() and path.read_bytes() != content:
            raise ValueError(f"immutable cross-workspace binding collision: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(content)
    return {
        **dict(plan["receipt"]),
        "bindingPath": str(binding_path),
        "receiptPath": str(receipt_path),
        "next_actions": [],
    }


def verify_cross_workspace_binding_receipt(
    binding_file: str | Path, receipt_file: str | Path
) -> dict[str, Any]:
    binding = json.loads(Path(binding_file).read_text(encoding="utf-8"))
    receipt = json.loads(Path(receipt_file).read_text(encoding="utf-8"))
    binding_verification = verify_cross_workspace_binding(binding)
    declared_receipt_root = _root(receipt.pop("receiptRoot", ""), "receiptRoot")
    local_role = str(receipt.get("localRole") or "")
    ok = bool(
        binding_verification["ok"]
        and local_role in {"parent", "child"}
        and receipt.get("bindingRoot") == binding.get("bindingRoot")
        and receipt.get("localWorkspaceIdentity")
        == binding[local_role]["workspaceIdentity"]
        and receipt.get("localEndpointRoot") == semantic_root(binding[local_role])
        and declared_receipt_root == semantic_root(receipt)
    )
    return {
        "schema": "kungfu.assignment-orchestration.cross-workspace-binding-receipt-verification/v1",
        "ok": ok,
        "bindingRoot": binding.get("bindingRoot"),
        "receiptRoot": declared_receipt_root,
        "localRole": local_role,
        "runtimeIndependent": True,
        "next_actions": [],
    }
