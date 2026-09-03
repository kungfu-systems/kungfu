# SPDX-License-Identifier: Apache-2.0

"""Bare update command orchestration contracts."""

from __future__ import annotations

from _distribution_update_support import *  # noqa: F403


def test_bare_update_check_noninteractive_and_yes_modes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    discovery = {
        "schema": "kungfu.product-update-discovery/v1",
        "transportState": "local-fixture",
        "cachePath": None,
        "plan": plan,
    }
    monkeypatch.setattr(
        update_command, "_discover_update_plan", lambda *_args: discovery
    )

    checked = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "--check", "--json"],
    )
    assert checked.exit_code == 0, checked.output
    assert json.loads(checked.output)["plan"]["planId"] == plan["planId"]

    noninteractive = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "--json"],
    )
    assert noninteractive.exit_code == 0, noninteractive.output
    assert json.loads(noninteractive.output)["reasonCode"] == "confirmation-required"

    expected_receipt = {
        "schema": distribution_update.ORCHESTRATION_RECEIPT_SCHEMA,
        "state": "complete",
        "receiptPath": str(tmp_path / "receipt.json"),
        "result": {
            "activationPlan": {
                "impact": {"activationTiming": "after current work is idle"},
                "nextAction": "Keep current work running.",
            }
        },
    }
    monkeypatch.setattr(
        distribution_update,
        "execute_update",
        lambda *_args, **_kwargs: expected_receipt,
    )
    executed = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "--yes", "--json"],
    )
    assert executed.exit_code == 0, executed.output
    assert json.loads(executed.output)["state"] == "complete"

    current_manifest = {**manifest, "productVersion": "4.0.0-alpha.0"}
    current_plan = distribution_update.plan_update(
        _selection(current_manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    monkeypatch.setattr(
        update_command,
        "_discover_update_plan",
        lambda *_args: {**discovery, "plan": current_plan},
    )
    no_update = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "--json"],
    )
    assert no_update.exit_code == 0, no_update.output
    assert json.loads(no_update.output)["plan"]["state"] == "current"


def test_previous_archive_alpha_upgrades_once_with_rooted_receipts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive, manifest = _archive(tmp_path)
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    monkeypatch.setattr(
        update_command,
        "_discover_update_plan",
        lambda *_args: {
            "schema": "kungfu.product-update-discovery/v1",
            "transportState": "local-fixture",
            "cachePath": None,
            "plan": plan,
        },
    )
    monkeypatch.setattr(
        update_command,
        "_activation_plan",
        lambda _ctx, value: {
            "state": "apply-now",
            "reasonCode": "workspace-idle",
            "runtimeBuildId": value["runtimeBuildId"],
            "impact": {
                "activeWorkContinues": False,
                "activationTiming": "now",
                "userActionRequired": False,
            },
            "nextAction": "Reconcile semantic readiness.",
        },
    )
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(archive.read_bytes()),
    )
    home = tmp_path / "installed-alpha"
    result = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(home),
            "update",
            "--yes",
            "--json",
        ],
        env={"KUNGFU_INSTALL_SOURCE": "archive"},
    )

    assert result.exit_code == 0, result.output
    receipt = json.loads(result.output)
    assert receipt["state"] == "complete"
    assert receipt["receiptRoot"].startswith("sha256:")
    orchestration_core = {
        key: value
        for key, value in receipt.items()
        if key not in {"receiptRoot", "receiptPath"}
    }
    assert receipt["receiptRoot"] == distribution_update._content_root(
        orchestration_core
    )
    assert receipt["releasePayloadRoot"] == plan["releasePayloadRoot"]
    execution = receipt["result"]
    for stage in ("download", "apply"):
        stage_receipt = execution[stage]
        stage_core = {
            key: value for key, value in stage_receipt.items() if key != "receiptRoot"
        }
        assert stage_receipt["receiptRoot"] == distribution_update._content_root(
            stage_core
        )
    assert (
        execution["apply"]["frontendImage"]["frontendBuildId"]
        == manifest["frontendBuildId"]
    )
    assert execution["apply"]["runtimeImage"]["buildId"] == manifest["runtimeBuildId"]
    assert Path(receipt["receiptPath"]).is_file()
    assert distribution_update.cli_inventory_fsck(home / "config")["ok"] is True


def test_bare_update_interactive_cancellation_writes_one_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    monkeypatch.setattr(
        update_command,
        "_discover_update_plan",
        lambda *_args: {
            "schema": "kungfu.product-update-discovery/v1",
            "transportState": "local-fixture",
            "cachePath": None,
            "plan": plan,
        },
    )
    monkeypatch.setattr(update_command, "_stdin_is_interactive", lambda: True)
    result = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update"],
        input="n\n",
    )
    assert result.exit_code == 0, result.output
    assert result.output.count("Proceed with this exact update?") == 1
    receipt_paths = list(
        (tmp_path / "config" / "product" / "update" / "receipts" / plan["planId"]).glob(
            "*.json"
        )
    )
    assert len(receipt_paths) == 1
    receipt_path = receipt_paths[0]
    receipt = json.loads(receipt_path.read_text("utf-8"))
    assert receipt["state"] == "cancelled"
    assert receipt["reasonCode"] == "cancelled-by-user"


@pytest.mark.parametrize(
    ("install_source", "reason_code"),
    [
        ("homebrew", "manager-required"),
        ("desktop-companion", "desktop-required"),
        ("native-installer", "unsupported-source"),
    ],
)
def test_bare_update_projects_non_executable_source_actions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    install_source: str,
    reason_code: str,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    plan = distribution_update.plan_update(
        _selection(manifest, source=install_source),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source(
            {"KUNGFU_INSTALL_SOURCE": install_source}
        ),
        cache_root=tmp_path / "cache",
    )
    monkeypatch.setattr(
        update_command,
        "_discover_update_plan",
        lambda *_args: {
            "schema": "kungfu.product-update-discovery/v1",
            "transportState": "local-fixture",
            "cachePath": None,
            "plan": plan,
        },
    )
    result = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "--json"],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["plan"]["state"] == "action-required"
    assert payload["plan"]["reasonCode"] == reason_code


def test_bare_update_forwards_explicit_channel_and_offline_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _archive_path, manifest = _archive(tmp_path, product_version="4.0.0-alpha.0")
    manifest["releaseChannel"] = "stable"
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    seen = {}

    def discover(_ctx, channel, offline):
        seen.update(channel=channel, offline=offline)
        return {
            "schema": "kungfu.product-update-discovery/v1",
            "transportState": "offline-cache",
            "cachePath": str(tmp_path / "cache.json"),
            "plan": plan,
        }

    monkeypatch.setattr(update_command, "_discover_update_plan", discover)
    result = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(tmp_path),
            "update",
            "--channel",
            "stable",
            "--offline",
            "--check",
            "--json",
        ],
    )
    assert result.exit_code == 0, result.output
    assert seen == {"channel": "stable", "offline": True}
