# SPDX-License-Identifier: Apache-2.0

import importlib.util
import sys
import types
from pathlib import Path

import click
import pytest


CORE = Path(__file__).resolve().parents[2]
ENV_COMMAND = CORE / "src/python/kungfu/cli/commands/env.py"
SHIFU_COMMAND = CORE / "src/python/kungfu/cli/commands/shifu.py"


class FakeKfc:
    def command(self, **_kwargs):
        return lambda function: function


def load_env_module(tmp_path, monkeypatch):
    kungfu = types.ModuleType("kungfu")
    kungfu.host = types.SimpleNamespace(product_root=lambda: None)
    cli = types.ModuleType("kungfu.cli")
    commands = types.ModuleType("kungfu.cli.commands")
    commands.kfc = FakeKfc()
    monkeypatch.setitem(sys.modules, "kungfu", kungfu)
    monkeypatch.setitem(sys.modules, "kungfu.cli", cli)
    monkeypatch.setitem(sys.modules, "kungfu.cli.commands", commands)
    spec = importlib.util.spec_from_file_location("env_command_under_test", ENV_COMMAND)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_trunk_component_forwards_argv_without_normalizing(tmp_path, monkeypatch):
    module = load_env_module(tmp_path, monkeypatch)
    trunk = tmp_path / "kungfu-trunk"
    trunk.write_bytes(b"")
    monkeypatch.setattr(module, "_resolve_trunk", lambda: str(trunk))
    observed = []

    def execv(path, argv):
        observed.append((path, argv))
        raise SystemExit(23)

    monkeypatch.setattr(module.os, "execv", execv)
    with pytest.raises(SystemExit) as raised:
        module._run_trunk_component("shifu", ("exec", "two words"), "trunk unavailable")
    assert raised.value.code == 23
    assert observed == [
        (str(trunk), [str(trunk), "shifu", "exec", "two words"]),
    ]


def test_trunk_component_uses_subprocess_on_windows(tmp_path, monkeypatch):
    module = load_env_module(tmp_path, monkeypatch)
    trunk = tmp_path / "kungfu-trunk.exe"
    trunk.write_bytes(b"")
    monkeypatch.setattr(module, "_resolve_trunk", lambda: str(trunk))
    monkeypatch.setattr(module.os, "name", "nt")
    observed = []

    def run(argv):
        observed.append(argv)
        return types.SimpleNamespace(returncode=17)

    monkeypatch.setattr(module.subprocess, "run", run)
    with pytest.raises(SystemExit) as raised:
        module._run_trunk_component("shifu", ("doctor",), "trunk unavailable")
    assert raised.value.code == 17
    assert observed == [[str(trunk), "shifu", "doctor"]]


def test_trunk_component_missing_binary_fails_closed(tmp_path, monkeypatch):
    module = load_env_module(tmp_path, monkeypatch)
    monkeypatch.setattr(module, "_resolve_trunk", lambda: None)
    with pytest.raises(click.ClickException, match="trunk unavailable"):
        module._run_trunk_component("shifu", (), "trunk unavailable")


def test_shifu_command_is_a_declarative_trunk_binding(tmp_path, monkeypatch):
    env_command = load_env_module(tmp_path, monkeypatch)
    monkeypatch.setitem(sys.modules, "kungfu.cli.commands.env", env_command)
    spec = importlib.util.spec_from_file_location(
        "shifu_command_under_test", SHIFU_COMMAND
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    observed = []

    def run(component, commands, missing_message):
        observed.append((component, commands, missing_message))
        return 29

    monkeypatch.setattr(module, "_run_trunk_component", run)
    assert module.shifu(("doctor", "--json")) == 29
    assert observed == [
        (
            "shifu",
            ("doctor", "--json"),
            "kungfu-trunk with linked Shifu was not found; set KUNGFU_TRUNK_BIN",
        )
    ]
