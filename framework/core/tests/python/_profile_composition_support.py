# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F401

import hashlib
import json
from pathlib import Path
import time

import pytest
from click.testing import CliRunner

from kungfu import profile_composition, profile_sdk
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service as storage_service


DOGFOOD_SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "dogfood"


def _brief():
    return {
        "schema": "kungfu.profile-brief/v1",
        "id": "example.week-day",
        "title": "Week / Day",
        "version": "1.0.0",
        "purposes": ["operator-review"],
        "permissions": [],
        "identity": {"authority": "workspace-owner"},
        "evidence": {"strength": "reported-with-references"},
        "migration": {"mode": "additive"},
    }


def _write_artifact(source, profile, path, value, ref):
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    (source / path).write_bytes(data)
    ref["sha256"] = hashlib.sha256(data).hexdigest()


def _source(
    tmp_path,
    *,
    unknown_view_surface=False,
    unsupported_view_schema=False,
    profile_view=False,
):
    source = tmp_path / "profile"
    profile_sdk.apply_scaffold(profile_sdk.scaffold_plan(_brief(), source))
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    definition = storage_service.build_fact_query_definition(limit=10)
    _write_artifact(
        source,
        profile,
        "contracts/facts.json",
        {
            "schema": "kungfu.profile-fact-surfaces/v1",
            "surfaces": [{"id": "work-item", "schema": "example.work-item/v1"}],
        },
        profile["kfd1"]["factSurfaces"][0],
    )
    _write_artifact(
        source,
        profile,
        "claims/claims.json",
        {
            "schema": "kungfu.profile-claims/v1",
            "claims": [
                {
                    "id": "week-progress",
                    "type": "example.week-progress/v1",
                    "factSurfaces": ["work-item"],
                }
            ],
        },
        profile["kfd2"]["claims"][0],
    )
    _write_artifact(
        source,
        profile,
        "assessments/policies.json",
        {
            "schema": "kungfu.profile-assessment-policies/v1",
            "policies": [
                {
                    "id": "week-progress-policy",
                    "version": "1",
                    "claimId": "week-progress",
                    "purposes": ["operator-review"],
                    "requiredEvidence": ["query-proof"],
                    "responsibility": "workspace owner supplies work facts",
                    "residualRisks": ["reported state may be incomplete"],
                }
            ],
        },
        profile["kfd2"]["policies"][0],
    )
    _write_artifact(
        source,
        profile,
        "views/registry.json",
        {
            "schema": (
                "example.private-views/v1"
                if unsupported_view_schema
                else "kungfu.profile-views/v1"
            ),
            "views": [
                {
                    "id": "week-table",
                    "title": "Week table",
                    "factSurfaces": [
                        "missing" if unknown_view_surface else "work-item"
                    ],
                    "definition": definition,
                    "view": (
                        {
                            "kind": "profile",
                            "profileId": "example.week-day",
                            "profileVersion": "1.0.0",
                            "memberId": "example-week-day-views",
                            "viewId": "week-cards",
                            "spec": {
                                "schema": "example.week-day.week-card-view/v1",
                                "groupBy": "day",
                            },
                        }
                        if profile_view
                        else {"kind": "table", "columns": ["episode_id"]}
                    ),
                }
            ],
        },
        profile["views"]["registry"],
    )
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")
    return source


