# SPDX-License-Identifier: Apache-2.0

"""Work Control facts, queries, authority, and Assignment lifecycle."""

import hashlib
import json
import re
import subprocess
import time
from collections.abc import Callable
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, TypeVar, cast

from kungfu import profile_composition, profile_sdk
from kungfu.canonical_json import canonical_json_text
from kungfu.storage import service as storage_service

CONTRACT_WORLD_ID = "kungfu.initiative-assignment"
CONTRACT_VERSION = "1"
INITIATIVE_SURFACE_ID = "kungfu.initiative-assignment.initiative"
ASSIGNMENT_SURFACE_ID = "kungfu.initiative-assignment.assignment"
CLAIM_SURFACE_ID = "kungfu.initiative-assignment.completion-claim"
# Assignment-graph events are a distinct record vocabulary on the existing
# append-only claim surface. Reusing that sealed v1 surface avoids silently
# changing the fact-surface register of the installed contract world.
RELATION_SURFACE_ID = CLAIM_SURFACE_ID
# Reviews and continuation decisions are versioned record kinds on the claim
# surface.
REVIEW_SURFACE_ID = CLAIM_SURFACE_ID
USER_FACT_SOURCE_ID = "kungfu-user"
AGENT_FACT_SOURCE_ID = "kungfu-agent"

_T = TypeVar("_T")
_BOUND_WORK_CONTROL_SOURCE: ContextVar[str] = ContextVar(
    "kungfu_work_control_profile_source", default=""
)

FACT_SURFACES = (INITIATIVE_SURFACE_ID, ASSIGNMENT_SURFACE_ID, CLAIM_SURFACE_ID)
PROGRESS_CLAIM = "initiative-progress-is-reasonable"
PROGRESS_PURPOSE = "operator-review"
COST_STATE_PROOF_PROFILE_ID = "kungfu.profile.delegated-work-cost-state-proof"
COST_STATE_PROOF_PROFILE_VERSION = "1"
WORK_CONTROL_PROFILE_ID = "kungfu.work-control"
WORK_CONTROL_PROFILE_VERSION = "4.0.0"
WORK_CONTROL_REDUCER = "kungfu.work-control.five-questions"
WORK_CONTROL_QUESTIONS = (
    ("initiative-intent", "What are we trying to achieve?"),
    ("observed-progress", "What actually happened?"),
    ("evidence-at-cut", "What does the evidence establish at this cut?"),
    (
        "fitness-for-purpose",
        "Is the delegated work still fit for the purpose that matters?",
    ),
    (
        "next-responsibility",
        "Who should continue, adjust, stop, approve, or supply evidence next?",
    ),
)
ATTRIBUTION_NAMES = {
    0: "exact-run",
    1: "exact-session",
    2: "observed-session-delta",
    3: "observed-window",
    4: "manual-estimate",
}
PROGRESS_POLICY: dict[str, Any] = {
    "id": "kungfu.work-control.reasonable-progress",
    "version": "1",
    "rules": {
        "requires_initiative": True,
        "requires_linked_assignment": True,
        "progress_statuses": [
            "active",
            "reviewing",
            "stage-ready",
            "ready",
            "completed",
            "merged",
        ],
        "warning_statuses": ["blocked", "paused", "waiting"],
        "completion_self_report_is_authority": False,
    },
}
COMPLETION_CLAIM = "task-completed"
COMPLETION_PURPOSE = "handoff"
INDEPENDENT_REVIEW = "independent-completion-review"
CONTINUATION_DECISION = "continuation-decision"
ASSIGNMENT_EXECUTION_CLAIM = "assignment-execution-claim"
ASSIGNMENT_PHASE_TRANSITION = "assignment-phase-transition"
ASSIGNMENT_RELATION_EVENT = "assignment-relation-event"
ASSIGNMENT_RELATION_EVENTS = (
    "delegation-offer",
    "destination-acceptance",
    "source-observation",
    "child-contribution",
    "parent-admission",
    "parent-assessment",
    "parent-decision",
)
ASSIGNMENT_PHASES = (
    "admitted",
    "claimed",
    "executing",
    "stage-ready",
    "completion-claimed",
    "independently-reviewed",
    "continuation-decided",
)
REVIEW_VERDICTS = {
    "fit",
    "partial",
    "insufficient",
    "conflicted",
    "stale",
    "unverifiable",
}
CONTINUATION_ACTIONS = {
    "approve",
    "adjust",
    "request-evidence",
    "reopen",
    "stop",
    "close",
    "create-follow-up",
}
ROOT_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_OBJECT_ID = re.compile(r"^[0-9a-f]{40}$")
COMPLETION_POLICY = {
    "id": "kungfu.work-control.task-completed",
    "version": "1",
    "rules": {
        "requires_completion_claim": True,
        "requires_verified_work_episode": True,
        "completion_self_report_is_authority": False,
        "missing_evidence_fails_closed": True,
    },
}
SURFACE_BY_KIND = {
    "initiative": INITIATIVE_SURFACE_ID,
    "assignment": ASSIGNMENT_SURFACE_ID,
}
SURFACE_AUTHORITIES = {
    INITIATIVE_SURFACE_ID: [USER_FACT_SOURCE_ID, AGENT_FACT_SOURCE_ID],
    ASSIGNMENT_SURFACE_ID: [USER_FACT_SOURCE_ID, AGENT_FACT_SOURCE_ID],
    RELATION_SURFACE_ID: [USER_FACT_SOURCE_ID, AGENT_FACT_SOURCE_ID],
    CLAIM_SURFACE_ID: [USER_FACT_SOURCE_ID, AGENT_FACT_SOURCE_ID],
}
STABLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def _record_schema(kind: str) -> dict[str, Any]:
    return {
        "$id": f"kungfu://initiative-assignment/{kind}/v1",
        "type": "object",
        "properties": {
            "record": {"type": "object"},
            "source": {
                "type": "object",
                "properties": {
                    "authority_mode": {"type": "string"},
                    "storage_source_id": {"type": "string"},
                    "kind": {"type": "string"},
                    "source_id": {"type": "string"},
                    "source_path": {"type": "string"},
                    "source_time": {"type": "string"},
                    "repo_head": {"type": "string"},
                    "import_id": {"type": "string"},
                    "import_episode_id": {"type": "string"},
                    "import_episode_root": {"type": "string"},
                    "payload_hash": {"type": "string"},
                    "actor": {"type": "string"},
                },
                "required": [
                    "authority_mode",
                    "source_id",
                    "source_time",
                    "payload_hash",
                ],
                "additionalProperties": False,
            },
            "links": {
                "type": "object",
                "properties": {
                    "initiative_id": {"type": "string"},
                    "assignment_id": {"type": "string"},
                },
                "additionalProperties": False,
            },
        },
        "required": ["record", "source", "links"],
        "additionalProperties": False,
    }


def capabilities() -> dict[str, Any]:
    """Describe the native Work Control vocabulary."""

    return {
        "schema": "kungfu.initiative-assignment.capabilities/v1",
        "profile": WORK_CONTROL_PROFILE_ID,
        "contractWorld": {
            "id": CONTRACT_WORLD_ID,
            "version": CONTRACT_VERSION,
        },
        "factSurfaces": {
            "initiative": INITIATIVE_SURFACE_ID,
            "assignment": ASSIGNMENT_SURFACE_ID,
            "relation": RELATION_SURFACE_ID,
            "completionClaim": CLAIM_SURFACE_ID,
        },
        "unchangedRoles": ["pursuit"],
    }


def _canonical_json(value: Any) -> str:
    return canonical_json_text(value)


def _sha256_root(value: Any) -> str:
    raw = value if isinstance(value, str) else _canonical_json(value)
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _source_time_nanos(value: Any, fallback: int) -> int:
    text = str(value or "").strip()
    if not text:
        return fallback
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return int(datetime.fromisoformat(text).timestamp() * 1_000_000_000)
    except ValueError:
        return fallback


def work_control_profile_source(runtime_dir: str) -> dict[str, Any]:
    bound = _BOUND_WORK_CONTROL_SOURCE.get()
    if bound:
        validated = profile_sdk.validate_source(bound, runtime_dir)
        return {
            "schema": "kungfu.profile-source-discovery/v1",
            "profileId": WORK_CONTROL_PROFILE_ID,
            "source": str(Path(bound).resolve()),
            "profileSuiteRoot": validated["inspection"]["profile_suite_root"],
            "memberRoots": validated["source"]["memberRoots"],
        }
    return profile_sdk.discover_source(WORK_CONTROL_PROFILE_ID, runtime_dir)


def _with_profile_source(source: str, operation: Callable[[], _T]) -> _T:
    """Keep one verified adapter invocation on its exact Suite source."""

    token = _BOUND_WORK_CONTROL_SOURCE.set(str(Path(source).resolve()))
    try:
        return operation()
    finally:
        _BOUND_WORK_CONTROL_SOURCE.reset(token)


_RETIRED_ATLAS_SOURCE = "atlas-adapter"
_RETIRED_ATLAS_SURFACES = {
    INITIATIVE_SURFACE_ID,
    ASSIGNMENT_SURFACE_ID,
}


