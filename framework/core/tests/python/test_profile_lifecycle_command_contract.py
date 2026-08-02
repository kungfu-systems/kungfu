# SPDX-License-Identifier: Apache-2.0

import copy
import json

import pytest
from click.testing import CliRunner

from kungfu import agent as agent_pack
from kungfu import profile_sdk
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu import profile_sdk_support as profile_lifecycle_commands
from kungfu.profile_sdk_support import _root


def _contract():
    return profile_sdk.capabilities()["lifecycleCommandContract"]


def _reroot(contract):
    body = copy.deepcopy(contract)
    body.pop("contractRoot", None)
    contract["contractRoot"] = _root(body)
    return contract


def _command(contract, operation_id):
    return next(row for row in contract["commands"] if row["id"] == operation_id)


def test_contract_is_deterministic_rooted_and_shared_by_installed_projections(tmp_path):
    first = _contract()
    second = _contract()
    body = copy.deepcopy(first)
    recorded = body.pop("contractRoot")

    assert first == second
    assert first["schema"] == "kungfu.profile-lifecycle-command-contract/v1"
    assert recorded == _root(body)
    assert profile_sdk.lifecycle_command_contract() == first

    runner = CliRunner()
    capabilities = runner.invoke(
        kfc, ["--home", str(tmp_path / "home"), "profile", "capabilities", "--json"]
    )
    manager = runner.invoke(
        kfc, ["--home", str(tmp_path / "home"), "profile", "manager", "--json"]
    )
    assert capabilities.exit_code == 0, capabilities.output
    assert manager.exit_code == 0, manager.output
    assert json.loads(capabilities.output)["lifecycleCommandContract"] == first
    assert json.loads(manager.output)["lifecycleCommandContract"] == first


def test_reader_and_plan_commands_render_as_argv_while_writes_are_fenced():
    contract = _contract()
    bindings = {
        "binary": "/task/bin/kungfu",
        "profile_id": "example.week-day",
        "source": "/task/profiles/week-day",
        "before_root": "sha256:" + "1" * 64,
    }

    assert profile_lifecycle_commands.render_command(
        contract, "profile.manager", bindings
    ) == ["/task/bin/kungfu", "profile", "manager", "--json"]
    assert profile_lifecycle_commands.render_command(
        contract, "profile.plan.upgrade", bindings
    ) == [
        "/task/bin/kungfu",
        "profile",
        "plan",
        "upgrade",
        "/task/profiles/week-day",
        "--expected-current-root",
        "sha256:" + "1" * 64,
        "--json",
    ]
    assert _command(contract, "profile.manager")["mutation"] is False
    assert _command(contract, "profile.plan.upgrade")["mutation"] is False
    assert _command(contract, "profile.apply")["mutation"] is True
    assert _command(contract, "profile.authorize-upgrade")["mutation"] is True
    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_lifecycle_commands.render_command(
            contract,
            "profile.apply",
            {
                "binary": "/task/bin/kungfu",
                "plan_file": "/task/plan.json",
                "authorization_file": "/task/authorization.json",
            },
        )
    assert raised.value.diagnosis["code"] == "lifecycle-command-mutation-rejected"


def test_contract_rejects_stale_root_unknown_placeholder_and_shell_argv():
    stale = _contract()
    stale["version"] = 2
    with pytest.raises(profile_sdk.ProfileSdkError):
        profile_lifecycle_commands.validate_command_contract(stale)

    unknown = _contract()
    command = _command(unknown, "profile.manager")
    command["argv"].append("{unknown}")
    command["placeholders"].append({"name": "unknown", "type": "text"})
    _reroot(unknown)
    with pytest.raises(profile_sdk.ProfileSdkError, match="unknown placeholder"):
        profile_lifecycle_commands.validate_command_contract(unknown)

    shell = _contract()
    command = _command(shell, "profile.manager")
    command["argv"] = ["{binary}", "profile", "manager", "sh", "-c", "date"]
    _reroot(shell)
    with pytest.raises(profile_sdk.ProfileSdkError, match="shell evaluation"):
        profile_lifecycle_commands.validate_command_contract(shell)


def test_contract_rejects_mutation_approval_precondition_and_catalog_drift():
    mislabeled = _contract()
    _command(mislabeled, "profile.apply")["mutation"] = False
    _reroot(mislabeled)
    with pytest.raises(profile_sdk.ProfileSdkError, match="mutation metadata"):
        profile_lifecycle_commands.validate_command_contract(mislabeled)

    approval = _contract()
    _command(approval, "profile.apply")["approvalPolicy"] = {
        "mode": "none",
        "caller_confirmation_required": False,
        "preconditions": [],
    }
    _reroot(approval)
    with pytest.raises(profile_sdk.ProfileSdkError, match="approval policy"):
        profile_lifecycle_commands.validate_command_contract(approval)

    precondition = _contract()
    _command(precondition, "profile.apply")["preconditions"] = []
    _reroot(precondition)
    with pytest.raises(profile_sdk.ProfileSdkError, match="require approval"):
        profile_lifecycle_commands.validate_command_contract(precondition)

    catalog = copy.deepcopy(agent_pack.cli_surface_catalog())
    catalog["surfaces"] = [
        row
        for row in catalog["surfaces"]
        if row["id"] != "kungfu.cli.commands.profile.manager"
    ]
    with pytest.raises(
        profile_sdk.ProfileSdkError, match="absent from the CLI catalog"
    ):
        profile_lifecycle_commands.command_contract(
            profile_sdk.capabilities()["lifecycleAuthority"],
            profile_sdk.capabilities()["sdkContract"],
            catalog,
        )


def test_cli_reads_and_plans_only_inside_the_supplied_home(tmp_path):
    real_home_sentinel = tmp_path / "outside-home-sentinel"
    real_home_sentinel.write_text("unchanged", encoding="utf-8")
    home = tmp_path / "isolated-home"
    runner = CliRunner()

    capabilities = runner.invoke(
        kfc, ["--home", str(home), "profile", "capabilities", "--json"]
    )
    listing = runner.invoke(kfc, ["--home", str(home), "profile", "list", "--json"])
    assert capabilities.exit_code == 0, capabilities.output
    assert listing.exit_code == 0, listing.output
    assert json.loads(listing.output)["profiles"] == []
    assert real_home_sentinel.read_text(encoding="utf-8") == "unchanged"
    assert (
        _command(
            json.loads(capabilities.output)["lifecycleCommandContract"], "profile.list"
        )["mutation"]
        is False
    )
