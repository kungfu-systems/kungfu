# SPDX-License-Identifier: Apache-2.0

import os
import subprocess

from kungfu.workspace import (
    ensure_workspace_data_home,
    inspect_workspace,
    load_workspace_registry,
    select_workspace,
)


def test_project_inspection_is_canonical_and_read_only(tmp_path):
    repo = tmp_path / "repo"
    child = repo / "nested"
    child.mkdir(parents=True)
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)

    identity = inspect_workspace(cwd=str(child), env={"HOME": str(tmp_path)})

    assert identity is not None
    assert identity.workspace_kind == "project"
    assert identity.workspace_root == os.path.realpath(repo)
    assert identity.data_home == str(repo / ".kungfu")
    assert identity.initialized is False
    assert identity.resolution_reason == "discovered-project-workspace"
    assert not (repo / ".kungfu").exists()


def test_home_selection_only_writes_global_registry(tmp_path):
    config_home = tmp_path / "config"
    env = {"HOME": str(tmp_path)}
    identity = inspect_workspace(home=True, env=env)
    assert identity is not None

    selected = select_workspace(identity, config_home=str(config_home), env=env)

    assert selected["last_workspace_id"] == "home"
    assert (config_home / "gui" / "workspaces.json").exists()
    assert not (tmp_path / ".kungfu").exists()
    loaded = load_workspace_registry(str(config_home), env=env)
    assert loaded["recent"][0]["workspace_id"] == "home"


def test_ensure_creates_minimum_layout_and_receipt_without_git_effects(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    identity = inspect_workspace(str(repo), env={"HOME": str(tmp_path)})
    assert identity is not None

    receipt = ensure_workspace_data_home(identity, "create-mission")

    assert receipt["schema"] == "kungfu.workspace.ensure-receipt/v1"
    assert receipt["reason"] == "create-mission"
    assert receipt["initialized"] is True
    assert (repo / ".kungfu" / "runtime").is_dir()
    assert receipt["git_effects"] == []

    repeated = ensure_workspace_data_home(identity, "create-go")
    assert repeated["initialized"] is False
    assert repeated["created_paths"] == []
