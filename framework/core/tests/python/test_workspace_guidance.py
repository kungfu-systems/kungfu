# SPDX-License-Identifier: Apache-2.0

import json
import subprocess

import pytest

from kungfu.workspace import inspect_workspace
from kungfu.workspace_guidance import (
    WorkspaceGuidanceError,
    advise_workspace,
    authorize_workspace_action,
    execute_workspace_action,
    inspect_guidance,
    preview_workspace_action,
    verify_workspace_action,
)


def _home(tmp_path):
    identity = inspect_workspace(home=True, env={"HOME": str(tmp_path)})
    assert identity is not None
    return identity


def _git_repo(tmp_path):
    repo = tmp_path / "repo"
    nested = repo / "nested"
    nested.mkdir(parents=True)
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    return repo, nested


def _preview(identity, source, intent="create-project-workspace"):
    inspection = inspect_guidance(identity, source_path=str(source))
    advice = advise_workspace(inspection)
    preview = preview_workspace_action(advice, intent)
    return inspection, advice, preview


def test_inspect_and_advise_are_deterministic_and_read_only(tmp_path):
    source = tmp_path / "loose-work"
    source.mkdir()
    identity = _home(tmp_path)

    first = inspect_guidance(identity, source_path=str(source))
    second = inspect_guidance(identity, source_path=str(source))
    advice = advise_workspace(first)

    assert first["cut_id"] == second["cut_id"]
    assert advice["state"] == "insufficient"
    assert advice["reason_codes"] == ["insufficient-project-gravity"]
    assert advice["recommended_intent"] is None
    assert not (tmp_path / ".kungfu").exists()


def test_existing_git_repo_produces_preview_and_bounded_project_creation(tmp_path):
    repo, nested = _git_repo(tmp_path)
    identity = _home(tmp_path)
    inspection, advice, preview = _preview(identity, nested)

    assert advice["state"] == "recommended"
    assert advice["reason_codes"] == ["existing-git-repository"]
    assert advice["project_candidate_root"] == str(repo)
    assert preview["authorization_class"] == "workspace-create"
    assert {row["effect"] for row in preview["effects"]} == {
        "create-project-data-home",
        "create-runtime-directory",
    }
    assert "git-init" in preview["skipped_effects"]
    assert not (tmp_path / ".kungfu").exists()
    assert not (repo / ".kungfu").exists()

    authorization = authorize_workspace_action(
        identity,
        preview,
        expected_preview_id=preview["preview_id"],
        decision="approve",
        authorized_by="test-user",
    )
    assert (tmp_path / ".kungfu" / "runtime").is_dir()
    assert not (repo / ".kungfu").exists()

    receipt = execute_workspace_action(
        identity,
        source_path=str(nested),
        authorization_id=authorization["authorization_id"],
    )
    assert receipt["intent"] == "create-project-workspace"
    assert (repo / ".kungfu" / "runtime").is_dir()
    assert receipt["resulting_identities"][0]["workspace_kind"] == "project"
    assert "git-init" in receipt["skipped_effects"]

    verification = verify_workspace_action(identity, receipt["receipt_id"])
    assert verification["ok"] is True
    assert verification["errors"] == []

    repeated = execute_workspace_action(
        identity,
        source_path=str(nested),
        authorization_id=authorization["authorization_id"],
    )
    assert repeated["receipt_id"] == receipt["receipt_id"]
    assert repeated["reused"] is True
    assert inspection["cut_id"] == preview["selected_cut"]


def test_authorization_rejects_wrong_preview_identity(tmp_path):
    _, nested = _git_repo(tmp_path)
    identity = _home(tmp_path)
    _, _, preview = _preview(identity, nested)

    with pytest.raises(WorkspaceGuidanceError) as caught:
        authorize_workspace_action(
            identity,
            preview,
            expected_preview_id="workspace-preview:sha256:stale-agent-value",
            decision="approve",
            authorized_by="weak-agent",
        )

    assert caught.value.diagnosis["code"] == "preview-mismatch"
    assert not (tmp_path / ".kungfu").exists()


def test_relevant_capture_invalidates_authorized_preview(tmp_path):
    repo, nested = _git_repo(tmp_path)
    identity = _home(tmp_path)
    _, _, preview = _preview(identity, nested)
    authorization = authorize_workspace_action(
        identity,
        preview,
        expected_preview_id=preview["preview_id"],
        decision="approve",
        authorized_by="test-user",
    )
    receipt_dir = tmp_path / ".kungfu" / "inbox" / "receipts"
    receipt_dir.mkdir(parents=True, exist_ok=True)
    (receipt_dir / "new-capture.json").write_text(
        json.dumps(
            {
                "schema": "kungfu.workspace.target-receipt/v1",
                "receipt_id": "workspace-target:new-capture",
                "association": "unassigned",
                "source_working_directory": str(repo),
                "resulting_identities": [{"kind": "episode", "id": "99"}],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(WorkspaceGuidanceError) as caught:
        execute_workspace_action(
            identity,
            source_path=str(nested),
            authorization_id=authorization["authorization_id"],
        )

    assert caught.value.diagnosis["code"] == "stale-preview"
    assert (
        caught.value.diagnosis["authorized_cut"]
        != caught.value.diagnosis["current_cut"]
    )
    assert not (repo / ".kungfu").exists()


def test_suppression_is_explicit_durable_and_changes_future_advice(tmp_path):
    _, nested = _git_repo(tmp_path)
    identity = _home(tmp_path)
    _, _, preview = _preview(identity, nested, "suppress-source")
    authorization = authorize_workspace_action(
        identity,
        preview,
        expected_preview_id=preview["preview_id"],
        decision="approve",
        authorized_by="test-user",
    )
    receipt = execute_workspace_action(
        identity,
        source_path=str(nested),
        authorization_id=authorization["authorization_id"],
    )

    assert receipt["intent"] == "suppress-source"
    future = advise_workspace(inspect_guidance(identity, source_path=str(nested)))
    assert future["state"] == "suppressed"
    assert future["reason_codes"] == ["source-guidance-suppressed"]
    repeated = execute_workspace_action(
        identity,
        source_path=str(nested),
        authorization_id=authorization["authorization_id"],
    )
    assert repeated["receipt_id"] == receipt["receipt_id"]
    assert repeated["reused"] is True


def test_denied_authorization_cannot_execute(tmp_path):
    _, nested = _git_repo(tmp_path)
    identity = _home(tmp_path)
    _, _, preview = _preview(identity, nested)
    authorization = authorize_workspace_action(
        identity,
        preview,
        expected_preview_id=preview["preview_id"],
        decision="deny",
        authorized_by="test-user",
    )

    with pytest.raises(WorkspaceGuidanceError) as caught:
        execute_workspace_action(
            identity,
            source_path=str(nested),
            authorization_id=authorization["authorization_id"],
        )

    assert caught.value.diagnosis["code"] == "authorization-denied"
