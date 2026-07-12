# SPDX-License-Identifier: Apache-2.0

import json

from click.testing import CliRunner

from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc


def test_storage_layout_inherits_the_complete_runtime_context(tmp_path):
    home = tmp_path / "home"

    result = CliRunner().invoke(
        kfc, ["--home", str(home), "storage", "layout", "--json"]
    )

    assert result.exit_code == 0, result.output
    layout = json.loads(result.output)
    assert layout["runtime_dir"] == str(home / "runtime")
