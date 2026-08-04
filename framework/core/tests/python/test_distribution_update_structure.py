# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import subprocess
import sys
import types

import pytest


fake = types.ModuleType("pykungfu")
fake.__file__ = "/nonexistent/pykungfu.so"
fake.runtime = types.ModuleType("pykungfu.runtime")
fake.runtime.coordinator = type("FakeNativeCoordinator", (), {})
fake.yijinjing = types.SimpleNamespace()
sys.modules.setdefault("pykungfu", fake)
sys.modules.setdefault("pykungfu.runtime", fake.runtime)

from kungfu import (  # noqa: E402
    distribution_update,
    distribution_update_planning,
    distribution_update_policy,
)


def test_distribution_update_compatibility_surface_reexports_extracted_layers() -> None:
    policy_exports = (
        "DistributionUpdateError",
        "compare_product_versions",
        "install_source",
        "local_dogfood_residency",
    )
    planning_exports = (
        "check_release",
        "plan_download",
        "plan_update",
        "validate_update_plan",
        "record_update_outcome",
    )
    for name in policy_exports:
        assert getattr(distribution_update, name) is getattr(
            distribution_update_policy, name
        )
    for name in planning_exports:
        assert getattr(distribution_update, name) is getattr(
            distribution_update_planning, name
        )


def test_windows_selected_cli_handoff_waits_for_child_and_preserves_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    argv = [r"C:\selected\kungfu.exe", "run", "codex"]
    env = {"KUNGFU_SELECTED_FRONTEND_BUILD_ID": "product-selected"}
    observed = {}

    monkeypatch.setattr(distribution_update.sys, "platform", "win32")
    monkeypatch.setattr(
        distribution_update,
        "selected_cli_command",
        lambda: (argv, env),
    )

    def run_selected(command, *, env, check):
        observed.update(command=command, env=env, check=check)
        return subprocess.CompletedProcess(command, 23)

    monkeypatch.setattr(distribution_update.subprocess, "run", run_selected)
    monkeypatch.setattr(
        distribution_update.os,
        "execve",
        lambda *_args: pytest.fail("Windows must not detach via os.execve"),
    )

    with pytest.raises(SystemExit) as exited:
        distribution_update.reexec_selected_cli()

    assert exited.value.code == 23
    assert observed == {"command": argv, "env": env, "check": False}


def test_non_windows_selected_cli_handoff_still_execs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    argv = ["/selected/kungfu", "--version"]
    env = {"KUNGFU_SELECTED_FRONTEND_BUILD_ID": "product-selected"}
    observed = {}

    monkeypatch.setattr(distribution_update.sys, "platform", "linux")
    monkeypatch.setattr(
        distribution_update,
        "selected_cli_command",
        lambda: (argv, env),
    )
    monkeypatch.setattr(
        distribution_update.os,
        "execve",
        lambda executable, command, selected_env: observed.update(
            executable=executable,
            command=command,
            env=selected_env,
        ),
    )

    distribution_update.reexec_selected_cli()

    assert observed == {"executable": argv[0], "command": argv, "env": env}
