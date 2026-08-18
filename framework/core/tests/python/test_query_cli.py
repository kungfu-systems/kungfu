# SPDX-License-Identifier: Apache-2.0

import json

from click.testing import CliRunner

from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service as storage_service


def _invoke(runner, home, *args):
    return runner.invoke(kfc, ["--home", str(home), "query", *args])


def test_storage_layout_lazy_context_keeps_all_runtime_paths(tmp_path):
    home = tmp_path / "home"
    result = CliRunner().invoke(
        kfc, ["--home", str(home), "storage", "layout", "--json"]
    )

    assert result.exit_code == 0, result.output
    layout = json.loads(result.output)
    assert layout["runtime_dir"] == str(home / "runtime")


def test_storage_query_does_not_depend_on_retired_source_compatibility(tmp_path):
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "storage",
            "query",
            "--table",
            "episodes",
            "--scope",
            "all",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["row_count"] == 0


def test_storage_query_preserves_explicit_range_filter(tmp_path, monkeypatch):
    captured = {}

    def capture_query(runtime_dir, **request):
        captured.update(request)
        return {"ok": True, "row_count": 0, "rows": []}

    monkeypatch.setattr(storage_service, "query_projection", capture_query)
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "storage",
            "query",
            "--from",
            "2026-08-17T00:00:00Z",
            "--until",
            "2026-08-18T00:00:00Z",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert captured["range_filter"] == {
        "since": "2026-08-17T00:00:00Z",
        "until": "2026-08-18T00:00:00Z",
    }


def test_facts_cli_exposes_the_libkungfu_owned_contract(tmp_path):
    result = CliRunner().invoke(
        kfc, ["--home", str(tmp_path / "home"), "facts", "capabilities"]
    )

    assert result.exit_code == 0, result.output
    contract = json.loads(result.output)
    assert contract["schema"] == "kungfu.facts.domain-admission/v1"
    assert contract["schema_owner"] == "flatbuffers"
    assert contract["admission_outcomes"] == [
        "admitted",
        "unregistered-surface",
        "incompatible-schema",
        "ambiguous-authority",
        "unverifiable",
    ]


def test_nested_facts_cli_inherits_the_root_runtime_context(tmp_path):
    home = tmp_path / "home"
    result = CliRunner().invoke(
        kfc, ["--home", str(home), "facts", "integrity", "fsck"]
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["ok"] is True


def test_facts_kernel_cli_is_a_thin_native_schema_edge(tmp_path, monkeypatch):
    calls = []

    class Runtime:
        @staticmethod
        def run_storage_service_operation(operation, runtime_dir, request):
            calls.append((operation, runtime_dir, request))
            return {
                "schema": "kungfu.fact-kernel.operation-result/v1",
                "ok": True,
                "action": request["action"],
            }

    monkeypatch.setattr(storage_service, "_runtime", lambda: Runtime())
    request_path = tmp_path / "request.json"
    request_path.write_text('{"ref_name":"heads/main"}', encoding="utf-8")
    home = tmp_path / "home"

    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(home),
            "facts",
            "kernel",
            "--action",
            "query",
            "--file",
            str(request_path),
        ],
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["action"] == "query"
    assert calls == [
        (
            "fact_kernel",
            str(home / "runtime"),
            {"action": "query", "ref_name": "heads/main"},
        )
    ]


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
    public_fields = [
        "episode_id",
        "status",
        "opened",
        "closed",
        "begin_time",
        "end_time",
        "record_count",
        "frame_count",
        "ref_count",
        "content_root",
        "content_root_status",
        "title",
        "actor",
        "source",
        "reason",
    ]
    assert [
        field["name"] for field in proof_value["result_schema"]["fields"]
    ] == public_fields
    project = next(
        operator
        for operator in proof_value["logical_plan"]["operators"]
        if operator["kind"] == "project"
    )
    assert project["arguments"]["fields"] == public_fields
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


