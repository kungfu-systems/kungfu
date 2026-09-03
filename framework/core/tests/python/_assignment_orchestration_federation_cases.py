# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F403,F405

from _assignment_orchestration_support import *


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

    offer = work_control.append_assignment_relation_event(
        str(source_runtime),
        workspace_identity_root=source_identity.identity_root,
        relation=relation,
        event_type="delegation-offer",
        actor="source-agent",
    )
    assert offer["next_action"] == "destination-acceptance"
    assert work_control.assignment_relations(str(source_runtime)) == [relation]
    other_ref = build_work_ref(
        source_identity,
        object_kind="assignment",
        subject="kungfu:other",
        version_root="sha256:" + "e" * 64,
        cut_root="sha256:" + "f" * 64,
    )
    other_relation = build_relation("delegates-to", source_ref, other_ref)
    repeated = work_control.append_assignment_relation_event(
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
        work_control.append_assignment_relation_event(
            str(source_runtime),
            workspace_identity_root=source_identity.identity_root,
            relation=relation,
            event_type="destination-acceptance",
            actor="wrong-agent",
            predecessor_event_roots=[offer["event"]["event_root"]],
        )

    accepted = work_control.append_assignment_relation_event(
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
    work_control.create_initiative(
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
        written = work_control.create_assignment(
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
        assert work_control.list_initiatives(str(runtime)) == []
        status = work_control.assignment_orchestration_status(
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
    work_control.create_initiative(
        str(runtime),
        initiative_id="initiative",
        title="Initiative",
        intent="Resolve local shorthand before admission",
        actor="owner",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="initiative",
        assignment_id="parent",
        title="Parent",
        objective="Own parent authority",
        actor="owner",
        storage_source_id="kungfu",
        owning_workspace_identity_root=identity.identity_root,
    )
    work_control.create_assignment(
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
        for row in work_control.list_assignments(str(runtime))
        if row["assignment_id"] == "child"
    )
    assert child["parent_assignment_id"] == ""
    assert child["parent_assignment_ref"]["workspace_identity_root"] == (
        identity.identity_root
    )
    assert child["parent_assignment_ref"]["subject"] == "kungfu:parent"

    with pytest.raises(ValueError, match="resolve exactly once"):
        work_control.create_assignment(
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


def test_unresolved_dependency_shorthand_remains_visible_without_fake_work_ref(
    tmp_path,
):
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
    work_control.create_initiative(
        str(runtime),
        initiative_id="initiative",
        title="Initiative",
        intent="Keep unavailable dependencies explicit",
        actor="owner",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="initiative",
        assignment_id="current",
        title="Current",
        objective="Expose unresolved cross-workspace dependency",
        actor="agent",
        storage_source_id="kungfu",
        owning_workspace_identity_root=identity.identity_root,
        depends_on=["historical-assignment"],
    )

    current = next(
        row
        for row in work_control.list_assignments(str(runtime))
        if row["assignment_id"] == "current"
    )
    assert current["depends_on"] == []
    assert current["dependency_refs"] == []
    assert current["unresolved_dependency_ids"] == ["historical-assignment"]

    result = query_federation(
        identity,
        scope="local",
        config_home=identity.config_home,
        env=env,
    )
    component = result["components"][0]
    assert component["problems"] == [
        {
            "code": "unresolved-assignment-dependency",
            "assignment_subject": "kungfu:current",
            "dependency_id": "historical-assignment",
        }
    ]
    assert result["proof"]["unresolved_references"] == [
        {
            "kind": "legacy-assignment-dependency",
            "code": "missing-reference",
            "workspace_identity_root": identity.identity_root,
            "assignment_subject": "kungfu:current",
            "dependency_id": "historical-assignment",
            "dependency_subject": "kungfu:historical-assignment",
            "candidate_canonical_roots": [],
            "candidate_sealed_state_roots": [],
            "candidate_unqualified_state_roots": [],
            "next_action": "register the dependency authority",
        }
    ]


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
    assert str(home) not in assignment_canonical.canonical_json(plan["snapshot"])


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
    assert "path" not in assignment_canonical.canonical_json(binding).lower()

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
