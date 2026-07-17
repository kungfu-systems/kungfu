# SPDX-License-Identifier: Apache-2.0

import json
import os
import subprocess
from hashlib import sha256

import pytest

from kungfu.workspace import (
    WorkspaceTargetRequired,
    ensure_workspace_data_home,
    import_full_evidence,
    inspect_workspace,
    load_workspace_registry,
    prepare_workspace_write,
    record_workspace_capture,
    request_full_evidence,
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
    assert receipt["previous_state"] == "uninitialized"
    assert receipt["resulting_state"] == "live-runtime"
    assert (repo / ".kungfu" / "runtime").is_dir()
    assert receipt["git_effects"] == []

    repeated = ensure_workspace_data_home(identity, "create-go")
    assert repeated["initialized"] is False
    assert repeated["created_paths"] == []


def test_tracked_settled_shadow_is_readable_without_runtime_initialization(tmp_path):
    repo = tmp_path / "repo"
    manifest_dir = (
        repo / ".kungfu" / "episodes" / "sealed" / "sha256" / "aa" / ("a" * 64)
    )
    manifest_dir.mkdir(parents=True)
    manifest = {
        "schema": "kungfu.episode.git-workspace-manifest/v1",
        "authority": "shadow-of-yijinjing-journal",
        "semanticRoot": "sha256:" + "a" * 64,
    }
    manifest["providerRoot"] = (
        "sha256:"
        + sha256(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )
    (manifest_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    cut_dir = repo / ".kungfu" / "project-cuts" / "sha256" / "cc"
    cut_dir.mkdir(parents=True)
    cut = {
        "schema": "project.cut/v1",
        "project": {"id": "fixture"},
        "parentCutRoots": [],
        "sourceProjection": {},
        "atlas": {},
        "episodeDelta": {},
        "interpretation": {},
        "visibility": "internal",
        "omissions": [],
        "conflicts": [],
        "unknowns": [],
        "compatibility": {},
    }
    root_input = {
        "schema": "project.cut.root-input/v1",
        **{key: value for key, value in cut.items() if key != "schema"},
    }
    cut["cutRoot"] = (
        "sha256:"
        + sha256(
            json.dumps(root_input, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )
    (cut_dir / ("c" * 64 + ".json")).write_text(
        json.dumps(cut),
        encoding="utf-8",
    )
    (cut_dir / "receipt.json").write_text(
        json.dumps({"schema": "project.cut.publication-receipt/v1"}),
        encoding="utf-8",
    )

    identity = inspect_workspace(str(repo), env={"HOME": str(tmp_path)})
    assert identity is not None
    status = identity.as_dict()

    assert identity.initialized is False
    assert status["state"] == "shadow-only"
    assert status["continuation"]["evidence_level"] == "settled-review"
    assert status["continuation"]["capabilities"]["inspect_settled_history"] is True
    assert status["continuation"]["capabilities"]["append_facts"] is False
    assert not (repo / ".kungfu" / "runtime").exists()

    receipt = ensure_workspace_data_home(identity, "start-continuation")
    assert receipt["initialized"] is True
    assert receipt["previous_state"] == "shadow-only"
    assert receipt["resulting_state"] == "live-runtime"
    assert receipt["parent_episode_roots"] == ["sha256:" + "a" * 64]
    assert receipt["parent_project_cut_roots"] == [cut["cutRoot"]]
    assert (manifest_dir / "manifest.json").exists()


def test_invalid_tracked_shadow_fails_visible_without_creating_runtime(tmp_path):
    repo = tmp_path / "repo"
    manifest_dir = repo / ".kungfu" / "episodes" / "sealed" / "broken"
    manifest_dir.mkdir(parents=True)
    (manifest_dir / "manifest.json").write_text("{", encoding="utf-8")

    identity = inspect_workspace(str(repo), env={"HOME": str(tmp_path)})
    assert identity is not None
    status = identity.as_dict()

    assert status["state"] == "evidence-degraded"
    assert status["continuation"]["issues"][0]["code"] == "episode-shadow-invalid"
    assert status["continuation"]["capabilities"]["start_continuation"] is False
    assert not (repo / ".kungfu" / "runtime").exists()

    with pytest.raises(ValueError, match="degraded settled evidence"):
        ensure_workspace_data_home(identity, "start-continuation")
    assert not (repo / ".kungfu" / "runtime").exists()


def test_full_evidence_request_and_import_upgrade_only_verified_capabilities(
    tmp_path, monkeypatch
):
    repo = tmp_path / "repo"
    episode_root = "sha256:" + "a" * 64
    manifest_dir = repo / ".kungfu" / "episodes" / "sealed" / "fixture"
    manifest_dir.mkdir(parents=True)
    manifest = {
        "schema": "kungfu.episode.git-workspace-manifest/v1",
        "authority": "shadow-of-yijinjing-journal",
        "semanticRoot": episode_root,
    }
    manifest["providerRoot"] = (
        "sha256:"
        + sha256(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )
    (manifest_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    identity = inspect_workspace(str(repo), env={"HOME": str(tmp_path)})
    assert identity is not None

    request = request_full_evidence(identity)

    assert request["episode_roots"] == [episode_root]
    assert request["missing_episode_roots"] == [episode_root]
    assert request["creates_runtime"] is False
    assert request["plan_root"].startswith("sha256:")
    assert not (repo / ".kungfu" / "runtime").exists()

    bundle = {
        "schema": "kungfu.storage.episode-bundle/v1",
        "episode_id": 61001,
        "manifest": {"content_root": "a" * 64},
    }
    bundle_path = tmp_path / "bundle.json"
    bundle_path.write_text(json.dumps(bundle), encoding="utf-8")
    calls = []

    def fake_import(runtime_dir, payload, *, verify, execute):
        calls.append((runtime_dir, payload, verify, execute))
        return {"ok": True, "status": "imported" if execute else "valid"}

    monkeypatch.setattr("kungfu.storage.service.import_bundle", fake_import)
    plan = import_full_evidence(identity, str(bundle_path))
    assert plan["executed"] is False
    assert plan["would_create_runtime"] is True
    assert not (repo / ".kungfu" / "runtime").exists()

    result = import_full_evidence(identity, str(bundle_path), execute=True)

    assert result["receipt"]["episode_root"] == episode_root
    assert result["receipt"]["receipt_root"].startswith("sha256:")
    assert calls[-1][2:] == (True, True)
    continuation = result["continuation"]
    assert continuation["full_evidence_episode_roots"] == [episode_root]
    assert continuation["capabilities"]["raw_replay"] is True
    assert continuation["capabilities"]["requalify"] is True
    assert continuation["capability_contractions"] == []

    receipt_path = result["receipt"]["receipt_path"]
    with open(receipt_path, "a", encoding="utf-8") as stream:
        stream.write("{}")
    degraded_full = identity.as_dict()["continuation"]
    assert degraded_full["state"] == "live-runtime"
    assert degraded_full["capabilities"]["inspect_settled_history"] is True
    assert degraded_full["capabilities"]["raw_replay"] is False
    assert degraded_full["full_evidence_issues"][0]["code"] == "full-evidence-invalid"


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
