# SPDX-License-Identifier: Apache-2.0

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


def test_catalog_joins_exact_profile_artifacts_without_new_authority(tmp_path):
    source = _source(tmp_path)
    result = profile_composition.catalog(source, tmp_path / "runtime")

    assert result["schema"] == "kungfu.profile-composition/v1"
    assert result["profileId"] == "example.week-day"
    assert result["activeExactRoot"] is False
    assert result["catalogRoot"].startswith("sha256:")
    assert [row["id"] for row in result["views"]] == ["week-table"]


def test_manager_projects_lifecycle_and_current_source_health(tmp_path):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    _activate(source, runtime)

    result = profile_composition.manager(runtime)

    assert result["schema"] == "kungfu.profile-manager/v1"
    assert result["count"] == 1
    managed = result["profiles"][0]
    assert managed["profileId"] == "example.week-day"
    assert managed["health"] == "active"
    assert managed["source"] == str(source.resolve())
    assert managed["catalog"]["activeExactRoot"] is True
    assert [view["id"] for view in managed["catalog"]["views"]] == ["week-table"]


def test_manager_reports_source_drift_without_hiding_lifecycle_state(tmp_path):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    _activate(source, runtime)
    (source / "views" / "registry.json").write_text("{}\n", encoding="utf-8")

    managed = profile_composition.manager(runtime)["profiles"][0]

    assert managed["lifecycleState"] == "activated"
    assert managed["health"] == "degraded"
    assert managed["catalog"] is None
    assert managed["diagnostics"][0]["ok"] is False


def test_current_lifecycle_authorization_rejects_drift_then_applies(tmp_path):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    planned = profile_sdk.lifecycle_plan(runtime, "install", source)
    plan_id = planned["corePlan"]["plan_id"]

    with pytest.raises(profile_sdk.ProfileSdkError, match="review a new decision"):
        profile_sdk.authorize_current_lifecycle(
            runtime, "install", source, "sha256:stale", "approve", "operator"
        )

    receipt = profile_sdk.authorize_current_lifecycle(
        runtime, "install", source, plan_id, "approve", "operator"
    )
    assert receipt["state"]["state"] == "installed"
    assert receipt["plan_id"] == plan_id


def test_catalog_rejects_cross_profile_view_surface_reference(tmp_path):
    source = _source(tmp_path, unknown_view_surface=True)

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_composition.catalog(source, tmp_path / "runtime")

    assert raised.value.diagnosis["code"] == "view-surface-unresolved"


def test_catalog_accepts_profile_owned_view_without_domain_interpretation(tmp_path):
    source = _source(tmp_path, profile_view=True)

    result = profile_composition.catalog(source, tmp_path / "runtime")

    assert result["views"][0]["view"]["kind"] == "profile"
    assert result["views"][0]["view"]["spec"]["groupBy"] == "day"


def test_catalog_rejects_uninstalled_artifact_schema(tmp_path):
    source = _source(tmp_path, unsupported_view_schema=True)

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_composition.catalog(source, tmp_path / "runtime")

    assert raised.value.diagnosis["code"] == "composition-schema-unsupported"


def test_query_plan_requires_exact_active_root_and_delegates_to_adr0048(tmp_path):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_composition.query_plan(source, runtime, "week-table")
    assert raised.value.diagnosis["code"] == "profile-not-active"

    _activate(source, runtime)
    plan = profile_composition.query_plan(source, runtime, "week-table")

    assert plan["schema"] == "kungfu.profile-query-plan/v1"
    assert plan["profileRevision"] == 3
    assert plan["corePlan"]["schema"] == "kungfu.query.explain/v1"


def test_installed_cli_catalog_and_query_plan_share_roots(tmp_path):
    source = _source(tmp_path)
    home = tmp_path / "home"
    _activate(source, home / "runtime")
    runner = CliRunner()

    catalog_result = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "catalog",
            str(source),
            "--require-active",
            "--json",
        ],
    )
    planned = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "query-plan",
            str(source),
            "week-table",
            "--json",
        ],
    )

    assert catalog_result.exit_code == 0, catalog_result.output
    assert planned.exit_code == 0, planned.output
    catalog_payload = json.loads(catalog_result.output)
    plan_payload = json.loads(planned.output)
    assert plan_payload["catalogRoot"] == catalog_payload["catalogRoot"]
    assert plan_payload["profileSuiteRoot"] == catalog_payload["profileSuiteRoot"]


