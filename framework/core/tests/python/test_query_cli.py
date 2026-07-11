# SPDX-License-Identifier: Apache-2.0

import json

from click.testing import CliRunner

from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service as storage_service


def _invoke(runner, home, *args):
    return runner.invoke(kfc, ["--home", str(home), "query", *args])


def test_offline_agent_discovers_and_proves_query_in_three_commands(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    storage_service.episode_begin(
        runtime_dir,
        episode_id=1048,
        title="query cli",
        actor="pytest",
        source="adr-0048-q1",
        begin_time=1000,
    )
    storage_service.episode_end(
        runtime_dir,
        episode_id=1048,
        end_time=1200,
        frame_count=0,
        reason="done",
    )
    runner = CliRunner()

    capabilities = _invoke(runner, home, "capabilities", "--json")
    examples = _invoke(runner, home, "examples", "--json")
    proof = _invoke(runner, home, "prove", "--episode-id", "1048", "--json")

    assert capabilities.exit_code == 0, capabilities.output
    assert examples.exit_code == 0, examples.output
    assert proof.exit_code == 0, proof.output
    assert "prove" in json.loads(capabilities.output)["commands"]
    assert len(json.loads(examples.output)["examples"]) >= 2
    proof_value = json.loads(proof.output)
    assert proof_value["rows"][0]["episode_id"] == 1048
    assert (
        proof_value["lineage"]["logical_plan_hash"]
        == proof_value["logical_plan"]["logical_plan_hash"]
    )
    assert proof_value["lineage"]["canonical_state"] is True
    assert proof_value["lineage"]["admission_outcomes"][0]["outcome"] == "admitted"


def test_query_cli_validate_explain_and_stream_formats_share_the_plan(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    storage_service.episode_begin(runtime_dir, episode_id=48, begin_time=1000)
    records = storage_service.episode_inspect(runtime_dir, episode_id=48)["records"]
    historical_cut = str(records[0]["manifest_frame_uid"])
    definition = storage_service.build_fact_query_definition(episode_id=48, limit=5)
    definition_path = tmp_path / "query.json"
    definition_path.write_text(json.dumps(definition), encoding="utf-8")
    runner = CliRunner()

    validation = _invoke(
        runner, home, "validate", "--file", str(definition_path), "--json"
    )
    explanation = _invoke(
        runner, home, "explain", "--file", str(definition_path), "--json"
    )
    ndjson = _invoke(runner, home, "prove", "--file", str(definition_path), "--ndjson")
    tsv = _invoke(runner, home, "prove", "--file", str(definition_path), "--tsv")
    semantic = _invoke(
        runner, home, "prove", "--episode-id", "48", "--limit", "5", "--json"
    )
    historical = _invoke(
        runner,
        home,
        "prove",
        "--episode-id",
        "48",
        "--cut",
        historical_cut,
        "--json",
    )

    assert validation.exit_code == 0, validation.output
    assert explanation.exit_code == 0, explanation.output
    assert ndjson.exit_code == 0, ndjson.output
    assert tsv.exit_code == 0, tsv.output
    assert semantic.exit_code == 0, semantic.output
    assert historical.exit_code == 0, historical.output
    validation_value = json.loads(validation.output)
    explanation_value = json.loads(explanation.output)
    assert (
        validation_value["logical_plan_hash"]
        == explanation_value["logical_plan"]["logical_plan_hash"]
    )
    assert (
        validation_value["logical_plan_hash"]
        == json.loads(semantic.output)["logical_plan"]["logical_plan_hash"]
    )
    assert "lineage" not in explanation_value
    assert explanation_value["physical"]["cost"]["class"] == "bounded-authority-scan"
    historical_value = json.loads(historical.output)
    assert historical_value["lineage"]["cut"]["declared"] == {
        "kind": "manifest_frame_uid",
        "manifest_frame_uid": historical_cut,
    }
    assert historical_value["lineage"]["cut"]["resolved"] == {
        "kind": "manifest_frame_uid",
        "manifest_frame_uid": historical_cut,
    }
    ndjson_records = [json.loads(line) for line in ndjson.output.splitlines()]
    assert [record["type"] for record in ndjson_records] == [
        "metadata",
        "row",
        "proof",
    ]
    assert tsv.output.splitlines()[0].startswith("episode_id\tstatus\t")


def test_query_cli_returns_stable_validation_error_code(tmp_path):
    home = tmp_path / "home"
    invalid_path = tmp_path / "invalid.json"
    invalid_path.write_text(
        json.dumps({"schema": "kungfu.query.definition/v999"}), encoding="utf-8"
    )

    result = _invoke(
        CliRunner(), home, "validate", "--file", str(invalid_path), "--json"
    )

    assert result.exit_code == 2
    error = json.loads(result.output)
    assert error["schema"] == "kungfu.query.error/v1"
    assert error["error"]["code"] == "KF_QUERY_VALIDATION"
