# SPDX-License-Identifier: Apache-2.0

"""Mission/Go admission for the read-only Atlas bridge.

Atlas remains authoritative. This module turns already captured Atlas Mission
and goal snapshots into the shared ADR-0051 Fact Library path so Mission
Control can query and assess them without treating the adapter projection as
truth. The original source coordinates and sealed import Episode remain bound
into every admitted payload.
"""

import hashlib
import json
import time
from datetime import datetime
from typing import Any

from kungfu.storage import service as storage_service

CONTRACT_WORLD_ID = "kungfu.mission-control"
CONTRACT_VERSION = "1"
MISSION_SURFACE_ID = "kungfu.mission-control.mission"
GO_SURFACE_ID = "kungfu.mission-control.go"
ATLAS_FACT_SOURCE_ID = "atlas-adapter"

FACT_SURFACES = (MISSION_SURFACE_ID, GO_SURFACE_ID)
PROGRESS_CLAIM = "mission-progress-is-reasonable"
PROGRESS_PURPOSE = "operator-review"
PROGRESS_POLICY = {
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
SURFACE_BY_KIND = {
    "mission": MISSION_SURFACE_ID,
    "goal": GO_SURFACE_ID,
}


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
                },
                "required": [
                    "authority_mode",
                    "storage_source_id",
                    "kind",
                    "source_id",
                    "source_path",
                    "source_time",
                    "repo_head",
                    "import_id",
                    "import_episode_id",
                    "import_episode_root",
                    "payload_hash",
                ],
                "additionalProperties": False,
            },
            "links": {
                "type": "object",
                "properties": {"mission_id": {"type": "string"}},
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
    worlds = [
        world
        for world in catalog.get("contract_worlds", [])
        if world.get("id") == CONTRACT_WORLD_ID
        and world.get("version") == CONTRACT_VERSION
    ]
    if len(worlds) > 1:
        raise RuntimeError("mission-control contract world is ambiguous")
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
    for offset, (kind, surface_id) in enumerate(SURFACE_BY_KIND.items(), start=1):
        created[kind] = storage_service.fact_type_create(
            runtime_dir,
            {
                "id": surface_id,
                "version": CONTRACT_VERSION,
                "contract_world_id": CONTRACT_WORLD_ID,
                "source_authorities": [ATLAS_FACT_SOURCE_ID],
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
    next_time = system_time + len(SURFACE_BY_KIND) + 1
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
    mission_subject = (
        mission_id
        if mission_id.startswith(f"{storage_source_id}:")
        else f"{storage_source_id}:{mission_id}"
    )
    materials = storage_service.fact_material_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    payloads = materials.get("payloads", {})
    selected = {mission_subject}
    mission_present = False
    for row in materials.get("state", {}).get("canonical_facts", []):
        payload = payloads.get(str(row.get("payload_hash") or ""), {})
        if row.get("fact_surface_id") == MISSION_SURFACE_ID:
            mission_present = (
                mission_present or row.get("subject_key") == mission_subject
            )
            continue
        if (
            row.get("fact_surface_id") == GO_SURFACE_ID
            and payload.get("links", {}).get("mission_id") == mission_subject
        ):
            selected.add(str(row["subject_key"]))
    if not mission_present:
        raise ValueError(f"admitted Mission fact not found: {mission_subject}")
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
    result = storage_service.fact_query_definition(
        runtime_dir, _runtime_query_definition(definition)
    )
    materials = storage_service.fact_material_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    payloads = materials.get("payloads", {})
    rows = []
    mission = None
    goals = []
    for row in result.get("rows", []):
        body = payloads.get(str(row.get("payload_hash") or ""))
        resolved = {**row, "payload": body}
        rows.append(resolved)
        if row.get("fact_surface_id") == MISSION_SURFACE_ID:
            mission = resolved
        elif row.get("fact_surface_id") == GO_SURFACE_ID:
            goals.append(resolved)
    goals.sort(key=lambda row: str(row.get("subject_key") or ""))
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
        "rows": rows,
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
        "report_hash": assessed.get("report", {}).get("report_hash"),
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": state["query_proof_root"],
    }