def test_query_receipt_preserves_core_definition_and_proof_roots(tmp_path):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    _activate(source, runtime)
    plan = profile_composition.query_plan(source, runtime, "week-table")

    receipt = profile_composition.execute_query(source, runtime, plan)

    assert receipt["queryDefinitionRoot"] == receipt["result"]["query_definition_root"]
    assert receipt["queryProofRoot"] == receipt["result"]["query_proof_root"]
    assert receipt["queryDefinitionRoot"].startswith("sha256:")
    assert receipt["queryProofRoot"].startswith("sha256:")


def test_non_mission_profile_resolves_query_materializes_contract_and_binds_claim_instance(
    tmp_path,
):
    source = _dynamic_source(tmp_path)
    runtime = tmp_path / "runtime"
    _activate(source, runtime)

    assert storage_service.fact_type_list(runtime)["contract_worlds"] == []
    contract_plan = profile_composition.contract_materialization_plan(source, runtime)
    assert contract_plan["requiresAuthorization"] is True
    assert [row["kind"] for row in contract_plan["operations"]] == [
        "declare-contract-world",
        "declare-fact-surface",
    ]
    contract_answer = profile_sdk.answer_decision(
        contract_plan["decisionCard"], "approve", "test-owner"
    )
    contract_receipt = profile_composition.authorized_contract_materialize(
        runtime, contract_plan, contract_answer
    )
    assert contract_receipt["status"] == "materialized"
    assert (
        profile_composition.contract_materialization_plan(source, runtime)["operations"]
        == []
    )

    action_input = {
        "type_id": "work-item",
        "type_version": "1",
        "source_id": "workspace-owner",
        "subject_key": "week-1",
        "payload": {"status": "active"},
        "observation_id": "week-1-active",
        "action": "assert",
        "valid_until": 0,
    }
    action_plan = profile_sdk.plan_action(
        source, runtime, "put-work-item", action_input
    )
    action_execution = profile_sdk.authorized_action_invoke(
        runtime,
        action_plan,
        profile_sdk.answer_decision(
            action_plan["decisionCard"], "approve", "test-owner"
        ),
    )
    written = action_execution["coreReceipt"]
    assert written["receipt"]["admission"]["outcome"] == "admitted"
    resolution = {
        "schema": "kungfu.profile-query-resolution/v1",
        "familyId": "week-at-cut",
        "bindings": {"weekId": "week-1"},
        "definition": _fact_state_definition(runtime, "week-1"),
    }
    query_plan = profile_composition.resolved_query_plan(
        source, runtime, "week-table", resolution
    )
    query = profile_composition.execute_query(source, runtime, query_plan)
    assert query_plan["resolverMemberRoot"].startswith("sha256:")
    assert query["result"]["row_count"] == 1

    verified = next(
        row
        for row in query["result"]["lineage"]["episode_content_roots"]
        if row["status"] == "verified"
    )
    tampered_receipt = json.loads(json.dumps(query))
    tampered_receipt["queryProofRoot"] = "sha256:" + "0" * 64
    with pytest.raises(profile_sdk.ProfileSdkError) as receipt_drift:
        profile_composition.assessment_plan(
            source,
            runtime,
            tampered_receipt,
            claim_id="week-progress",
            claim_instance_id="week-progress:tampered",
            policy_id="week-progress-policy",
            purpose="operator-review",
            work_episode_id=int(verified["episode_id"]),
        )
    assert receipt_drift.value.diagnosis["code"] == "query-receipt-root-mismatch"
    assessment = profile_composition.assessment_plan(
        source,
        runtime,
        query,
        claim_id="week-progress",
        claim_instance_id="week-progress:week-1",
        policy_id="week-progress-policy",
        purpose="operator-review",
        work_episode_id=int(verified["episode_id"]),
    )
    assert assessment["claimTypeId"] == "week-progress"
    assert assessment["claimInstanceId"] == "week-progress:week-1"
    assert assessment["request"]["claim_id"] == "week-progress:week-1"
    answer = profile_sdk.answer_decision(
        assessment["decisionCard"], "approve", "test-operator"
    )
    receipt = profile_composition.authorized_assessment_execute(
        runtime, assessment, answer
    )
    assert (
        action_execution["memberReceipt"]["profileSuiteRoot"]
        == query["profileSuiteRoot"]
    )
    assert query["profileSuiteRoot"] == assessment["profileSuiteRoot"]
    assert receipt["profileSuiteRoot"] == assessment["profileSuiteRoot"]
    assert receipt["assessment"]["assessment_key"].startswith("sha256:")


