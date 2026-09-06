# SPDX-License-Identifier: Apache-2.0

import importlib.util
import os
import sys
import types
from pathlib import Path

import click
import pytest

from kungfu import host


CORE = Path(__file__).resolve().parents[2]
COMMAND = CORE / "src/python/kungfu/cli/commands/action.py"


class FakeKfc:
    def command(self, **_kwargs):
        return lambda function: function


class FakeLibnode:
    def __init__(self, status=0):
        self.status = status
        self.argv = None

    def run(self, *argv):
        self.argv = argv
        return self.status


def load_action_module(tmp_path, monkeypatch, status=0):
    binding_file = tmp_path / "runtime" / "pykungfu.so"
    binding_file.parent.mkdir(parents=True)
    binding_file.write_bytes(b"")
    libnode = FakeLibnode(status)
    kungfu = types.ModuleType("kungfu")
    kungfu.host = host
    kungfu.__binding__ = types.SimpleNamespace(
        __file__=str(binding_file), libnode=libnode
    )
    cli = types.ModuleType("kungfu.cli")
    commands = types.ModuleType("kungfu.cli.commands")
    commands.kfc = FakeKfc()
    monkeypatch.setitem(sys.modules, "kungfu", kungfu)
    monkeypatch.setitem(sys.modules, "kungfu.cli", cli)
    monkeypatch.setitem(sys.modules, "kungfu.cli.commands", commands)
    spec = importlib.util.spec_from_file_location("action_command_under_test", COMMAND)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, libnode


def test_installed_action_uses_embedded_libnode(tmp_path, monkeypatch):
    module, libnode = load_action_module(tmp_path, monkeypatch)
    entry = tmp_path / "action" / "action.mjs"
    entry.parent.mkdir()
    entry.write_text("// fixture\n", encoding="utf-8")
    monkeypatch.setenv("KUNGFU_ACTION_ENTRY", str(entry))
    monkeypatch.setenv("KUNGFU_INSTALL_SOURCE", "archive")
    module._run_action(("contract", "--json"))
    assert libnode.argv[1:] == (str(entry), "contract", "--json")
    assert os.environ["KUNGFU_ACTION_HOST"] == "embedded-libnode"
    assert os.environ["KUNGFU_ACTION_LAYOUT"] == "installed"


def test_packaged_action_infers_installed_layout(tmp_path, monkeypatch):
    module, libnode = load_action_module(tmp_path, monkeypatch)
    entry = tmp_path / "action" / "action.mjs"
    entry.parent.mkdir()
    entry.write_text("// fixture\n", encoding="utf-8")
    monkeypatch.setenv("KUNGFU_ACTION_ENTRY", str(entry))
    monkeypatch.delenv("KUNGFU_INSTALL_SOURCE", raising=False)
    module._run_action(("contract", "--json"))
    assert libnode.argv[1:] == (str(entry), "contract", "--json")
    assert os.environ["KUNGFU_ACTION_HOST"] == "embedded-libnode"
    assert os.environ["KUNGFU_ACTION_LAYOUT"] == "installed"


def test_action_override_is_canonicalized_to_real_path(tmp_path, monkeypatch):
    module, libnode = load_action_module(tmp_path, monkeypatch)
    entry = tmp_path / "action.mjs"
    entry.write_text("// fixture\n", encoding="utf-8")
    monkeypatch.setenv("KUNGFU_ACTION_ENTRY", str(entry))
    seen = []

    def fake_realpath(value):
        seen.append(value)
        return f"canonical:{value}"

    monkeypatch.setattr(module.os.path, "realpath", fake_realpath)
    module._run_action(("contract", "--json"))
    assert seen[0] == str(entry)
    assert libnode.argv[1] == f"canonical:{entry}"


def test_action_rejects_missing_override_without_fallback(tmp_path, monkeypatch):
    module, libnode = load_action_module(tmp_path, monkeypatch)
    monkeypatch.setenv("KUNGFU_ACTION_ENTRY", str(tmp_path / "missing.mjs"))
    with pytest.raises(click.ClickException, match="Action package not found"):
        module._run_action(("contract", "--json"))
    assert libnode.argv is None


def test_action_propagates_embedded_node_exit_code(tmp_path, monkeypatch):
    module, _libnode = load_action_module(tmp_path, monkeypatch, status=64)
    entry = tmp_path / "action.mjs"
    entry.write_text("// fixture\n", encoding="utf-8")
    monkeypatch.setenv("KUNGFU_ACTION_ENTRY", str(entry))
    with pytest.raises(SystemExit) as raised:
        module._run_action(("unknown", "--json"))
    assert raised.value.code == 64


def test_source_action_uses_the_declared_public_package_entry(tmp_path, monkeypatch):
    module, _libnode = load_action_module(tmp_path, monkeypatch)
    entry = tmp_path / "public-action.mjs"
    entry.write_text("export {};\n")
    requested = []

    def resolve(specifier):
        requested.append(specifier)
        return str(entry)

    monkeypatch.setattr(host, "node_package_entry", resolve)
    monkeypatch.delenv("KUNGFU_ACTION_ENTRY", raising=False)
    assert module._resolve_action_entry() == str(entry)
    assert requested == ["@kungfu-tech/work/action/cli"]
