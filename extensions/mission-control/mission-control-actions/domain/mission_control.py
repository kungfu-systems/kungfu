# SPDX-License-Identifier: Apache-2.0

"""Mission Control facts for the Atlas bridge and Kungfu-native authority.

Atlas remains authoritative for imported observations. Native user and agent
Mission/Go/claim facts enter the same ADR-0051 Fact Library with explicit source
authority, so query, assessment, GUI, CLI, and portable bundles share one truth
path. Imported payloads retain their source coordinates and sealed Episode.
"""

import hashlib
import json
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from kungfu import profile_composition, profile_sdk
from kungfu.rewind import ACTION_COST_SNAPSHOT
from kungfu.rewind import replay as rewind_replay
from kungfu.storage import service as storage_service

CONTRACT_WORLD_ID = "kungfu.mission-control"
CONTRACT_VERSION = "3"
LEGACY_CONTRACT_VERSION = "2"
LEGACY_CONTRACT_VERSIONS = ("1", "2")
MISSION_SURFACE_ID = "kungfu.mission-control.mission"
GO_SURFACE_ID = "kungfu.mission-control.go"
CLAIM_SURFACE_ID = "kungfu.mission-control.completion-claim"
# Reviews and continuation decisions are versioned record kinds on the existing
# claim surface. Keeping the v3 surface register stable lets an authority-cutover
# workspace adopt this additive profile without rewriting its admitted facts.
REVIEW_SURFACE_ID = CLAIM_SURFACE_ID
ATLAS_FACT_SOURCE_ID = "atlas-adapter"
USER_FACT_SOURCE_ID = "kungfu-user"
AGENT_FACT_SOURCE_ID = "kungfu-agent"

FACT_SURFACES = (MISSION_SURFACE_ID, GO_SURFACE_ID, CLAIM_SURFACE_ID)
PROGRESS_CLAIM = "mission-progress-is-reasonable"
PROGRESS_PURPOSE = "operator-review"
COST_STATE_PROOF_PROFILE_ID = "kungfu.profile.delegated-work-cost-state-proof"
COST_STATE_PROOF_PROFILE_VERSION = "1"
MISSION_CONTROL_PROFILE_ID = "kungfu.mission-control"
MISSION_CONTROL_PROFILE_VERSION = "3.0.0"
MISSION_CONTROL_REDUCER = "kungfu.mission-control.five-questions"
MISSION_CONTROL_QUESTIONS = (
    ("mission-intent", "What are we trying to achieve?"),
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
    "id": "kungfu.mission-control.reasonable-progress",
    "version": "1",
    "rules": {
        "requires_mission": True,
        "requires_linked_go": True,
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
AUTHORITY_MIGRATION_CLAIM = "mission-go-authority-migration"
AUTHORITY_SUBJECT_PREFIX = "kungfu:authority:mission-go:"
ROOT_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_OBJECT_ID = re.compile(r"^[0-9a-f]{40}$")
COMPLETION_POLICY = {
    "id": "kungfu.mission-control.task-completed",
    "version": "1",
    "rules": {
        "requires_completion_claim": True,
        "requires_verified_work_episode": True,
        "completion_self_report_is_authority": False,
        "missing_evidence_fails_closed": True,
    },
}
SURFACE_BY_KIND = {
    "mission": MISSION_SURFACE_ID,
    "goal": GO_SURFACE_ID,
}
SURFACE_AUTHORITIES = {
    MISSION_SURFACE_ID: [
        ATLAS_FACT_SOURCE_ID,
        USER_FACT_SOURCE_ID,
        AGENT_FACT_SOURCE_ID,
    ],
    GO_SURFACE_ID: [
        ATLAS_FACT_SOURCE_ID,
        USER_FACT_SOURCE_ID,
        AGENT_FACT_SOURCE_ID,
    ],
    CLAIM_SURFACE_ID: [USER_FACT_SOURCE_ID, AGENT_FACT_SOURCE_ID],
}
STABLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def _record_schema(kind: str) -> dict[str, Any]:
    return {
        "$id": f"kungfu://mission-control/{kind}/v1",
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
                    "mission_id": {"type": "string"},
                    "go_id": {"type": "string"},
                },
                "additionalProperties": False,
            },
        },
        "required": ["record", "source", "links"],
        "additionalProperties": False,
    }


def _canonical_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _sha256_root(value: Any) -> str:
    raw = value if isinstance(value, str) else _canonical_json(value)
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _observation_id(entry: dict[str, Any], storage_source_id: str) -> str:
    identity = {
        "adapter": ATLAS_FACT_SOURCE_ID,
        "storage_source_id": storage_source_id,
        "kind": str(entry.get("kind") or ""),
        "source_id": str(entry.get("source_id") or ""),
        "payload_hash": str(entry.get("payload_hash") or ""),
    }
    digest = hashlib.sha256(_canonical_json(identity).encode("utf-8")).hexdigest()
    return f"atlas-{identity['kind']}-{digest[:24]}"


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


def mission_control_profile_source(runtime_dir: str) -> dict[str, Any]:
    return profile_sdk.discover_source(MISSION_CONTROL_PROFILE_ID, runtime_dir)


def _profile_context(runtime_dir: str) -> dict[str, Any]:
    discovered = mission_control_profile_source(runtime_dir)
    source = discovered["source"]
    composed = profile_composition.catalog(source, runtime_dir, require_active=True)
    materialization = profile_composition.contract_materialization_plan(
        source, runtime_dir
    )
    if materialization["operations"]:
        raise profile_sdk.ProfileSdkError(
            "profile-contract-not-materialized",
            "Mission Control requires an approved Profile contract plan before facts can be read or written",
            profileId=MISSION_CONTROL_PROFILE_ID,
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
        "schema": "kungfu.mission-control.profile-contract/v1",
        "status": "current",
        "profile_id": MISSION_CONTROL_PROFILE_ID,
        "profile_suite_root": context["catalog"]["profileSuiteRoot"],
        "catalog_root": context["catalog"]["catalogRoot"],
        "source": context["source"],
    }


def admit_import(
    runtime_dir: str,
    *,
    import_id: str,
    import_episode_id: int,
    import_episode_root: str,
    repo_head: str | None,
    storage_source_id: str,
    entries: list[dict[str, Any]],
) -> dict[str, Any]:
    """Admit present Mission/Go snapshots and return a bridge receipt."""

    _ensure_atlas_write_allowed(runtime_dir)
    system_time = time.time_ns()
    contract = _ensure_contract(runtime_dir, system_time)
    state = storage_service.fact_state(runtime_dir)
    existing_ids = {
        str(row.get("observation_id") or "")
        for row in state.get("observation_history", [])
    }

    receipts = []
    already_present = 0
    skipped = []
    next_time = system_time + len(FACT_SURFACES) + 1
    for entry in entries:
        kind = str(entry.get("kind") or "")
        if kind not in SURFACE_BY_KIND:
            continue
        if entry.get("payload_state") != "present" or not isinstance(
            entry.get("payload"), dict
        ):
            skipped.append(
                {
                    "kind": kind,
                    "source_id": str(entry.get("source_id") or ""),
                    "reason": f"payload-{entry.get('payload_state') or 'unavailable'}",
                }
            )
            continue
        observation_id = _observation_id(entry, storage_source_id)
        if observation_id in existing_ids:
            already_present += 1
            continue
        source_id = str(entry.get("source_id") or "")
        subject_key = f"{storage_source_id}:{source_id}"
        record = dict(entry["payload"])
        raw_mission_id = (
            source_id if kind == "mission" else str(record.get("mission_id") or "")
        )
        mission_id = f"{storage_source_id}:{raw_mission_id}" if raw_mission_id else ""
        payload = {
            "record": record,
            "source": {
                "authority_mode": "atlas-bridge",
                "storage_source_id": storage_source_id,
                "kind": kind,
                "source_id": source_id,
                "source_path": str(entry.get("source_path") or ""),
                "source_time": str(entry.get("source_time") or ""),
                "repo_head": str(repo_head or ""),
                "import_id": import_id,
                "import_episode_id": str(import_episode_id),
                "import_episode_root": import_episode_root,
                "payload_hash": str(entry.get("payload_hash") or ""),
            },
            "links": {"mission_id": mission_id},
        }
        receipt = storage_service.fact_material_put(
            runtime_dir,
            {
                "type_id": SURFACE_BY_KIND[kind],
                "type_version": CONTRACT_VERSION,
                "source_id": ATLAS_FACT_SOURCE_ID,
                "subject_key": subject_key,
                "payload": payload,
                "observation_id": observation_id,
                "action": "assert",
                "valid_from": _source_time_nanos(entry.get("source_time"), next_time),
                "valid_until": 0,
            },
            system_time=next_time,
        )
        next_time += 1
        receipts.append(
            {
                "kind": kind,
                "source_id": source_id,
                "observation_id": observation_id,
                "outcome": receipt["receipt"]["admission"]["outcome"],
                "episode_id": receipt["receipt"]["episode_id"],
            }
        )
        existing_ids.add(observation_id)

    outcomes: dict[str, int] = {}
    for receipt in receipts:
        outcome = str(receipt["outcome"])
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
    return {
        "schema": "kungfu.mission-control.atlas-admission/v1",
        "status": "admitted"
        if not skipped and outcomes.get("admitted", 0) == len(receipts)
        else "degraded",
        "authority_mode": "atlas-bridge",
        "contract_world": {
            "id": CONTRACT_WORLD_ID,
            "version": CONTRACT_VERSION,
        },
        "fact_surfaces": list(FACT_SURFACES),
        "contract": contract,
        "import_id": import_id,
        "import_episode_id": int(import_episode_id),
        "import_episode_root": import_episode_root,
        "admitted": outcomes.get("admitted", 0),
        "already_present": already_present,
        "outcomes": outcomes,
        "skipped": skipped,
        "receipts": receipts,
    }


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
        raise RuntimeError("mission-control contract world is missing or ambiguous")
    surfaces = []
    for surface_id in FACT_SURFACES:
        matches = [
            row
            for row in catalog.get("fact_types", [])
            if row.get("id") == surface_id and row.get("version") == CONTRACT_VERSION
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"mission-control fact surface is missing or ambiguous: {surface_id}"
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
    mission_id: str,
    storage_source_id: str,
    cut_system_time: int,
) -> tuple[str, list[str], dict[str, Any]]:
    materials = storage_service.fact_material_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    payloads = materials.get("payloads", {})
    requested_subjects = (
        {mission_id}
        if ":" in mission_id
        else {f"{storage_source_id}:{mission_id}", f"kungfu:{mission_id}"}
    )
    admitted_subjects = {
        str(row.get("subject_key") or "")
        for row in materials.get("state", {}).get("canonical_facts", [])
        if row.get("fact_surface_id") == MISSION_SURFACE_ID
        and row.get("subject_key") in requested_subjects
    }
    if not admitted_subjects:
        raise ValueError(f"admitted Mission fact not found: {mission_id}")
    if len(admitted_subjects) > 1:
        raise ValueError(
            f"Mission id is ambiguous across source authorities: {mission_id}"
        )
    mission_subject = next(iter(admitted_subjects))
    selected = {mission_subject}
    for row in materials.get("state", {}).get("canonical_facts", []):
        payload = payloads.get(str(row.get("payload_hash") or ""), {})
        if row.get("fact_surface_id") == MISSION_SURFACE_ID:
            continue
        if (
            row.get("fact_surface_id") == GO_SURFACE_ID
            and payload.get("links", {}).get("mission_id") == mission_subject
        ):
            selected.add(str(row["subject_key"]))
        if (
            row.get("fact_surface_id") == CLAIM_SURFACE_ID
            and payload.get("links", {}).get("mission_id") == mission_subject
        ):
            selected.add(str(row["subject_key"]))
    return mission_subject, sorted(selected), materials


