# SPDX-License-Identifier: Apache-2.0

"""Work Control contract, source binding, state query, and fact authority."""

import hashlib
import json
import re
from collections.abc import Callable
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from typing import Any, TypeVar

from kungfu import profile_composition, profile_sdk
from kungfu.canonical_json import canonical_json_text
from kungfu.storage import content_store, service as storage_service

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
_INACTIVE_PROJECTION_READ: ContextVar[bool] = ContextVar(
    "kungfu_work_control_inactive_projection_read", default=False
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


def _with_profile_source(
    source: str,
    operation: Callable[[], _T],
    *,
    inactive_projection_read: bool = False,
) -> _T:
    token = _BOUND_WORK_CONTROL_SOURCE.set(str(Path(source).resolve()))
    projection_token = _INACTIVE_PROJECTION_READ.set(inactive_projection_read)
    try:
        return operation()
    finally:
        _INACTIVE_PROJECTION_READ.reset(projection_token)
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
        return profile_composition.contract_materialization_plan(
            source,
            runtime_dir,
            require_active=not _INACTIVE_PROJECTION_READ.get(),
        )
    except profile_sdk.ProfileSdkError as error:
        return _retained_source_authority_compatibility(runtime_dir, error)


def ensure_profile_contract(
    runtime_dir: str, source: str, authorized_by: str
) -> list[dict[str, Any]]:
    """Materialize Work declarations or prove the retained-history boundary."""

    contract = contract_materialization_plan(runtime_dir, source)
    if contract.get("status") == "retained-history-compatible":
        return [
            {
                "schema": "kungfu.work.profile-contract-compatibility-receipt/v1",
                "profileContract": _ensure_contract(runtime_dir),
                "writeOccurred": False,
            }
        ]
    if not contract["operations"]:
        return []
    answer = profile_sdk.answer_decision(
        contract["decisionCard"], "approve", authorized_by
    )
    return [
        profile_composition.authorized_contract_materialize(
            runtime_dir, contract, answer
        )
    ]


def _profile_context(runtime_dir: str) -> dict[str, Any]:
    discovered = work_control_profile_source(runtime_dir)
    source = discovered["source"]
    require_active = not _INACTIVE_PROJECTION_READ.get()
    composed = profile_composition.catalog(
        source,
        runtime_dir,
        require_active=require_active,
    )
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
        require_active = not _INACTIVE_PROJECTION_READ.get()
        plan = profile_composition.resolved_query_plan(
            context["source"],
            runtime_dir,
            "initiative-state",
            resolution,
            require_active=require_active,
        )
        receipt = profile_composition.execute_query(
            context["source"], runtime_dir, plan, require_active=require_active
        )
        results.append(receipt["result"])
        receipts.append(receipt)
    if len(results) == 1:
        composed_receipt = profile_composition.compose_query_receipt(
            context["source"],
            runtime_dir,
            "initiative-state",
            receipts,
            results[0],
            require_active=not _INACTIVE_PROJECTION_READ.get(),
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
    rows = []
    initiative = None
    assignments = []
    claims = []
    reviews = []
    for row in result.get("rows", []):
        body = json.loads(
            content_store.get(
                runtime_dir, content_store.PAYLOADS_NAMESPACE, row["payload_hash"]
            )
        )
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
