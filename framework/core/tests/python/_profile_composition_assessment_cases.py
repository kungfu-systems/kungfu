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
    "test_assessment_plan_binds_verified_episode_query_proof_and_decision",
    "test_installed_cli_assessment_plan_decide_and_run",
]


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