def _dynamic_source(tmp_path):
    source = _source(tmp_path)
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    _write_artifact(
        source,
        profile,
        "actions/registry.json",
        {
            "schema": "kungfu.profile-actions/v1",
            "actions": [
                {
                    "id": "put-work-item",
                    "title": "Put work item",
                    "runner": "kfx-member",
                    "operation": "example-week-day-actions",
                    "runtimeOperation": "episode.append",
                    "authorityClass": "workspace-owner",
                    "requiredCapabilities": [],
                    "effects": ["append-admitted-fact"],
                }
            ],
        },
        profile["actions"]["registry"],
    )
    action_member = source / "members" / "example-week-day-actions"
    action_manifest = json.loads((action_member / "kungfu.kfx.json").read_text())
    action_manifest["kungfuConfig"]["config"] = {
        "adapter": {
            "targets": ["kungfu.profile.member"],
            "runtimes": ["python"],
            "capabilities": [],
            "entry": {"python": "adapter.py"},
        }
    }
    (action_member / "kungfu.kfx.json").write_text(
        json.dumps(action_manifest, indent=2, sort_keys=True) + "\n"
    )
    (action_member / "adapter.py").write_text(
        "from kungfu.storage import service as storage_service\n\n"
        "def invoke(operation, *, runtime_dir, input_value, context):\n"
        "    if operation != 'put-work-item':\n"
        "        raise ValueError('unsupported Week/Day operation')\n"
        "    if context.get('invocationMode') != 'authorized-action':\n"
        "        raise ValueError('Week/Day writes require authorization')\n"
        "    receipt = storage_service.fact_material_put(runtime_dir, input_value)\n"
        "    return {'coreReceipt': receipt, 'affected': {'entityKeys': [input_value['subject_key']]}}\n"
    )
    _write_artifact(
        source,
        profile,
        "contracts/world.json",
        {
            "schema": "kungfu.profile-contract-world/v1",
            "profileId": "example.week-day",
            "identityAuthority": "workspace-owner",
            "contractWorld": {
                "id": "example.week-day",
                "version": "1",
                "factSurfaceIds": ["work-item"],
            },
            "factSurfaces": [
                {
                    "id": "work-item",
                    "version": "1",
                    "contractWorldId": "example.week-day",
                    "sourceAuthorities": ["workspace-owner"],
                    "schema": {
                        "type": "object",
                        "properties": {"status": {"type": "string"}},
                        "required": ["status"],
                        "additionalProperties": False,
                    },
                }
            ],
        },
        profile["kfd1"]["contractWorld"],
    )
    _write_artifact(
        source,
        profile,
        "views/registry.json",
        {
            "schema": "kungfu.profile-views/v1",
            "views": [
                {
                    "id": "week-table",
                    "title": "Week table",
                    "factSurfaces": ["work-item"],
                    "queryFamily": {
                        "id": "week-at-cut",
                        "member": "example-week-day-contract",
                        "resolutionMode": "member-resolved-definition",
                        "bindings": [
                            {
                                "name": "weekId",
                                "type": "string",
                                "required": True,
                            }
                        ],
                    },
                    "view": {"kind": "table", "columns": ["subject_key"]},
                }
            ],
        },
        profile["views"]["registry"],
    )
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")
    return source


def _fact_state_definition(runtime, subject_key):
    catalog = storage_service.fact_type_list(runtime)
    world = next(
        row for row in catalog["contract_worlds"] if row["id"] == "example.week-day"
    )
    surface = next(row for row in catalog["fact_types"] if row["id"] == "work-item")
    return {
        "schema": "kungfu.query.definition/v1",
        "basis": {
            "contract_world": {
                "id": world["id"],
                "version": world["version"],
                "root": world["root"],
            },
            "fact_surfaces": [
                {
                    "id": surface["id"],
                    "version": surface["version"],
                    "root": surface["root"],
                }
            ],
            "scope": "domain-fact-ledger",
            "perspective": "system-time-then-observation-id",
            "cut": {"kind": "head"},
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
        "subject_keys": [subject_key],
        "limit": 1,
        "evidence": "proof",
    }


def _activate(source, runtime):
    for action in ["install", "qualify", "activate"]:
        plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")


def _upgrade(source, runtime):
    for action in ["upgrade", "qualify", "activate"]:
        plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")


def _set_work_item_authorities(source, authorities):
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    world_path = source / "contracts" / "world.json"
    world = json.loads(world_path.read_text())
    world["factSurfaces"][0]["sourceAuthorities"] = authorities
    _write_artifact(
        source,
        profile,
        "contracts/world.json",
        world,
        profile["kfd1"]["contractWorld"],
    )
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")


def _set_retired_fact_surface(source, *, present):
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    facts_path = source / "contracts" / "facts.json"
    facts = json.loads(facts_path.read_text())
    world_path = source / "contracts" / "world.json"
    world = json.loads(world_path.read_text())
    surface_id = "retired-item"
    facts["surfaces"] = [row for row in facts["surfaces"] if row["id"] != surface_id]
    world["contractWorld"]["factSurfaceIds"] = [
        item for item in world["contractWorld"]["factSurfaceIds"] if item != surface_id
    ]
    world["factSurfaces"] = [
        row for row in world["factSurfaces"] if row["id"] != surface_id
    ]
    if present:
        facts["surfaces"].append(
            {"id": surface_id, "schema": "example.retired-item/v1"}
        )
        world["contractWorld"]["factSurfaceIds"].append(surface_id)
        world["factSurfaces"].append(
            {
                "id": surface_id,
                "version": "1",
                "contractWorldId": "example.week-day",
                "sourceAuthorities": ["workspace-owner"],
                "schema": {
                    "type": "object",
                    "properties": {"status": {"type": "string"}},
                    "required": ["status"],
                    "additionalProperties": False,
                },
            }
        )
    _write_artifact(
        source,
        profile,
        "contracts/facts.json",
        facts,
        profile["kfd1"]["factSurfaces"][0],
    )
    _write_artifact(
        source,
        profile,
        "contracts/world.json",
        world,
        profile["kfd1"]["contractWorld"],
    )
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")