def _retained_source_authority_compatibility(
    runtime_dir: str, error: profile_sdk.ProfileSdkError
) -> dict[str, Any]:
    """Recognize the exact pre-cutover Atlas writer as retained history only."""

    diagnosis = error.diagnosis
    if (
        diagnosis.get("code") != "fact-surface-authority-migration-required"
        or diagnosis.get("factSurface") not in _RETIRED_ATLAS_SURFACES
        or diagnosis.get("admittedSourceAuthorities") != [_RETIRED_ATLAS_SOURCE]
    ):
        raise error
    observed = {
        str(row.get("source_id") or "")
        for row in storage_service.fact_state(runtime_dir).get(
            "observation_history", []
        )
        if row.get("outcome") == "admitted"
        and row.get("fact_surface_id") in _RETIRED_ATLAS_SURFACES
    }
    allowed = {"kungfu-user", "kungfu-agent", _RETIRED_ATLAS_SOURCE}
    unexpected = sorted(observed - allowed)
    if unexpected or _RETIRED_ATLAS_SOURCE not in observed:
        raise profile_sdk.ProfileSdkError(
            "fact-surface-authority-migration-required",
            "Work Control found source-authority history outside its exact retained compatibility boundary",
            admittedSourceAuthorities=sorted(observed),
            unexpectedSourceAuthorities=unexpected,
        ) from error
    return {
        "schema": "kungfu.work-control.retained-source-authority/v1",
        "status": "retained-history-compatible",
        "operations": [],
        "retainedSourceAuthorities": [_RETIRED_ATLAS_SOURCE],
        "factSurfaces": sorted(_RETIRED_ATLAS_SURFACES),
        "writeAuthority": "kungfu-native",
        "migrationPerformed": False,
        "nonClaims": [
            "retained history does not restore the removed Atlas adapter",
            "compatibility is not a source-authority migration",
        ],
    }


def contract_materialization_plan(runtime_dir: str, source: str) -> dict[str, Any]:
    """Resolve the exact Work contract plan and its retained-history boundary."""

    try:
        return profile_composition.contract_materialization_plan(source, runtime_dir)
    except profile_sdk.ProfileSdkError as error:
        return _retained_source_authority_compatibility(runtime_dir, error)


def _profile_context(runtime_dir: str) -> dict[str, Any]:
    discovered = work_control_profile_source(runtime_dir)
    source = discovered["source"]
    composed = profile_composition.catalog(source, runtime_dir, require_active=True)
    materialization = contract_materialization_plan(runtime_dir, source)
    if materialization["operations"]:
        raise profile_sdk.ProfileSdkError(
            "profile-contract-not-materialized",
            "Work Control requires an approved Profile contract plan before facts can be read or written",
            profileId=WORK_CONTROL_PROFILE_ID,
            profileSuiteRoot=composed["profileSuiteRoot"],
            decisionCards=[materialization["decisionCard"]],
            contractPlan=materialization,
        )
    return {
        "source": source,
        "catalog": composed,
        "contractPlan": materialization,
    }


def _ensure_contract(runtime_dir: str, system_time: int = 0) -> dict[str, Any]:
    context = _profile_context(runtime_dir)
    return {
        "schema": "kungfu.work-control.profile-contract/v1",
        "status": context["contractPlan"].get("status", "current"),
        "profile_id": WORK_CONTROL_PROFILE_ID,
        "profile_suite_root": context["catalog"]["profileSuiteRoot"],
        "catalog_root": context["catalog"]["catalogRoot"],
        "source": context["source"],
        "retained_source_authorities": context["contractPlan"].get(
            "retainedSourceAuthorities", []
        ),
    }


def _episode_root(value: dict[str, Any]) -> str:
    recorded = value.get("recorded") or {}
    if value.get("match") is not True:
        return ""
    root = str(recorded.get("root_value") or "")
    if root and not root.startswith("sha256:"):
        root = "sha256:" + root
    return root


def _declaration_refs(runtime_dir: str, cut_system_time: int) -> tuple[dict, list]:
    catalog = storage_service.fact_type_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    worlds = [
        row
        for row in catalog.get("contract_worlds", [])
        if row.get("id") == CONTRACT_WORLD_ID and row.get("version") == CONTRACT_VERSION
    ]
    if len(worlds) != 1:
        raise RuntimeError("Work Control contract world is not materialized")
    surfaces = []
    for surface_id in FACT_SURFACES:
        matches = [
            row
            for row in catalog.get("fact_types", [])
            if row.get("id") == surface_id and row.get("version") == CONTRACT_VERSION
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"Work Control fact surface is not materialized: {surface_id}"
            )
        surfaces.append(
            {
                "id": matches[0]["id"],
                "version": matches[0]["version"],
                "root": matches[0]["root"],
            }
        )
    world = {
        "id": worlds[0]["id"],
        "version": worlds[0]["version"],
        "root": worlds[0]["root"],
    }
    return world, surfaces


def _selected_subjects(
    runtime_dir: str,
    *,
    initiative_id: str,
    storage_source_id: str,
    cut_system_time: int,
) -> tuple[str, list[str], dict[str, Any]]:
    materials = storage_service.fact_material_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    payloads = materials.get("payloads", {})
    requested_subjects = (
        {initiative_id}
        if ":" in initiative_id
        else {f"{storage_source_id}:{initiative_id}", f"kungfu:{initiative_id}"}
    )
    canonical_facts = materials.get("state", {}).get("canonical_facts", [])
    admitted_subjects = {
        str(row.get("subject_key") or "")
        for row in canonical_facts
        if row.get("fact_surface_id") == INITIATIVE_SURFACE_ID
        and row.get("subject_key") in requested_subjects
    }
    if not admitted_subjects:
        external_subjects = {
            str(
                (payloads.get(str(row.get("payload_hash") or "")) or {})
                .get("links", {})
                .get("initiative_id")
                or ""
            )
            for row in canonical_facts
            if row.get("fact_surface_id") == ASSIGNMENT_SURFACE_ID
        }
        admitted_subjects = external_subjects & requested_subjects
    if not admitted_subjects:
        raise ValueError(
            f"admitted or externally referenced Initiative not found: {initiative_id}"
        )
    if len(admitted_subjects) > 1:
        raise ValueError(
            f"Initiative id is ambiguous across source authorities: {initiative_id}"
        )
    initiative_subject = next(iter(admitted_subjects))
    selected = {initiative_subject}
    for row in canonical_facts:
        payload = payloads.get(str(row.get("payload_hash") or ""), {})
        if row.get("fact_surface_id") == INITIATIVE_SURFACE_ID:
            continue
        if (
            row.get("fact_surface_id") == ASSIGNMENT_SURFACE_ID
            and payload.get("links", {}).get("initiative_id") == initiative_subject
        ):
            selected.add(str(row["subject_key"]))
        if (
            row.get("fact_surface_id") == CLAIM_SURFACE_ID
            and payload.get("links", {}).get("initiative_id") == initiative_subject
        ):
            selected.add(str(row["subject_key"]))
    return initiative_subject, sorted(selected), materials


def build_state_query(
    runtime_dir: str,
    *,
    initiative_id: str,
    storage_source_id: str = "kungfu",
    cut_system_time: int = 0,
    limit: int = 256,
) -> dict[str, Any]:
    """Build the KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104 query shared by CLI, API, and GUI."""

    _ensure_contract(runtime_dir)
    initiative_subject, subjects, _ = _selected_subjects(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
        cut_system_time=cut_system_time,
    )
    world, surfaces = _declaration_refs(runtime_dir, cut_system_time)
    cut = (
        {"kind": "system_time", "system_time": str(cut_system_time)}
        if cut_system_time
        else {"kind": "head"}
    )
    return {
        "schema": "kungfu.query.definition/v1",
        "basis": {
            "contract_world": world,
            "fact_surfaces": surfaces,
            "scope": "domain-fact-ledger",
            "perspective": "system-time-then-observation-id",
            "cut": cut,
            "policy": {
                "fold": "latest-admitted-per-source/v1",
                "schema": "kungfu.facts.domain-fact-event/v1",
                "engine": "fact-authority-scan/v1",
                "conflict": "preserve-source-claims/v1",
                "redaction": "hash-and-ref/v1",
            },
            "time_basis": {
                "valid_time": "explicit",
                "system_time": "event",
                "causal_time": "event-parent",
            },
        },
        "object": "fact-state",
        "subject_keys": subjects,
        "limit": max(limit, len(subjects)),
        "evidence": "proof",
        "work_control": {
            "initiative_subject": initiative_subject,
            "initiative_id": initiative_id,
            "storage_source_id": storage_source_id,
            "cut_system_time": cut_system_time,
            "selection": "admitted-payload-links/v1",
        },
    }


def _runtime_query_definition(definition: dict[str, Any]) -> dict[str, Any]:
    query = dict(definition)
    query.pop("work_control", None)
    return query


