# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
import json
from types import SimpleNamespace
import sys

import click
from click.testing import CliRunner
import pytest

from kungfu import config
from kungfu.agent import runtime_profiles
from kungfu.agent.kfd3 import verify_agent_interface
from kungfu.rewind.cost.discovery import discover_provider_candidates


ROOT = Path(__file__).resolve().parents[4]
CONTRACT = ROOT / "framework" / "config" / "kungfu-config.contract.json"
ROOT_HASH = "sha256:" + "a" * 64


def _contract():
    return config.load_contract(str(CONTRACT))


def _work_ref():
    return {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "workspace:test",
        "profileId": "kungfu.mission-control",
        "profileRoot": ROOT_HASH,
        "entityType": "go",
        "entityId": "go:test",
        "entityRoot": ROOT_HASH,
        "purpose": "delegated-work",
        "systemTimeCut": "2026-07-13T00:00:00Z",
    }


def test_agent_runtime_profile_is_part_of_the_global_config_contract():
    value = config.raw_default_config(str(CONTRACT))
    value["agent"]["runtimeProfiles"] = [
        {
            "schema": "kungfu.agent-runtime-profile/v1",
            "id": "codex-app",
            "label": "Codex App CLI",
            "provider": "codex",
            "launch": {
                "executable": "/Applications/Codex.app/Contents/Resources/codex",
                "argv": [],
                "shellMode": False,
            },
            "cwdPolicy": "workspace-root",
            "backendDefault": "tmux",
            "bootstrap": {"adapter": "codex", "envelope": "required"},
            "source": "discovered",
            "lastVerified": None,
        }
    ]
    value["agent"]["defaultRuntimeProfile"] = "codex-app"
    config.validate_config(value, contract=_contract())


def test_agent_runtime_profile_rejects_opaque_extra_fields():
    value = config.raw_default_config(str(CONTRACT))
    value["agent"]["runtimeProfiles"] = [
        {
            "schema": "kungfu.agent-runtime-profile/v1",
            "id": "unsafe",
            "label": "Unsafe",
            "provider": "codex",
            "launch": {
                "executable": "/bin/sh",
                "argv": ["-lc", "codex"],
                "shellMode": True,
                "secret": "must-not-be-stored",
            },
            "cwdPolicy": "workspace-root",
            "backendDefault": "direct",
            "bootstrap": {"adapter": "codex", "envelope": "required"},
            "source": "user",
        }
    ]
    with pytest.raises(ValueError):
        config.validate_config(value, contract=_contract())


def test_work_console_requires_a_bound_work_ref_for_work_bindings():
    value = {
        "schema": "kungfu.work-console-registry/v1",
        "workspaceId": "workspace:test",
        "consoles": [
            {
                "consoleId": "console:go-test",
                "bindingKind": "work",
                "workRef": _work_ref(),
                "runtimeProfileId": "codex-app",
                "backend": "tmux",
                "attempts": [
                    {
                        "attemptId": "attempt:1",
                        "runId": "run:1",
                        "status": "running",
                        "startedAt": 1,
                    }
                ],
                "createdAt": 1,
                "updatedAt": 1,
            }
        ],
        "presentation": {"tabs": [], "splits": [], "drawer": None, "windows": []},
    }
    config.validate_value("workConsoleRegistry", value, contract=_contract())
    del value["consoles"][0]["workRef"]
    with pytest.raises(ValueError):
        config.validate_value("workConsoleRegistry", value, contract=_contract())


def test_agent_console_envelope_binds_work_and_discovery_entrypoints():
    value = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": "workspace:test",
        "consoleId": "console:go-test",
        "attemptId": "attempt:1",
        "runtimeProfileId": "codex-app",
        "provider": "codex",
        "activeProfiles": [{"id": "kungfu.mission-control", "root": ROOT_HASH}],
        "workRef": _work_ref(),
        "entrypoints": {
            "context": ["kungfu", "agent", "context", "--json"],
            "capabilities": ["kungfu", "agent", "capabilities", "--json"],
            "profiles": ["kungfu", "profile", "manager", "--json"],
        },
        "knownLimits": ["terminal transcript is not proof"],
        "envelopeRoot": ROOT_HASH,
    }
    config.validate_value("agentConsoleEnvelope", value, contract=_contract())
    value["workRef"]["profileRoot"] = "latest"
    with pytest.raises(ValueError):
        config.validate_value("agentConsoleEnvelope", value, contract=_contract())


def test_discovery_returns_path_and_app_candidates_without_first_hit_collapse():
    rows = discover_provider_candidates(
        "codex",
        which=lambda name: "/usr/local/bin/codex" if name == "codex" else None,
        platform="darwin",
        exists=lambda path: path.startswith("/Applications/Codex.app/"),
        version_probe=lambda path: f"version:{path}",
    )
    assert [row.path_class for row in rows] == ["path", "codex_app_bundle"]
    assert all(row.found for row in rows)
    assert rows[0].path == "/usr/local/bin/codex"
    assert rows[1].path.endswith("/Contents/Resources/codex")


