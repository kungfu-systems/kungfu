# SPDX-License-Identifier: Apache-2.0

import copy
from pathlib import Path
import json
from types import SimpleNamespace
import sys

import click
from click.testing import CliRunner
import pytest

from kungfu import config
from kungfu.agent import run_agent
from kungfu.agent import runtime_profiles
from kungfu.agent.kfd3 import verify_agent_interface
from kungfu.rewind.cost.discovery import discover_provider_candidates


ROOT = Path(__file__).resolve().parents[4]
CONTRACT = ROOT / "framework" / "config" / "kungfu-config.contract.json"
ROOT_HASH = "sha256:" + "a" * 64


ATLAS_COMPLETION_COMMAND_CONTRACTS = {
    "kungfu.atlas.claim-completion": {
        "command": "claim-completion",
        "payload_options": {
            "--acceptance-root",
            "--actor",
            "--actor-type",
            "--evidence-availability",
            "--evidence-episode",
            "--git-commit",
            "--git-tree-root",
            "--go-set",
            "--input-atlas-root",
            "--known-gap",
            "--project-cut-root",
            "--project-cut-receipt-root",
            "--proof-root",
            "--result-atlas-root",
            "--source",
            "--statement",
        },
        "signature": "kungfu profile mission-control claim-completion <mission-id> <goal-id> --statement <statement> --actor <actor> [--actor-type <type>] [--source <source>] [--evidence-episode <id>] [--go-set <id>] [--acceptance-root <root>] [--input-atlas-root <root>] [--result-atlas-root <root>] [--project-cut-root <root>] [--project-cut-receipt-root <root>] [--git-commit <sha>] [--git-tree-root <root>] [--proof-root <root>] [--known-gap <gap>] [--evidence-availability <json>] --json",
    },
    "kungfu.atlas.review-completion": {
        "command": "review-completion",
        "payload_options": {
            "--cut-system-time",
            "--checkout",
            "--executor",
            "--follow-up",
            "--purpose",
            "--reviewer",
            "--reviewer-source",
            "--source",
        },
        "signature": "kungfu profile mission-control review-completion <mission-id> <goal-id> --reviewer <actor> --reviewer-source <source> [--checkout <path>] [--source <source>] [--purpose <purpose>] [--cut-system-time <ns>] [--executor <profile>] [--follow-up <json>] --json",
    },
    "kungfu.atlas.decide-continuation": {
        "command": "decide-continuation",
        "payload_options": {
            "--action",
            "--actor",
            "--actor-type",
            "--change-class",
            "--expected-plan-root",
            "--expected-review-root",
            "--reason",
            "--source",
        },
        "signature": "kungfu profile mission-control decide-continuation <mission-id> <goal-id> <review-id> --expected-review-root <root> --expected-plan-root <root> --action <action> --actor <actor> [--actor-type <type>] [--change-class <class>] [--source <source>] --reason <reason> --json",
    },
}


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


def test_opencode_runtime_profile_is_native_config_contract_member():
    value = config.raw_default_config(str(CONTRACT))
    value["agent"]["runtimeProfiles"] = [
        {
            "schema": "kungfu.agent-runtime-profile/v1",
            "id": "opencode-free",
            "label": "OpenCode free",
            "provider": "opencode",
            "launch": {
                "executable": "/usr/local/bin/opencode",
                "argv": [
                    "run",
                    "--pure",
                    "--model",
                    "opencode/north-mini-code-free",
                    "--format",
                    "json",
                ],
                "shellMode": False,
            },
            "cwdPolicy": "workspace-root",
            "backendDefault": "direct",
            "bootstrap": {"adapter": "opencode", "envelope": "required"},
            "source": "user",
            "lastVerified": None,
        }
    ]
    value["agent"]["defaultRuntimeProfile"] = "opencode-free"
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


def test_agent_console_envelope_accepts_opencode_provider():
    value = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": "workspace:test",
        "consoleId": "console:go-test",
        "attemptId": "attempt:1",
        "runtimeProfileId": "opencode-free",
        "provider": "opencode",
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


def test_opencode_discovery_is_path_only_and_privacy_bounded():
    rows = discover_provider_candidates(
        "opencode",
        which=lambda name: "/opt/opencode/bin/opencode" if name == "opencode" else None,
        platform="darwin",
        exists=lambda path: True,
        version_probe=lambda path: "1.18.3",
    )
    assert len(rows) == 1
    assert rows[0].provider == "opencode"
    assert rows[0].path == "/opt/opencode/bin/opencode"
    assert rows[0].path_class == "path"
    assert rows[0].version == "1.18.3"


