# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta, timezone
import importlib
import json
from pathlib import Path
import shutil
from types import SimpleNamespace

import click
import kungfu
import pytest

from kungfu import assignment_orchestration, profile_composition, profile_sdk
from kungfu.atlas import mission_control
from kungfu.workspace import (
    ensure_workspace_data_home,
    inspect_workspace,
    resolve_workspace_target,
)
from kungfu.workspace_federation import (
    build_relation,
    build_work_ref,
    query_federation,
)


SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "mission-control"
ASSIGNMENT_CLI = importlib.import_module("kungfu.cli.commands.assignment")


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


def test_cli_run_preserves_an_intentional_machine_readable_exit(monkeypatch):
    emitted = []
    monkeypatch.setattr(ASSIGNMENT_CLI, "_emit", emitted.append)

    with pytest.raises(click.exceptions.Exit) as failure:
        ASSIGNMENT_CLI._run(lambda: (_ for _ in ()).throw(click.exceptions.Exit(3)))

    assert failure.value.exit_code == 3
    assert emitted == []


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
            "project_cut_root": "sha256:" + "d" * 64,
            "evidence_episode_roots": ["sha256:" + "e" * 64],
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
    assert projected["project_cut_root"] == "sha256:" + "d" * 64
    assert projected["evidence_episode_roots"] == ["sha256:" + "e" * 64]

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


def test_assignment_relation_handshake_is_workspace_routed_and_fact_backed(
    tmp_path,
):
    source_root = tmp_path / "source"
    destination_root = tmp_path / "destination"
    source_root.mkdir()
    destination_root.mkdir()
    source_candidate = inspect_workspace(str(source_root), env={"HOME": str(tmp_path)})
    destination_candidate = inspect_workspace(
        str(destination_root), env={"HOME": str(tmp_path)}
    )
    assert source_candidate is not None
    assert destination_candidate is not None
    ensure_workspace_data_home(source_candidate, "create-assignment")
    ensure_workspace_data_home(destination_candidate, "create-assignment")
    source_identity = inspect_workspace(str(source_root), env={"HOME": str(tmp_path)})
    destination_identity = inspect_workspace(
        str(destination_root), env={"HOME": str(tmp_path)}
    )
    assert source_identity is not None
    assert destination_identity is not None
    source_runtime = source_root / ".kungfu" / "runtime"
    destination_runtime = destination_root / ".kungfu" / "runtime"
    _activate(source_runtime)
    _activate(destination_runtime)
    source_ref = build_work_ref(
        source_identity,
        object_kind="assignment",
        subject="kungfu:parent",
        version_root="sha256:" + "a" * 64,
        cut_root="sha256:" + "b" * 64,
    )
    destination_ref = build_work_ref(
        destination_identity,
        object_kind="assignment",
        subject="kungfu:child",
        version_root="sha256:" + "c" * 64,
        cut_root="sha256:" + "d" * 64,
    )
    relation = build_relation("delegates-to", source_ref, destination_ref)

    offer = mission_control.append_assignment_relation_event(
        str(source_runtime),
        workspace_identity_root=source_identity.identity_root,
        relation=relation,
        event_type="delegation-offer",
        actor="source-agent",
    )
    assert offer["next_action"] == "destination-acceptance"
    assert mission_control.assignment_relations(str(source_runtime)) == [relation]
    other_ref = build_work_ref(
        source_identity,
        object_kind="assignment",
        subject="kungfu:other",
        version_root="sha256:" + "e" * 64,
        cut_root="sha256:" + "f" * 64,
    )
    other_relation = build_relation("delegates-to", source_ref, other_ref)
    repeated = mission_control.append_assignment_relation_event(
        str(source_runtime),
        workspace_identity_root=source_identity.identity_root,
        relation=relation,
        event_type="delegation-offer",
        actor="source-agent",
        known_relations=[relation, other_relation],
    )
    assert repeated["event"]["event_root"] == offer["event"]["event_root"]
    assert repeated["receipt"]["reused"] is True

    related = query_federation(
        source_identity,
        scope="related",
        config_home=source_identity.config_home,
        env={"HOME": str(tmp_path)},
    )
    assert {row["workspace"]["identity_root"] for row in related["components"]} == {
        source_identity.identity_root,
        destination_identity.identity_root,
    }

    with pytest.raises(ValueError, match="wrong owning workspace"):
        mission_control.append_assignment_relation_event(
            str(source_runtime),
            workspace_identity_root=source_identity.identity_root,
            relation=relation,
            event_type="destination-acceptance",
            actor="wrong-agent",
            predecessor_event_roots=[offer["event"]["event_root"]],
        )

    accepted = mission_control.append_assignment_relation_event(
        str(destination_runtime),
        workspace_identity_root=destination_identity.identity_root,
        relation=relation,
        event_type="destination-acceptance",
        actor="destination-agent",
        predecessor_event_roots=[offer["event"]["event_root"]],
    )
    assert accepted["next_action"] == "source-observation"
    assert accepted["event"]["predecessor_event_roots"] == [
        offer["event"]["event_root"]
    ]


