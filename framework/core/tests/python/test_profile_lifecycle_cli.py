# SPDX-License-Identifier: Apache-2.0

import json

from click.testing import CliRunner

from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service as storage_service


def test_profile_lifecycle_python_service_and_cli_share_core_contract(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"

    direct = storage_service.profile_lifecycle(runtime_dir, "contract")
    result = CliRunner().invoke(
        kfc, ["--home", str(home), "kfx", "profile", "contract"]
    )

    assert direct["schema"] == "kungfu.profile-lifecycle/v1"
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == direct


def test_profile_lifecycle_cli_lists_empty_workspace_without_sidecar_authority(
    tmp_path,
):
    home = tmp_path / "home"
    result = CliRunner().invoke(kfc, ["--home", str(home), "kfx", "profile", "list"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["schema"] == "kungfu.profile-catalog/v1"
    assert payload["profiles"] == []
    assert not (home / "runtime" / "profile-catalog.json").exists()
