# SPDX-License-Identifier: Apache-2.0

import copy
import json
import os
from pathlib import Path
import sys

import click
from click.testing import CliRunner
import pytest

from kungfu import config
from kungfu.agent import run_agent
from kungfu.agent.kfd3 import verify_agent_interface


ROOT = Path(__file__).resolve().parents[4]
CONTRACT = ROOT / "framework" / "config" / "kungfu-config.contract.json"
ROOT_HASH = "sha256:" + "a" * 64

WORK_CONTROL_COMMAND_CONTRACTS = {
    "kungfu.work.claim-completion": {
        "command": "claim-completion",
        "payload_options": {"--workspace", "--home", "--authorized-by"},
        "signature": "kungfu work claim-completion <input.json> --workspace <path> --authorized-by <actor>",
    },
    "kungfu.work.review": {
        "command": "review",
        "payload_options": {"--workspace", "--home", "--authorized-by"},
        "signature": "kungfu work review <input.json> --workspace <path> --authorized-by <reviewer>",
    },
    "kungfu.work.decide": {
        "command": "decide",
        "payload_options": {"--workspace", "--home", "--authorized-by"},
        "signature": "kungfu work decide <input.json> --workspace <path> --authorized-by <actor>",
    },
}


def _contract():
    return config.load_contract(str(CONTRACT))


def _work_ref():
    return {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "workspace:test",
        "profileId": "kungfu.work-control",
        "profileRoot": ROOT_HASH,
        "entityType": "assignment",
        "entityId": "assignment:test",
        "entityRoot": ROOT_HASH,
        "purpose": "delegated-work",
        "systemTimeCut": "2026-07-13T00:00:00Z",
        "initiativeId": "initiative:test",
    }


def test_run_agent_process_streams_output_before_return(tmp_path):
    script = tmp_path / "stream.py"
    script.write_text(
        "import sys\n"
        "print('first', flush=True)\n"
        "print('second', flush=True)\n"
        "print('notice', file=sys.stderr, flush=True)\n",
        encoding="utf-8",
    )
    streamed = []
    result = run_agent.run_process(
        [sys.executable, str(script)],
        cwd=str(tmp_path),
        env=os.environ,
        timeout_seconds=5,
        output_sink=lambda stream, line: streamed.append((stream, line.strip())),
    )
    assert result.exit_code == 0
    assert result.stdout == "first\nsecond\n"
    assert result.stderr == "notice\n"
    assert ("stdout", "first") in streamed
    assert ("stdout", "second") in streamed
    assert ("stderr", "notice") in streamed


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


def _assert_work_control_command_contract(work_control, command_catalog, api_registry):
    for api_id, contract in WORK_CONTROL_COMMAND_CONTRACTS.items():
        runtime_command = work_control.commands[contract["command"]]
        runtime_payload_options = {
            option.opts[0]
            for option in runtime_command.params
            if isinstance(option, click.Option) and option.name != "as_json"
        }
        assert runtime_payload_options == contract["payload_options"], api_id
        assert command_catalog[api_id] == contract["signature"]
        assert api_registry[api_id] == contract["signature"]


def test_work_control_commands_match_the_runtime_payload_contract():
    from kungfu import agent as agent_pack
    from kungfu.cli.commands.assignment import assignment

    command_catalog = {
        row["apiId"]: row["name"] for row in agent_pack.commands()["commands"]
    }
    api_registry = {row["id"]: row["name"] for row in agent_pack.registry()["apis"]}
    _assert_work_control_command_contract(assignment, command_catalog, api_registry)

    drifted_work_control = copy.copy(assignment)
    drifted_command = copy.copy(assignment.commands["claim-completion"])
    drifted_command.params = [
        *drifted_command.params,
        click.Option(["--joint-drift"]),
    ]
    drifted_work_control.commands = {
        **assignment.commands,
        "claim-completion": drifted_command,
    }
    drifted_command_catalog = dict(command_catalog)
    drifted_api_registry = dict(api_registry)
    for catalog in (drifted_command_catalog, drifted_api_registry):
        catalog["kungfu.work.claim-completion"] += " [--joint-drift <value>]"
    with pytest.raises(AssertionError):
        _assert_work_control_command_contract(
            drifted_work_control,
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
    monkeypatch.delenv("KUNGFU_AGENT_CONSOLE_ID", raising=False)

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
