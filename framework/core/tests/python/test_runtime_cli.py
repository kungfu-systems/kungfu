# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path

import click
from click.testing import CliRunner
import kungfu
from kungfu import runtime_broker, runtime_service

kungfu.__version__ = "test"

from kungfu.cli.commands.runtime import runtime  # noqa: E402


@click.group()
@click.option("--home", type=click.Path(), required=True)
@click.pass_context
def runtime_test_cli(ctx, home):
    ctx.name = "runtime-test"
    ctx.config_home = str(Path(home) / "config")
    ctx.home = str(home)
    ctx.extension_path = None
    ctx.log_level = "warning"
    ctx.runtime_dir = str(Path(home) / "runtime")
    ctx.dataset_dir = str(Path(home) / "dataset")
    ctx.backtest_dir = str(Path(home) / "backtest")
    ctx.inbox_dir = str(Path(home) / "inbox")
    ctx.runtime_locator = None
    ctx.backtest_locator = None
    ctx.config_location = None
    ctx.console_location = None
    ctx.index_location = None
    ctx.stage = "test"


runtime_test_cli.add_command(runtime)


def test_runtime_operations_exposes_the_contract_catalog_as_json(tmp_path):
    result = CliRunner().invoke(
        runtime_test_cli,
        ["--home", str(tmp_path / "home"), "runtime", "operations", "--json"],
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == runtime_broker.operation_catalog()


def test_runtime_status_preserves_the_plain_line_contract(tmp_path, monkeypatch):
    payload = {
        "configHome": "/config",
        "dataRoot": "/data",
        "runtimeDir": "/runtime",
        "product": {
            "availability": "available",
            "liveState": "ready",
            "handle": {
                "generation": "7",
                "readiness": {
                    "state": "ready",
                    "durableCut": {"sequence": "11"},
                    "projectionCut": {"sequence": "9"},
                },
            },
            "leases": {"activeCount": 2},
        },
        "lifecycle": {"state": "running", "warnings": ["sample-warning"]},
        "supervisor": {"pid": 101, "running": True},
        "coordinator": {"pid": 102, "running": False},
    }
    monkeypatch.setattr(runtime_service, "route_status", lambda *_args: payload)

    result = CliRunner().invoke(
        runtime_test_cli,
        ["--home", str(tmp_path / "home"), "runtime", "status"],
    )

    assert result.exit_code == 0, result.output
    assert result.output == (
        "workspace: available\n"
        "live runtime: ready\n"
        "generation: 7\n"
        "readiness: ready\n"
        'durable cut: {"sequence": "11"}\n'
        'projection cut: {"sequence": "9"}\n'
        "active leases: 2\n"
        "config: /config\n"
        "data root: /data\n"
        "runtime: /runtime\n"
        "process diagnostics:\n"
        "  lifecycle: running\n"
        "  supervisor: 101 (running)\n"
        "  coordinator: 102 (stopped)\n"
        "warnings: sample-warning\n"
    )


def test_runtime_status_preserves_falsy_product_and_handle_fallbacks(
    tmp_path, monkeypatch
):
    base_payload = {
        "configHome": "/config",
        "dataRoot": "/data",
        "runtimeDir": "/runtime",
        "lifecycle": {"state": "stopped"},
        "supervisor": {"pid": None, "running": False},
    }
    expected = (
        "workspace: unknown\n"
        "live runtime: unknown\n"
        "config: /config\n"
        "data root: /data\n"
        "runtime: /runtime\n"
        "process diagnostics:\n"
        "  lifecycle: stopped\n"
        "  supervisor: - (stopped)\n"
    )

    for product in (None, {"handle": None}):
        payload = {**base_payload, "product": product}
        monkeypatch.setattr(runtime_service, "route_status", lambda *_args: payload)

        result = CliRunner().invoke(
            runtime_test_cli,
            ["--home", str(tmp_path / "home"), "runtime", "status"],
        )

        assert result.exit_code == 0, result.output
        assert result.output == expected


def test_runtime_status_preserves_error_line_and_trailing_newline_contract(
    tmp_path, monkeypatch
):
    payload = {
        "configHome": "/config",
        "dataRoot": "/data",
        "runtimeDir": "/runtime",
        "product": {"error": {"code": "not_ready", "message": "details"}},
        "lifecycle": {"state": "stopped"},
        "supervisor": {"pid": None, "running": False},
    }
    monkeypatch.setattr(runtime_service, "route_status", lambda *_args: payload)
    prefix = "workspace: unknown\nlive runtime: unknown\nruntime problem:\n"
    suffix = (
        "config: /config\n"
        "data root: /data\n"
        "runtime: /runtime\n"
        "process diagnostics:\n"
        "  lifecycle: stopped\n"
        "  supervisor: - (stopped)\n"
    )

    for actionable, indented in (
        ("", ""),
        ("first\n\nsecond", "  first\n  \n  second\n"),
    ):
        monkeypatch.setattr(
            "kungfu.cli.commands.runtime.diagnostics.actionable_text",
            lambda *_args, value=actionable, **_kwargs: value,
        )

        result = CliRunner().invoke(
            runtime_test_cli,
            ["--home", str(tmp_path / "home"), "runtime", "status"],
        )

        assert result.exit_code == 0, result.output
        assert result.output == f"{prefix}{indented}{suffix}"


def test_runtime_plan_projects_storage_only_without_starting_a_process(tmp_path):
    home = tmp_path / "home"
    result = CliRunner().invoke(
        runtime_test_cli,
        [
            "--home",
            str(home),
            "runtime",
            "plan",
            "episode.append",
            "--request-id",
            "request-storage",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["operation"]["id"] == "episode.append"
    assert payload["requirement"]["operationClass"] == "storage-only"
    assert payload["requirement"]["requiredCapabilities"] == []
    assert not (home / "runtime" / "supervisor").exists()
    assert not (home / "runtime" / "coordinator").exists()


def test_runtime_plan_exposes_live_requirements_and_exact_cut(tmp_path):
    home = tmp_path / "home"
    cut = {
        "stream_id": "7",
        "container_epoch": "11",
        "sequence": "41",
        "frame_uid": "1041",
    }
    result = CliRunner().invoke(
        runtime_test_cli,
        [
            "--home",
            str(home),
            "runtime",
            "plan",
            "assessment.request",
            "--minimum-cut",
            json.dumps(cut),
            "--request-id",
            "request-live",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    requirement = payload["requirement"]
    assert requirement["operationClass"] == "live-required"
    assert requirement["requiredCapabilities"] == ["runtime.assessment-scheduling"]
    assert requirement["minimumCut"] == cut
    assert not (home / "runtime" / "supervisor").exists()
    assert not (home / "runtime" / "coordinator").exists()
