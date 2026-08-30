# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F401

from _profile_composition_support import (
    DOGFOOD_SOURCE,
    CliRunner,
    Path,
    __registry__,
    _activate,
    _brief,
    _dynamic_source,
    _fact_state_definition,
    _set_retired_fact_surface,
    _set_work_item_authorities,
    _source,
    _upgrade,
    _write_artifact,
    hashlib,
    json,
    kfc,
    profile_composition,
    profile_sdk,
    pytest,
    storage_service,
    time,
)

__all__ = [
    "test_installed_cli_catalog_and_query_plan_share_roots",
    "test_query_receipt_preserves_core_definition_and_proof_roots",
    "test_non_mission_profile_resolves_query_materializes_contract_and_binds_claim_instance",
    "test_contract_materialization_keeps_one_world_when_head_clock_lags",
    "test_resolved_query_rejects_binding_and_surface_drift",
    "test_installed_cli_contract_and_resolved_query_share_public_receipts",
]


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