def _batched_state_query(
    runtime_dir: str, definition: dict[str, Any]
) -> dict[str, Any]:
    """Run one logical Initiative query through bounded fact-state subqueries."""

    context = _profile_context(runtime_dir)
    subjects = list(definition["subject_keys"])
    results = []
    receipts = []
    for offset in range(0, len(subjects), 256):
        query = _runtime_query_definition(definition)
        query["subject_keys"] = subjects[offset : offset + 256]
        requested_limit = int(definition.get("limit") or 0)
        query["limit"] = max(requested_limit, len(query["subject_keys"]))
        resolution = {
            "schema": "kungfu.profile-query-resolution/v1",
            "familyId": "initiative-state-at-cut",
            "bindings": {
                "initiativeId": definition["work_control"]["initiative_id"],
                "storageSourceId": definition["work_control"]["storage_source_id"],
                **(
                    {"cutSystemTime": definition["work_control"]["cut_system_time"]}
                    if definition["work_control"]["cut_system_time"]
                    else {}
                ),
            },
            "definition": query,
        }
        plan = profile_composition.resolved_query_plan(
            context["source"], runtime_dir, "initiative-state", resolution
        )
        receipt = profile_composition.execute_query(
            context["source"], runtime_dir, plan
        )
        results.append(receipt["result"])
        receipts.append(receipt)
    if len(results) == 1:
        composed_receipt = profile_composition.compose_query_receipt(
            context["source"], runtime_dir, "initiative-state", receipts, results[0]
        )
        return {
            **results[0],
            "profile_query_receipt": composed_receipt,
            "profile_suite_root": context["catalog"]["profileSuiteRoot"],
            "catalog_root": context["catalog"]["catalogRoot"],
        }

    def merged_rows(key: str) -> list[dict[str, Any]]:
        by_value = {}
        for result in results:
            for row in result.get("lineage", {}).get(key, []):
                by_value[_canonical_json(row)] = row
        return [by_value[key] for key in sorted(by_value)]

    admission_counts: dict[str, int] = {}
    for result in results:
        for row in result.get("lineage", {}).get("admission_outcomes", []):
            outcome = str(row.get("outcome") or "unverifiable")
            admission_counts[outcome] = admission_counts.get(outcome, 0) + int(
                row.get("record_count") or 0
            )
    subqueries = [
        {
            "query_definition_root": result["query_definition_root"],
            "query_proof_root": result["query_proof_root"],
            "result_hash": result["result_hash"],
        }
        for result in results
    ]
    composite_definition = {
        "schema": "kungfu.work-control.batched-state-query/v1",
        "basis": definition["basis"],
        "object": definition["object"],
        "subject_keys": subjects,
        "evidence": definition["evidence"],
        "work_control": {
            **definition["work_control"],
            "batch_size": 256,
            "subqueries": subqueries,
        },
    }
    rows = [row for result in results for row in result.get("rows", [])]
    rows.sort(
        key=lambda row: (
            str(row.get("subject_key") or ""),
            str(row.get("fact_surface_id") or ""),
            str(row.get("source_id") or ""),
        )
    )
    lineage = {
        **results[0]["lineage"],
        "canonical_state": all(
            bool(result.get("lineage", {}).get("canonical_state")) for result in results
        ),
        "episode_content_roots": merged_rows("episode_content_roots"),
        "conflicts": merged_rows("conflicts"),
        "unverifiable_inputs": merged_rows("unverifiable_inputs"),
        "admission_outcomes": [
            {"outcome": outcome, "record_count": admission_counts[outcome]}
            for outcome in sorted(admission_counts)
        ],
        "subqueries": subqueries,
    }
    query_definition_root = _sha256_root(composite_definition)
    result_hash = _sha256_root(
        {"query_definition_root": query_definition_root, "subqueries": subqueries}
    )
    composite_result = {
        "definition": composite_definition,
        "logical_plan": {
            "engine": "work-control-batched-fact-state/v1",
            "batch_size": 256,
            "subquery_count": len(results),
        },
        "query_definition_root": query_definition_root,
        "query_proof_root": _sha256_root(
            {
                "query_definition_root": query_definition_root,
                "result_hash": result_hash,
                "subqueries": subqueries,
            }
        ),
        "result_hash": result_hash,
        "row_count": len(rows),
        "rows": rows,
        "lineage": lineage,
    }
    composed_receipt = profile_composition.compose_query_receipt(
        context["source"], runtime_dir, "initiative-state", receipts, composite_result
    )
    return {
        **composite_result,
        "profile_query_receipt": composed_receipt,
        "profile_suite_root": context["catalog"]["profileSuiteRoot"],
        "catalog_root": context["catalog"]["catalogRoot"],
    }


def query_state(
    runtime_dir: str,
    *,
    initiative_id: str,
    storage_source_id: str = "kungfu",
    cut_system_time: int = 0,
) -> dict[str, Any]:
    """Return one proof-bearing Initiative/Assignment state."""

    definition = build_state_query(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
        cut_system_time=cut_system_time,
    )
    result = _batched_state_query(runtime_dir, definition)
    materials = storage_service.fact_material_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    payloads = materials.get("payloads", {})
    rows = []
    initiative = None
    assignments = []
    claims = []
    reviews = []
    for row in result.get("rows", []):
        body = payloads.get(str(row.get("payload_hash") or ""))
        resolved = {**row, "payload": body}
        rows.append(resolved)
        if row.get("fact_surface_id") == INITIATIVE_SURFACE_ID:
            initiative = resolved
        elif row.get("fact_surface_id") == ASSIGNMENT_SURFACE_ID:
            assignments.append(resolved)
        elif row.get("fact_surface_id") == CLAIM_SURFACE_ID:
            record = (body or {}).get("record", {})
            if record.get("review_type") in {
                INDEPENDENT_REVIEW,
                CONTINUATION_DECISION,
            }:
                reviews.append(resolved)
            else:
                claims.append(resolved)
    assignments.sort(key=lambda row: str(row.get("subject_key") or ""))
    claims.sort(key=lambda row: str(row.get("subject_key") or ""))
    reviews.sort(key=lambda row: str(row.get("subject_key") or ""))
    return {
        "schema": "kungfu.work-control.state/v1",
        "authority_mode": "kungfu-native",
        "initiative_subject": definition["work_control"]["initiative_subject"],
        "definition": result["definition"],
        "logical_plan": result["logical_plan"],
        "query_definition_root": result["query_definition_root"],
        "query_proof_root": result["query_proof_root"],
        "result_hash": result["result_hash"],
        "profile_suite_root": result["profile_suite_root"],
        "catalog_root": result["catalog_root"],
        "profile_query_receipt": result["profile_query_receipt"],
        "cut": result["lineage"]["cut"],
        "canonical_state": result["lineage"]["canonical_state"],
        "lineage": result["lineage"],
        "initiative": initiative,
        "assignments": assignments,
        "claims": claims,
        "reviews": reviews,
        "rows": rows,
    }


def _native_source(actor_type: str) -> str:
    if actor_type == "user":
        return USER_FACT_SOURCE_ID
    if actor_type == "agent":
        return AGENT_FACT_SOURCE_ID
    raise ValueError("actor_type must be user or agent")


def _stable_id(value: str, field: str) -> str:
    value = value.strip()
    if not STABLE_ID.fullmatch(value):
        raise ValueError(
            f"{field} must be 1..128 stable identifier characters "
            "(letters, digits, dot, underscore, colon, or hyphen)"
        )
    return value


def _native_observation_id(
    kind: str, subject_key: str, source_id: str, payload: dict[str, Any]
) -> str:
    digest = _sha256_root(
        {
            "kind": kind,
            "subject_key": subject_key,
            "source_id": source_id,
            "payload": payload,
        }
    )
    return f"work-control-{kind}-{digest[7:31]}"


def _put_native_fact(
    runtime_dir: str,
    *,
    kind: str,
    surface_id: str,
    subject_key: str,
    source_id: str,
    payload: dict[str, Any],
    system_time: int,
) -> dict[str, Any]:
    observation_id = _native_observation_id(kind, subject_key, source_id, payload)
    state = storage_service.fact_state(runtime_dir)
    existing = next(
        (
            row
            for row in state.get("observation_history", [])
            if str(row.get("observation_id") or "") == observation_id
        ),
        None,
    )
    if existing is not None:
        return {
            "schema": "kungfu.initiative-assignment.write-receipt/v1",
            "status": "already-present",
            "reused": True,
            "observation_id": observation_id,
            "subject_key": subject_key,
            "episode_id": str(existing.get("episode_id") or ""),
            "payload_hash": str(existing.get("payload_hash") or ""),
        }
    written = storage_service.fact_material_put(
        runtime_dir,
        {
            "type_id": surface_id,
            "type_version": CONTRACT_VERSION,
            "source_id": source_id,
            "subject_key": subject_key,
            "payload": payload,
            "observation_id": observation_id,
            "action": "assert",
            "valid_from": system_time,
            "valid_until": 0,
        },
        system_time=system_time,
    )
    return {
        "schema": "kungfu.initiative-assignment.write-receipt/v1",
        "status": written["receipt"]["admission"]["outcome"],
        "reused": False,
        "observation_id": observation_id,
        "subject_key": subject_key,
        "episode_id": str(written["receipt"]["episode_id"]),
        "payload_hash": written["payload_hash"],
    }