@pytest.mark.parametrize(
    ("provider_output", "expected"),
    [
        ("codex-cli 0.144.3\n", "0.144.3"),
        ("2.1.209 (Claude Code)\n", "2.1.209"),
        ("1.18.3\n", "1.18.3"),
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


def test_run_agent_default_and_explicit_profiles_resolve_the_same_executable(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        "kungfu.contract.contract_hash", lambda *args, **kwargs: ROOT_HASH
    )
    config_home = tmp_path / "config"
    runtime_home = tmp_path / "runtime"
    for profile_id, agent_name in (
        ("opencode.free.plan", "plan"),
        ("opencode.free.build", "build"),
    ):
        plan = runtime_profiles.plan_upsert(
            profile_id=profile_id,
            label=profile_id,
            provider="opencode",
            executable=sys.executable,
            argv=["run", "--pure", "--agent", agent_name, "--format", "json"],
            backend="direct",
            config_home=str(config_home),
            runtime_home=str(runtime_home),
        )
        runtime_profiles.apply_upsert(
            plan, config_home=str(config_home), runtime_home=str(runtime_home)
        )
    runtime_profiles.set_default(
        "opencode.free.plan",
        execute=True,
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    default, default_source = run_agent.select_profile(
        None, config_home=str(config_home), runtime_home=str(runtime_home)
    )
    explicit, explicit_source = run_agent.select_profile(
        "opencode.free.build",
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    assert default_source == "default"
    assert explicit_source == "explicit"
    assert default["launch"]["executable"] == explicit["launch"]["executable"]
    assert default["launch"]["executable"] == sys.executable


def test_run_agent_parses_opencode_jsonl_without_using_session_history():
    output = "\n".join(
        [
            json.dumps(
                {
                    "type": "step_start",
                    "sessionID": "ses-fresh",
                    "part": {"type": "step-start"},
                }
            ),
            json.dumps(
                {
                    "type": "text",
                    "sessionID": "ses-fresh",
                    "part": {"type": "text", "text": "OPENCODE_OK"},
                }
            ),
            json.dumps(
                {
                    "type": "step_finish",
                    "sessionID": "ses-fresh",
                    "part": {
                        "type": "step-finish",
                        "tokens": {"total": 12},
                        "cost": 0,
                    },
                }
            ),
        ]
    )
    parsed = run_agent.parse_provider_output("opencode", output)
    assert parsed["providerSessionIds"] == ["ses-fresh"]
    assert parsed["text"] == "OPENCODE_OK"
    assert parsed["usage"] == {"total": 12}
    assert parsed["cost"] == 0


def test_run_agent_continuation_rejects_transcript_fields_and_root_drift():
    continuation = {
        "schema": "kungfu.agent-continuation-envelope/v1",
        "workRef": _work_ref(),
        "currentCutRoot": ROOT_HASH,
        "priorClaimRoot": ROOT_HASH,
        "assessmentRoot": ROOT_HASH,
        "remainingObligation": "write exact oracle",
        "nextAction": "write-oracle",
    }
    assert run_agent.validate_continuation(continuation) == continuation
    injected = {**continuation, "transcript": "private chat"}
    with pytest.raises(ValueError, match="exact"):
        run_agent.validate_continuation(injected)
    drifted = {**continuation, "assessmentRoot": "latest"}
    with pytest.raises(ValueError, match="assessmentRoot"):
        run_agent.validate_continuation(drifted)


def test_agent_runtime_commands_are_closed_in_the_kfd3_registry(monkeypatch):
    import kungfu

    kungfu.__dict__["__version__"] = "test"
    from kungfu.cli.commands.agent import agent

    monkeypatch.setattr("kungfu.agent.kfd3.registry_digest", lambda: ROOT_HASH)
    result = verify_agent_interface(agent)
    assert result["ok"], result


def _assert_mission_control_command_contract(
    mission_control, command_catalog, api_registry
):
    for api_id, contract in ATLAS_COMPLETION_COMMAND_CONTRACTS.items():
        runtime_command = mission_control.commands[contract["command"]]
        runtime_payload_options = {
            option.opts[0]
            for option in runtime_command.params
            if isinstance(option, click.Option) and option.name != "as_json"
        }
        assert runtime_payload_options == contract["payload_options"], api_id
        assert command_catalog[api_id] == contract["signature"]
        assert api_registry[api_id] == contract["signature"]


def test_mission_control_commands_match_the_runtime_payload_contract():
    from kungfu import agent as agent_pack
    from kungfu.cli.commands.atlas import mission_control

    command_catalog = {
        row["apiId"]: row["name"] for row in agent_pack.commands()["commands"]
    }
    api_registry = {row["id"]: row["name"] for row in agent_pack.registry()["apis"]}
    _assert_mission_control_command_contract(
        mission_control, command_catalog, api_registry
    )

    drifted_mission_control = copy.copy(mission_control)
    drifted_command = copy.copy(mission_control.commands["claim-completion"])
    drifted_command.params = [
        *drifted_command.params,
        click.Option(["--joint-drift"]),
    ]
    drifted_mission_control.commands = {
        **mission_control.commands,
        "claim-completion": drifted_command,
    }
    drifted_command_catalog = dict(command_catalog)
    drifted_api_registry = dict(api_registry)
    for catalog in (drifted_command_catalog, drifted_api_registry):
        catalog["kungfu.atlas.claim-completion"] += " [--joint-drift <value>]"
    with pytest.raises(AssertionError):
        _assert_mission_control_command_contract(
            drifted_mission_control,
            drifted_command_catalog,
            drifted_api_registry,
        )


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
