# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kungfu.rewind import events
from kungfu.rewind import progress as progress_contract
from kungfu.rewind.fb.RunProgress import RunProgress


def test_agent_console_progress_coordinates_come_from_explicit_env(
    monkeypatch, tmp_path
):
    control_runtime = tmp_path / "control" / "runtime"
    monkeypatch.setenv(progress_contract.CONTROL_RUNTIME_ENV, str(control_runtime))
    monkeypatch.setenv(progress_contract.ATTEMPT_ID_ENV, "attempt-1")
    monkeypatch.setenv(
        progress_contract.WORK_REF_ENV,
        json.dumps(
            {
                "schema": "kungfu.work-ref/v1",
                "workspaceId": "home",
                "profileId": "kungfu.work-control",
                "profileRoot": "sha256:profile",
                "entityType": "go",
                "entityId": "go-1",
                "entityRoot": "sha256:go",
            }
        ),
    )

    assert progress_contract.report_runtime_dir(str(tmp_path / "work")) == str(
        control_runtime
    )
    assert progress_contract.reported_run_id(None) == "attempt-1"
    assert progress_contract.reported_work_ref() == {
        "workspaceId": "home",
        "profileId": "kungfu.work-control",
        "profileRoot": "sha256:profile",
        "entityType": "go",
        "entityId": "go-1",
        "entityRoot": "sha256:go",
    }


def test_agent_console_progress_rejects_partial_work_ref(monkeypatch):
    monkeypatch.setenv(
        progress_contract.WORK_REF_ENV,
        json.dumps({"schema": "kungfu.work-ref/v1", "entityId": "go-1"}),
    )

    with pytest.raises(ValueError, match="complete kungfu.work-ref/v1"):
        progress_contract.reported_work_ref()


def test_run_progress_flatbuffer_preserves_live_work_ref():
    payload = events.run_progress(
        run_id="attempt-1",
        phase="verify",
        message="running tests",
        severity="info",
        pct=80,
        signal="heartbeat",
        next_action="review",
        workspace_id="home",
        profile_id="kungfu.work-control",
        profile_root="sha256:profile",
        entity_type="go",
        entity_id="go-1",
        entity_root="sha256:go",
    )

    progress = RunProgress.GetRootAs(payload, 0)
    assert progress.RunId() == b"attempt-1"
    assert progress.Phase() == b"verify"
    assert progress.Message() == b"running tests"
    assert progress.Pct() == 80
    assert progress.Signal() == b"heartbeat"
    assert progress.NextAction() == b"review"
    assert progress.WorkspaceId() == b"home"
    assert progress.ProfileId() == b"kungfu.work-control"
    assert progress.ProfileRoot() == b"sha256:profile"
    assert progress.EntityType() == b"go"
    assert progress.EntityId() == b"go-1"
    assert progress.EntityRoot() == b"sha256:go"


def test_native_replay_registers_run_progress():
    replay_source = (
        Path(__file__).parents[2] / "src/python/kungfu/rewind/replay.py"
    ).read_text(encoding="utf-8")
    assert '"RunProgress": RunProgress.RunProgress' in replay_source