def list_domain_records(
    runtime_dir: str,
    *,
    surface_ids: set[str],
    cut_system_time: int = 0,
) -> list[dict[str, Any]]:
    """List native Work Control records without rewriting evidence."""

    materials = storage_service.fact_material_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    declarations = storage_service.fact_type_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    fact_types = list(declarations.get("fact_types", []))

    def sealed_type_version(row: dict[str, Any]) -> str:
        observation_time = int(row.get("system_time") or 0)
        candidates = {
            str(declaration.get("version") or "")
            for declaration in fact_types
            if str(declaration.get("id") or "") == str(row.get("fact_surface_id") or "")
            and str(declaration.get("contract_world", {}).get("id") or "")
            == str(row.get("contract_world_id") or "")
            and str(declaration.get("schema_owner_root") or "")
            == str(row.get("schema_owner_root") or "")
            and observation_time >= int(declaration.get("effective_from") or 0)
            and (
                int(declaration.get("effective_until") or 0) == 0
                or observation_time < int(declaration.get("effective_until") or 0)
            )
        }
        return next(iter(candidates)) if len(candidates) == 1 else ""

    payloads = materials.get("payloads", {})
    records = []
    for row in materials.get("state", {}).get("canonical_facts", []):
        surface_id = str(row.get("fact_surface_id") or "")
        if surface_id not in surface_ids:
            continue
        payload = payloads.get(str(row.get("payload_hash") or ""), {})
        record = dict(payload.get("record") or {})
        if not record:
            continue
        record["subject_key"] = str(row.get("subject_key") or "")
        record["source_authority"] = str(row.get("source_id") or "")
        record["authority_mode"] = str(
            payload.get("source", {}).get("authority_mode") or "unknown"
        )
        record["sealed_identity"] = {
            "contract_world_id": str(row.get("contract_world_id") or ""),
            "fact_surface_id": surface_id,
            "type_version": sealed_type_version(row),
            "observation_id": str(row.get("observation_id") or ""),
            "payload_hash": str(row.get("payload_hash") or ""),
            "source_id": str(row.get("source_id") or ""),
            "subject_key": str(row.get("subject_key") or ""),
        }
        records.append(record)
    identity_key = (
        "initiative_id" if INITIATIVE_SURFACE_ID in surface_ids else "assignment_id"
    )
    records.sort(key=lambda record: str(record.get(identity_key) or ""))
    return records


def list_initiatives(
    runtime_dir: str, *, cut_system_time: int = 0
) -> list[dict[str, Any]]:
    return list_domain_records(
        runtime_dir,
        surface_ids={INITIATIVE_SURFACE_ID},
        cut_system_time=cut_system_time,
    )


def list_assignments(
    runtime_dir: str, *, cut_system_time: int = 0
) -> list[dict[str, Any]]:
    return list_domain_records(
        runtime_dir,
        surface_ids={ASSIGNMENT_SURFACE_ID},
        cut_system_time=cut_system_time,
    )


def _root_id(value: str, field: str, *, required: bool = False) -> str:
    value = value.strip()
    if not value and not required:
        return ""
    if not ROOT_ID.fullmatch(value):
        raise ValueError(f"{field} must be a sha256 content root")
    return value


def authority_status(runtime_dir: str) -> dict[str, Any]:
    """Return the native Work Control write authority."""

    del runtime_dir
    return {
        "schema": "kungfu.work-control.authority-status/v1",
        "state": "native-only",
        "write_authority": "kungfu-native",
        "transition_count": 0,
    }


def _ensure_native_write_allowed(runtime_dir: str) -> None:
    del runtime_dir


def create_initiative(
    runtime_dir: str,
    *,
    initiative_id: str,
    title: str,
    intent: str,
    actor: str,
    actor_type: str = "agent",
    status: str = "active",
    horizon: str = "long-term",
    source_identity: dict[str, Any] | None = None,
    system_time: int = 0,
) -> dict[str, Any]:
    """Create one Kungfu-native Initiative in the shared Fact Library."""

    _ensure_native_write_allowed(runtime_dir)
    system_time = system_time or time.time_ns()
    _ensure_contract(runtime_dir, system_time)
    system_time += len(FACT_SURFACES) + 1
    initiative_id = _stable_id(initiative_id, "initiative_id")
    existing = [
        row
        for row in list_initiatives(runtime_dir)
        if row.get("initiative_id") == initiative_id
    ]
    if any(row.get("subject_key") != f"kungfu:{initiative_id}" for row in existing):
        raise ValueError(
            f"initiative_id already belongs to another source authority: {initiative_id}"
        )
    if status not in {"proposed", "active", "paused"}:
        raise ValueError("native Initiative status must be proposed, active, or paused")
    source_id = _native_source(actor_type)
    record: dict[str, Any] = {
        "initiative_id": initiative_id,
        "title": title.strip(),
        "intent": intent.strip(),
        "status": status,
        "horizon": horizon.strip() or "long-term",
        "owner": actor.strip(),
        "actor_type": actor_type,
    }
    if not record["title"] or not record["intent"] or not record["owner"]:
        raise ValueError("title, intent, and actor are required")
    from . import native_state

    source_identity = native_state.validate_source_identity(
        source_identity, initiative_id
    )
    if source_identity:
        record["source_identity"] = source_identity
    subject_key = f"kungfu:{initiative_id}"
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": record["owner"],
        },
        "links": {"initiative_id": subject_key},
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="initiative",
        surface_id=INITIATIVE_SURFACE_ID,
        subject_key=subject_key,
        source_id=source_id,
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.initiative-assignment.initiative-write/v1",
        "authority_mode": "kungfu-native",
        "initiative_subject": subject_key,
        "receipt": receipt,
    }


def _local_work_ref(
    runtime_dir: str,
    *,
    workspace_identity_root: str,
    object_kind: str,
    object_id: str,
    records: list[dict[str, Any]],
    cut_root: str,
) -> dict[str, Any]:
    from kungfu.workspace_federation import WorkRef

    identity_field = "initiative_id" if object_kind == "initiative" else "assignment_id"
    matches = [
        row
        for row in records
        if str(row.get(identity_field) or row.get("assignment_id") or "") == object_id
    ]
    if len(matches) != 1:
        raise ValueError(
            f"local {object_kind} shorthand must resolve exactly once: {object_id}"
        )
    sealed = matches[0].get("sealed_identity") or {}
    return WorkRef(
        workspace_identity_root=_root_id(
            workspace_identity_root,
            "owning_workspace_identity_root",
            required=True,
        ),
        object_kind=object_kind,  # type: ignore[arg-type]
        subject=str(sealed.get("subject_key") or ""),
        version_root=_root_id(
            str(sealed.get("payload_hash") or ""),
            f"{object_kind}_version_root",
            required=True,
        ),
        cut_root=_root_id(cut_root, "workspace_cut_root", required=True),
    ).as_dict()


def _validated_work_ref(
    value: dict[str, Any] | None,
    *,
    object_kind: str,
    field: str,
) -> dict[str, Any]:
    from kungfu.workspace_federation import parse_work_ref

    if not value:
        return {}
    reference = parse_work_ref(value)
    if reference.object_kind != object_kind:
        raise ValueError(f"{field} must reference an {object_kind}")
    return reference.as_dict()


