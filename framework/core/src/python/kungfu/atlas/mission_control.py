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
import time
from datetime import datetime
from pathlib import Path
from typing import Any

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
ATLAS_FACT_SOURCE_ID = "atlas-adapter"
USER_FACT_SOURCE_ID = "kungfu-user"
AGENT_FACT_SOURCE_ID = "kungfu-agent"

FACT_SURFACES = (MISSION_SURFACE_ID, GO_SURFACE_ID, CLAIM_SURFACE_ID)
PROGRESS_CLAIM = "mission-progress-is-reasonable"
PROGRESS_PURPOSE = "operator-review"
COST_STATE_PROOF_PROFILE_ID = "kungfu.profile.delegated-work-cost-state-proof"
COST_STATE_PROOF_PROFILE_VERSION = "1"
MISSION_CONTROL_PROFILE_ID = "kungfu.mission-control"
MISSION_CONTROL_PROFILE_VERSION = "1"
MISSION_CONTROL_REDUCER = "kungfu.mission-control.reducer/v1"
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


def _ensure_contract(runtime_dir: str, system_time: int) -> dict[str, Any]:
    catalog = storage_service.fact_type_list(runtime_dir)
    legacy_worlds = [
        world
        for world in catalog.get("contract_worlds", [])
        if world.get("id") == CONTRACT_WORLD_ID
        and world.get("version") in LEGACY_CONTRACT_VERSIONS
    ]
    worlds = [
        world
        for world in catalog.get("contract_worlds", [])
        if world.get("id") == CONTRACT_WORLD_ID
        and world.get("version") == CONTRACT_VERSION
    ]
    if len(worlds) > 1:
        raise RuntimeError("mission-control contract world is ambiguous")
    if not worlds and legacy_worlds:
        raise RuntimeError(
            "mission-control v1/v2 data requires explicit migration or re-import "
            "into a clean pre-release data root before v3 native Mission operations"
        )
    if worlds:
        declared = set(worlds[0].get("fact_surface_ids") or [])
        if declared != set(FACT_SURFACES):
            raise RuntimeError(
                "mission-control contract world has an incompatible surface register"
            )
    else:
        storage_service.fact_declare_contract_world(
            runtime_dir,
            {
                "id": CONTRACT_WORLD_ID,
                "version": CONTRACT_VERSION,
                "effective_from": system_time,
                "effective_until": 0,
                "fact_surface_ids": list(FACT_SURFACES),
            },
            system_time=system_time,
        )

    created = {}
    kind_by_surface = {
        MISSION_SURFACE_ID: "mission",
        GO_SURFACE_ID: "goal",
        CLAIM_SURFACE_ID: "claim",
    }
    for offset, surface_id in enumerate(FACT_SURFACES, start=1):
        kind = kind_by_surface[surface_id]
        created[kind] = storage_service.fact_type_create(
            runtime_dir,
            {
                "id": surface_id,
                "version": CONTRACT_VERSION,
                "contract_world_id": CONTRACT_WORLD_ID,
                "source_authorities": SURFACE_AUTHORITIES[surface_id],
                "schema": _record_schema(kind),
                "effective_from": system_time + offset,
                "effective_until": 0,
            },
            system_time=system_time + offset,
        )
    return created


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

    subjects = list(definition["subject_keys"])
    results = []
    for offset in range(0, len(subjects), 256):
        query = _runtime_query_definition(definition)
        query["subject_keys"] = subjects[offset : offset + 256]
        query["limit"] = len(query["subject_keys"])
        results.append(storage_service.fact_query_definition(runtime_dir, query))
    if len(results) == 1:
        return results[0]

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
    return {
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
        "rows": rows,
        "lineage": lineage,
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
    for row in result.get("rows", []):
        body = payloads.get(str(row.get("payload_hash") or ""))
        resolved = {**row, "payload": body}
        rows.append(resolved)
        if row.get("fact_surface_id") == MISSION_SURFACE_ID:
            mission = resolved
        elif row.get("fact_surface_id") == GO_SURFACE_ID:
            goals.append(resolved)
        elif row.get("fact_surface_id") == CLAIM_SURFACE_ID:
            claims.append(resolved)
    goals.sort(key=lambda row: str(row.get("subject_key") or ""))
    claims.sort(key=lambda row: str(row.get("subject_key") or ""))
    return {
        "schema": "kungfu.mission-control.state/v1",
        "authority_mode": "atlas-bridge",
        "mission_subject": definition["mission_control"]["mission_subject"],
        "definition": result["definition"],
        "logical_plan": result["logical_plan"],
        "query_definition_root": result["query_definition_root"],
        "query_proof_root": result["query_proof_root"],
        "result_hash": result["result_hash"],
        "cut": result["lineage"]["cut"],
        "canonical_state": result["lineage"]["canonical_state"],
        "lineage": result["lineage"],
        "mission": mission,
        "goals": goals,
        "claims": claims,
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
    system_time: int = 0,
) -> dict[str, Any]:
    """Create one Kungfu-native Go linked to an admitted Mission."""

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
    system_time: int = 0,
) -> dict[str, Any]:
    """Record a visible completion claim without treating it as authority."""

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
    claim_basis = {
        "mission_subject": state["mission_subject"],
        "go_subject": str(goal["subject_key"]),
        "statement": statement.strip(),
        "actor": actor.strip(),
        "evidence": evidence,
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
    answers_by_id = {
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
    """Resolve and persist the five built-in views over one canonical query."""

    definition = _runtime_query_definition(state["definition"])
    if definition.get("schema") != "kungfu.query.definition/v1":
        raise RuntimeError(
            "Mission Control profile requires one portable QueryDefinition"
        )
    mission_hash = _sha256_root(state["mission_subject"])[7:19]
    declared_cut = definition.get("basis", {}).get("cut", {})
    cut_key = (
        "head"
        if declared_cut.get("kind") == "head"
        else _sha256_root(declared_cut)[7:19]
    )
    current = {
        str(entry.get("query_id") or ""): entry
        for entry in storage_service.saved_query_catalog(runtime_dir).get("entries", [])
    }
    views = []
    for question_id, question in MISSION_CONTROL_QUESTIONS:
        query_id = f"mission-control.{question_id}.{mission_hash}.{cut_key}"
        saved_view = {
            "schema": "kungfu.query.saved-view/v1",
            "name": question,
            "definition": definition,
            "view": {
                "kind": "mission-control",
                "profileId": MISSION_CONTROL_PROFILE_ID,
                "profileVersion": MISSION_CONTROL_PROFILE_VERSION,
                "questionId": question_id,
                "reducer": MISSION_CONTROL_REDUCER,
            },
        }
        entry = current.get(query_id)
        if entry is None or entry.get("saved_view") != saved_view:
            entry = storage_service.saved_query_catalog(
                runtime_dir,
                "put",
                query_id=query_id,
                saved_view=saved_view,
                **(
                    {"expected_revision": int(entry["revision"])}
                    if entry is not None
                    else {}
                ),
            )
        views.append(
            {
                "question_id": question_id,
                "query_id": query_id,
                "revision": int(entry["revision"]),
                "saved_view_hash": str(entry["saved_view_hash"]),
                "saved_view": entry["saved_view"],
            }
        )
    profile = {
        "schema": "kungfu.mission-control.query-profile/v1",
        "profile": {
            "id": MISSION_CONTROL_PROFILE_ID,
            "version": MISSION_CONTROL_PROFILE_VERSION,
            "reducer": MISSION_CONTROL_REDUCER,
        },
        "mission_subject": state["mission_subject"],
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": state["query_proof_root"],
        "result_hash": state["result_hash"],
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


def assess_progress(
    runtime_dir: str,
    *,
    mission_id: str,
    storage_source_id: str = "atlas",
    purpose: str = PROGRESS_PURPOSE,
    cut_system_time: int = 0,
    executor_profile: str = "thread",
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
    policy_ref = {
        "id": PROGRESS_POLICY["id"],
        "version": PROGRESS_POLICY["version"],
        "root": _sha256_root(PROGRESS_POLICY),
    }
    request = {
        "claim_id": f"mission-progress-{_sha256_root(claim_basis)[7:31]}",
        "claim_type": PROGRESS_CLAIM,
        "purpose": purpose,
        "work_episode_id": work_episode_id,
        "work_episode_root": work_episode_root,
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": state["query_proof_root"],
        "contract_world": state["definition"]["basis"]["contract_world"],
        "fact_surfaces": state["definition"]["basis"]["fact_surfaces"],
        "policy": policy_ref,
        "evidence": _assessment_evidence(state),
        "deadline": 0,
        "responsibility": "Atlas source authority; libkungfu proof and assessment",
        "residual_risks": [
            "Atlas remains authoritative in bridge mode",
            "source status is evidence, not universal external truth",
        ],
    }
    requested = storage_service.assessment_request(runtime_dir, request)
    assessed = storage_service.assessment_execute(
        runtime_dir,
        requested["assessment_key"],
        executor_profile=executor_profile,
    )
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
            "id": request["claim_id"],
            "type": PROGRESS_CLAIM,
            "purpose": purpose,
        },
        "fitness": fitness,
        "findings": findings,
        "known_limits": request["residual_risks"],
        "state": state,
        "assessment": assessed,
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
    policy_ref = {
        "id": COMPLETION_POLICY["id"],
        "version": COMPLETION_POLICY["version"],
        "root": _sha256_root(COMPLETION_POLICY),
    }
    request = {
        "claim_id": claim_record["claim_id"],
        "claim_type": COMPLETION_CLAIM,
        "purpose": purpose,
        "work_episode_id": work_episode_id,
        "work_episode_root": work_episode_root,
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": _sha256_root(composite_proof),
        "contract_world": state["definition"]["basis"]["contract_world"],
        "fact_surfaces": state["definition"]["basis"]["fact_surfaces"],
        "policy": policy_ref,
        "evidence": evidence,
        "deadline": 0,
        "responsibility": (
            "claimant asserts completion; Episode sources establish work evidence; "
            "libkungfu verifies and assesses"
        ),
        "residual_risks": [
            "completion is fit only for the declared purpose",
            "claimant self-report is not independent completion authority",
        ],
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