def test_query_cli_shares_saved_view_and_resumes_changelog(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    storage_service.episode_begin(runtime_dir, episode_id=48, begin_time=1000)
    definition = storage_service.build_fact_query_definition(episode_id=48)
    definition_path = tmp_path / "query.json"
    definition_path.write_text(json.dumps(definition), encoding="utf-8")
    saved_path = tmp_path / "saved-view.json"
    saved_path.write_text(
        json.dumps(
            {
                "schema": "kungfu.query.saved-view/v1",
                "name": "episode-48",
                "definition": definition,
                "view": {
                    "kind": "table",
                    "columns": ["episode_id", "status", "content_root_status"],
                },
            }
        ),
        encoding="utf-8",
    )
    runner = CliRunner()

    inspected = _invoke(runner, home, "saved-view", "--file", str(saved_path), "--json")
    first = _invoke(
        runner,
        home,
        "changelog",
        "--file",
        str(definition_path),
        "--max-messages",
        "2",
        "--json",
    )

    assert inspected.exit_code == 0, inspected.output
    assert first.exit_code == 0, first.output
    inspected_value = json.loads(inspected.output)
    first_value = json.loads(first.output)
    assert inspected_value["definition"] == definition
    assert inspected_value["view"]["kind"] == "table"
    assert first_value["complete"] is False
    resume_path = tmp_path / "resume.json"
    resume_path.write_text(json.dumps(first_value["resume_token"]), encoding="utf-8")

    resumed = _invoke(
        runner,
        home,
        "changelog",
        "--file",
        str(definition_path),
        "--resume-file",
        str(resume_path),
        "--json",
    )
    assert resumed.exit_code == 0, resumed.output
    resumed_value = json.loads(resumed.output)
    assert resumed_value["batch_id"] == first_value["batch_id"]
    assert resumed_value["complete"] is True
    assert [message["type"] for message in resumed_value["messages"]] == ["SnapshotEnd"]


def test_query_cli_keeps_profile_views_generic_and_legacy_readable(tmp_path):
    home = tmp_path / "home"
    definition = storage_service.build_fact_query_definition(limit=10)
    views = [
        {
            "kind": "profile",
            "profileId": "example.week-day",
            "profileVersion": "1.0.0",
            "memberId": "week-day-views",
            "viewId": "week-plan",
            "spec": {
                "schema": "example.week-day.week-plan-view/v1",
                "cardField": "day",
            },
        },
        {
            "kind": "legacy-domain-view",
            "profileId": "example.legacy",
            "profileVersion": "1",
            "domainValue": {"retained": True},
        },
    ]
    runner = CliRunner()

    for index, view in enumerate(views):
        saved_path = tmp_path / f"profile-view-{index}.json"
        saved_path.write_text(
            json.dumps(
                {
                    "schema": "kungfu.query.saved-view/v1",
                    "name": f"profile-view-{index}",
                    "definition": definition,
                    "view": view,
                }
            ),
            encoding="utf-8",
        )
        inspected = _invoke(
            runner, home, "saved-view", "--file", str(saved_path), "--json"
        )

        assert inspected.exit_code == 0, inspected.output
        assert json.loads(inspected.output)["view"] == view


def test_query_cli_rejects_incomplete_profile_view_envelope(tmp_path):
    saved_path = tmp_path / "incomplete-profile-view.json"
    saved_path.write_text(
        json.dumps(
            {
                "schema": "kungfu.query.saved-view/v1",
                "name": "incomplete",
                "definition": storage_service.build_fact_query_definition(limit=10),
                "view": {
                    "kind": "profile",
                    "profileId": "example.week-day",
                    "profileVersion": "1.0.0",
                },
            }
        ),
        encoding="utf-8",
    )

    inspected = _invoke(
        CliRunner(),
        tmp_path / "home",
        "saved-view",
        "--file",
        str(saved_path),
        "--json",
    )

    assert inspected.exit_code == 2
    assert json.loads(inspected.output)["error"]["code"] == "KF_QUERY_VIEW"


def test_workspace_saved_query_catalog_survives_reopen_and_tracks_revisions(tmp_path):
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"
    storage_service.episode_begin(runtime_dir, episode_id=2048, begin_time=1000)
    definition = storage_service.build_fact_query_definition(episode_id=2048)
    saved_path = tmp_path / "saved-view.json"
    saved_view = {
        "schema": "kungfu.query.saved-view/v1",
        "name": "episode-2048",
        "definition": definition,
        "view": {
            "kind": "profile",
            "profileId": "example.week-day",
            "profileVersion": "1.0.0",
            "memberId": "week-day-views",
            "viewId": "week-plan",
            "spec": {
                "schema": "example.week-day.week-plan-view/v1",
                "cardField": "day",
            },
        },
    }
    saved_path.write_text(json.dumps(saved_view), encoding="utf-8")

    created = _invoke(
        CliRunner(),
        home,
        "saved",
        "import",
        "--id",
        "episode-attention",
        "--file",
        str(saved_path),
        "--json",
    )
    assert created.exit_code == 0, created.output
    created_value = json.loads(created.output)
    assert created_value["query_id"] == "episode-attention"
    assert created_value["revision"] == 1

    # A new CLI runner reopens the catalog from the workspace journal.
    listed = _invoke(CliRunner(), home, "saved", "list", "--json")
    assert listed.exit_code == 0, listed.output
    assert json.loads(listed.output)["entries"][0]["saved_view"] == saved_view

    saved_view["view"] = {
        "kind": "timeline",
        "timeField": "begin_time",
        "labelField": "episode_id",
    }
    saved_path.write_text(json.dumps(saved_view), encoding="utf-8")
    updated = _invoke(
        CliRunner(),
        home,
        "saved",
        "update",
        "episode-attention",
        "--expected-revision",
        "1",
        "--file",
        str(saved_path),
        "--json",
    )
    assert updated.exit_code == 0, updated.output
    assert json.loads(updated.output)["revision"] == 2

    run = _invoke(CliRunner(), home, "saved", "run", "episode-attention", "--json")
    history = _invoke(
        CliRunner(), home, "saved", "history", "episode-attention", "--json"
    )
    rebuilt = _invoke(CliRunner(), home, "saved", "rebuild", "--json")
    assert run.exit_code == 0, run.output
    assert json.loads(run.output)["saved_query"]["revision"] == 2
    assert history.exit_code == 0, history.output
    assert len(json.loads(history.output)["events"]) == 2
    assert rebuilt.exit_code == 0, rebuilt.output
    assert json.loads(rebuilt.output)["authority_records"] == 2

    deleted = _invoke(
        CliRunner(),
        home,
        "saved",
        "delete",
        "episode-attention",
        "--expected-revision",
        "2",
        "--json",
    )
    assert deleted.exit_code == 0, deleted.output
    assert json.loads(deleted.output)["state"] == "deleted"
    assert (
        json.loads(_invoke(CliRunner(), home, "saved", "list", "--json").output)[
            "count"
        ]
        == 0
    )
    assert (
        json.loads(
            _invoke(
                CliRunner(), home, "saved", "list", "--include-deleted", "--json"
            ).output
        )["count"]
        == 1
    )


def test_query_cli_compiles_bounded_sql_and_runs_sqlite_engine(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    storage_service.episode_begin(runtime_dir, episode_id=48, begin_time=1000)
    definition_path = tmp_path / "base-query.json"
    definition_path.write_text(
        json.dumps(storage_service.build_fact_query_definition()), encoding="utf-8"
    )
    runner = CliRunner()

    rebuilt = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "storage",
            "episode",
            "rebuild-projection",
            "--json",
        ],
    )

    compiled = _invoke(
        runner,
        home,
        "compile-sql",
        "--file",
        str(definition_path),
        "--sql",
        "SELECT * FROM episodes WHERE episode_id = 48 LIMIT 5",
        "--json",
    )
    proof = _invoke(
        runner,
        home,
        "prove",
        "--episode-id",
        "48",
        "--limit",
        "5",
        "--engine",
        "sqlite",
        "--json",
    )

    assert rebuilt.exit_code == 0, rebuilt.output
    assert json.loads(rebuilt.output)["query_records"] == 1
    assert compiled.exit_code == 0, compiled.output
    assert proof.exit_code == 0, proof.output
    compiled_value = json.loads(compiled.output)
    proof_value = json.loads(proof.output)
    assert compiled_value["schema"] == "kungfu.query.sql-compilation/v1"
    assert (
        compiled_value["logical_plan_hash"]
        == proof_value["logical_plan"]["logical_plan_hash"]
    )
    assert proof_value["lineage"]["execution"]["engine"] == (
        "episode-sqlite-projection/v1"
    )