@pytest.mark.parametrize(
    ("provider_output", "expected"),
    [
        ("codex-cli 0.144.3\n", "0.144.3"),
        ("2.1.209 (Claude Code)\n", "2.1.209"),
    ],
)
def test_runtime_profile_verification_returns_a_semantic_provider_version(
    monkeypatch, provider_output, expected
):
    monkeypatch.setattr(
        runtime_profiles.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0, stdout=provider_output, stderr=""
        ),
    )
    result = runtime_profiles.verify_profile(
        {
            "id": "provider.path.test",
            "provider": "codex",
            "launch": {"executable": sys.executable},
        }
    )
    assert result["ok"] is True
    assert result["version"] == expected


def test_runtime_profile_plan_apply_default_and_remove_are_preview_first(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        "kungfu.contract.contract_hash", lambda *args, **kwargs: ROOT_HASH
    )
    config_home = tmp_path / "config"
    runtime_home = tmp_path / "runtime"
    plan = runtime_profiles.plan_upsert(
        profile_id="codex-python-wrapper",
        label="Codex test wrapper",
        provider="codex",
        executable=sys.executable,
        argv=["-c", "print('codex')"],
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    assert plan["requiresExecute"] is True
    assert not (config_home / "config.json").exists()

    receipt = runtime_profiles.apply_upsert(
        plan, config_home=str(config_home), runtime_home=str(runtime_home)
    )
    assert receipt["changed"] is True
    assert (
        runtime_profiles.configured_profiles(
            config_home=str(config_home), runtime_home=str(runtime_home)
        )[0]["id"]
        == "codex-python-wrapper"
    )

    default_plan = runtime_profiles.set_default(
        "codex-python-wrapper",
        execute=False,
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    assert default_plan["changed"] is False
    default_receipt = runtime_profiles.set_default(
        "codex-python-wrapper",
        execute=True,
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    assert default_receipt["changed"] is True

    remove_plan = runtime_profiles.plan_remove(
        "codex-python-wrapper",
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    assert runtime_profiles.configured_profiles(
        config_home=str(config_home), runtime_home=str(runtime_home)
    )
    runtime_profiles.apply_remove(
        remove_plan, config_home=str(config_home), runtime_home=str(runtime_home)
    )
    resolved = config.resolve_config(
        config_home=str(config_home), runtime_home=str(runtime_home)
    )
    assert resolved["config"]["agent"]["runtimeProfiles"] == []
    assert resolved["config"]["agent"]["defaultRuntimeProfile"] is None


def test_agent_runtime_commands_are_closed_in_the_kfd3_registry(monkeypatch):
    import kungfu

    kungfu.__dict__["__version__"] = "test"
    from kungfu.cli.commands.agent import agent

    monkeypatch.setattr("kungfu.agent.kfd3.registry_digest", lambda: ROOT_HASH)
    result = verify_agent_interface(agent)
    assert result["ok"], result


def test_agent_session_cli_forwards_the_same_self_describing_action(
    tmp_path, monkeypatch
):
    import kungfu

    kungfu.__dict__["__version__"] = "test"
    from kungfu.cli.commands.agent import agent

    captured = []

    def fake_invoke(request, endpoint=None, timeout=5.0):
        captured.append((request, endpoint, timeout))
        return {
            "schema": "kungfu.agent-session.surface-list/v1",
            "sessions": [],
            "listRoot": ROOT_HASH,
        }

    monkeypatch.setattr("kungfu.agent.session_surface.invoke", fake_invoke)

    @click.group()
    @click.option("--home", type=click.Path(), required=True)
    @click.pass_context
    def test_cli(ctx, home):
        ctx.name = "agent-session-test"
        ctx.config_home = str(Path(home) / "config")
        ctx.home = str(home)
        ctx.runtime_dir = str(Path(home) / "runtime")
        ctx.extension_path = None
        ctx.log_level = "warning"
        ctx.dataset_dir = str(Path(home) / "dataset")
        ctx.backtest_dir = str(Path(home) / "backtest")
        ctx.inbox_dir = str(Path(home) / "inbox")
        ctx.runtime_locator = None
        ctx.backtest_locator = None
        ctx.config_location = None
        ctx.console_location = None
        ctx.index_location = None
        ctx.stage = "test"

    test_cli.add_command(agent)
    result = CliRunner().invoke(
        test_cli,
        ["--home", str(tmp_path), "agent", "session", "list", "--json"],
        env={"KUNGFU_AGENT_SESSION_ACTOR": "controller:test"},
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["schema"] == "kungfu.agent-session.surface-list/v1"
    assert captured[0][0] == {
        "operation": "list",
        "client": "cli",
        "actorId": "controller:test",
    }


def test_work_console_registry_accepts_capsule_backend():
    value = {
        "schema": "kungfu.work-console-registry/v1",
        "workspaceId": "workspace:test",
        "consoles": [
            {
                "consoleId": "console:assistant",
                "bindingKind": "workspace-assistant",
                "workRef": None,
                "runtimeProfileId": "codex-app",
                "backend": "capsule",
                "attempts": [
                    {
                        "attemptId": "attempt:1",
                        "runId": "attempt:1",
                        "status": "running",
                        "startedAt": 1,
                    }
                ],
                "createdAt": 1,
                "updatedAt": 1,
            }
        ],
        "presentation": {"tabs": [], "splits": [], "drawer": None, "windows": []},
    }
    config.validate_value("workConsoleRegistry", value, contract=_contract())
