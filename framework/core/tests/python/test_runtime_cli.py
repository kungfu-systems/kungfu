# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path

import click
from click.testing import CliRunner
import kungfu
from kungfu import runtime_broker

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