def create_assignment(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    title: str,
    objective: str,
    actor: str,
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    status: str = "active",
    parent_assignment_id: str = "",
    depends_on: list[str] | None = None,
    owning_workspace_identity_root: str = "",
    initiative_ref: dict[str, Any] | None = None,
    parent_assignment_ref: dict[str, Any] | None = None,
    dependency_refs: list[dict[str, Any]] | None = None,
    responsibility: str = "",
    acceptance_root: str = "",
    context_root: str = "",
    context_binding: dict[str, Any] | None = None,
    project_cut_root: str = "",
    evidence_episode_roots: list[str] | None = None,
    request_root: str = "",
    capture_receipt_roots: list[str] | None = None,
    work_definition: dict[str, Any] | None = None,
    system_time: int = 0,
) -> dict[str, Any]:
    """Create one Kungfu-native Assignment linked to an admitted Initiative."""

    _ensure_native_write_allowed(runtime_dir)
    system_time = system_time or time.time_ns()
    _ensure_contract(runtime_dir, system_time)
    explicit_initiative_ref = _validated_work_ref(
        initiative_ref,
        object_kind="initiative",
        field="initiative_ref",
    )
    if explicit_initiative_ref:
        initiative_subject = str(explicit_initiative_ref["subject"])
        declared_initiative_id = initiative_subject.split(":", 1)[-1]
        if declared_initiative_id != _stable_id(initiative_id, "initiative_id"):
            raise ValueError("initiative_ref subject does not match initiative_id")
        state_for_refs: dict[str, Any] = {}
    else:
        initiative_subject, _, _ = _selected_subjects(
            runtime_dir,
            initiative_id=initiative_id,
            storage_source_id=storage_source_id,
            cut_system_time=0,
        )
        state_for_refs = query_state(
            runtime_dir,
            initiative_id=initiative_id,
            storage_source_id=storage_source_id,
        )
    assignment_id = _stable_id(assignment_id, "assignment_id")
    existing_assignments = list_assignments(runtime_dir)
    conflicting = [
        row
        for row in existing_assignments
        if row.get("payload", {}).get("record", {}).get("assignment_id")
        == assignment_id
        and row.get("subject_key") != f"kungfu:{assignment_id}"
    ]
    if conflicting:
        raise ValueError(
            f"assignment_id already belongs to another source authority: {assignment_id}"
        )
    if status not in {"proposed", "active", "blocked", "waiting-for-decision"}:
        raise ValueError(
            "native Assignment status is not in the v1 responsibility vocabulary"
        )
    parent_assignment_id = (
        _stable_id(parent_assignment_id, "parent_assignment_id")
        if parent_assignment_id.strip()
        else ""
    )
    dependencies = sorted(
        {_stable_id(str(dependency), "depends_on") for dependency in (depends_on or [])}
    )
    if assignment_id in dependencies:
        raise ValueError("an Assignment cannot depend on itself")
    owning_workspace_identity_root = _root_id(
        owning_workspace_identity_root,
        "owning_workspace_identity_root",
    )
    if (parent_assignment_id or dependencies) and not owning_workspace_identity_root:
        raise ValueError(
            "local parent/dependency shorthand requires owning_workspace_identity_root"
        )
    workspace_cut_root = str(
        state_for_refs.get("query_proof_root")
        or _sha256_root(
            {
                "schema": "kungfu.assignment-graph.local-cut/v1",
                "assignment_versions": sorted(
                    str(row.get("sealed_identity", {}).get("payload_hash") or "")
                    for row in existing_assignments
                ),
            }
        )
    )
    local_initiative_ref = explicit_initiative_ref
    if not local_initiative_ref and owning_workspace_identity_root:
        local_initiative_ref = _local_work_ref(
            runtime_dir,
            workspace_identity_root=owning_workspace_identity_root,
            object_kind="initiative",
            object_id=_stable_id(initiative_id, "initiative_id"),
            records=list_initiatives(runtime_dir),
            cut_root=workspace_cut_root,
        )
    explicit_parent_ref = _validated_work_ref(
        parent_assignment_ref,
        object_kind="assignment",
        field="parent_assignment_ref",
    )
    if parent_assignment_id and explicit_parent_ref:
        raise ValueError(
            "pass parent_assignment_id shorthand or parent_assignment_ref, not both"
        )
    resolved_parent_ref = explicit_parent_ref
    if parent_assignment_id:
        resolved_parent_ref = _local_work_ref(
            runtime_dir,
            workspace_identity_root=owning_workspace_identity_root,
            object_kind="assignment",
            object_id=parent_assignment_id,
            records=existing_assignments,
            cut_root=workspace_cut_root,
        )
    resolved_dependency_refs = [
        _validated_work_ref(
            dict(value),
            object_kind="assignment",
            field="dependency_refs",
        )
        for value in (dependency_refs or [])
    ]
    if dependencies and resolved_dependency_refs:
        raise ValueError("pass depends_on shorthand or dependency_refs, not both")
    unresolved_dependency_ids: list[str] = []
    if dependencies:
        for dependency in dependencies:
            matches = [
                row
                for row in existing_assignments
                if str(row.get("assignment_id") or row.get("assignment_id") or "")
                == dependency
            ]
            if len(matches) > 1:
                raise ValueError(
                    f"local assignment shorthand resolves more than once: {dependency}"
                )
            if not matches:
                unresolved_dependency_ids.append(dependency)
                continue
            resolved_dependency_refs.append(
                _local_work_ref(
                    runtime_dir,
                    workspace_identity_root=owning_workspace_identity_root,
                    object_kind="assignment",
                    object_id=dependency,
                    records=matches,
                    cut_root=workspace_cut_root,
                )
            )
    dependency_keys = {
        (
            row["workspace_identity_root"],
            row["object_kind"],
            row["subject"],
        )
        for row in resolved_dependency_refs
    }
    if len(dependency_keys) != len(resolved_dependency_refs):
        raise ValueError("dependency_refs must be unique")
    acceptance_root = _root_id(acceptance_root, "acceptance_root")
    context_root = _root_id(context_root, "context_root")
    context_binding = dict(context_binding or {})
    if context_binding:
        required_context_fields = {
            "schema",
            "status",
            "context_root",
            "cut_root",
            "route_id",
            "route_root",
            "authority_root",
            "task_envelope_root",
            "route_receipt_root",
            "chart_root",
            "policy_root",
            "omissions_root",
            "budget",
        }
        if set(context_binding) != required_context_fields:
            raise ValueError("context_binding must contain the exact v1 field set")
        if (
            context_binding.get("schema") != "xinfa.go-context-binding/v1"
            or context_binding.get("status") != "complete"
        ):
            raise ValueError("context_binding must be a complete Xinfa v1 binding")
        for field in (
            "context_root",
            "cut_root",
            "route_root",
            "authority_root",
            "task_envelope_root",
            "route_receipt_root",
            "chart_root",
            "policy_root",
            "omissions_root",
        ):
            context_binding[field] = _root_id(
                str(context_binding.get(field) or ""),
                f"context_binding.{field}",
                required=True,
            )
        if context_binding["context_root"] != context_root:
            raise ValueError("context_binding.context_root must equal context_root")
        if not str(context_binding.get("route_id") or "").strip():
            raise ValueError("context_binding.route_id is required")
        budget = context_binding.get("budget")
        if not isinstance(budget, int) or isinstance(budget, bool) or budget <= 0:
            raise ValueError("context_binding.budget must be a positive integer")
    project_cut_root = _root_id(project_cut_root, "project_cut_root")
    episode_roots = sorted(
        {
            _root_id(str(root), "evidence_episode_root", required=True)
            for root in (evidence_episode_roots or [])
        }
    )
    request_root = _root_id(request_root, "request_root")
    capture_roots = sorted(
        {
            _root_id(str(root), "capture_receipt_root", required=True)
            for root in (capture_receipt_roots or [])
        }
    )
    work_definition = dict(work_definition or {})
    source_id = _native_source(actor_type)
    subject_key = f"kungfu:{assignment_id}"
    record = {
        "assignment_id": assignment_id,
        "title": title.strip(),
        "objective": objective.strip(),
        "status": status,
        "initiative_id": initiative_subject.split(":", 1)[-1],
        "initiative_subject": initiative_subject,
        "initiative_ref": local_initiative_ref,
        "owning_workspace_identity_root": owning_workspace_identity_root,
        "actor": actor.strip(),
        "actor_type": actor_type,
        "parent_assignment_id": "",
        "parent_assignment_ref": resolved_parent_ref,
        "depends_on": [],
        "unresolved_dependency_ids": unresolved_dependency_ids,
        "dependency_refs": sorted(
            resolved_dependency_refs,
            key=lambda row: (
                row["workspace_identity_root"],
                row["subject"],
                row["version_root"],
            ),
        ),
        "responsibility": responsibility.strip() or actor.strip(),
        "acceptance_root": acceptance_root,
        "input_context_root": context_root,
        "context_binding": context_binding,
        "context_binding_root": _sha256_root(context_binding)
        if context_binding
        else "",
        "project_cut_root": project_cut_root,
        "evidence_episode_roots": episode_roots,
        "request_root": request_root,
        "capture_receipt_roots": capture_roots,
        "work_definition": work_definition,
        "work_definition_root": _sha256_root(work_definition)
        if work_definition
        else "",
        "orchestration_phase": "admitted",
    }
    if not record["title"] or not record["objective"] or not record["actor"]:
        raise ValueError("title, objective, and actor are required")
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": record["actor"],
        },
        "links": {"initiative_id": initiative_subject},
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="assignment",
        surface_id=ASSIGNMENT_SURFACE_ID,
        subject_key=subject_key,
        source_id=source_id,
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.initiative-assignment.assignment-write/v1",
        "authority_mode": "kungfu-native",
        "initiative_subject": initiative_subject,
        "assignment_subject": subject_key,
        "receipt": receipt,
    }


def list_assignment_relation_events(
    runtime_dir: str,
    *,
    cut_system_time: int = 0,
) -> list[dict[str, Any]]:
    """List domain relation events without projecting them as Assignments."""

    return [
        record
        for record in list_domain_records(
            runtime_dir,
            surface_ids={RELATION_SURFACE_ID},
            cut_system_time=cut_system_time,
        )
        if record.get("claim_type") == ASSIGNMENT_RELATION_EVENT
    ]


def assignment_relations(
    runtime_dir: str,
    *,
    cut_system_time: int = 0,
) -> list[dict[str, Any]]:
    """Return unique verified relation bodies observed in this workspace."""

    from kungfu.workspace_federation import build_relation

    relations: dict[str, dict[str, Any]] = {}
    for event in list_assignment_relation_events(
        runtime_dir, cut_system_time=cut_system_time
    ):
        relation = event.get("relation")
        if not isinstance(relation, dict):
            continue
        verified = build_relation(
            str(relation.get("relation_type") or ""),
            relation.get("source") or {},
            relation.get("target") or {},
            evidence_roots=relation.get("evidence_roots") or [],
            state=cast(
                Literal["proposed", "accepted", "revoked"],
                str(relation.get("state") or "accepted"),
            ),
        )
        if verified["relation_root"] != relation.get("relation_root"):
            raise ValueError("stored Assignment relation root does not verify")
        relations[verified["relation_root"]] = verified
    return [relations[root] for root in sorted(relations)]