def build_state_query(
    runtime_dir: str,
    *,
    mission_id: str,
    storage_source_id: str = "atlas",
    cut_system_time: int = 0,
    limit: int = 256,
) -> dict[str, Any]:
    """Build the ADR-0048 query shared by CLI, API, and GUI."""

    _ensure_contract(runtime_dir)
    mission_subject, subjects, _ = _selected_subjects(
        runtime_dir,
        mission_id=mission_id,
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
        "mission_control": {
            "mission_subject": mission_subject,
            "mission_id": mission_id,
            "storage_source_id": storage_source_id,
            "cut_system_time": cut_system_time,
            "selection": "admitted-payload-links/v1",
        },
    }


def _runtime_query_definition(definition: dict[str, Any]) -> dict[str, Any]:
    query = dict(definition)
    query.pop("mission_control", None)
    return query


def _batched_state_query(
    runtime_dir: str, definition: dict[str, Any]
) -> dict[str, Any]:
    """Run one logical Mission query through bounded ADR-0048 subqueries."""

    context = _profile_context(runtime_dir)
    subjects = list(definition["subject_keys"])
    results = []
    receipts = []
    for offset in range(0, len(subjects), 256):
        query = _runtime_query_definition(definition)
        query["subject_keys"] = subjects[offset : offset + 256]
        query["limit"] = len(query["subject_keys"])
        resolution = {
            "schema": "kungfu.profile-query-resolution/v1",
            "familyId": "mission-state-at-cut",
            "bindings": {
                "missionId": definition["mission_control"]["mission_id"],
                "storageSourceId": definition["mission_control"]["storage_source_id"],
                **(
                    {"cutSystemTime": definition["mission_control"]["cut_system_time"]}
                    if definition["mission_control"]["cut_system_time"]
                    else {}
                ),
            },
            "definition": query,
        }
        plan = profile_composition.resolved_query_plan(
            context["source"], runtime_dir, "mission-state", resolution
        )
        receipt = profile_composition.execute_query(
            context["source"], runtime_dir, plan
        )
        results.append(receipt["result"])
        receipts.append(receipt)
    if len(results) == 1:
        composed_receipt = profile_composition.compose_query_receipt(
            context["source"], runtime_dir, "mission-state", receipts, results[0]
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
        "schema": "kungfu.mission-control.batched-state-query/v1",
        "basis": definition["basis"],
        "object": definition["object"],
        "subject_keys": subjects,
        "evidence": definition["evidence"],
        "mission_control": {
            **definition["mission_control"],
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
            "engine": "mission-control-batched-fact-state/v1",
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
        context["source"], runtime_dir, "mission-state", receipts, composite_result
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
    mission_id: str,
    storage_source_id: str = "atlas",
    cut_system_time: int = 0,
) -> dict[str, Any]:
    """Return one proof-bearing Mission/Go state from admitted facts."""

    definition = build_state_query(
        runtime_dir,
        mission_id=mission_id,
        storage_source_id=storage_source_id,
        cut_system_time=cut_system_time,
    )
    result = _batched_state_query(runtime_dir, definition)
    materials = storage_service.fact_material_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    payloads = materials.get("payloads", {})
    rows = []
    mission = None
    goals = []
    claims = []
    reviews = []
    for row in result.get("rows", []):
        body = payloads.get(str(row.get("payload_hash") or ""))
        resolved = {**row, "payload": body}
        rows.append(resolved)
        if row.get("fact_surface_id") == MISSION_SURFACE_ID:
            mission = resolved
        elif row.get("fact_surface_id") == GO_SURFACE_ID:
            goals.append(resolved)
        elif row.get("fact_surface_id") == CLAIM_SURFACE_ID:
            record = (body or {}).get("record", {})
            if record.get("review_type") in {
                INDEPENDENT_REVIEW,
                CONTINUATION_DECISION,
            }:
                reviews.append(resolved)
            else:
                claims.append(resolved)
    goals.sort(key=lambda row: str(row.get("subject_key") or ""))
    claims.sort(key=lambda row: str(row.get("subject_key") or ""))
    reviews.sort(key=lambda row: str(row.get("subject_key") or ""))
    return {
        "schema": "kungfu.mission-control.state/v1",
        "authority_mode": "atlas-bridge",
        "mission_subject": definition["mission_control"]["mission_subject"],
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
        "mission": mission,
        "goals": goals,
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
    return f"mission-control-{kind}-{digest[7:31]}"


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
    if observation_id in {
        str(row.get("observation_id") or "")
        for row in state.get("observation_history", [])
    }:
        return {
            "schema": "kungfu.mission-control.native-write/v1",
            "status": "already-present",
            "reused": True,
            "observation_id": observation_id,
            "subject_key": subject_key,
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
        "schema": "kungfu.mission-control.native-write/v1",
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
    surface_id: str,
    cut_system_time: int = 0,
) -> list[dict[str, Any]]:
    """List current admitted records without depending on an Atlas projection."""

    materials = storage_service.fact_material_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    payloads = materials.get("payloads", {})
    records = []
    for row in materials.get("state", {}).get("canonical_facts", []):
        if row.get("fact_surface_id") != surface_id:
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
        records.append(record)
    identity_key = "mission_id" if surface_id == MISSION_SURFACE_ID else "goal_id"
    records.sort(key=lambda record: str(record.get(identity_key) or ""))
    return records


def list_missions(
    runtime_dir: str, *, cut_system_time: int = 0
) -> list[dict[str, Any]]:
    return list_domain_records(
        runtime_dir,
        surface_id=MISSION_SURFACE_ID,
        cut_system_time=cut_system_time,
    )


def list_goals(runtime_dir: str, *, cut_system_time: int = 0) -> list[dict[str, Any]]:
    return list_domain_records(
        runtime_dir,
        surface_id=GO_SURFACE_ID,
        cut_system_time=cut_system_time,
    )


def _root_id(value: str, field: str, *, required: bool = False) -> str:
    value = value.strip()
    if not value and not required:
        return ""
    if not ROOT_ID.fullmatch(value):
        raise ValueError(f"{field} must be a sha256 content root")
    return value


def _authority_events(runtime_dir: str) -> list[dict[str, Any]]:
    materials = storage_service.fact_material_list(runtime_dir)
    payloads = materials.get("payloads", {})
    events = []
    for row in materials.get("state", {}).get("canonical_facts", []):
        if row.get("fact_surface_id") != CLAIM_SURFACE_ID:
            continue
        payload = payloads.get(str(row.get("payload_hash") or ""), {})
        record = dict(payload.get("record") or {})
        if record.get("claim_type") != AUTHORITY_MIGRATION_CLAIM:
            continue
        events.append(
            {
                **record,
                "subject_key": str(row.get("subject_key") or ""),
                "observation_id": str(row.get("observation_id") or ""),
                "system_time": int(row.get("system_time") or 0),
                "source_authority": str(row.get("source_id") or ""),
                "source": dict(payload.get("source") or {}),
            }
        )
    events.sort(
        key=lambda row: (int(row.get("system_time") or 0), row["observation_id"])
    )
    return events


def authority_status(runtime_dir: str) -> dict[str, Any]:
    """Return the append-only Mission/Go write-authority decision."""

    events = _authority_events(runtime_dir)
    if events:
        current = events[-1]
        return {
            "schema": "kungfu.mission-control.authority-status/v1",
            "state": str(current["migration_status"]),
            "write_authority": str(current["write_authority"]),
            "legacy_mutation_path": str(current["legacy_mutation_path"]),
            "migration_id": str(current["migration_id"]),
            "parity_root": str(current.get("parity_root") or ""),
            "transition_count": len(events),
            "latest": current,
        }
    materials = storage_service.fact_material_list(runtime_dir)
    bridge_present = any(
        row.get("fact_surface_id") in {MISSION_SURFACE_ID, GO_SURFACE_ID}
        and row.get("source_id") == ATLAS_FACT_SOURCE_ID
        for row in materials.get("state", {}).get("canonical_facts", [])
    )
    return {
        "schema": "kungfu.mission-control.authority-status/v1",
        "state": "pre-cutover" if bridge_present else "native-only",
        "write_authority": ATLAS_FACT_SOURCE_ID if bridge_present else "kungfu-native",
        "legacy_mutation_path": "available" if bridge_present else "not-configured",
        "migration_id": "",
        "parity_root": "",
        "transition_count": 0,
        "latest": None,
    }


def _ensure_native_write_allowed(runtime_dir: str) -> None:
    authority = authority_status(runtime_dir)
    if (
        authority["transition_count"]
        and authority["write_authority"] != "kungfu-native"
    ):
        raise ValueError(
            "Kungfu-native Mission/Go mutation is frozen by authority rollback "
            f"{authority['migration_id']}"
        )


def _ensure_atlas_write_allowed(runtime_dir: str) -> None:
    authority = authority_status(runtime_dir)
    if (
        authority["transition_count"]
        and authority["write_authority"] == "kungfu-native"
    ):
        raise ValueError(
            "Atlas Mission/Go mutation path is frozen read-only by authority "
            f"cutover {authority['migration_id']}"
        )


def authority_parity(
    runtime_dir: str, *, storage_source_id: str = "atlas"
) -> dict[str, Any]:
    """Compare the latest Atlas import manifest with admitted bridge facts."""

    from kungfu.atlas import payloads as atlas_payloads
    from kungfu.atlas import store as atlas_store

    manifest = atlas_payloads.load_latest_manifest(atlas_store.store_dir(runtime_dir))
    if manifest is None:
        raise ValueError("authority cutover requires a completed Atlas import manifest")
    if str(manifest.get("storage_source_id") or "atlas") != storage_source_id:
        raise ValueError("latest Atlas import belongs to another storage source")

    expected: dict[tuple[str, str], dict[str, str]] = {}
    unavailable = []
    for entry in manifest.get("entries", []):
        kind = str(entry.get("kind") or "")
        if kind not in SURFACE_BY_KIND:
            continue
        key = (kind, str(entry.get("source_id") or ""))
        if entry.get("payload_state") != "present":
            unavailable.append(
                {
                    "kind": key[0],
                    "source_id": key[1],
                    "payload_state": str(entry.get("payload_state") or "unknown"),
                }
            )
            continue
        expected[key] = {
            "kind": key[0],
            "source_id": key[1],
            "payload_hash": str(entry.get("payload_hash") or ""),
            "source_path": str(entry.get("source_path") or ""),
        }

    materials = storage_service.fact_material_list(runtime_dir)
    payloads = materials.get("payloads", {})
    admitted: dict[tuple[str, str], dict[str, str]] = {}
    for row in materials.get("state", {}).get("canonical_facts", []):
        if row.get("source_id") != ATLAS_FACT_SOURCE_ID:
            continue
        payload = payloads.get(str(row.get("payload_hash") or ""), {})
        source = payload.get("source", {})
        kind = str(source.get("kind") or "")
        if kind not in SURFACE_BY_KIND:
            continue
        if str(source.get("storage_source_id") or "") != storage_source_id:
            continue
        key = (kind, str(source.get("source_id") or ""))
        admitted[key] = {
            "kind": key[0],
            "source_id": key[1],
            "payload_hash": str(source.get("payload_hash") or ""),
            "source_path": str(source.get("source_path") or ""),
        }

    missing = [expected[key] for key in sorted(set(expected) - set(admitted))]
    extra = [admitted[key] for key in sorted(set(admitted) - set(expected))]
    hash_mismatch = [
        {
            "kind": key[0],
            "source_id": key[1],
            "expected": expected[key]["payload_hash"],
            "actual": admitted[key]["payload_hash"],
        }
        for key in sorted(set(expected) & set(admitted))
        if expected[key]["payload_hash"] != admitted[key]["payload_hash"]
    ]
    parity_basis = {
        "schema": "kungfu.mission-control.authority-parity-basis/v1",
        "storage_source_id": storage_source_id,
        "atlas_import": {
            "import_id": str(manifest.get("import_id") or ""),
            "repo_head": str(manifest.get("repo_head") or ""),
            "sync_root": str(manifest.get("sync_root") or ""),
            "episode_id": str(manifest.get("episode_id") or ""),
        },
        "expected": [expected[key] for key in sorted(expected)],
        "admitted": [admitted[key] for key in sorted(admitted)],
    }
    parity_root = _sha256_root(parity_basis)
    return {
        "schema": "kungfu.mission-control.authority-parity/v1",
        "status": (
            "matched"
            if not missing and not extra and not hash_mismatch and not unavailable
            else "degraded"
        ),
        "parity_root": parity_root,
        "basis": parity_basis,
        "counts": {
            "expected": len(expected),
            "admitted": len(admitted),
            "missing": len(missing),
            "extra": len(extra),
            "hash_mismatch": len(hash_mismatch),
            "unavailable": len(unavailable),
        },
        "missing": missing,
        "extra": extra,
        "hash_mismatch": hash_mismatch,
        "unavailable": unavailable,
    }


def cutover_authority(
    runtime_dir: str,
    *,
    storage_source_id: str,
    expected_parity_root: str,
    project_cut_root: str,
    atlas_root: str,
    actor: str,
    actor_type: str = "agent",
    reason: str,
    system_time: int = 0,
) -> dict[str, Any]:
    """Freeze Atlas writes after an exact parity-bound native cutover."""

    system_time = system_time or time.time_ns()
    _ensure_contract(runtime_dir, system_time)
    parity = authority_parity(runtime_dir, storage_source_id=storage_source_id)
    expected_parity_root = _root_id(
        expected_parity_root, "expected_parity_root", required=True
    )
    project_cut_root = _root_id(project_cut_root, "project_cut_root", required=True)
    atlas_root = _root_id(atlas_root, "atlas_root", required=True)
    actor = actor.strip()
    reason = reason.strip()
    if not actor or not reason:
        raise ValueError("actor and reason are required")
    if parity["status"] != "matched":
        raise ValueError("Atlas/Kungfu authority parity is degraded")
    if parity["parity_root"] != expected_parity_root:
        raise ValueError("authority parity root changed before cutover")
    current = authority_status(runtime_dir)
    if current["transition_count"] and current["write_authority"] == "kungfu-native":
        if current["parity_root"] != expected_parity_root:
            raise ValueError(
                "native authority is already active at another parity root"
            )
        return {**current, "status": "already-active", "parity": parity}

    migration_basis = {
        "schema": "kungfu.mission-control.authority-migration-basis/v1",
        "transition": "atlas-to-kungfu-native",
        "previous_migration_id": current["migration_id"] or None,
        "storage_source_id": storage_source_id,
        "parity_root": expected_parity_root,
        "project_cut_root": project_cut_root,
        "atlas_root": atlas_root,
        "actor": actor,
        "actor_type": actor_type,
        "reason": reason,
    }
    migration_id = f"authority-{_sha256_root(migration_basis)[7:31]}"
    record = {
        "claim_id": migration_id,
        "claim_type": AUTHORITY_MIGRATION_CLAIM,
        "migration_id": migration_id,
        "migration_status": "native-active",
        "write_authority": "kungfu-native",
        "previous_write_authority": ATLAS_FACT_SOURCE_ID,
        "previous_migration_id": current["migration_id"] or None,
        "legacy_mutation_path": "frozen-read-only",
        "rollback_action": "rollback-authority",
        "parity_root": expected_parity_root,
        "project_cut_root": project_cut_root,
        "atlas_root": atlas_root,
        "atlas_import": parity["basis"]["atlas_import"],
        "source_record_count": parity["counts"]["expected"],
        "reason": reason,
        "authorized_by": actor,
        "actor_type": actor_type,
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
        "links": {},
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="authority-migration",
        surface_id=CLAIM_SURFACE_ID,
        subject_key=f"{AUTHORITY_SUBJECT_PREFIX}{migration_id}",
        source_id=source_id,
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.mission-control.authority-cutover-receipt/v1",
        "status": "cutover",
        "migration": record,
        "parity": parity,
        "receipt": receipt,
    }


def rollback_authority(
    runtime_dir: str,
    *,
    expected_migration_id: str,
    actor: str,
    actor_type: str = "agent",
    reason: str,
    system_time: int = 0,
) -> dict[str, Any]:
    """Append an explicit rollback without deleting native facts."""

    system_time = system_time or time.time_ns()
    _ensure_contract(runtime_dir, system_time)
    current = authority_status(runtime_dir)
    if current["write_authority"] != "kungfu-native":
        raise ValueError("Kungfu-native authority is not active")
    if current["migration_id"] != expected_migration_id:
        raise ValueError("authority migration changed before rollback")
    actor = actor.strip()
    reason = reason.strip()
    if not actor or not reason:
        raise ValueError("actor and reason are required")
    rollback_basis = {
        "schema": "kungfu.mission-control.authority-rollback-basis/v1",
        "transition": "kungfu-native-to-atlas",
        "previous_migration_id": expected_migration_id,
        "actor": actor,
        "actor_type": actor_type,
        "reason": reason,
    }
    migration_id = f"authority-{_sha256_root(rollback_basis)[7:31]}"
    record = {
        "claim_id": migration_id,
        "claim_type": AUTHORITY_MIGRATION_CLAIM,
        "migration_id": migration_id,
        "migration_status": "rolled-back",
        "write_authority": ATLAS_FACT_SOURCE_ID,
        "previous_write_authority": "kungfu-native",
        "previous_migration_id": expected_migration_id,
        "legacy_mutation_path": "restored",
        "native_fact_disposition": "retained-read-only",
        "rollback_action": "cutover-authority",
        "parity_root": current["parity_root"],
        "reason": reason,
        "authorized_by": actor,
        "actor_type": actor_type,
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
        "links": {},
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="authority-migration",
        surface_id=CLAIM_SURFACE_ID,
        subject_key=f"{AUTHORITY_SUBJECT_PREFIX}{migration_id}",
        source_id=source_id,
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.mission-control.authority-rollback-receipt/v1",
        "status": "rolled-back",
        "migration": record,
        "receipt": receipt,
    }


def create_mission(
    runtime_dir: str,
    *,
    mission_id: str,
    title: str,
    intent: str,
    actor: str,
    actor_type: str = "agent",
    status: str = "active",
    horizon: str = "long-term",
    system_time: int = 0,
) -> dict[str, Any]:
    """Create one Kungfu-native Mission in the shared Fact Library."""

    _ensure_native_write_allowed(runtime_dir)
    system_time = system_time or time.time_ns()
    _ensure_contract(runtime_dir, system_time)
    system_time += len(FACT_SURFACES) + 1
    mission_id = _stable_id(mission_id, "mission_id")
    existing = [
        row for row in list_missions(runtime_dir) if row.get("mission_id") == mission_id
    ]
    if any(row.get("subject_key") != f"kungfu:{mission_id}" for row in existing):
        raise ValueError(
            f"mission_id already belongs to another source authority: {mission_id}"
        )
    if status not in {"proposed", "active", "paused"}:
        raise ValueError("native Mission status must be proposed, active, or paused")
    source_id = _native_source(actor_type)
    record = {
        "mission_id": mission_id,
        "title": title.strip(),
        "intent": intent.strip(),
        "status": status,
        "horizon": horizon.strip() or "long-term",
        "owner": actor.strip(),
        "actor_type": actor_type,
    }
    if not record["title"] or not record["intent"] or not record["owner"]:
        raise ValueError("title, intent, and actor are required")
    subject_key = f"kungfu:{mission_id}"
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": record["owner"],
        },
        "links": {"mission_id": subject_key},
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="mission",
        surface_id=MISSION_SURFACE_ID,
        subject_key=subject_key,
        source_id=source_id,
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.mission-control.mission-write/v1",
        "authority_mode": "kungfu-native",
        "mission_subject": subject_key,
        "receipt": receipt,
    }


