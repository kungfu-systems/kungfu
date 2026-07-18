# SPDX-License-Identifier: Apache-2.0

import importlib.util
import sys
import types
from pathlib import Path

import click
import pytest


CORE = Path(__file__).resolve().parents[2]
COMMAND = CORE / "src/python/kungfu/cli/commands/xinfa.py"


class FakeKfc:
    def command(self, **_kwargs):
        return lambda function: function


def load_xinfa_module(tmp_path, monkeypatch):
    binding_file = tmp_path / "runtime" / "pykungfu.so"
    binding_file.parent.mkdir(parents=True)
    binding_file.write_bytes(b"")
    kungfu = types.ModuleType("kungfu")
    kungfu.__binding__ = types.SimpleNamespace(__file__=str(binding_file))
    cli = types.ModuleType("kungfu.cli")
    commands = types.ModuleType("kungfu.cli.commands")
    commands.kfc = FakeKfc()
    monkeypatch.setitem(sys.modules, "kungfu", kungfu)
    monkeypatch.setitem(sys.modules, "kungfu.cli", cli)
    monkeypatch.setitem(sys.modules, "kungfu.cli.commands", commands)
    spec = importlib.util.spec_from_file_location("xinfa_command_under_test", COMMAND)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_compile_defaults_to_workspace_xinfa_project(tmp_path, monkeypatch):
    module = load_xinfa_module(tmp_path, monkeypatch)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.chdir(workspace)
    assert module._normalize_commands(("compile", "--output", "atlas", "--json")) == (
        "atlas",
        "compile",
        "--root",
        str(workspace),
        "--project",
        str(workspace / ".xinfa" / "project.json"),
        "--output",
        "atlas",
        "--json",
    )


def test_bare_compile_has_complete_workspace_defaults(tmp_path, monkeypatch):
    module = load_xinfa_module(tmp_path, monkeypatch)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.chdir(workspace)
    assert module._normalize_commands(("compile",)) == (
        "atlas",
        "compile",
        "--root",
        str(workspace),
        "--project",
        str(workspace / ".xinfa" / "project.json"),
        "--output",
        str(workspace / ".xinfa" / "atlas"),
        "--json",
    )


def test_atlas_lifecycle_commands_are_public_shortcuts(tmp_path, monkeypatch):
    module = load_xinfa_module(tmp_path, monkeypatch)
    assert module._normalize_commands(("verify", "--atlas", "out", "--json")) == (
        "atlas",
        "verify",
        "--atlas",
        "out",
        "--json",
    )
    assert module._normalize_commands(("contract", "--json")) == (
        "contract",
        "--json",
    )


def test_xinfa_forwards_to_private_engine_and_propagates_exit(tmp_path, monkeypatch):
    module = load_xinfa_module(tmp_path, monkeypatch)
    engine = tmp_path / "xinfa-engine"
    engine.write_bytes(b"")
    monkeypatch.setenv("KUNGFU_XINFA_ENTRY", str(engine))
    observed = []

    def run(argv, **kwargs):
        observed.append((argv, kwargs))
        return types.SimpleNamespace(returncode=23)

    monkeypatch.setattr(module.subprocess, "run", run)
    with pytest.raises(SystemExit) as raised:
        module._run_xinfa(("contract", "--json"))
    assert raised.value.code == 23
    assert observed[0][0] == [str(engine), "contract", "--json"]
    assert observed[0][1]["check"] is False


def test_xinfa_missing_override_fails_without_path_fallback(tmp_path, monkeypatch):
    module = load_xinfa_module(tmp_path, monkeypatch)
    monkeypatch.setenv("KUNGFU_XINFA_ENTRY", str(tmp_path / "missing"))
    with pytest.raises(click.ClickException, match="Xinfa engine not found"):
        module._run_xinfa(("contract", "--json"))
