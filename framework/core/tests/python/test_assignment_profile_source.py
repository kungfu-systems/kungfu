# SPDX-License-Identifier: Apache-2.0

import importlib

from kungfu import assignment_orchestration


ASSIGNMENT_CLI = importlib.import_module("kungfu.cli.commands.assignment")


def test_assignment_profile_source_prefers_native_source_layout(tmp_path, monkeypatch):
    package = tmp_path / "package" / "kungfu"
    package.mkdir(parents=True)
    checkout = tmp_path / "checkout"
    native = checkout / "extensions" / "work-control"
    native.mkdir(parents=True)
    monkeypatch.setattr(assignment_orchestration, "__file__", package / "module.py")
    monkeypatch.setattr(
        assignment_orchestration, "source_root", lambda *_starts: checkout
    )

    assert ASSIGNMENT_CLI._profile_source() == native
