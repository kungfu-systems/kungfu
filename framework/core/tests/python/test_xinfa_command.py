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
    env_command = types.ModuleType("kungfu.cli.commands.env")
    env_command._resolve_trunk = lambda: None
    monkeypatch.setitem(sys.modules, "kungfu", kungfu)
    monkeypatch.setitem(sys.modules, "kungfu.cli", cli)
    monkeypatch.setitem(sys.modules, "kungfu.cli.commands", commands)
    monkeypatch.setitem(sys.modules, "kungfu.cli.commands.env", env_command)
    spec = importlib.util.spec_from_file_location("xinfa_command_under_test", COMMAND)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_xinfa_forwards_argv_to_trunk_without_normalizing(tmp_path, monkeypatch):
    module = load_xinfa_module(tmp_path, monkeypatch)
    trunk = tmp_path / "kungfu-trunk"
    trunk.write_bytes(b"")
    monkeypatch.setattr(module, "_resolve_trunk", lambda: str(trunk))
    observed = []

    def execv(path, argv):
        observed.append((path, argv))
        raise SystemExit(23)

    monkeypatch.setattr(module.os, "execv", execv)
    with pytest.raises(SystemExit) as raised:
        module._run_xinfa(("compile", "--workspace", "two words"))
    assert raised.value.code == 23
    assert observed == [
        (
            str(trunk),
            [str(trunk), "xinfa", "compile", "--workspace", "two words"],
        )
    ]


def test_xinfa_missing_trunk_fails_closed(tmp_path, monkeypatch):
    module = load_xinfa_module(tmp_path, monkeypatch)
    monkeypatch.setattr(module, "_resolve_trunk", lambda: None)
    with pytest.raises(click.ClickException, match="linked Xinfa component"):
        module._run_xinfa(("contract", "--json"))
