#  SPDX-License-Identifier: Apache-2.0
"""The host-neutral seam: form detection, product root, re-entry command.

Each host form is staged without real product builds: assembled via a marker
file under a faked sys.base_prefix, source as the live test interpreter itself
(a uv-managed dev interpreter has no marker).
"""

import json
import os
import stat
import sys

from kungfu import _runtime_violation, host


def _write_marker(prefix, body=None):
    prefix.mkdir(parents=True, exist_ok=True)
    marker = prefix / "kungfu-host.json"
    marker.write_text(
        json.dumps(
            {"schema": "kungfu.host/v1", "form": "assembled", "product_root": ".."}
            if body is None
            else body
        ),
        encoding="utf-8",
    )
    return marker


def test_source_form_on_the_dev_interpreter():
    assert host.host_form() == host.FORM_SOURCE
    assert host.product_root() is None


def test_assembled_form_detects_marker_and_resolves_root(monkeypatch, tmp_path):
    prefix = tmp_path / "dist" / "kungfu" / "python"
    _write_marker(prefix)
    monkeypatch.setattr(sys, "base_prefix", str(prefix))
    assert host.host_form() == host.FORM_ASSEMBLED
    assert host.product_root() == (tmp_path / "dist" / "kungfu").resolve()


def test_marker_with_wrong_schema_is_not_assembled(monkeypatch, tmp_path):
    prefix = tmp_path / "python"
    _write_marker(prefix, {"schema": "other/v1"})
    monkeypatch.setattr(sys, "base_prefix", str(prefix))
    assert host.host_form() == host.FORM_SOURCE
    assert host.product_root() is None


def test_entry_command_prefers_a_real_product_executable_argv0(monkeypatch, tmp_path):
    prefix = tmp_path / "dist" / "kungfu" / "python"
    _write_marker(prefix)
    monkeypatch.setattr(sys, "base_prefix", str(prefix))
    entry = tmp_path / "kungfu"
    entry.write_text("#!/bin/sh\n", encoding="utf-8")
    entry.chmod(entry.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(sys, "argv", [str(entry)])
    assert host.entry_command() == [str(entry.resolve())]


def test_source_entry_command_does_not_treat_pytest_as_kungfu(monkeypatch, tmp_path):
    entry = tmp_path / "pytest"
    entry.write_text("#!/bin/sh\n", encoding="utf-8")
    entry.chmod(entry.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(sys, "argv", [str(entry)])
    assert host.entry_command() == [sys.executable, "-m", "kungfu"]


def test_entry_command_reenters_the_interpreter_for_module_runs(monkeypatch):
    # python -m kungfu leaves argv0 pointing at __main__.py, which is not a
    # command a child can exec; re-enter through the running interpreter.
    monkeypatch.setattr(sys, "argv", [os.path.join("kungfu", "__main__.py")])
    assert host.entry_command() == [sys.executable, "-m", "kungfu"]


def test_entry_command_falls_back_when_argv0_is_the_interpreter(monkeypatch):
    # A bare interpreter argv0 (python, python3, python3.13) is not the
    # product entry; re-enter with -m so the child gets the CLI, not a REPL.
    monkeypatch.setattr(sys, "argv", [sys.executable])
    assert host.entry_command() == [sys.executable, "-m", "kungfu"]


def test_assembled_host_is_blessed_unconditionally():
    assert (
        _runtime_violation(
            "3.13.14",
            base_prefix="/opt/kungfu/python",
            running_version="3.13.14",
            assembled=True,
        )
        is None
    )


def test_node_package_entry_uses_public_exports_without_source_fallback(tmp_path):
    package = tmp_path / "node_modules/@test/provider"
    package.mkdir(parents=True)
    (package / "package.json").write_text(
        json.dumps(
            {
                "name": "@test/provider",
                "type": "module",
                "exports": {"./public": "./public.mjs"},
            }
        )
    )
    public = package / "public.mjs"
    public.write_text("export const value = 1;\n")
    (package / "private.mjs").write_text("export const hidden = true;\n")
    assert host.node_package_entry("@test/provider/public", tmp_path) == str(
        public.resolve()
    )
    assert host.node_package_entry("@test/provider/private.mjs", tmp_path) is None
    (package / "package.json").write_text(
        json.dumps({"name": "@test/provider", "exports": {}})
    )
    assert host.node_package_entry("@test/provider/public", tmp_path) is None


def test_node_package_entry_reports_a_missing_node_runtime(monkeypatch):
    monkeypatch.setenv("PATH", "")
    assert host.node_package_entry("@test/provider/public") is None
