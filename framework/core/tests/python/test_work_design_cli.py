# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner

from kungfu.cli.commands import kfc
from kungfu.cli.commands import work_design  # noqa: F401


def test_work_design_preflight_routes_to_product_owned_libnode(tmp_path):
    request = tmp_path / "request.json"
    history = tmp_path / "history.json"
    request.write_text("{}\n", encoding="utf-8")
    history.write_text("{}\n", encoding="utf-8")
    entry = tmp_path / "work-design-preflight.mjs"
    entry.write_text("// product runtime\n", encoding="utf-8")

    with (
        patch("kungfu.cli.commands.work_design._preflight_entry", return_value=entry),
        patch(
            "kungfu.cli.commands.work_design.kungfu.__binding__.libnode.run",
            return_value=0,
        ) as run,
    ):
        result = CliRunner().invoke(
            kfc,
            [
                "work-design",
                "preflight",
                "--input",
                str(request),
                "--history-query",
                str(history),
            ],
        )

    assert result.exit_code == 0, result.output
    assert run.call_args.args == (
        "node",
        str(entry),
        "--input",
        str(request.resolve()),
        "--history-query",
        str(history.resolve()),
    )


def test_work_design_preflight_fails_closed_without_product_runtime(tmp_path):
    request = tmp_path / "request.json"
    request.write_text("{}\n", encoding="utf-8")
    missing = Path(tmp_path / "missing.mjs")

    with patch(
        "kungfu.cli.commands.work_design._preflight_entry", return_value=missing
    ):
        result = CliRunner().invoke(
            kfc,
            ["work-design", "preflight", "--input", str(request)],
        )

    assert result.exit_code == 1
    assert "installed Work Design runtime is missing" in result.output


def test_work_design_preflight_preserves_runtime_json_output(tmp_path):
    request = tmp_path / "request.json"
    request.write_text("{}\n", encoding="utf-8")
    entry = tmp_path / "work-design-preflight.mjs"
    entry.write_text("// product runtime\n", encoding="utf-8")
    expected = {"schema": "kungfu.work-design.preflight/v1"}

    def run(*_argv):
        print(json.dumps(expected))
        return 0

    with (
        patch("kungfu.cli.commands.work_design._preflight_entry", return_value=entry),
        patch(
            "kungfu.cli.commands.work_design.kungfu.__binding__.libnode.run",
            side_effect=run,
        ),
    ):
        result = CliRunner().invoke(
            kfc,
            ["work-design", "preflight", "--input", str(request)],
        )

    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == expected
