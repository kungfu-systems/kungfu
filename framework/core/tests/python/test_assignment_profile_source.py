# SPDX-License-Identifier: Apache-2.0

import importlib
from types import SimpleNamespace

from kungfu import assignment_orchestration


ASSIGNMENT_CLI = importlib.import_module("kungfu.cli.commands.assignment")


def _sha256(marker):
    return "sha256:" + marker * 64


def test_kickoff_restores_work_control_after_dogfood_profile(monkeypatch, tmp_path):
    active_profile = {"id": ""}
    ensure_calls = []

    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_runtime",
        lambda *_args, **_kwargs: (
            SimpleNamespace(workspace_root=str(tmp_path)),
            str(tmp_path / "runtime"),
            {},
        ),
    )

    def ensure_profile(_runtime_dir, _actor):
        active_profile["id"] = "work-control"
        ensure_calls.append("work-control")
        return []

    monkeypatch.setattr(ASSIGNMENT_CLI, "_ensure_profile", ensure_profile)
    monkeypatch.setattr(
        ASSIGNMENT_CLI.run_agent,
        "bind_current_native_work",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_status",
        lambda *_args: {
            "phase": "claimed",
            "assignment": {"assignment_id": "work-1"},
        },
    )

    def consider_assignment(*_args, **_kwargs):
        active_profile["id"] = "dogfood"
        return {"consideration": {"receipt_root": _sha256("d")}}

    monkeypatch.setattr(
        ASSIGNMENT_CLI.dogfood_api,
        "consider_assignment",
        consider_assignment,
    )

    def profile_action(*_args, **_kwargs):
        assert active_profile["id"] == "work-control"
        return {"receipt": {"payload_hash": _sha256("a")}}

    monkeypatch.setattr(ASSIGNMENT_CLI, "_profile_action", profile_action)

    result = ASSIGNMENT_CLI._advance(
        str(tmp_path),
        False,
        "initiative-1",
        "work-1",
        "executing",
        "test-owner",
        "test kickoff",
    )

    assert ensure_calls == ["work-control", "work-control"]
    assert result["dogfood_consideration_root"] == _sha256("d")


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