def test_external_initiative_ref_owns_no_duplicate_project_initiative(tmp_path):
    env = {"HOME": str(tmp_path)}
    home = inspect_workspace(home=True, env=env)
    assert home is not None
    ensure_workspace_data_home(home, "create-initiative")
    home_runtime = tmp_path / ".kungfu" / "runtime"
    _activate(home_runtime)
    mission_control.create_initiative(
        str(home_runtime),
        initiative_id="portfolio",
        title="Portfolio",
        intent="Coordinate independent projects",
        actor="owner",
    )
    home_work = query_federation(
        home,
        scope="local",
        config_home=home.config_home,
        env=env,
    )
    initiative_ref = home_work["components"][0]["initiatives"][0]["work_ref"]

    project_refs = []
    project_identities = []
    for name in ("typescript-project", "python-project"):
        root = tmp_path / name
        root.mkdir()
        if name == "typescript-project":
            (root / "package.json").write_text(
                '{"name":"workspace-federation-typescript-fixture"}\n',
                encoding="utf-8",
            )
        else:
            (root / "pyproject.toml").write_text(
                '[project]\nname = "workspace-federation-python-fixture"\n',
                encoding="utf-8",
            )
        candidate = inspect_workspace(str(root), env=env)
        assert candidate is not None
        ensure_workspace_data_home(candidate, "create-assignment")
        identity = inspect_workspace(str(root), env=env)
        assert identity is not None
        project_identities.append(identity)
        runtime = root / ".kungfu" / "runtime"
        _activate(runtime)
        written = mission_control.create_assignment(
            str(runtime),
            initiative_id="portfolio",
            assignment_id="duplicate-local-id",
            title=f"Work in {name}",
            objective="Prove workspace-qualified duplicate IDs",
            actor="agent",
            storage_source_id="kungfu",
            owning_workspace_identity_root=identity.identity_root,
            initiative_ref=initiative_ref,
        )
        assert written["initiative_subject"] == initiative_ref["subject"]
        assert mission_control.list_initiatives(str(runtime)) == []
        status = mission_control.assignment_orchestration_status(
            str(runtime),
            initiative_id="portfolio",
            assignment_id="duplicate-local-id",
            storage_source_id="kungfu",
        )
        assert status["phase"] == "admitted"
        project_work = query_federation(
            identity,
            scope="local",
            config_home=identity.config_home,
            env=env,
        )
        assert (
            project_work["components"][0]["assignments"][0]["lifecycle"][
                "portfolio_state"
            ]
            == "open"
        )
        project_refs.append(project_work["components"][0]["assignments"][0]["work_ref"])

    assert project_refs[0]["subject"] == project_refs[1]["subject"]
    assert (
        project_refs[0]["workspace_identity_root"]
        != project_refs[1]["workspace_identity_root"]
    )
    all_work = query_federation(
        home,
        scope="all",
        config_home=home.config_home,
        env=env,
    )
    assert {row["workspace"]["identity_root"] for row in all_work["components"]} == {
        home.identity_root,
        project_identities[0].identity_root,
        project_identities[1].identity_root,
    }
    assert all(row["availability"] == "available" for row in all_work["components"])


def test_local_parent_shorthand_is_frozen_as_workspace_qualified_ref(tmp_path):
    env = {"HOME": str(tmp_path)}
    root = tmp_path / "project"
    root.mkdir()
    candidate = inspect_workspace(str(root), env=env)
    assert candidate is not None
    ensure_workspace_data_home(candidate, "create-assignment")
    identity = inspect_workspace(str(root), env=env)
    assert identity is not None
    runtime = root / ".kungfu" / "runtime"
    _activate(runtime)
    mission_control.create_initiative(
        str(runtime),
        initiative_id="initiative",
        title="Initiative",
        intent="Resolve local shorthand before admission",
        actor="owner",
    )
    mission_control.create_assignment(
        str(runtime),
        initiative_id="initiative",
        assignment_id="parent",
        title="Parent",
        objective="Own parent authority",
        actor="owner",
        storage_source_id="kungfu",
        owning_workspace_identity_root=identity.identity_root,
    )
    mission_control.create_assignment(
        str(runtime),
        initiative_id="initiative",
        assignment_id="child",
        title="Child",
        objective="Freeze exact parent WorkRef",
        actor="agent",
        storage_source_id="kungfu",
        owning_workspace_identity_root=identity.identity_root,
        parent_assignment_id="parent",
    )
    child = next(
        row
        for row in mission_control.list_assignments(str(runtime))
        if row["assignment_id"] == "child"
    )
    assert child["parent_assignment_id"] == ""
    assert child["parent_assignment_ref"]["workspace_identity_root"] == (
        identity.identity_root
    )
    assert child["parent_assignment_ref"]["subject"] == "kungfu:parent"

    with pytest.raises(ValueError, match="resolve exactly once"):
        mission_control.create_assignment(
            str(runtime),
            initiative_id="initiative",
            assignment_id="bad-child",
            title="Bad child",
            objective="Reject unresolved cross-workspace string",
            actor="agent",
            storage_source_id="kungfu",
            owning_workspace_identity_root=identity.identity_root,
            parent_assignment_id="not-local",
        )


def test_sealed_state_verification_survives_path_free_transfer(tmp_path):
    status = {
        "initiative_subject": "kungfu:initiative-a",
        "assignment_subject": "kungfu:assignment-a",
        "assignment": {"assignment_id": "assignment-a"},
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "a" * 64,
    }
    source = tmp_path / "source"
    source.mkdir()
    plan = assignment_orchestration.sealed_state_plan(source, status)
    receipt = assignment_orchestration.apply_sealed_state(plan, plan["state_root"])
    state_file = Path(receipt["statePath"])

    transferred = tmp_path / "transferred"
    transferred.mkdir()
    transferred_state = transferred / "state.json"
    shutil.copy2(state_file, transferred_state)
    shutil.copy2(state_file.with_name("receipt.json"), transferred / "receipt.json")

    assert assignment_orchestration.verify_sealed_state(transferred_state)["ok"] is True
    tampered = json.loads(transferred_state.read_text(encoding="utf-8"))
    tampered["phase"] = "tampered"
    transferred_state.write_text(json.dumps(tampered), encoding="utf-8")
    assert (
        assignment_orchestration.verify_sealed_state(transferred_state)["ok"] is False
    )


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
