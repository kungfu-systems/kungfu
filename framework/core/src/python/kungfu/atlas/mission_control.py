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