def append_assignment_relation_event(
    runtime_dir: str,
    *,
    workspace_identity_root: str,
    relation: dict[str, Any],
    event_type: str,
    actor: str,
    predecessor_event_roots: list[str] | None = None,
    evidence_roots: list[str] | None = None,
    known_relations: list[dict[str, Any]] | None = None,
    actor_type: str = "agent",
    system_time: int = 0,
) -> dict[str, Any]:
    """Append one independently retryable cross-workspace relation fact."""

    from kungfu.workspace_federation import (
        build_relation,
        parse_work_ref,
        qualify_assignment_graph,
    )

    _ensure_native_write_allowed(runtime_dir)
    _ensure_contract(runtime_dir, system_time or time.time_ns())
    workspace_identity_root = _root_id(
        workspace_identity_root,
        "workspace_identity_root",
        required=True,
    )
    if event_type not in ASSIGNMENT_RELATION_EVENTS:
        raise ValueError("unknown Assignment relation event type")
    actor = actor.strip()
    if not actor:
        raise ValueError("relation event actor is required")
    verified = build_relation(
        str(relation.get("relation_type") or ""),
        relation.get("source") or {},
        relation.get("target") or {},
        evidence_roots=relation.get("evidence_roots") or [],
        state=cast(
            Literal["proposed", "accepted", "revoked"],
            str(relation.get("state") or "accepted"),
        ),
    )
    if verified["relation_root"] != relation.get("relation_root"):
        raise ValueError("Assignment relation root does not verify")
    source = parse_work_ref(verified["source"])
    target = parse_work_ref(verified["target"])
    source_events = {
        "delegation-offer",
        "source-observation",
        "parent-admission",
        "parent-assessment",
        "parent-decision",
    }
    local = source if event_type in source_events else target
    if local.workspace_identity_root != workspace_identity_root:
        raise ValueError("relation event is routed to the wrong owning workspace")
    predecessor_roots = sorted(
        {
            _root_id(str(root), "predecessor_event_root", required=True)
            for root in (predecessor_event_roots or [])
        }
    )
    required_predecessor = {
        "destination-acceptance",
        "source-observation",
        "child-contribution",
        "parent-admission",
        "parent-assessment",
        "parent-decision",
    }
    if event_type in required_predecessor and not predecessor_roots:
        raise ValueError(f"{event_type} requires a predecessor event root")
    event_evidence = sorted(
        {
            _root_id(str(root), "relation_event_evidence_root", required=True)
            for root in (evidence_roots or [])
        }
    )
    if event_type == "delegation-offer":
        graph_relations = {
            str(row.get("relation_root") or ""): row
            for row in (known_relations or assignment_relations(runtime_dir))
        }
        graph_relations[verified["relation_root"]] = verified
        qualification = qualify_assignment_graph(
            [graph_relations[root] for root in sorted(graph_relations)]
        )
        if not qualification["ok"]:
            issue = qualification["issues"][0]
            raise ValueError(
                f"Assignment relation qualification failed: {issue['code']}"
            )
    else:
        qualification = qualify_assignment_graph([verified])
        if not qualification["ok"]:
            raise ValueError("Assignment relation does not qualify")
    relation_qualification = qualify_assignment_graph([verified])
    if not relation_qualification["ok"]:
        raise ValueError("Assignment relation does not qualify")
    basis = {
        "claim_type": ASSIGNMENT_RELATION_EVENT,
        "event_type": event_type,
        "workspace_identity_root": workspace_identity_root,
        "relation_root": verified["relation_root"],
        "predecessor_event_roots": predecessor_roots,
        "evidence_roots": event_evidence,
        "actor": actor,
    }
    event_root = _sha256_root(basis)
    record = {
        **basis,
        "event_root": event_root,
        "relation": verified,
        # Persist only the stable qualification of this relation. The broader
        # graph qualification can evolve as other relations become visible and
        # therefore belongs in the write receipt, not in retry identity.
        "qualification_root": relation_qualification["qualification_root"],
    }
    source_id = _native_source(actor_type)
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": actor,
        },
        "links": {
            "assignment_id": local.subject,
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="assignment-relation",
        surface_id=RELATION_SURFACE_ID,
        subject_key=f"kungfu:assignment-relation:{event_root[7:]}",
        source_id=source_id,
        payload=payload,
        system_time=system_time or time.time_ns(),
    )
    return {
        "schema": "kungfu.assignment-graph.event-write/v1",
        "event": record,
        "receipt": receipt,
        "graph_qualification": qualification,
        "next_action": {
            "delegation-offer": "destination-acceptance",
            "destination-acceptance": "source-observation",
            "source-observation": "child-contribution",
            "child-contribution": "parent-admission",
            "parent-admission": "parent-assessment",
            "parent-assessment": "parent-decision",
            "parent-decision": None,
        }[event_type],
    }


def claim_assignment_execution(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    owner: str,
    agent: str,
    slot: str,
    lease_id: str,
    lease_expires_at: str,
    authorized_by: str,
    attempt_id: str = "",
    grant_scope: str = "assignment-execution",
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    system_time: int = 0,
) -> dict[str, Any]:
    """Append a bounded execution lease; slot identity never grants authority."""

    _ensure_native_write_allowed(runtime_dir)
    from . import native_state

    state = native_state.query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
    )
    assignment = native_state.assignment_row(state, assignment_id)
    values = {
        "owner": owner.strip(),
        "agent": agent.strip(),
        "slot": slot.strip(),
        "lease_id": lease_id.strip(),
        "authorized_by": authorized_by.strip(),
        "grant_scope": grant_scope.strip(),
    }
    if not all(values.values()):
        raise ValueError(
            "owner, agent, slot, lease_id, authorized_by, and grant_scope are required"
        )
    _stable_id(values["lease_id"], "lease_id")
    expiry = native_state.parse_lease_expiry(lease_expires_at)
    now = datetime.now(expiry.tzinfo)
    if expiry <= now:
        raise ValueError("execution lease must expire in the future")
    claim_id = f"execution-{_sha256_root({**values, 'assignment': assignment_id, 'expires': lease_expires_at})[7:31]}"
    record = {
        "claim_id": claim_id,
        "attempt_id": _stable_id(attempt_id or claim_id, "attempt_id"),
        "claim_type": ASSIGNMENT_EXECUTION_CLAIM,
        "assignment_id": _stable_id(assignment_id, "assignment_id"),
        **values,
        "lease_expires_at": expiry.isoformat().replace("+00:00", "Z"),
        "authority_semantics": {
            "owner": "accountability-and-cost-principal",
            "agent": "acting-runtime-identity",
            "slot": "execution-lane-not-authority",
            "lease": "bounded-task-authorization",
        },
    }
    source_id = _native_source(actor_type)
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": values["agent"],
        },
        "links": {
            "initiative_id": state["initiative_subject"],
            "assignment_id": str(assignment["subject_key"]),
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="assignment-execution-claim",
        surface_id=CLAIM_SURFACE_ID,
        subject_key=f"kungfu:assignment-execution:{record['claim_id']}",
        source_id=source_id,
        payload=payload,
        system_time=system_time or time.time_ns(),
    )
    return {
        "schema": "kungfu.assignment-orchestration.execution-claim/v1",
        "claim": record,
        "receipt": receipt,
    }


def assignment_orchestration_status(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    storage_source_id: str = "kungfu",
    now: str = "",
) -> dict[str, Any]:
    """Fold append-only orchestration facts into one deterministic Assignment phase."""

    from . import native_state

    state = native_state.query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
    )
    assignment = native_state.assignment_row(state, assignment_id)
    assignment_subject = str(assignment["subject_key"])
    linked = [
        row
        for row in state["claims"] + state["reviews"]
        if row.get("payload", {}).get("links", {}).get("assignment_id")
        == assignment_subject
    ]
    records = [row.get("payload", {}).get("record", {}) for row in linked]
    execution_claims = [
        row for row in records if row.get("claim_type") == ASSIGNMENT_EXECUTION_CLAIM
    ]
    transitions = [
        row for row in records if row.get("claim_type") == ASSIGNMENT_PHASE_TRANSITION
    ]
    instant = (
        native_state.parse_lease_expiry(now) if now else datetime.now().astimezone()
    )
    active_leases = [
        row
        for row in execution_claims
        if (
            native_state.parse_lease_expiry(str(row.get("lease_expires_at") or ""))
            > instant
        )
    ]
    active_lease = (
        max(active_leases, key=lambda row: str(row["lease_expires_at"]))
        if active_leases
        else None
    )
    active_claim_id = str((active_lease or {}).get("claim_id") or "")
    execution_claims.sort(
        key=lambda row: str(row.get("claim_id") or "") == active_claim_id
    )
    phase = "admitted"
    if execution_claims:
        phase = "claimed"
    if transitions:
        explicit = {str(row.get("to_phase") or "") for row in transitions}
        phase = max(explicit, key=ASSIGNMENT_PHASES.index)
    completion_claims, independent_reviews, decisions, completion_phase = (
        native_state.fold_completion_cycle(linked)
    )
    if completion_phase:
        phase = completion_phase
    result = {
        "schema": "kungfu.assignment-orchestration.status/v1",
        "initiative_subject": state["initiative_subject"],
        "assignment_subject": assignment_subject,
        "assignment": assignment["payload"]["record"],
        "phase": phase,
        "active_lease": active_lease,
        "execution_claims": execution_claims,
        "phase_transitions": transitions,
        "completion_claim_count": len(completion_claims),
        "completion_claims": completion_claims,
        "independent_review_count": len(independent_reviews),
        "independent_reviews": independent_reviews,
        "continuation_decision_count": len(decisions),
        "continuation_decisions": decisions,
        "query_proof_root": state["query_proof_root"],
    }
    from . import work_semantics

    semantic_records = [
        row.get("payload", {}).get("record", {})
        for row in linked
        if row.get("payload", {}).get("record", {}).get("record_type")
        in work_semantics.RECORD_TYPES
    ]
    semantic_records.sort(
        key=lambda row: (
            int(row.get("recorded_at_system_time") or 0),
            str(row.get("record_root") or ""),
        )
    )
    result["work_semantics"] = work_semantics.project(
        semantic_records,
        phase=phase,
        active_lease=result["active_lease"],
        query_proof_root=state["query_proof_root"],
    )
    return result


