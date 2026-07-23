# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
from types import SimpleNamespace

import kungfu
import pytest
from kungfu import assignment_orchestration, profile_composition, profile_sdk
from kungfu.atlas import mission_control
from kungfu.workspace import resolve_workspace_target


SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "mission-control"


def _activate(runtime):
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(
            runtime,
            action,
            SOURCE,
            **({"granted_permissions": ["storage"]} if action == "activate" else {}),
        )["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")
    contract = profile_composition.contract_materialization_plan(SOURCE, runtime)
    if contract["operations"]:
        profile_composition.authorized_contract_materialize(
            runtime,
            contract,
            profile_sdk.answer_decision(
                contract["decisionCard"], "approve", "test-owner"
            ),
        )


def test_source_root_recovers_checkout_from_assembled_binding(tmp_path):
    checkout = tmp_path / "kungfu"
    checkout.mkdir()
    (checkout / ".git").write_text("gitdir: /tmp/example\n", encoding="utf-8")
    binding = checkout / "framework" / "core" / "dist" / "kungfu" / "pykungfu.so"
    binding.parent.mkdir(parents=True)
    binding.touch()

    assert assignment_orchestration.source_root(binding) == checkout


def test_binding_provenance_accepts_one_manifest_bound_installed_product(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "installed" / "kungfu"
    runtime.mkdir(parents=True)
    binding = runtime / "pykungfu.so"
    binding.touch()
    revision = "a" * 40
    build_info = {
        "version": "4.0.0-alpha.1",
        "git": {"revision": revision, "pristine": True},
    }
    (runtime / "kungfubuildinfo.json").write_text(
        json.dumps(build_info), encoding="utf-8"
    )
    manifest = {
        "schema": "kungfu.product-upgrade.manifest/v1",
        "sourceCommit": revision,
        "runtimeEntrypoint": "kungfu",
        "runtimeArtifactDigest": "sha256:" + "b" * 64,
    }
    manifest_path = tmp_path / "kungfu-release-manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(kungfu, "_binding", SimpleNamespace(__file__=str(binding)))
    monkeypatch.setenv("KUNGFU_INSTALL_SOURCE", "archive")
    monkeypatch.setenv("KUNGFU_DIR", str(runtime))
    monkeypatch.setenv("KUNGFU_UPGRADE_MANIFEST", str(manifest_path))

    provenance = assignment_orchestration.binding_provenance()

    assert provenance["ok"] is True
    assert provenance["state"] == "installed-product"
    assert provenance["source_revision"] == revision
    assert provenance["override"] is False


def test_installed_capture_matches_source_contract_without_runtime(tmp_path):
    request = {
        "schema": "kungfu.assignment-request/v1",
        "source": {"kind": "atlas-go-card"},
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {"goal_id": "installed-capture"},
    }
    target = resolve_workspace_target(
        "capture-only", str(tmp_path), cwd=str(tmp_path), env={"HOME": str(tmp_path)}
    )

    response = assignment_orchestration.capture_assignment_request(request, target)

    assert response["schema"] == "kungfu.assignment-capture.response/v1"
    assert response["status"] == "captured"
    assert response["authority"] == "capture-material-only"
    assert response["target"]["runtimeInitialized"] is False
    assert not (tmp_path / ".kungfu" / "runtime").exists()
    captured = assignment_orchestration.load_captured_request(response["requestPath"])
    assert captured["request_root"] == response["requestRoot"]
    assert captured["capture_receipt_roots"] == [response["receiptRoot"]]
    assert (
        assignment_orchestration.capture_assignment_request(request, target)["status"]
        == "already-present"
    )


def test_captured_request_admits_losslessly_and_drives_bounded_execution(tmp_path):
    request = {
        "schema": "kungfu.assignment-request/v1",
        "source": {"kind": "atlas-go-card"},
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {
            "goal_id": "assignment-a",
            "mission_id": "initiative-a",
            "title": "Assignment A",
            "objective": "Prove the native state machine",
            "parent_goal": "parent-assignment",
            "context_binding": {"root": "sha256:" + "c" * 64},
            "unknown_source_field": {"must": "survive"},
        },
    }
    request_root = assignment_orchestration.semantic_root(request)
    directory = (
        tmp_path
        / ".kungfu"
        / "inbox"
        / "assignment-requests"
        / "sha256"
        / request_root[7:9]
        / request_root[7:]
    )
    directory.mkdir(parents=True)
    request_file = directory / "request.json"
    request_file.write_text(
        assignment_orchestration.canonical_json(request) + "\n", encoding="utf-8"
    )
    receipt = {
        "schema": "kungfu.assignment-capture.receipt/v1",
        "requestRoot": request_root,
        "requestPath": "inbox/example/request.json",
    }
    receipt_root = assignment_orchestration.semantic_root(receipt)
    receipt["receiptRoot"] = receipt_root
    receipt_dir = directory / "receipts" / "sha256"
    receipt_dir.mkdir(parents=True)
    (receipt_dir / f"{receipt_root[7:]}.json").write_text(
        assignment_orchestration.canonical_json(receipt) + "\n", encoding="utf-8"
    )

    captured = assignment_orchestration.load_captured_request(request_file)
    projected = assignment_orchestration.atlas_assignment_projection(captured)
    assert projected["work_definition"] == request["workDefinition"]
    assert projected["parent_assignment_id"] == "parent-assignment"
    assert projected["context_binding"] == request["workDefinition"]["context_binding"]

    runtime = tmp_path / ".kungfu" / "runtime"
    _activate(runtime)
    mission_control.create_initiative(
        str(runtime),
        initiative_id="initiative-a",
        title="Initiative A",
        intent="Own the control plane",
        actor="owner-a",
        actor_type="user",
    )
    mission_control.create_assignment(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        title=projected["title"],
        objective=projected["objective"],
        actor="agent-a",
        request_root=request_root,
        capture_receipt_roots=[receipt_root],
        work_definition=projected["work_definition"],
    )
    status = mission_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert status["phase"] == "admitted"
    assert status["assignment"]["work_definition"] == request["workDefinition"]

    expiry = datetime.now(timezone.utc) + timedelta(hours=2)
    mission_control.claim_assignment_execution(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        owner="owner-a",
        agent="agent-a",
        slot="codex-slot-1",
        lease_id="lease-a",
        lease_expires_at=expiry.isoformat(),
        authorized_by="owner-a",
    )
    claimed = mission_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert claimed["phase"] == "claimed"
    assert claimed["active_lease"]["authority_semantics"]["slot"] == (
        "execution-lane-not-authority"
    )
    assert assignment_orchestration.gate(claimed, "run")["ok"] is True

    mission_control.advance_assignment_phase(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        to_phase="executing",
        actor="agent-a",
        reason="begin exact admitted work",
    )
    executing = mission_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert executing["phase"] == "executing"
    mission_control.advance_assignment_phase(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        to_phase="stage-ready",
        actor="agent-a",
        reason="bounded stage is ready",
    )
    staged = mission_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert staged["phase"] == "stage-ready"
    expired = mission_control.assignment_orchestration_status(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        now=(expiry + timedelta(seconds=1)).isoformat(),
    )
    assert assignment_orchestration.gate(expired, "run")["ok"] is False


def test_gate_field_equivalence_and_runtime_independent_seal(tmp_path):
    status = {
        "initiative_id": "initiative-a",
        "assignment_id": "assignment-a",
        "initiative_subject": "kungfu:initiative-a",
        "assignment_subject": "kungfu:assignment-a",
        "assignment": {"assignment_id": "assignment-a"},
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "a" * 64,
        "execution_claims": [{}],
        "phase_transitions": [{}, {}],
        "completion_claim_count": 1,
        "independent_review_count": 1,
        "continuation_decision_count": 1,
    }
    closed = assignment_orchestration.gate(status, "closeout")
    assert set(closed["atlas_compatibility"]) == {
        "schema",
        "ok",
        "phase",
        "policy",
        "reason",
        "state_path",
        "target",
    }
    assert closed["ok"] is True

    runtime = tmp_path / ".kungfu" / "runtime"
    runtime.mkdir(parents=True)
    plan = assignment_orchestration.sealed_state_plan(tmp_path, status)
    receipt = assignment_orchestration.apply_sealed_state(plan, plan["state_root"])
    state_file = Path(receipt["statePath"])
    shutil.rmtree(runtime)
    verified = assignment_orchestration.verify_sealed_state(state_file)
    assert verified == {
        "schema": "kungfu.assignment-orchestration.seal-verification/v1",
        "ok": True,
        "state_root": plan["state_root"],
        "phase": "continuation-decided",
        "next_actions": [],
    }


def test_sealed_state_survives_git_worktree_deletion(tmp_path):
    common = tmp_path / "repo.git"
    administration = common / "worktrees" / "assignment"
    administration.mkdir(parents=True)
    (administration / "commondir").write_text("../..\n", encoding="utf-8")
    workspace = tmp_path / "worktree"
    workspace.mkdir()
    (workspace / ".git").write_text(f"gitdir: {administration}\n", encoding="utf-8")
    status = {
        "initiative_subject": "kungfu:initiative-a",
        "assignment_subject": "kungfu:assignment-a",
        "assignment": {"assignment_id": "assignment-a"},
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "a" * 64,
    }

    plan = assignment_orchestration.sealed_state_plan(workspace, status)
    assert plan["storage_kind"] == "git-common-dir"
    receipt = assignment_orchestration.apply_sealed_state(plan, plan["state_root"])
    state_file = Path(receipt["statePath"])
    assert common in state_file.parents
    shutil.rmtree(workspace)

    assert receipt["worktreeDeletionSafe"] is True
    assert assignment_orchestration.verify_sealed_state(state_file)["ok"] is True


def test_home_sealed_state_uses_home_storage_without_embedding_its_path(tmp_path):
    home = tmp_path / ".kungfu"
    status = {
        "initiative_subject": "kungfu:initiative-home",
        "assignment_subject": "kungfu:assignment-home",
        "assignment": {"assignment_id": "assignment-home"},
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "d" * 64,
    }
    plan = assignment_orchestration.sealed_state_plan(
        home,
        status,
        workspace_identity={"workspace_id": "home", "workspace_kind": "home"},
    )

    assert plan["storage_kind"] == "home-workspace"
    assert plan["storage_root"] == str(home)
    assert plan["snapshot"]["workspace"] == {
        "workspace_id": "home",
        "workspace_kind": "home",
    }
    assert str(home) not in assignment_orchestration.canonical_json(plan["snapshot"])


def _binding_endpoint_fixture(workspace_id, workspace_kind, assignment_id, marker):
    digits = [format(int(marker, 16) + offset, "x") for offset in range(4)]
    admission = {
        "workspace": {
            "workspace_id": workspace_id,
            "workspace_kind": workspace_kind,
        },
        "assignment_receipt": {"receipt": {"payload_hash": "sha256:" + digits[0] * 64}},
    }
    status = {
        "initiative_id": "initiative-a",
        "assignment_id": assignment_id,
        "query_proof_root": "sha256:" + digits[1] * 64,
        "assignment": {
            "request_root": "sha256:" + digits[2] * 64,
            "capture_receipt_roots": ["sha256:" + digits[3] * 64],
            "project_cut_root": "",
            "evidence_episode_roots": [],
        },
    }
    return admission, status


def test_cross_workspace_binding_has_two_local_receipts_and_verifies_offline(tmp_path):
    parent_admission, parent_status = _binding_endpoint_fixture(
        "home", "home", "parent-assignment", "1"
    )
    child_admission, child_status = _binding_endpoint_fixture(
        "project:child", "project", "child-assignment", "8"
    )
    binding = assignment_orchestration.cross_workspace_binding(
        parent_admission,
        parent_status,
        child_admission,
        child_status,
    )
    assert binding["relationshipType"] == "parent-child"
    assert "path" not in assignment_orchestration.canonical_json(binding).lower()

    home = tmp_path / "home" / ".kungfu"
    parent_plan = assignment_orchestration.cross_workspace_binding_plan(
        home,
        {"workspace_id": "home", "workspace_kind": "home"},
        parent_status,
        binding,
    )
    parent_receipt = assignment_orchestration.apply_cross_workspace_binding(
        parent_plan, binding, binding["bindingRoot"]
    )
    child = tmp_path / "child"
    child.mkdir()
    child_plan = assignment_orchestration.cross_workspace_binding_plan(
        child,
        {"workspace_id": "project:child", "workspace_kind": "project"},
        child_status,
        binding,
    )
    child_receipt = assignment_orchestration.apply_cross_workspace_binding(
        child_plan, binding, binding["bindingRoot"]
    )

    assert parent_receipt["localRole"] == "parent"
    assert child_receipt["localRole"] == "child"
    verification = assignment_orchestration.verify_cross_workspace_binding_receipt(
        parent_receipt["bindingPath"], parent_receipt["receiptPath"]
    )
    assert verification["ok"] is True
    assert verification["runtimeIndependent"] is True

    tampered = dict(binding)
    tampered["relationshipType"] = "string-parent-id"
    with pytest.raises(ValueError, match="contract mismatch"):
        assignment_orchestration.verify_cross_workspace_binding(tampered)
