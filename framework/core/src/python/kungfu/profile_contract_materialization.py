# SPDX-License-Identifier: Apache-2.0

"""Exact-time application of an already planned Profile contract."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, NoReturn

import kungfu
from kungfu import profile_sdk
from kungfu.storage import service as storage_service


def materialize_contract(
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
    answer: Mapping[str, Any] | None,
    *,
    contract_plan_schema: str,
    refresh: Callable[[str, str | Path], dict[str, Any]],
    fail: Callable[[str, str], NoReturn],
) -> dict[str, Any]:
    if plan.get("schema") != contract_plan_schema:
        fail(
            "contract-plan-invalid", "materialization requires a Profile contract plan"
        )
    refreshed = refresh(str(plan.get("source") or ""), runtime_dir)
    if refreshed["planId"] != plan.get("planId"):
        fail("contract-plan-stale", "Profile or Fact Library declarations changed")
    if refreshed["operations"]:
        if not isinstance(answer, Mapping):
            fail(
                "contract-authorization-required",
                "contract plan requires a decision answer",
            )
        card = plan.get("decisionCard") or {}
        profile_sdk.validate_decision_answer(answer, card)
        if answer.get("choice") != "approve" or (answer.get("basis") or {}).get(
            "planId"
        ) != plan.get("planId"):
            fail("decision-denied", "contract materialization was not approved")
    system_time = _native_system_time()
    receipts = []
    contract = dict(refreshed["contract"])
    world = contract["contractWorld"]
    current = storage_service.fact_type_list(runtime_dir)
    world_reference = next(
        (
            {"id": row["id"], "version": row["version"], "root": row["root"]}
            for row in current.get("contract_worlds") or []
            if row.get("id") == world["id"] and row.get("version") == world["version"]
        ),
        None,
    )
    for index, operation in enumerate(refreshed["operations"]):
        at = system_time + index
        if operation["kind"] == "declare-contract-world":
            receipt = storage_service.fact_declare_contract_world(
                runtime_dir,
                {
                    "id": world["id"],
                    "version": world["version"],
                    "effective_from": at,
                    "effective_until": 0,
                    "fact_surface_ids": world["factSurfaceIds"],
                },
                system_time=at,
            )
            receipts.append(receipt)
            world_reference = receipt["reference"]
        elif operation["kind"] == "declare-fact-surface":
            if world_reference is None:
                fail(
                    "contract-world-reference-missing",
                    "contract materialization requires the exact contract-world reference",
                )
            surface = next(
                row for row in contract["factSurfaces"] if row["id"] == operation["id"]
            )
            receipts.append(
                storage_service.fact_type_create(
                    runtime_dir,
                    {
                        "id": surface["id"],
                        "version": surface["version"],
                        "contract_world_id": surface["contractWorldId"],
                        "contract_world": world_reference,
                        "source_authorities": surface["sourceAuthorities"],
                        "schema": surface["schema"],
                        "effective_from": at,
                        "effective_until": 0,
                    },
                    system_time=at,
                )
            )
    return {
        "schema": "kungfu.profile-contract-receipt/v1",
        "planId": refreshed["planId"],
        "profileSuiteRoot": refreshed["profileSuiteRoot"],
        "catalogRoot": refreshed["catalogRoot"],
        "authorizationId": (answer or {}).get("authorizationId"),
        "status": "materialized" if receipts else "current",
        "receipts": receipts,
        "factCatalog": storage_service.fact_type_list(runtime_dir),
    }


def contract_operations(
    artifact: Mapping[str, Any],
    current: Mapping[str, Any],
    *,
    fail: Callable[..., NoReturn],
    root: Callable[[Any], str],
) -> list[dict[str, str]]:
    world = artifact["contractWorld"]
    same_world = [
        row
        for row in current.get("contract_worlds") or []
        if row.get("id") == world["id"] and row.get("version") == world["version"]
    ]
    other_world = [
        row
        for row in current.get("contract_worlds") or []
        if row.get("id") == world["id"] and row.get("version") != world["version"]
    ]
    if len(same_world) > 1:
        fail("contract-world-ambiguous", "contract world is declared more than once")
    if not same_world and other_world:
        fail(
            "contract-version-migration-required",
            "another contract-world version exists; explicit migration is required",
            existingVersions=sorted(str(row.get("version")) for row in other_world),
            requestedVersion=world["version"],
        )
    if same_world and set(same_world[0].get("fact_surface_ids") or []) != set(
        world["factSurfaceIds"]
    ):
        fail(
            "contract-world-incompatible",
            "existing contract world has another fact-surface register",
        )
    operations = []
    if not same_world:
        operations.append(
            {
                "kind": "declare-contract-world",
                "id": world["id"],
                "version": world["version"],
            }
        )
    current_types = current.get("fact_types") or []
    for surface in artifact["factSurfaces"]:
        same = [
            row
            for row in current_types
            if row.get("id") == surface["id"]
            and row.get("version") == surface["version"]
        ]
        other = [
            row
            for row in current_types
            if row.get("id") == surface["id"]
            and row.get("version") != surface["version"]
        ]
        if len(same) > 1:
            fail(
                "fact-surface-ambiguous",
                "fact surface is declared more than once",
                factSurface=surface["id"],
            )
        if not same and other:
            fail(
                "fact-surface-migration-required",
                "another fact-surface version exists; explicit migration is required",
                factSurface=surface["id"],
            )
        if same:
            row = same[0]
            contract = row.get("contract_world") or {}
            if (
                sorted(row.get("source_authorities") or [])
                != sorted(surface["sourceAuthorities"])
                or row.get("schema_owner_root") != root(surface["schema"])
                or contract.get("id") != world["id"]
                or contract.get("version") != world["version"]
            ):
                fail(
                    "fact-surface-incompatible",
                    "existing fact surface differs from the Profile declaration",
                    factSurface=surface["id"],
                )
        else:
            operations.append(
                {
                    "kind": "declare-fact-surface",
                    "id": surface["id"],
                    "version": surface["version"],
                }
            )
    return operations


def _native_system_time() -> int:
    return int(kungfu.__binding__.runtime.now_in_nano())