def test_contract_materialization_keeps_one_world_when_head_clock_lags(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "runtime"
    _activate(DOGFOOD_SOURCE, runtime)
    plan = profile_composition.contract_materialization_plan(DOGFOOD_SOURCE, runtime)
    answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", "test-owner")
    future = time.time_ns() + 10_000_000_000
    monkeypatch.setattr(time, "time_ns", lambda: future)

    profile_composition.authorized_contract_materialize(runtime, plan, answer)

    catalog = storage_service.fact_type_list(runtime)
    world = next(
        row
        for row in catalog["contract_worlds"]
        if row["id"] == "kungfu.dogfood-feedback"
    )
    surfaces = [
        row
        for row in catalog["fact_types"]
        if row["id"].startswith("kungfu.dogfood-feedback.")
    ]
    assert world["fact_surface_ids"] == [
        "kungfu.dogfood-feedback.finding",
        "kungfu.dogfood-feedback.issue",
        "kungfu.dogfood-feedback.consideration",
    ]
    assert {row["contract_world"]["root"] for row in surfaces} == {world["root"]}


def test_resolved_query_rejects_binding_and_surface_drift(tmp_path):
    source = _dynamic_source(tmp_path)
    runtime = tmp_path / "runtime"
    _activate(source, runtime)
    contract_plan = profile_composition.contract_materialization_plan(source, runtime)
    profile_composition.authorized_contract_materialize(
        runtime,
        contract_plan,
        profile_sdk.answer_decision(
            contract_plan["decisionCard"], "approve", "test-owner"
        ),
    )
    definition = _fact_state_definition(runtime, "week-1")

    with pytest.raises(profile_sdk.ProfileSdkError) as missing:
        profile_composition.resolved_query_plan(
            source,
            runtime,
            "week-table",
            {
                "schema": "kungfu.profile-query-resolution/v1",
                "familyId": "week-at-cut",
                "bindings": {},
                "definition": definition,
            },
        )
    assert missing.value.diagnosis["code"] == "query-binding-invalid"

    definition["basis"]["fact_surfaces"] = []
    with pytest.raises(profile_sdk.ProfileSdkError) as surface:
        profile_composition.resolved_query_plan(
            source,
            runtime,
            "week-table",
            {
                "schema": "kungfu.profile-query-resolution/v1",
                "familyId": "week-at-cut",
                "bindings": {"weekId": "week-1"},
                "definition": definition,
            },
        )
    assert surface.value.diagnosis["code"] == "resolved-query-surface-mismatch"


def test_installed_cli_contract_and_resolved_query_share_public_receipts(tmp_path):
    source = _dynamic_source(tmp_path)
    home = tmp_path / "home"
    runtime = home / "runtime"
    _activate(source, runtime)
    runner = CliRunner()
    contract_file = tmp_path / "contract-plan.json"
    contract_answer_file = tmp_path / "contract-answer.json"

    planned = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "contract-plan",
            str(source),
            "--out",
            str(contract_file),
            "--json",
        ],
    )
    assert planned.exit_code == 0, planned.output
    contract_plan = json.loads(contract_file.read_text())
    contract_answer_file.write_text(
        json.dumps(
            profile_sdk.answer_decision(
                contract_plan["decisionCard"], "approve", "test-owner"
            )
        )
    )
    applied = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "contract-apply",
            str(contract_file),
            "--authorization-file",
            str(contract_answer_file),
            "--json",
        ],
    )
    assert applied.exit_code == 0, applied.output
    assert json.loads(applied.output)["status"] == "materialized"

    storage_service.fact_material_put(
        runtime,
        {
            "type_id": "work-item",
            "type_version": "1",
            "source_id": "workspace-owner",
            "subject_key": "week-1",
            "payload": {"status": "active"},
            "observation_id": "week-1-active",
            "action": "assert",
            "valid_until": 0,
        },
    )
    resolution_file = tmp_path / "resolution.json"
    resolution_file.write_text(
        json.dumps(
            {
                "schema": "kungfu.profile-query-resolution/v1",
                "familyId": "week-at-cut",
                "bindings": {"weekId": "week-1"},
                "definition": _fact_state_definition(runtime, "week-1"),
            }
        )
    )
    query_plan_file = tmp_path / "query-plan.json"
    query_plan_result = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "query-plan",
            str(source),
            "week-table",
            "--resolution-file",
            str(resolution_file),
            "--out",
            str(query_plan_file),
            "--json",
        ],
    )
    assert query_plan_result.exit_code == 0, query_plan_result.output
    query_result = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "query-run",
            str(source),
            str(query_plan_file),
            "--json",
        ],
    )
    assert query_result.exit_code == 0, query_result.output
    query = json.loads(query_result.output)
    assert query["result"]["row_count"] == 1
    assert (
        query["profileSuiteRoot"]
        == json.loads(query_plan_result.output)["profileSuiteRoot"]
    )