def create_go(
    runtime_dir: str,
    *,
    mission_id: str,
    goal_id: str,
    title: str,
    objective: str,
    actor: str,
    actor_type: str = "agent",
    storage_source_id: str = "atlas",
    status: str = "active",
    parent_goal_id: str = "",
    depends_on: list[str] | None = None,
    responsibility: str = "",
    acceptance_root: str = "",
    atlas_root: str = "",
    project_cut_root: str = "",
    evidence_episode_roots: list[str] | None = None,
    system_time: int = 0,
) -> dict[str, Any]:
    """Create one Kungfu-native Go linked to an admitted Mission."""

    _ensure_native_write_allowed(runtime_dir)
    system_time = system_time or time.time_ns()
    _ensure_contract(runtime_dir, system_time)
    mission_subject, _, _ = _selected_subjects(
        runtime_dir,
        mission_id=mission_id,
        storage_source_id=storage_source_id,
        cut_system_time=0,
    )
    goal_id = _stable_id(goal_id, "goal_id")
    existing_goals = query_state(
        runtime_dir,
        mission_id=mission_id,
        storage_source_id=storage_source_id,
    )["goals"]
    conflicting = [
        row
        for row in existing_goals
        if row.get("payload", {}).get("record", {}).get("goal_id") == goal_id
        and row.get("subject_key") != f"kungfu:{goal_id}"
    ]
    if conflicting:
        raise ValueError(
            f"goal_id already belongs to another source authority: {goal_id}"
        )
    if status not in {"proposed", "active", "blocked", "waiting-for-decision"}:
        raise ValueError("native Go status is not in the v1 responsibility vocabulary")
    parent_goal_id = (
        _stable_id(parent_goal_id, "parent_goal_id") if parent_goal_id.strip() else ""
    )
    dependencies = sorted(
        {_stable_id(str(dependency), "depends_on") for dependency in (depends_on or [])}
    )
    if goal_id in dependencies:
        raise ValueError("a Go cannot depend on itself")
    acceptance_root = _root_id(acceptance_root, "acceptance_root")
    atlas_root = _root_id(atlas_root, "atlas_root")
    project_cut_root = _root_id(project_cut_root, "project_cut_root")
    episode_roots = sorted(
        {
            _root_id(str(root), "evidence_episode_root", required=True)
            for root in (evidence_episode_roots or [])
        }
    )
    source_id = _native_source(actor_type)
    subject_key = f"kungfu:{goal_id}"
    record = {
        "goal_id": goal_id,
        "title": title.strip(),
        "objective": objective.strip(),
        "status": status,
        "mission_id": mission_subject.split(":", 1)[-1],
        "mission_subject": mission_subject,
        "actor": actor.strip(),
        "actor_type": actor_type,
        "parent_goal_id": parent_goal_id,
        "depends_on": dependencies,
        "responsibility": responsibility.strip() or actor.strip(),
        "acceptance_root": acceptance_root,
        "input_atlas_root": atlas_root,
        "project_cut_root": project_cut_root,
        "evidence_episode_roots": episode_roots,
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
        "links": {"mission_id": mission_subject},
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="go",
        surface_id=GO_SURFACE_ID,
        subject_key=subject_key,
        source_id=source_id,
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.mission-control.go-write/v1",
        "authority_mode": "kungfu-native",
        "mission_subject": mission_subject,
        "go_subject": subject_key,
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
    goal_id: str,
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
            "schema": "kungfu.mission-control.tracked-completion-evidence/v1",
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

    target_goal = next(
        (
            row
            for row in state.get("goals", [])
            if row.get("payload", {}).get("record", {}).get("goal_id") == goal_id
            or row.get("subject_key") in {goal_id, f"kungfu:{goal_id}"}
        ),
        None,
    )
    goal_record = (target_goal or {}).get("payload", {}).get("record", {})
    expected_go_set = {goal_id}
    expected_go_set.update(
        str(row.get("payload", {}).get("record", {}).get("goal_id") or "")
        for row in state.get("goals", [])
        if row.get("payload", {}).get("record", {}).get("parent_goal_id") == goal_id
    )
    expected_go_set.discard("")
    if set(claim_record.get("go_set") or []) != expected_go_set:
        reject(
            "incomplete-parent-acceptance", "completion Go set omits or adds a child"
        )
    for claim_key, goal_key, code in (
        ("acceptance_root", "acceptance_root", "acceptance-root-mismatch"),
        ("input_atlas_root", "input_atlas_root", "stale-atlas"),
        ("project_cut_root", "project_cut_root", "project-cut-root-mismatch"),
    ):
        expected = str(goal_record.get(goal_key) or "")
        actual = str(claim_record.get(claim_key) or "")
        if not expected or actual != expected:
            reject(code, f"claim {claim_key} differs from the Go contract")

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
            + str(cut.get("atlasRoot") or "").removeprefix("sha256:")
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
                path == prefix
                or path.startswith(prefix + ":")
                or path.startswith(prefix + "/")
                for prefix in scoped_paths
                if prefix
            ):
                reject(
                    str(row.get("code") or "project-cut-invalid"),
                    str(row.get("detail") or row),
                )
        comparisons = (
            ("cutRoot", "project_cut_root", "project-cut-root-mismatch"),
            ("atlasRoot", "result_atlas_root", "stale-atlas"),
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
        if not claimed_episode_roots or not claimed_episode_roots.issubset(
            sealed_episode_roots
        ):
            reject(
                "missing-episode", "claimed Episode is not sealed by the Project Cut"
            )

    diagnostics.sort(key=lambda row: (row["code"], row["detail"]))
    evidence = {
        "schema": "kungfu.mission-control.tracked-completion-evidence/v1",
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
    mission_id: str,
    goal_id: str,
    statement: str,
    actor: str,
    actor_type: str = "agent",
    storage_source_id: str = "atlas",
    evidence_episode_ids: list[int] | None = None,
    go_set: list[str] | None = None,
    acceptance_root: str = "",
    input_atlas_root: str = "",
    result_atlas_root: str = "",
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
        mission_id=mission_id,
        storage_source_id=storage_source_id,
    )
    goal_id = _stable_id(goal_id, "goal_id")
    goal = next(
        (
            row
            for row in state["goals"]
            if row.get("subject_key") == goal_id
            or row.get("subject_key") == f"kungfu:{goal_id}"
            or row.get("payload", {}).get("record", {}).get("goal_id") == goal_id
        ),
        None,
    )
    if goal is None:
        raise ValueError(f"Go not found under Mission: {goal_id}")
    if not statement.strip() or not actor.strip():
        raise ValueError("statement and actor are required")
    evidence = [
        _verified_episode(runtime_dir, int(episode_id))
        for episode_id in (evidence_episode_ids or [])
    ]
    go_set = [_stable_id(row, "go_set") for row in (go_set or [goal_id])]
    if goal_id not in go_set:
        raise ValueError("go_set must contain the claimed goal_id")
    if len(set(go_set)) != len(go_set):
        raise ValueError("go_set must not contain duplicates")
    roots = {
        "acceptance_root": _root_id(acceptance_root, "acceptance_root"),
        "input_atlas_root": _root_id(input_atlas_root, "input_atlas_root"),
        "result_atlas_root": _root_id(result_atlas_root, "result_atlas_root"),
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
            raise ValueError("evidence_availability rows must be objects")
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
        "mission_subject": state["mission_subject"],
        "go_subject": str(goal["subject_key"]),
        "statement": statement.strip(),
        "actor": actor.strip(),
        "evidence": evidence,
        "go_set": sorted(go_set),
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
        "go_set": sorted(go_set),
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
            "mission_id": state["mission_subject"],
            "go_id": str(goal["subject_key"]),
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
        "schema": "kungfu.mission-control.completion-claim-write/v1",
        "authority_mode": "kungfu-native",
        "mission_subject": state["mission_subject"],
        "go_subject": str(goal["subject_key"]),
        "claim": record,
        "receipt": receipt,
    }


def _assessment_evidence(state: dict[str, Any]) -> dict[str, int]:
    lineage = state["lineage"]
    counts = {
        "admitted": 0,
        "unregistered-surface": 0,
        "incompatible-schema": 0,
        "ambiguous-authority": 0,
        "unverifiable": 0,
    }
    for row in lineage.get("admission_outcomes", []):
        outcome = str(row.get("outcome") or "unverifiable")
        if outcome in counts:
            counts[outcome] += int(row.get("record_count") or 0)
    return {
        "canonical_fact_count": len(state["rows"]),
        "conflict_count": len(lineage.get("conflicts", [])),
        "admitted_count": counts["admitted"],
        "unregistered_surface_count": counts["unregistered-surface"],
        "incompatible_schema_count": counts["incompatible-schema"],
        "ambiguous_authority_count": counts["ambiguous-authority"],
        "unverifiable_count": counts["unverifiable"]
        + len(lineage.get("unverifiable_inputs", [])),
    }


def _responsibility_state(state: dict[str, Any]) -> dict[str, Any]:
    source_statuses = [
        str(row.get("payload", {}).get("record", {}).get("status") or "unknown")
        for row in state.get("goals", [])
    ]
    normalized = []
    for status in source_statuses:
        if status in {"blocked", "paused"}:
            normalized.append("blocked")
        elif status in {"waiting", "waiting-for-decision"}:
            normalized.append("waiting-for-decision")
        elif status in {"claimed-complete", "completed", "merged", "closed"}:
            normalized.append("claimed-complete")
        elif status in {"active", "reviewing", "stage-ready", "ready"}:
            normalized.append("active")
        else:
            normalized.append("proposed")
    has_completion_claim = any(
        row.get("payload", {}).get("record", {}).get("claim_type") == COMPLETION_CLAIM
        for row in state.get("claims", [])
    )
    if has_completion_claim:
        normalized.append("claimed-complete")
    selected = "proposed"
    for candidate in (
        "blocked",
        "waiting-for-decision",
        "claimed-complete",
        "active",
    ):
        if candidate in normalized:
            selected = candidate
            break
    return {
        "value": selected,
        "source_statuses": source_statuses,
        "mapping_policy": "kungfu.profile.responsibility-state/v1",
        "go_subjects": [
            str(row.get("subject_key") or "") for row in state.get("goals", [])
        ],
        "completion_claim_count": len(state.get("claims", [])),
    }


def _episode_root(value: dict[str, Any]) -> str:
    recorded = value.get("recorded") or {}
    if value.get("match") is not True:
        return ""
    root = str(recorded.get("root_value") or "")
    if root and not root.startswith("sha256:"):
        root = "sha256:" + root
    return root


def _cost_profile(runtime_dir: str, state: dict[str, Any]) -> dict[str, Any]:
    work_ids = {str(row.get("subject_key") or "") for row in state.get("goals", [])}
    work_ids.update(
        str(row.get("payload", {}).get("record", {}).get("goal_id") or "")
        for row in state.get("goals", [])
    )
    work_ids.discard("")
    declared_cut = state.get("cut", {}).get("declared", {})
    cost_cut = (
        int(declared_cut.get("system_time") or 0)
        if declared_cut.get("kind") == "system_time"
        else 0
    )
    # Open the Episode fold before Rewind readers. Both are journal-backed, and
    # this pins one visibility frontier for the profile instead of letting a
    # later reader construction observe a different filesystem snapshot.
    first_episode_rows = storage_service.episode_list(runtime_dir).get("episodes", [])
    refreshed_episode_rows = storage_service.episode_list(runtime_dir).get(
        "episodes", []
    )
    episode_rows = list(
        {
            str(row.get("episode_id") or ""): row
            for row in [*first_episode_rows, *refreshed_episode_rows]
        }.values()
    )
    rewind_root = Path(runtime_dir) / "rewind"
    observations: list[dict[str, Any]] = []
    unreadable_runs = []
    episode_id_by_run = {}
    episode_by_run = {}
    for episode in episode_rows:
        source = str(episode.get("open", {}).get("source") or "")
        if source.startswith("rewind:"):
            episode_by_run[source.removeprefix("rewind:")] = episode
    run_ids = set(episode_by_run)
    if rewind_root.is_dir():
        run_ids.update(path.name for path in rewind_root.iterdir() if path.is_dir())
    for run_id in sorted(run_ids):
        run_dir = rewind_root / run_id
        if run_dir.is_dir():
            manifest_path = run_dir / "bundle" / "manifest.json"
            if manifest_path.is_file():
                try:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    episode_id = manifest.get("fact_bridge", {}).get("episode_id") or ""
                    if str(episode_id).isdigit():
                        episode_id_by_run[run_id] = str(episode_id)
                except (OSError, ValueError, TypeError):
                    pass
        try:
            frames = rewind_replay.read_frames(runtime_dir, run_id)
        except (FileNotFoundError, RuntimeError, ValueError) as error:
            unreadable_runs.append({"run_id": run_id, "error": type(error).__name__})
            continue
        for action_type, header, payload in frames:
            if action_type != ACTION_COST_SNAPSHOT:
                continue
            if cost_cut and int(header.gen_time) > cost_cut:
                continue
            fact = rewind_replay.decode_native(action_type, payload)
            if str(fact.get("work_id") or "") not in work_ids:
                continue
            observations.append(
                {
                    "run_id": str(fact.get("run_id") or run_id),
                    "work_id": str(fact.get("work_id") or ""),
                    "system_time": str(header.gen_time),
                    "provider": str(fact.get("provider") or ""),
                    "surface": str(fact.get("surface") or ""),
                    "model": str(fact.get("model") or ""),
                    "source": str(fact.get("source") or ""),
                    "attribution": ATTRIBUTION_NAMES.get(
                        int(fact.get("attribution") or 0), "unknown"
                    ),
                    "attribution_rank": int(fact.get("attribution") or 0),
                    "ambiguous": bool(fact.get("ambiguous_attribution")),
                    "input_tokens": int(fact.get("input_tokens") or 0),
                    "output_tokens": int(fact.get("output_tokens") or 0),
                    "cached_input_tokens": int(fact.get("cached_input_tokens") or 0),
                    "cache_creation_input_tokens": int(
                        fact.get("cache_creation_input_tokens") or 0
                    ),
                    "reasoning_tokens": int(fact.get("reasoning_tokens") or 0),
                    "cost_usd": (
                        float(fact.get("cost_usd") or 0.0)
                        if fact.get("cost_usd_known")
                        else None
                    ),
                }
            )
    proof_episodes = []
    unsealed_runs = []
    for run_id in sorted({row["run_id"] for row in observations}):
        episode_id = episode_id_by_run.get(run_id)
        episode = episode_by_run.get(run_id)
        if episode_id is None and episode is not None:
            episode_id = str(episode["episode_id"])
        if episode_id is None:
            unsealed_runs.append(run_id)
            continue
        try:
            verified = _verified_episode(runtime_dir, int(episode_id))
        except ValueError:
            unsealed_runs.append(run_id)
            continue
        proof_episodes.append(
            {
                "run_id": run_id,
                "episode_id": episode_id,
                "episode_root": verified["episode_root"],
            }
        )

    tokens = {
        name: sum(int(row[name]) for row in observations)
        for name in (
            "input_tokens",
            "output_tokens",
            "cached_input_tokens",
            "cache_creation_input_tokens",
            "reasoning_tokens",
        )
    }
    known_costs = [
        float(row["cost_usd"])
        for row in observations
        if row.get("cost_usd") is not None
    ]
    ambiguous = any(bool(row["ambiguous"]) for row in observations)
    if not observations:
        status = "missing"
    elif ambiguous:
        status = "ambiguous"
    elif len(known_costs) != len(observations) or unsealed_runs:
        status = "partial"
    else:
        status = "attributed"
    ranks = [int(row["attribution_rank"]) for row in observations]
    return {
        "status": status,
        "observation_count": len(observations),
        "linked_run_count": len({row["run_id"] for row in observations}),
        "tokens": tokens,
        "cost_usd": round(sum(known_costs), 12) if known_costs else None,
        "cost_usd_known": bool(observations) and len(known_costs) == len(observations),
        "attribution": {
            "best": ATTRIBUTION_NAMES.get(min(ranks), "unknown")
            if ranks
            else "missing",
            "worst": ATTRIBUTION_NAMES.get(max(ranks), "unknown")
            if ranks
            else "missing",
            "ambiguous": ambiguous,
        },
        "observations": observations,
        "proof_episodes": proof_episodes,
        "missing": {
            "unsealed_runs": unsealed_runs,
            "unreadable_runs": unreadable_runs,
            "no_linked_cost_fact": not observations,
        },
    }


def build_cost_state_proof_profile(
    runtime_dir: str,
    state: dict[str, Any],
    *,
    assessment_state: str,
    report_hash: str | None,
    go_subject: str | None = None,
) -> dict[str, Any]:
    """Compose the first commercial profile without creating new authorities."""

    profile_state = state
    if go_subject:
        profile_state = {
            **state,
            "goals": [
                row
                for row in state.get("goals", [])
                if row["subject_key"] == go_subject
            ],
            "claims": [
                row
                for row in state.get("claims", [])
                if row.get("payload", {}).get("links", {}).get("go_id") == go_subject
            ],
        }
    cost = _cost_profile(runtime_dir, profile_state)
    proof = {
        "canonical_state": bool(state.get("canonical_state")),
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": state["query_proof_root"],
        "query_result_hash": state["result_hash"],
        "verified_fact_episode_roots": state["lineage"].get(
            "episode_content_roots", []
        ),
        "cost_episode_roots": cost["proof_episodes"],
        "assessment_state": assessment_state,
        "assessment_report_hash": report_hash,
        "conflicts": state["lineage"].get("conflicts", []),
        "unverifiable_inputs": state["lineage"].get("unverifiable_inputs", []),
    }
    profile = {
        "schema": "kungfu.profile.delegated-work-cost-state-proof/v1",
        "profile": {
            "id": COST_STATE_PROOF_PROFILE_ID,
            "version": COST_STATE_PROOF_PROFILE_VERSION,
        },
        "mission_subject": state["mission_subject"],
        "go_subject": go_subject,
        "cost": cost,
        "state": _responsibility_state(profile_state),
        "proof": proof,
    }
    profile["profile_hash"] = _sha256_root(profile)
    return profile


def _mission_control_answers(
    state: dict[str, Any],
    *,
    fitness: str,
    assessment_state: str,
    findings: list[str],
    known_limits: list[str],
) -> list[dict[str, Any]]:
    mission = (state.get("mission") or {}).get("payload", {}).get("record", {})
    goals = [row.get("payload", {}).get("record", {}) for row in state.get("goals", [])]
    statuses: dict[str, int] = {}
    for goal in goals:
        status = str(goal.get("status") or "unknown")
        statuses[status] = statuses.get(status, 0) + 1
    status_summary = " · ".join(
        f"{status}={statuses[status]}" for status in sorted(statuses)
    )

    intent = "Not yet declared. Create or import a Mission."
    if mission:
        identity = str(mission.get("title") or mission.get("mission_id") or "Mission")
        intent = f"{identity} — {mission.get('intent') or 'intent not declared'}"
        if mission.get("stage_name"):
            intent += f" · stage {mission['stage_name']}"

    actual = "No admitted Go activity is visible at this cut."
    if goals:
        actual = f"{len(goals)} Go(s) at this cut"
        if status_summary:
            actual += f" · {status_summary}"

    declared_actions = []
    for goal in goals:
        if str(goal.get("next_action") or "").strip():
            declared_actions.append(
                {
                    "actor": str(goal.get("owner_agent") or goal.get("actor") or ""),
                    "subject": str(goal.get("goal_id") or ""),
                    "action": str(goal["next_action"]),
                    "source": "go.next_action",
                }
            )
    if str(mission.get("next_action") or "").strip():
        declared_actions.append(
            {
                "actor": str(mission.get("owner") or ""),
                "subject": str(mission.get("mission_id") or ""),
                "action": str(mission["next_action"]),
                "source": "mission.next_action",
            }
        )
    if declared_actions:
        next_summary = " · ".join(
            f"{item['actor'] or item['subject'] or 'declared actor'}: {item['action']}"
            for item in declared_actions
        )
        responsibility_state = "declared"
    elif fitness == "fit":
        next_summary = "No next action or responsible actor is declared at this cut."
        responsibility_state = "undeclared"
    else:
        next_summary = (
            "A decision or additional evidence is required, but no responsible "
            "actor is declared at this cut."
        )
        responsibility_state = "needs-decision"

    proof_suffix = str(state.get("query_proof_root") or "")[-12:]
    answers_by_id: dict[str, dict[str, Any]] = {
        "mission-intent": {
            "status": "declared" if mission else "missing",
            "summary": intent,
            "data": {"mission": mission},
        },
        "observed-progress": {
            "status": "observed" if goals else "missing",
            "summary": actual,
            "data": {"goal_count": len(goals), "status_counts": statuses},
        },
        "evidence-at-cut": {
            "status": "established" if state.get("canonical_state") else "degraded",
            "summary": (
                f"{'canonical' if state.get('canonical_state') else 'degraded'} cut"
                f" · {len(findings)} finding(s) · proof {proof_suffix or '-'}"
            ),
            "data": {
                "canonical_state": bool(state.get("canonical_state")),
                "cut": state.get("cut", {}),
                "findings": findings,
                "query_definition_root": state.get("query_definition_root", ""),
                "query_proof_root": state.get("query_proof_root", ""),
            },
        },
        "fitness-for-purpose": {
            "status": fitness,
            "summary": (
                f"{fitness} · assessment {assessment_state}"
                f" · residual limits {len(known_limits)}"
            ),
            "data": {
                "fitness": fitness,
                "assessment_state": assessment_state,
                "known_limits": known_limits,
            },
        },
        "next-responsibility": {
            "status": responsibility_state,
            "summary": next_summary,
            "data": {"declared_actions": declared_actions},
        },
    }
    return [
        {"question_id": question_id, "question": question, **answers_by_id[question_id]}
        for question_id, question in MISSION_CONTROL_QUESTIONS
    ]


def build_mission_control_query_profile(
    runtime_dir: str,
    state: dict[str, Any],
    *,
    fitness: str,
    assessment_state: str,
    findings: list[str],
    known_limits: list[str],
) -> dict[str, Any]:
    """Reduce one public Profile query receipt into the five Mission questions."""

    definition = _runtime_query_definition(state["definition"])
    if definition.get("schema") != "kungfu.query.definition/v1":
        raise RuntimeError(
            "Mission Control profile requires one portable QueryDefinition"
        )
    context = _profile_context(runtime_dir)
    catalog = context["catalog"]
    views = [
        {
            "view_id": row["id"],
            "title": row["title"],
            "fact_surfaces": row["factSurfaces"],
            "query_family": row.get("queryFamily"),
            "view": row["view"],
        }
        for row in catalog["views"]
    ]
    profile = {
        "schema": "kungfu.mission-control.query-profile/v1",
        "profile": {
            "id": MISSION_CONTROL_PROFILE_ID,
            "version": MISSION_CONTROL_PROFILE_VERSION,
            "reducer": MISSION_CONTROL_REDUCER,
            "profile_suite_root": catalog["profileSuiteRoot"],
            "catalog_root": catalog["catalogRoot"],
            "member_roots": catalog["memberRoots"],
        },
        "mission_subject": state["mission_subject"],
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": state["query_proof_root"],
        "result_hash": state["result_hash"],
        "query_receipt": state["profile_query_receipt"],
        "views": views,
        "answers": _mission_control_answers(
            state,
            fitness=fitness,
            assessment_state=assessment_state,
            findings=findings,
            known_limits=known_limits,
        ),
    }
    profile["profile_hash"] = _sha256_root(profile)
    return profile


def _progress_fitness(
    state: dict[str, Any], assessment_state: str
) -> tuple[str, list[str]]:
    if assessment_state != "fresh":
        mapped = {
            "insufficient-evidence": "insufficient",
            "conflicted": "conflicted",
            "stale": "stale",
            "unverifiable": "unverifiable",
        }
        return mapped.get(assessment_state, "warning"), [
            f"assessment state is {assessment_state}"
        ]
    if not state.get("canonical_state"):
        return "unverifiable", ["query lineage is not canonical"]
    if state.get("mission") is None:
        return "insufficient", ["Mission fact is missing"]
    goals = state.get("goals", [])
    if not goals:
        return "insufficient", ["no linked Go facts are admitted"]
    statuses = [
        str(row.get("payload", {}).get("record", {}).get("status") or "unknown")
        for row in goals
    ]
    warning_statuses = set(PROGRESS_POLICY["rules"]["warning_statuses"])
    progress_statuses = set(PROGRESS_POLICY["rules"]["progress_statuses"])
    findings = [f"linked Go statuses: {', '.join(statuses)}"]
    if any(status in warning_statuses for status in statuses):
        return "warning", findings
    if any(status in progress_statuses for status in statuses):
        return "fit", findings
    return "warning", findings + ["no Go carries a recognized progress state"]


def _execute_profile_assessment(
    runtime_dir: str,
    *,
    source: str,
    query_receipt: dict[str, Any],
    claim_type_id: str,
    claim_instance_id: str,
    policy_id: str,
    purpose: str,
    work_episode_id: int,
    independent_observation: dict[str, Any],
    executor_profile: str,
    authorized_by: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    plan = profile_composition.assessment_plan(
        source,
        runtime_dir,
        query_receipt,
        claim_id=claim_type_id,
        claim_instance_id=claim_instance_id,
        policy_id=policy_id,
        purpose=purpose,
        work_episode_id=work_episode_id,
        independent_observation=independent_observation,
        executor_profile=executor_profile,
    )
    authorization = profile_sdk.answer_decision(
        plan["decisionCard"], "approve", authorized_by
    )
    receipt = profile_composition.authorized_assessment_execute(
        runtime_dir, plan, authorization
    )
    return plan, authorization, receipt


def assess_progress(
    runtime_dir: str,
    *,
    mission_id: str,
    storage_source_id: str = "atlas",
    purpose: str = PROGRESS_PURPOSE,
    cut_system_time: int = 0,
    executor_profile: str = "thread",
    authorized_by: str = "kungfu-mission-control",
) -> dict[str, Any]:
    """Persist and expose the first purpose-bound Mission progress report."""

    state = query_state(
        runtime_dir,
        mission_id=mission_id,
        storage_source_id=storage_source_id,
        cut_system_time=cut_system_time,
    )
    if not state["rows"]:
        raise ValueError("Mission progress assessment requires admitted facts")
    context = _profile_context(runtime_dir)
    work_row = max(state["rows"], key=lambda row: int(row["system_time"]))
    work_episode_id = str(work_row["episode_id"])
    root_rows = {
        str(row.get("episode_id")): str(row.get("computed") or "")
        for row in state["lineage"].get("episode_content_roots", [])
    }
    work_episode_root = root_rows.get(work_episode_id, "")
    if not work_episode_root:
        raise RuntimeError("selected Mission/Go fact Episode has no verified root")
    claim_basis = {
        "claim_type": PROGRESS_CLAIM,
        "mission_subject": state["mission_subject"],
        "purpose": purpose,
        "query_result_hash": state["result_hash"],
    }
    claim_instance_id = f"mission-progress-{_sha256_root(claim_basis)[7:31]}"
    plan, authorization, receipt = _execute_profile_assessment(
        runtime_dir,
        source=context["source"],
        query_receipt=state["profile_query_receipt"],
        claim_type_id=PROGRESS_CLAIM,
        claim_instance_id=claim_instance_id,
        policy_id="mission-progress-policy",
        purpose=purpose,
        work_episode_id=int(work_episode_id),
        independent_observation={
            "episodeRoot": work_episode_root,
            "authority": "admitted-source",
            "relation": "admitted-source",
        },
        executor_profile=executor_profile,
        authorized_by=authorized_by,
    )
    assessed = receipt["assessment"]
    request = plan["request"]
    fitness, findings = _progress_fitness(state, assessed["state"])
    report_hash = assessed.get("report", {}).get("report_hash")
    query_profile = build_mission_control_query_profile(
        runtime_dir,
        state,
        fitness=fitness,
        assessment_state=assessed["state"],
        findings=findings,
        known_limits=request["residual_risks"],
    )
    return {
        "schema": "kungfu.mission-control.trust-report/v1",
        "claim": {
            "id": claim_instance_id,
            "type": PROGRESS_CLAIM,
            "purpose": purpose,
        },
        "fitness": fitness,
        "findings": findings,
        "known_limits": request["residual_risks"],
        "state": state,
        "assessment": assessed,
        "assessment_plan": plan,
        "assessment_authorization": authorization,
        "assessment_receipt": receipt,
        "assessment_key": assessed["assessment_key"],
        "report_hash": report_hash,
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": state["query_proof_root"],
        "query_profile": query_profile,
        "profile": build_cost_state_proof_profile(
            runtime_dir,
            state,
            assessment_state=assessed["state"],
            report_hash=report_hash,
        ),
    }


def assess_completion(
    runtime_dir: str,
    *,
    mission_id: str,
    goal_id: str,
    storage_source_id: str = "atlas",
    purpose: str = COMPLETION_PURPOSE,
    cut_system_time: int = 0,
    executor_profile: str = "thread",
    authorized_by: str = "kungfu-mission-control",
) -> dict[str, Any]:
    """Assess one explicit completion claim against independent Episode proof."""

    state = query_state(
        runtime_dir,
        mission_id=mission_id,
        storage_source_id=storage_source_id,
        cut_system_time=cut_system_time,
    )
    goal_id = _stable_id(goal_id, "goal_id")
    goals = [
        row
        for row in state["goals"]
        if row.get("subject_key") == goal_id
        or row.get("subject_key") == f"kungfu:{goal_id}"
        or row.get("payload", {}).get("record", {}).get("goal_id") == goal_id
    ]
    if len(goals) != 1:
        raise ValueError(f"Go is missing or ambiguous under Mission: {goal_id}")
    goal_subject = str(goals[0]["subject_key"])
    claims = [
        row
        for row in state["claims"]
        if row.get("payload", {}).get("record", {}).get("claim_type")
        == COMPLETION_CLAIM
        and row.get("payload", {}).get("links", {}).get("go_id") == goal_subject
    ]
    if not claims:
        raise ValueError(f"completion claim not found for Go: {goal_id}")
    context = _profile_context(runtime_dir)
    claim = max(claims, key=lambda row: int(row["system_time"]))
    claim_record = claim["payload"]["record"]
    verified_evidence = []
    invalid_evidence = []
    for reference in claim_record.get("evidence_episodes", []):
        episode_id = int(reference["episode_id"])
        try:
            current = _verified_episode(runtime_dir, episode_id)
        except ValueError as error:
            invalid_evidence.append(
                {"episode_id": str(episode_id), "reason": str(error)}
            )
            continue
        if current["episode_root"] != reference.get("episode_root"):
            invalid_evidence.append(
                {
                    "episode_id": str(episode_id),
                    "reason": "content root changed since the claim",
                }
            )
            continue
        verified_evidence.append(current)

    root_rows = {
        str(row.get("episode_id")): str(row.get("computed") or "")
        for row in state["lineage"].get("episode_content_roots", [])
    }
    claim_episode_id = str(claim["episode_id"])
    claim_episode_root = root_rows.get(claim_episode_id, "")
    if verified_evidence:
        work_episode_id = verified_evidence[0]["episode_id"]
        work_episode_root = verified_evidence[0]["episode_root"]
    else:
        work_episode_id = claim_episode_id
        work_episode_root = claim_episode_root
    if not work_episode_root:
        raise RuntimeError("completion claim has no verified work or claim Episode")

    evidence = _assessment_evidence(state)
    if not verified_evidence:
        evidence["unverifiable_count"] += 1
    evidence["unverifiable_count"] += len(invalid_evidence)
    composite_proof = {
        "state_query_proof_root": state["query_proof_root"],
        "completion_claim_observation_id": claim["observation_id"],
        "verified_evidence": verified_evidence,
        "invalid_evidence": invalid_evidence,
    }
    assessment_plan = None
    assessment_authorization = None
    assessment_receipt = None
    if verified_evidence:
        assessment_plan, assessment_authorization, assessment_receipt = (
            _execute_profile_assessment(
                runtime_dir,
                source=context["source"],
                query_receipt=state["profile_query_receipt"],
                claim_type_id=COMPLETION_CLAIM,
                claim_instance_id=claim_record["claim_id"],
                policy_id="task-completion-policy",
                purpose=purpose,
                work_episode_id=int(work_episode_id),
                independent_observation={
                    "episodeRoot": work_episode_root,
                    "authority": "sealed-work-episode",
                    "relation": "observed-work",
                },
                executor_profile=executor_profile,
                authorized_by=authorized_by,
            )
        )
        assessed = assessment_receipt["assessment"]
        request = assessment_plan["request"]
    else:
        # Compatibility projection for an explicitly unproved completion claim.
        # The public Profile plan correctly refuses to manufacture independent
        # evidence; Core records the resulting insufficient state so existing
        # Mission Control cuts remain inspectable.
        declared_claim = next(
            row for row in context["catalog"]["claims"] if row["id"] == COMPLETION_CLAIM
        )
        declared_policy = next(
            row
            for row in context["catalog"]["policies"]
            if row["id"] == "task-completion-policy"
        )
        request = {
            "claim_id": claim_record["claim_id"],
            "claim_type": declared_claim["type"],
            "purpose": purpose,
            "work_episode_id": work_episode_id,
            "work_episode_root": work_episode_root,
            "query_definition_root": state["query_definition_root"],
            "query_proof_root": _sha256_root(composite_proof),
            "contract_world": state["definition"]["basis"]["contract_world"],
            "fact_surfaces": state["definition"]["basis"]["fact_surfaces"],
            "policy": {
                "id": declared_policy["id"],
                "version": declared_policy["version"],
                "root": _sha256_root(declared_policy),
            },
            "evidence": evidence,
            "deadline": 0,
            "responsibility": declared_policy["responsibility"],
            "residual_risks": declared_policy["residualRisks"],
        }
        requested = storage_service.assessment_request(runtime_dir, request)
        assessed = storage_service.assessment_execute(
            runtime_dir,
            requested["assessment_key"],
            executor_profile=executor_profile,
        )
    if not verified_evidence:
        fitness = "insufficient"
    else:
        fitness = (
            "fit"
            if assessed["state"] == "fresh"
            else {
                "insufficient-evidence": "insufficient",
                "conflicted": "conflicted",
                "stale": "stale",
                "unverifiable": "unverifiable",
            }.get(assessed["state"], "warning")
        )
    findings = [
        f"verified completion evidence Episodes: {len(verified_evidence)}",
        f"invalid completion evidence Episodes: {len(invalid_evidence)}",
    ]
    report_hash = assessed.get("report", {}).get("report_hash")
    return {
        "schema": "kungfu.mission-control.trust-report/v1",
        "claim": {
            "id": claim_record["claim_id"],
            "type": COMPLETION_CLAIM,
            "purpose": purpose,
            "go_subject": goal_subject,
        },
        "fitness": fitness,
        "findings": findings,
        "known_limits": request["residual_risks"],
        "state": state,
        "assessment": assessed,
        "assessment_plan": assessment_plan,
        "assessment_authorization": assessment_authorization,
        "assessment_receipt": assessment_receipt,
        "assessment_key": assessed["assessment_key"],
        "report_hash": report_hash,
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": request["query_proof_root"],
        "composite_proof": composite_proof,
        "profile": build_cost_state_proof_profile(
            runtime_dir,
            state,
            assessment_state=assessed["state"],
            report_hash=report_hash,
            go_subject=goal_subject,
        ),
    }


def _review_verdict(
    report: dict[str, Any], claim_record: dict[str, Any]
) -> tuple[str, list[str], list[dict[str, str]]]:
    fitness = str(report.get("fitness") or "unverifiable")
    verdict = {
        "fit": "fit",
        "insufficient": "insufficient",
        "conflicted": "conflicted",
        "stale": "stale",
        "unverifiable": "unverifiable",
    }.get(fitness, "unverifiable")
    findings = list(report.get("findings") or [])
    requests = []
    for row in claim_record.get("evidence_availability", []):
        state = str(row.get("state") or "")
        if state == "available":
            continue
        request = {
            "acceptance": str(row.get("acceptance") or ""),
            "level": str(row.get("level") or ""),
            "state": state,
            "action": "request-evidence",
        }
        if request["level"] == "full":
            request["command"] = (
                "./shifu workspace request-full-evidence <checkout> --json"
            )
        requests.append(request)
        findings.append(
            f"{request['level']} evidence is {state} for {request['acceptance']}"
        )
        if request["level"] == "thin" or state == "missing":
            verdict = "insufficient"
        elif verdict == "fit":
            verdict = "partial"
    gaps = [str(row) for row in claim_record.get("known_gaps", []) if str(row)]
    if gaps and verdict == "fit":
        verdict = "partial"
    findings.extend(f"known gap: {row}" for row in gaps)
    if verdict not in REVIEW_VERDICTS:
        verdict = "unverifiable"
    return verdict, findings, requests


def _continuation_actions(verdict: str) -> list[str]:
    return {
        "fit": ["approve", "close"],
        "partial": ["adjust", "request-evidence", "create-follow-up"],
        "insufficient": ["request-evidence", "reopen", "create-follow-up"],
        "conflicted": ["request-evidence", "reopen"],
        "stale": ["request-evidence", "reopen"],
        "unverifiable": ["request-evidence", "reopen", "create-follow-up"],
    }[verdict]


def _bounded_followups(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if len(rows or []) > 6:
        raise ValueError("continuation plans may contain at most six follow-up Go rows")
    result: list[dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            raise ValueError("follow-up Go rows must be objects")
        goal_id = _stable_id(str(row.get("goal_id") or ""), "followup.goal_id")
        title = str(row.get("title") or "").strip()
        objective = str(row.get("objective") or "").strip()
        why_created = str(row.get("why_created") or "").strip()
        if not title or not objective or not why_created:
            raise ValueError(
                "follow-up Go title, objective, and why_created are required"
            )
        result.append(
            {
                "goal_id": goal_id,
                "title": title,
                "objective": objective,
                "why_created": why_created,
                "depends_on": sorted(
                    {
                        _stable_id(str(value), "followup.depends_on")
                        for value in row.get("depends_on", [])
                    }
                ),
                "acceptance_root": _root_id(
                    str(row.get("acceptance_root") or ""),
                    "followup.acceptance_root",
                ),
            }
        )
    if len({row["goal_id"] for row in result}) != len(result):
        raise ValueError("continuation plan follow-up goal ids must be unique")
    result.sort(key=lambda row: row["goal_id"])
    return result


def review_completion(
    runtime_dir: str,
    *,
    mission_id: str,
    goal_id: str,
    reviewer: str,
    reviewer_source: str,
    storage_source_id: str = "atlas",
    purpose: str = COMPLETION_PURPOSE,
    cut_system_time: int = 0,
    executor_profile: str = "thread",
    proposed_followups: list[dict[str, Any]] | None = None,
    checkout_path: str = "",
    system_time: int = 0,
) -> dict[str, Any]:
    """Write an independent exact-cut review and deterministic continuation plan."""

    _ensure_native_write_allowed(runtime_dir)
    reviewer = reviewer.strip()
    reviewer_source = reviewer_source.strip()
    if not reviewer or not reviewer_source:
        raise ValueError("reviewer and reviewer_source are required")
    report = assess_completion(
        runtime_dir,
        mission_id=mission_id,
        goal_id=goal_id,
        storage_source_id=storage_source_id,
        purpose=purpose,
        cut_system_time=cut_system_time,
        executor_profile=executor_profile,
        authorized_by=reviewer,
    )
    claim_id = str(report["claim"]["id"])
    claim_rows = [
        row
        for row in report["state"]["claims"]
        if row.get("payload", {}).get("record", {}).get("claim_id") == claim_id
    ]
    if len(claim_rows) != 1:
        raise ValueError("review requires one exact completion claim")
    claim_row = claim_rows[0]
    claim_record = dict(claim_row["payload"]["record"])
    claimant = str(claim_record.get("asserted_by") or "")
    if not claimant or claimant == reviewer:
        raise ValueError("independent reviewer identity must differ from claimant")
    claimant_source = str(
        claim_row.get("payload", {}).get("source", {}).get("source_id") or ""
    )
    if reviewer_source in {claimant, claimant_source}:
        raise ValueError("independent reviewer source must differ from claimant source")
    verdict, findings, evidence_requests = _review_verdict(report, claim_record)
    tracked_evidence = None
    if checkout_path.strip():
        tracked_evidence = _tracked_completion_evidence(
            checkout_path, report["state"], goal_id, claim_record
        )
        findings.extend(
            f"tracked checkout: {row['code']}: {row['detail']}"
            for row in tracked_evidence["diagnostics"]
        )
        if not tracked_evidence["valid"]:
            verdict = "unverifiable"
    followups = _bounded_followups(proposed_followups)
    trust_basis = {
        "schema": "kungfu.mission-control.review-trust-basis/v1",
        "claim_id": claim_id,
        "claim_payload_hash": claim_row["payload_hash"],
        "assessment_key": report["assessment_key"],
        "assessment_report_hash": report.get("report_hash") or "",
        "query_definition_root": report["query_definition_root"],
        "query_proof_root": report["query_proof_root"],
        "reviewer": reviewer,
        "reviewer_source": reviewer_source,
        "verdict": verdict,
        "findings": findings,
        "evidence_requests": evidence_requests,
        "tracked_evidence_root": (
            tracked_evidence.get("evidence_root") if tracked_evidence else None
        ),
    }
    trust_report_root = _sha256_root(trust_basis)
    plan = {
        "schema": "kungfu.mission-control.continuation-plan/v1",
        "claim_id": claim_id,
        "verdict": verdict,
        "allowed_actions": _continuation_actions(verdict),
        "evidence_requests": evidence_requests,
        "followups": followups,
        "authority_gate": (
            "mechanical-only; mission, authority, privacy, security, public-claim, "
            "and irreversible changes require a human actor"
        ),
    }
    plan_root = _sha256_root(plan)
    review_basis = {
        "schema": "kungfu.mission-control.independent-review-basis/v1",
        "mission_subject": report["state"]["mission_subject"],
        "go_subject": report["claim"]["go_subject"],
        "trust_report_root": trust_report_root,
        "plan_root": plan_root,
    }
    review_id = f"review-{_sha256_root(review_basis)[7:31]}"
    record = {
        "review_id": review_id,
        "review_type": INDEPENDENT_REVIEW,
        "claim_id": claim_id,
        "claimant": claimant,
        "reviewer": reviewer,
        "reviewer_source": reviewer_source,
        "purpose": purpose,
        "verdict": verdict,
        "findings": findings,
        "trust_report_root": trust_report_root,
        "assessment_key": report["assessment_key"],
        "assessment_report_hash": report.get("report_hash") or "",
        "query_definition_root": report["query_definition_root"],
        "query_proof_root": report["query_proof_root"],
        "claim_payload_hash": claim_row["payload_hash"],
        "tracked_evidence": tracked_evidence,
        "continuation_plan": plan,
        "continuation_plan_root": plan_root,
    }
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": AGENT_FACT_SOURCE_ID,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": reviewer,
        },
        "links": {
            "mission_id": report["state"]["mission_subject"],
            "go_id": report["claim"]["go_subject"],
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="independent-review",
        surface_id=REVIEW_SURFACE_ID,
        subject_key=f"kungfu:review:{review_id}",
        source_id=AGENT_FACT_SOURCE_ID,
        payload=payload,
        system_time=system_time or time.time_ns(),
    )
    return {
        "schema": "kungfu.mission-control.independent-review/v1",
        "review": record,
        "review_root": _sha256_root(record),
        "continuation_plan_root": plan_root,
        "trust_report": report,
        "receipt": receipt,
    }


def decide_continuation(
    runtime_dir: str,
    *,
    mission_id: str,
    goal_id: str,
    review_id: str,
    expected_review_root: str,
    expected_plan_root: str,
    action: str,
    actor: str,
    actor_type: str = "agent",
    change_class: str = "mechanical",
    storage_source_id: str = "atlas",
    reason: str = "",
    system_time: int = 0,
) -> dict[str, Any]:
    """Append an exact-review continuation decision and materialize bounded follow-ups."""

    _ensure_native_write_allowed(runtime_dir)
    action = action.strip()
    actor = actor.strip()
    reason = reason.strip()
    if action not in CONTINUATION_ACTIONS or not actor or not reason:
        raise ValueError("valid action, actor, and reason are required")
    if change_class != "mechanical" and actor_type != "user":
        raise ValueError(f"human-decision-required for change class {change_class}")
    if action == "stop" and actor_type != "user":
        raise ValueError("stop requires a human actor")
    state = query_state(
        runtime_dir,
        mission_id=mission_id,
        storage_source_id=storage_source_id,
    )
    goal_id = _stable_id(goal_id, "goal_id")
    review_id = _stable_id(review_id, "review_id")
    rows = [
        row
        for row in state["reviews"]
        if row.get("payload", {}).get("record", {}).get("review_id") == review_id
        and row.get("payload", {}).get("record", {}).get("review_type")
        == INDEPENDENT_REVIEW
    ]
    if len(rows) != 1:
        raise ValueError("continuation decision requires one exact independent review")
    review_row = rows[0]
    review = dict(review_row["payload"]["record"])
    review_root = _sha256_root(review)
    if review_root != _root_id(
        expected_review_root, "expected_review_root", required=True
    ):
        raise ValueError("independent review changed before continuation decision")
    if review["continuation_plan_root"] != _root_id(
        expected_plan_root, "expected_plan_root", required=True
    ):
        raise ValueError("continuation plan changed before decision")
    if action not in review["continuation_plan"]["allowed_actions"]:
        raise ValueError(
            f"continuation action {action} is not allowed for verdict {review['verdict']}"
        )
    decision_basis = {
        "schema": "kungfu.mission-control.continuation-decision-basis/v1",
        "review_id": review_id,
        "review_root": review_root,
        "plan_root": expected_plan_root,
        "action": action,
        "actor": actor,
        "actor_type": actor_type,
        "change_class": change_class,
        "reason": reason,
    }
    decision_id = f"decision-{_sha256_root(decision_basis)[7:31]}"
    record = {
        "decision_id": decision_id,
        "review_type": CONTINUATION_DECISION,
        "review_id": review_id,
        "review_root": review_root,
        "continuation_plan_root": expected_plan_root,
        "action": action,
        "actor": actor,
        "actor_type": actor_type,
        "change_class": change_class,
        "reason": reason,
    }
    goal_subject = next(
        (
            str(row["subject_key"])
            for row in state["goals"]
            if row.get("subject_key") in {goal_id, f"kungfu:{goal_id}"}
            or row.get("payload", {}).get("record", {}).get("goal_id") == goal_id
        ),
        "",
    )
    if not goal_subject:
        raise ValueError(f"Go not found under Mission: {goal_id}")
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
        "links": {"mission_id": state["mission_subject"], "go_id": goal_subject},
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="continuation-decision",
        surface_id=REVIEW_SURFACE_ID,
        subject_key=f"kungfu:decision:{decision_id}",
        source_id=source_id,
        payload=payload,
        system_time=system_time or time.time_ns(),
    )
    created = []
    if action == "create-follow-up":
        for followup in review["continuation_plan"]["followups"]:
            created.append(
                create_go(
                    runtime_dir,
                    mission_id=state["mission_subject"],
                    goal_id=followup["goal_id"],
                    title=followup["title"],
                    objective=followup["objective"],
                    actor=actor,
                    actor_type=actor_type,
                    storage_source_id=storage_source_id,
                    parent_goal_id=goal_id,
                    depends_on=followup["depends_on"],
                    responsibility=followup["why_created"],
                    acceptance_root=followup["acceptance_root"],
                )
            )
    return {
        "schema": "kungfu.mission-control.continuation-decision/v1",
        "decision": record,
        "receipt": receipt,
        "created_followups": created,
    }
