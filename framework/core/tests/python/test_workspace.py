# SPDX-License-Identifier: Apache-2.0

import json
import os
import subprocess

from kungfu.workspace import (
    WorkspaceTargetRequired,
    ensure_workspace_data_home,
    inspect_workspace,
    load_workspace_registry,
    prepare_workspace_write,
    record_workspace_capture,
    resolve_workspace_target,
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


def test_capture_only_falls_back_to_unassigned_home_with_source_cwd(tmp_path):
    source = tmp_path / "loose-work"
    source.mkdir()
    env = {"HOME": str(tmp_path), "PWD": str(source)}

    target = resolve_workspace_target("capture-only", cwd=str(source), env=env)

    assert target.identity.workspace_id == "home"
    assert target.identity.resolution_reason == "no-project-workspace"
    assert target.association == "unassigned"
    assert target.source_working_directory == os.path.realpath(source)
    assert not (tmp_path / ".kungfu").exists()

    receipt = prepare_workspace_write(target, "managed-run")
    assert receipt["schema"] == "kungfu.workspace.target-receipt/v1"
    assert receipt["workspace_id"] == "home"
    assert receipt["association"] == "unassigned"
    assert receipt["resolution_reason"] == "no-project-workspace"
    assert receipt["source_working_directory"] == os.path.realpath(source)
    assert receipt["initialized"] is True
    assert (tmp_path / ".kungfu" / "runtime").is_dir()


def test_non_capture_write_without_project_fails_closed(tmp_path):
    source = tmp_path / "loose-work"
    source.mkdir()
    env = {"HOME": str(tmp_path), "PWD": str(source)}

    for operation_class in (
        "semantic-write",
        "assessment",
        "repair",
        "migration",
        "destructive",
    ):
        try:
            resolve_workspace_target(operation_class, cwd=str(source), env=env)
        except WorkspaceTargetRequired as error:
            assert error.diagnosis["operation_class"] == operation_class
            assert error.diagnosis["resolution_reason"] == "no-project-workspace"
        else:
            raise AssertionError(f"{operation_class} unexpectedly resolved Home")

    assert not (tmp_path / ".kungfu").exists()


def test_capture_only_prefers_discovered_project_without_home_fallback(tmp_path):
    repo = tmp_path / "repo"
    source = repo / "nested"
    source.mkdir(parents=True)
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)

    target = resolve_workspace_target(
        "capture-only",
        cwd=str(source),
        env={"HOME": str(tmp_path), "PWD": str(source)},
    )

    assert target.identity.workspace_kind == "project"
    assert target.identity.workspace_root == os.path.realpath(repo)
    assert target.identity.resolution_reason == "discovered-project-workspace"
    assert target.association == "workspace"
    assert not (repo / ".kungfu").exists()


def test_home_capture_records_durable_inbox_identity_without_inventing_purpose(
    tmp_path,
):
    source = tmp_path / "loose-work"
    source.mkdir()
    target = resolve_workspace_target(
        "capture-only",
        cwd=str(source),
        env={"HOME": str(tmp_path), "PWD": str(source)},
    )
    receipt = prepare_workspace_write(target, "episode-import")

    class FakeWorkStore:
        def __init__(self, runtime_dir):
            self.runtime_dir = runtime_dir

        def create(self, title, kind, summary):
            assert kind == "agent-work-inbox"
            assert "without a project or declared Mission purpose" in summary
            return "w-inbox-1"

        def set_next_action(self, work_id, next_action):
            assert work_id == "w-inbox-1"
            assert "Mission/Go" in next_action

        def link_run(self, work_id, run_id):
            raise AssertionError("an imported Episode must not masquerade as a run")

        def artifact(self, work_id, ref, kind):
            assert work_id == "w-inbox-1"
            assert kind == "workspace-capture"
            assert ref.endswith(".json")

    recorded = record_workspace_capture(
        target,
        receipt,
        [{"kind": "episode", "id": "501"}],
        work_store_factory=FakeWorkStore,
    )

    assert recorded["inbox_work_id"] == "w-inbox-1"
    assert recorded["resulting_identities"] == [{"kind": "episode", "id": "501"}]
    assert "mission-association" in recorded["skipped_effects"]
    with open(recorded["receipt_path"], encoding="utf-8") as f:
        assert json.load(f)["receipt_id"] == recorded["receipt_id"]
