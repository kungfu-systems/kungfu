# SPDX-License-Identifier: Apache-2.0

import importlib.util
import os
import sys
import types
from pathlib import Path


def _load_tui_runtime(monkeypatch):
    source = (
        Path(__file__).resolve().parents[2]
        / "src"
        / "python"
        / "kungfu"
        / "cli"
        / "tui_runtime.py"
    )
    fake_kungfu = types.ModuleType("kungfu")
    fake_skill = types.ModuleType("kungfu.skill")
    fake_skill.build_skill_runtime_audit = lambda _home: {"schema": "fixture"}
    fake_skill.write_skill_runtime_audit = lambda path, _document: path
    monkeypatch.setitem(sys.modules, "kungfu", fake_kungfu)
    monkeypatch.setitem(sys.modules, "kungfu.skill", fake_skill)
    spec = importlib.util.spec_from_file_location("tui_runtime_fixture", source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_packaged_tui_exports_its_bundled_extension_root(tmp_path, monkeypatch):
    tui_runtime = _load_tui_runtime(monkeypatch)
    runtime = tmp_path / "product" / "runtime"
    binding = runtime / "pykungfu.so"
    home = tmp_path / "home" / "runtime"
    monkeypatch.delenv("KUNGFU_DIR", raising=False)
    monkeypatch.delenv("KF_BUNDLED_EXTENSION_ROOT", raising=False)
    monkeypatch.delenv("KF_RUNTIME_DIR", raising=False)

    tui_runtime._configure_tui_environment(str(binding), str(home))

    assert os.environ["KUNGFU_DIR"] == str(runtime)
    assert os.environ["KF_BUNDLED_EXTENSION_ROOT"] == str(
        tmp_path / "product" / "extensions"
    )
    assert os.environ["KF_RUNTIME_DIR"] == str(home)


def test_packaged_tui_projects_one_shared_runtime_audit_file(tmp_path, monkeypatch):
    tui_runtime = _load_tui_runtime(monkeypatch)
    written = []
    monkeypatch.setattr(
        tui_runtime,
        "build_skill_runtime_audit",
        lambda home: {"schema": "fixture", "home": home},
    )
    monkeypatch.setattr(
        tui_runtime,
        "write_skill_runtime_audit",
        lambda path, document: written.append((path, document)),
    )

    output = tui_runtime._configure_tui_skill_runtime_audit(
        str(tmp_path / "home"), str(tmp_path / "runtime")
    )

    assert output == str(
        tmp_path / "runtime" / "skill-manager" / "tui-runtime-audit.json"
    )
    assert os.environ["KF_SKILL_RUNTIME_AUDIT_FILE"] == output
    assert written == [(output, {"schema": "fixture", "home": str(tmp_path / "home")})]