def advance_assignment_phase(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    to_phase: str,
    actor: str,
    reason: str,
    expected_phase: str = "",
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    system_time: int = 0,
) -> dict[str, Any]:
    """Advance only the explicit pre-completion orchestration states."""

    _ensure_native_write_allowed(runtime_dir)
    status = assignment_orchestration_status(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        storage_source_id=storage_source_id,
    )
    if expected_phase and status["phase"] != expected_phase:
        raise ValueError("Assignment phase changed before transition")
    allowed = {"claimed": "executing", "executing": "stage-ready"}
    if allowed.get(status["phase"]) != to_phase:
        raise ValueError(
            f"invalid Assignment phase transition: {status['phase']} -> {to_phase}"
        )
    if status["active_lease"] is None:
        raise ValueError("an active execution lease is required for phase advancement")
    actor = actor.strip()
    reason = reason.strip()
    if not actor or not reason:
        raise ValueError("actor and reason are required")
    basis = {
        "assignment_subject": status["assignment_subject"],
        "from_phase": status["phase"],
        "to_phase": to_phase,
        "lease_id": status["active_lease"]["lease_id"],
        "actor": actor,
        "reason": reason,
    }
    record = {
        "claim_id": f"phase-{_sha256_root(basis)[7:31]}",
        "claim_type": ASSIGNMENT_PHASE_TRANSITION,
        **basis,
    }
    source_id = _native_source(actor_type)
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": actor,
        },
        "links": {
            "initiative_id": status["initiative_subject"],
            "assignment_id": status["assignment_subject"],
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="assignment-phase-transition",
        surface_id=CLAIM_SURFACE_ID,
        subject_key=f"kungfu:assignment-phase:{record['claim_id']}",
        source_id=source_id,
        payload=payload,
        system_time=system_time or time.time_ns(),
    )
    return {
        "schema": "kungfu.assignment-orchestration.phase-transition/v1",
        "transition": record,
        "receipt": receipt,
    }


def _verified_episode(runtime_dir: str, episode_id: int) -> dict[str, Any]:
    fsck = storage_service.fsck(runtime_dir, episode_id=episode_id, verify_frames=True)
    if not fsck.get("ok"):
        raise ValueError(f"Episode {episode_id} failed frame verification")
    root = ""
    for _ in range(2):
        inspected = storage_service.episode_inspect(runtime_dir, episode_id=episode_id)
        root = _episode_root(inspected.get("content_root", {}))
        if not root:
            recorded = inspected.get("episode", {}).get("root", {})
            root = str(recorded.get("root_value") or "")
            if root and not root.startswith("sha256:"):
                root = "sha256:" + root
        if root:
            break
    if not root:
        raise ValueError(f"Episode {episode_id} has no verified content root")
    return {"episode_id": str(episode_id), "episode_root": root}


