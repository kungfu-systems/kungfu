# SPDX-License-Identifier: Apache-2.0

import hashlib
import json

import pytest
from click.testing import CliRunner

from kungfu import profile_composition, profile_sdk
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service as storage_service


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


def _source(tmp_path, *, unknown_view_surface=False, unsupported_view_schema=False):
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
                    "view": {"kind": "table", "columns": ["episode_id"]},
                }
            ],
        },
        profile["views"]["registry"],
    )
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")
    return source


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


def test_catalog_rejects_cross_profile_view_surface_reference(tmp_path):
    source = _source(tmp_path, unknown_view_surface=True)

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_composition.catalog(source, tmp_path / "runtime")

    assert raised.value.diagnosis["code"] == "view-surface-unresolved"


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
            "--policy-id",
            "week-progress-policy",
            "--purpose",
            "operator-review",
            "--work-episode-id",
            str(verified["episode_id"]),
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
    assert decided.exit_code == 0, decided.output
    assert executed.exit_code == 0, executed.output
    assert json.loads(executed.output)["assessment"]["assessment_key"].startswith(
        "sha256:"
    )