def test_assessment_plan_binds_verified_episode_query_proof_and_decision(tmp_path):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    _activate(source, runtime)
    query = profile_composition.execute_query(
        source,
        runtime,
        profile_composition.query_plan(source, runtime, "week-table"),
    )
    verified = next(
        row
        for row in query["result"]["lineage"]["episode_content_roots"]
        if row["status"] == "verified"
    )
    plan = profile_composition.assessment_plan(
        source,
        runtime,
        query,
        claim_id="week-progress",
        policy_id="week-progress-policy",
        purpose="operator-review",
        work_episode_id=int(verified["episode_id"]),
    )
    answer = profile_sdk.answer_decision(
        plan["decisionCard"], "approve", "test-operator"
    )

    receipt = profile_composition.authorized_assessment_execute(runtime, plan, answer)

    assert plan["request"]["work_episode_root"] == (
        "sha256:" + verified["computed"]["value"]
    )
    assert plan["request"]["query_proof_root"] == query["queryProofRoot"]
    assert receipt["schema"] == "kungfu.profile-assessment-receipt/v1"
    assert receipt["assessment"]["assessment_key"].startswith("sha256:")


def test_installed_cli_assessment_plan_decide_and_run(tmp_path):
    source = _source(tmp_path)
    home = tmp_path / "home"
    runtime = home / "runtime"
    _activate(source, runtime)
    query = profile_composition.execute_query(
        source,
        runtime,
        profile_composition.query_plan(source, runtime, "week-table"),
    )
    verified = next(
        row
        for row in query["result"]["lineage"]["episode_content_roots"]
        if row["status"] == "verified"
    )
    query_file = tmp_path / "query-receipt.json"
    query_file.write_text(json.dumps(query))
    observation_file = tmp_path / "independent-observation.json"
    observation_file.write_text(
        json.dumps(
            {
                "episodeRoot": "sha256:" + verified["computed"]["value"],
                "authority": "independent-reviewer",
                "relation": "admitted-source",
            }
        )
    )
    plan_file = tmp_path / "assessment-plan.json"
    answer_file = tmp_path / "assessment-answer.json"
    runner = CliRunner()

    planned = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "assess-plan",
            str(source),
            str(query_file),
            "--claim-id",
            "week-progress",
            "--claim-instance-id",
            "week-progress:cli-cut",
            "--policy-id",
            "week-progress-policy",
            "--purpose",
            "operator-review",
            "--work-episode-id",
            str(verified["episode_id"]),
            "--independent-observation-file",
            str(observation_file),
            "--out",
            str(plan_file),
            "--json",
        ],
    )
    decided = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "decide",
            str(plan_file),
            "--choice",
            "approve",
            "--authorized-by",
            "test-operator",
            "--out",
            str(answer_file),
            "--json",
        ],
    )
    executed = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "assess-run",
            str(plan_file),
            "--authorization-file",
            str(answer_file),
            "--json",
        ],
    )

    assert planned.exit_code == 0, planned.output
    assert json.loads(plan_file.read_text())["claimInstanceId"] == (
        "week-progress:cli-cut"
    )
    assert json.loads(plan_file.read_text())["independentObservation"] == json.loads(
        observation_file.read_text()
    )
    assert decided.exit_code == 0, decided.output
    assert executed.exit_code == 0, executed.output
    assert json.loads(executed.output)["assessment"]["assessment_key"].startswith(
        "sha256:"
    )