def test_query_cli_compiles_and_proves_temporal_attention_pattern(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    for episode_id, title, actor, begin_time in [
        (1, "alpha_published", "feature-agent", 1000),
        (2, "gate_failed", "release-infra", 1100),
        (3, "alpha_published", "feature-agent", 1200),
        (4, "gate_failed", "release-infra", 1300),
    ]:
        storage_service.episode_begin(
            runtime_dir,
            episode_id=episode_id,
            title=title,
            actor=actor,
            source="buildchain-cli-fixture",
            begin_time=begin_time,
        )
    base = storage_service.build_fact_query_definition(limit=10)
    definition = json.loads(json.dumps(base))
    definition["temporal_pattern"] = {
        "schema": "kungfu.query.temporal-pattern/v1",
        "partition_by": "source",
        "order_by": "begin_time",
        "sequence": [
            {"field": "title", "equals": "alpha_published"},
            {"field": "title", "equals": "gate_failed"},
        ],
        "repeat": {"min": 2, "max": 8},
        "within_ns": "1000",
        "as_of_time": "2000",
        "absence": {"field": "title", "equals": "stable_published"},
    }
    base_path = tmp_path / "base.json"
    base_path.write_text(json.dumps(base), encoding="utf-8")
    definition_path = tmp_path / "attention.json"
    definition_path.write_text(json.dumps(definition), encoding="utf-8")
    saved_path = tmp_path / "attention-view.json"
    saved_path.write_text(
        json.dumps(
            {
                "schema": "kungfu.query.saved-view/v1",
                "name": "release-attention",
                "definition": definition,
                "view": {
                    "kind": "attention",
                    "partitionField": "partition_key",
                    "repeatField": "repeat_count",
                    "elapsedField": "elapsed_ns",
                    "attributionField": "attribution_counts",
                    "evidenceField": "matched_episode_ids",
                },
            }
        ),
        encoding="utf-8",
    )
    sql = """SELECT * FROM episodes MATCH_RECOGNIZE (
      PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8})
      DEFINE A AS title = 'alpha_published', B AS title = 'gate_failed'
      WITHIN 1000 AS OF 2000 ABSENT title = 'stable_published'
    ) LIMIT 10"""
    runner = CliRunner()

    compiled = _invoke(
        runner,
        home,
        "compile-sql",
        "--file",
        str(base_path),
        "--sql",
        sql,
        "--json",
    )
    proof = _invoke(runner, home, "prove", "--file", str(definition_path), "--json")
    inspected = _invoke(runner, home, "saved-view", "--file", str(saved_path), "--json")

    assert compiled.exit_code == 0, compiled.output
    assert proof.exit_code == 0, proof.output
    assert inspected.exit_code == 0, inspected.output
    compiled_value = json.loads(compiled.output)
    proof_value = json.loads(proof.output)
    assert compiled_value["definition"] == proof_value["definition"]
    assert (
        compiled_value["logical_plan_hash"]
        == (proof_value["logical_plan"]["logical_plan_hash"])
    )
    assert proof_value["rows"][0]["partition_key"] == "buildchain-cli-fixture"
    assert proof_value["rows"][0]["attention_required"] is True
    assert json.loads(inspected.output)["view"]["kind"] == "attention"
