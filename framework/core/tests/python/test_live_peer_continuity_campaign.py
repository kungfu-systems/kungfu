# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import importlib.util
from pathlib import Path


CAMPAIGN_PATH = (
    Path(__file__).parents[1]
    / "qualification"
    / "live-peer-continuity"
    / "native_campaign.py"
)


def _load_campaign():
    spec = importlib.util.spec_from_file_location(
        "kungfu_test_live_peer_continuity_campaign", CAMPAIGN_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_windows_workspace_cleanup_retries_a_transient_file_lock(tmp_path, monkeypatch):
    campaign = _load_campaign()
    original_rmtree = campaign.shutil.rmtree
    attempts = []
    sleeps = []

    def remove_after_transient_lock(path):
        attempts.append(Path(path))
        if len(attempts) == 1:
            raise PermissionError(32, "file is in use", str(path / "peer.log"))
        original_rmtree(path)

    monkeypatch.setattr(campaign.platform, "system", lambda: "Windows")
    monkeypatch.setattr(campaign.shutil, "rmtree", remove_after_transient_lock)
    monkeypatch.setattr(campaign.time, "sleep", sleeps.append)

    with campaign._temporary_workspace(tmp_path) as workspace:
        (workspace / "peer.log").write_text("peer\n", "utf-8")

    assert attempts == [workspace, workspace]
    assert sleeps == [campaign.WINDOWS_CLEANUP_RETRY_SECONDS]
    assert not workspace.exists()


def test_non_windows_workspace_cleanup_does_not_hide_a_file_error(
    tmp_path, monkeypatch
):
    campaign = _load_campaign()
    workspace = None

    monkeypatch.setattr(campaign.platform, "system", lambda: "Linux")

    def fail_cleanup(path):
        raise PermissionError(13, "permission denied", str(path))

    monkeypatch.setattr(campaign.shutil, "rmtree", fail_cleanup)

    try:
        with campaign._temporary_workspace(tmp_path) as active_workspace:
            workspace = active_workspace
    except PermissionError:
        pass
    else:
        raise AssertionError("non-Windows cleanup failure must remain visible")

    assert workspace is not None