def _tracked_completion_evidence(
    checkout_path: str,
    state: dict[str, Any],
    assignment_id: str,
    claim_record: dict[str, Any],
) -> dict[str, Any]:
    """Verify a Completion Claim against one tracked checkout and Project Cut."""

    checkout = Path(checkout_path).expanduser().resolve()
    diagnostics: list[dict[str, str]] = []

    def reject(code: str, detail: str) -> None:
        diagnostics.append({"code": code, "detail": detail})

    def git(*args: str) -> str:
        completed = subprocess.run(
            ["git", "-C", str(checkout), *args],
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()

    commit = str(claim_record.get("git_commit") or "")
    try:
        repository = Path(git("rev-parse", "--show-toplevel")).resolve()
        if repository != checkout:
            reject("checkout-root-mismatch", "checkout must name the Git worktree root")
        observed_commit = git("rev-parse", f"{commit}^{{commit}}")
        head_commit = git("rev-parse", "HEAD^{commit}")
        tree_oid = git("rev-parse", f"{commit}^{{tree}}")
    except (OSError, subprocess.CalledProcessError) as error:
        reject("git-evidence-unavailable", str(error))
        return {
            "schema": "kungfu.work-control.tracked-completion-evidence/v1",
            "valid": False,
            "checkout": str(checkout),
            "diagnostics": diagnostics,
        }

    if observed_commit != commit:
        reject("forged-claim", "claimed Git commit does not resolve exactly")
    if head_commit != commit:
        reject("post-claim-source-drift", "checkout HEAD differs from claimed commit")
    expected_tree_root = _sha256_root(tree_oid)
    if claim_record.get("git_tree_root") != expected_tree_root:
        reject(
            "git-tree-mismatch", "claimed Git tree root differs from the commit tree"
        )

    target_assignment = next(
        (
            row
            for row in state.get("assignments", [])
            if row.get("payload", {}).get("record", {}).get("assignment_id")
            == assignment_id
            or row.get("subject_key") in {assignment_id, f"kungfu:{assignment_id}"}
        ),
        None,
    )
    assignment_payload = (target_assignment or {}).get("payload", {})
    assignment_record = assignment_payload.get("record", {})
    expected_assignment_set = {assignment_id}
    expected_assignment_set.update(
        str(
            row.get("payload", {}).get("record", {}).get("assignment_id")
            or row.get("payload", {}).get("record", {}).get("assignment_id")
            or ""
        )
        for row in state.get("assignments", [])
        if (
            row.get("payload", {}).get("record", {}).get("parent_assignment_id")
            == assignment_id
            or (
                row.get("payload", {})
                .get("record", {})
                .get("parent_assignment_ref", {})
                .get("object_kind")
                == "assignment"
                and row.get("payload", {})
                .get("record", {})
                .get("parent_assignment_ref", {})
                .get("subject")
                in {assignment_id, f"kungfu:{assignment_id}"}
            )
        )
    )
    assignment_subject = str((target_assignment or {}).get("subject_key") or "")
    owning_workspace_identity_root = str(
        assignment_record.get("owning_workspace_identity_root") or ""
    )
    expected_assignment_set.update(
        str(
            row.get("payload", {}).get("record", {}).get("assignment_id")
            or row.get("payload", {}).get("record", {}).get("assignment_id")
            or ""
        )
        for row in state.get("assignments", [])
        if (
            row.get("payload", {})
            .get("record", {})
            .get("parent_assignment_ref", {})
            .get("subject")
            == assignment_subject
            and row.get("payload", {})
            .get("record", {})
            .get("parent_assignment_ref", {})
            .get("workspace_identity_root")
            == owning_workspace_identity_root
            and row.get("payload", {})
            .get("record", {})
            .get("owning_workspace_identity_root")
            == owning_workspace_identity_root
        )
    )
    expected_assignment_set.discard("")
    if set(claim_record.get("assignment_set") or []) != expected_assignment_set:
        reject(
            "incomplete-parent-acceptance",
            "completion Assignment set omits or adds a child",
        )
    request_root = str(assignment_record.get("request_root") or "")
    work_definition_root = str(assignment_record.get("work_definition_root") or "")
    work_definition = assignment_record.get("work_definition")
    source = assignment_payload.get("source", {})
    native_assignment = bool(
        assignment_subject == f"kungfu:{assignment_id}"
        and assignment_record.get("assignment_id") == assignment_id
        and (target_assignment or {}).get("source_id")
        in {USER_FACT_SOURCE_ID, AGENT_FACT_SOURCE_ID}
        and source.get("authority_mode") == "kungfu-native"
        and request_root
        and work_definition_root
        and isinstance(work_definition, dict)
        and work_definition
        and work_definition_root == _sha256_root(work_definition)
    )
    if native_assignment:
        if claim_record.get("acceptance_root") != work_definition_root:
            reject(
                "acceptance-root-mismatch",
                "claim acceptance_root differs from the Assignment work definition",
            )
        for claim_key in (
            "input_context_root",
            "result_context_root",
            "project_cut_root",
            "project_cut_receipt_root",
        ):
            if claim_record.get(claim_key):
                reject(
                    "unsupported-context-binding",
                    f"native Assignment claim must not set {claim_key}",
                )
        diagnostics.sort(key=lambda row: (row["code"], row["detail"]))
        evidence = {
            "schema": "kungfu.work-control.tracked-completion-evidence/v1",
            "authority": "kungfu-assignment-request",
            "valid": not diagnostics,
            "commit": commit,
            "head_commit": head_commit,
            "tree_oid": tree_oid,
            "git_tree_root": expected_tree_root,
            "request_root": request_root,
            "work_definition_root": work_definition_root,
            "cut": {},
            "diagnostics": diagnostics,
        }
        evidence["evidence_root"] = _sha256_root(evidence)
        return evidence
    for claim_key, assignment_key, code in (
        ("acceptance_root", "acceptance_root", "acceptance-root-mismatch"),
        ("input_context_root", "input_context_root", "stale-context"),
        ("project_cut_root", "project_cut_root", "project-cut-root-mismatch"),
    ):
        expected = str(assignment_record.get(assignment_key) or "")
        actual = str(claim_record.get(claim_key) or "")
        if not expected or actual != expected:
            reject(code, f"claim {claim_key} differs from the Assignment contract")

    project_cut_bin = (
        Path(__file__).resolve().parents[4]
        / "framework"
        / "project-cut"
        / "bin"
        / "project-cut.mjs"
    )
    reconcile = None
    try:
        completed = subprocess.run(
            [
                "node",
                str(project_cut_bin),
                "reconcile",
                "--commit",
                commit,
                "--root",
                str(checkout),
                "--json",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        reconcile = json.loads(completed.stdout)
    except (OSError, json.JSONDecodeError) as error:
        reject("project-cut-verifier-failed", str(error))

    cuts = list((reconcile or {}).get("cuts") or [])
    claimed_cut_root = str(claim_record.get("project_cut_root") or "")
    matching_cuts = [row for row in cuts if row.get("cutRoot") == claimed_cut_root]
    if len(matching_cuts) != 1:
        reject(
            "project-cut-count-mismatch",
            "claimed commit must contain exactly one matching Project Cut",
        )
        cut: dict[str, Any] = {}
    else:
        cut = matching_cuts[0]
        cut_digest = claimed_cut_root.removeprefix("sha256:")
        cut_path = str(
            cut.get("path")
            or (
                f".kungfu/project-cuts/sha256/{cut_digest[:2]}/"
                f"{cut_digest}/manifest.json"
            )
        )
        receipt_path = str(Path(cut_path).parent / "receipt.json")
        promotion_path = (
            ".xinfa/manifests/project-cuts/"
            + str(cut.get("contextRoot") or "").removeprefix("sha256:")
            + ".json"
        )
        episode_paths = {
            ".kungfu/episodes/sealed/sha256/"
            + semantic_root.removeprefix("sha256:")[:2]
            + "/"
            + semantic_root.removeprefix("sha256:")
            for semantic_root in (
                str(row.get("semanticRoot") or "") for row in cut.get("episodes", [])
            )
            if semantic_root.startswith("sha256:")
        }
        scoped_paths = {cut_path, receipt_path, promotion_path, *episode_paths}
        for row in (reconcile or {}).get("diagnostics", []):
            path = str(row.get("path") or "")
            if path in {"", "$"} or any(
                path == prefix or path.startswith((prefix + ":", prefix + "/"))
                for prefix in scoped_paths
                if prefix
            ):
                reject(
                    str(row.get("code") or "project-cut-invalid"),
                    str(row.get("detail") or row),
                )
        comparisons = (
            ("cutRoot", "project_cut_root", "project-cut-root-mismatch"),
            ("contextRoot", "result_context_root", "stale-context"),
            ("receiptRoot", "project_cut_receipt_root", "receipt-cut-mismatch"),
        )
        for cut_key, claim_key, code in comparisons:
            if not claim_record.get(claim_key) or cut.get(cut_key) != claim_record.get(
                claim_key
            ):
                reject(code, f"Project Cut {cut_key} differs from the claim")
        sealed_episode_roots = {
            str(row.get("semanticRoot") or "") for row in cut.get("episodes", [])
        }
        claimed_episode_roots = {
            str(row.get("episode_root") or "")
            for row in claim_record.get("evidence_episodes", [])
        }
        if (
            claimed_episode_roots
            and not claimed_episode_roots.issubset(sealed_episode_roots)
        ) or (sealed_episode_roots and not claimed_episode_roots):
            reject(
                "missing-episode",
                "claimed Episode set does not match the Project Cut Episode delta",
            )

    diagnostics.sort(key=lambda row: (row["code"], row["detail"]))
    evidence = {
        "schema": "kungfu.work-control.tracked-completion-evidence/v1",
        "valid": not diagnostics,
        "commit": commit,
        "head_commit": head_commit,
        "tree_oid": tree_oid,
        "git_tree_root": expected_tree_root,
        "cut": cut,
        "diagnostics": diagnostics,
    }
    # A tracked checkout is an observation location, not protocol identity.
    # Excluding its host-local absolute path keeps the evidence and review roots
    # stable when another reviewer verifies the same commit on another machine.
    evidence["evidence_root"] = _sha256_root(evidence)
    return evidence


def claim_completion(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    statement: str,
    actor: str,
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    evidence_episode_ids: list[int] | None = None,
    assignment_set: list[str] | None = None,
    acceptance_root: str = "",
    input_context_root: str = "",
    result_context_root: str = "",
    project_cut_root: str = "",
    project_cut_receipt_root: str = "",
    git_commit: str = "",
    git_tree_root: str = "",
    proof_roots: list[str] | None = None,
    known_gaps: list[str] | None = None,
    evidence_availability: list[dict[str, Any]] | None = None,
    system_time: int = 0,
) -> dict[str, Any]:
    """Record a visible completion claim without treating it as authority."""

    _ensure_native_write_allowed(runtime_dir)
    system_time = system_time or time.time_ns()
    _ensure_contract(runtime_dir, system_time)
    state = query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
    )
    assignment_id = _stable_id(assignment_id, "assignment_id")
    assignment = next(
        (
            row
            for row in state["assignments"]
            if row.get("subject_key") == assignment_id
            or row.get("subject_key") == f"kungfu:{assignment_id}"
            or row.get("payload", {}).get("record", {}).get("assignment_id")
            == assignment_id
        ),
        None,
    )
    if assignment is None:
        raise ValueError(f"Assignment not found under Initiative: {assignment_id}")
    if not statement.strip() or not actor.strip():
        raise ValueError("statement and actor are required")
    from . import work_semantics

    semantics = work_semantics.status(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        storage_source_id=storage_source_id,
    )
    if semantics["current_input_snapshot"]:
        if not semantics["completion_eligible"]:
            raise ValueError(
                "Work semantics effects must be settled before completion can be claimed"
            )
        required_semantic_roots = {
            semantics["current_input_snapshot"]["record_root"],
            semantics["managed_runs"][-1]["record_root"],
            *[row["record_root"] for row in semantics["effect_outcomes"]],
        }
        supplied_semantic_roots = set(proof_roots or [])
        if not required_semantic_roots.issubset(supplied_semantic_roots):
            raise ValueError(
                "completion proof_roots must bind the current Work semantics evidence"
            )
    evidence = [
        _verified_episode(runtime_dir, int(episode_id))
        for episode_id in (evidence_episode_ids or [])
    ]
    assignment_set = [
        _stable_id(row, "assignment_set") for row in (assignment_set or [assignment_id])
    ]
    if assignment_id not in assignment_set:
        raise ValueError("assignment_set must contain the claimed assignment_id")
    if len(set(assignment_set)) != len(assignment_set):
        raise ValueError("assignment_set must not contain duplicates")
    roots = {
        "acceptance_root": _root_id(acceptance_root, "acceptance_root"),
        "input_context_root": _root_id(input_context_root, "input_context_root"),
        "result_context_root": _root_id(result_context_root, "result_context_root"),
        "project_cut_root": _root_id(project_cut_root, "project_cut_root"),
        "project_cut_receipt_root": _root_id(
            project_cut_receipt_root, "project_cut_receipt_root"
        ),
        "git_tree_root": _root_id(git_tree_root, "git_tree_root"),
        "proof_roots": sorted(
            {_root_id(row, "proof_roots", required=True) for row in proof_roots or []}
        ),
    }
    git_commit = git_commit.strip()
    if git_commit and not GIT_OBJECT_ID.fullmatch(git_commit):
        raise ValueError("git_commit must be a full lowercase Git object id")
    gaps = [row.strip() for row in (known_gaps or []) if row.strip()]
    availability = []
    for row in evidence_availability or []:
        if not isinstance(row, dict):
            raise ValueError(  # noqa: TRY004 - stable public validation surface
                "evidence_availability rows must be objects"
            )
        acceptance = str(row.get("acceptance") or "").strip()
        level = str(row.get("level") or "").strip()
        availability_state = str(row.get("state") or "").strip()
        if (
            not acceptance
            or level not in {"thin", "full"}
            or availability_state
            not in {
                "available",
                "unavailable",
                "missing",
            }
        ):
            raise ValueError(
                "evidence_availability requires acceptance, thin/full level, "
                "and available/unavailable/missing state"
            )
        availability.append(
            {
                "acceptance": acceptance,
                "level": level,
                "state": availability_state,
            }
        )
    availability.sort(key=lambda row: (row["acceptance"], row["level"], row["state"]))
    claim_basis = {
        "initiative_subject": state["initiative_subject"],
        "assignment_subject": str(assignment["subject_key"]),
        "statement": statement.strip(),
        "actor": actor.strip(),
        "evidence": evidence,
        "assignment_set": sorted(assignment_set),
        "roots": roots,
        "git_commit": git_commit,
        "known_gaps": gaps,
        "evidence_availability": availability,
    }
    claim_id = f"completion-{_sha256_root(claim_basis)[7:31]}"
    source_id = _native_source(actor_type)
    subject_key = f"kungfu:claim:{claim_id}"
    record = {
        "claim_id": claim_id,
        "claim_type": COMPLETION_CLAIM,
        "status": "claimed-complete",
        "statement": statement.strip(),
        "asserted_by": actor.strip(),
        "actor_type": actor_type,
        "evidence_episodes": evidence,
        "assignment_set": sorted(assignment_set),
        **roots,
        "git_commit": git_commit,
        "known_gaps": gaps,
        "evidence_availability": availability,
    }
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": actor.strip(),
        },
        "links": {
            "initiative_id": state["initiative_subject"],
            "assignment_id": str(assignment["subject_key"]),
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="completion-claim",
        surface_id=CLAIM_SURFACE_ID,
        subject_key=subject_key,
        source_id=source_id,
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.initiative-assignment.completion-claim-write/v1",
        "authority_mode": "kungfu-native",
        "initiative_subject": state["initiative_subject"],
        "assignment_subject": str(assignment["subject_key"]),
        "claim": record,
        "receipt": receipt,
    }
