# SPDX-License-Identifier: Apache-2.0

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from kungfu import (
    initiative_bundle,
    initiative_family,
    profile_composition,
    profile_sdk,
    work_control,
)
from kungfu.agent import work_profile
from kungfu.rewind import reporting as rewind_reporting
from kungfu.storage import service as storage_service


SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "work-control"


@pytest.fixture(autouse=True)
def _bind_work_control_profile(monkeypatch):
    monkeypatch.setenv("KF_EXTENSION_PATH", str(SOURCE.parent))


def _activate(source: Path, runtime: Path) -> None:
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")


def _materialize_contract(source: Path, runtime: Path) -> None:
    contract = profile_composition.contract_materialization_plan(source, runtime)
    if contract["operations"]:
        profile_composition.authorized_contract_materialize(
            runtime,
            contract,
            profile_sdk.answer_decision(
                contract["decisionCard"], "approve", "test-owner"
            ),
        )


def test_completion_review_deduplicates_one_subject_across_authorities(tmp_path):
    runtime = tmp_path / "runtime"
    _activate(SOURCE, runtime)
    _materialize_contract(SOURCE, runtime)
    work_control.create_initiative(
        str(runtime),
        initiative_id="user-mission",
        title="User Mission",
        intent="Retain the user authority fact",
        actor="test-user",
        actor_type="user",
    )
    work_control.create_initiative(
        str(runtime),
        initiative_id="agent-mission",
        title="Agent Mission",
        intent="Retain the agent authority fact",
        actor="test-agent",
        actor_type="agent",
    )
    for initiative_id, actor, actor_type in (
        ("user-mission", "test-user", "user"),
        ("agent-mission", "test-agent", "agent"),
    ):
        work_control.create_assignment(
            str(runtime),
            initiative_id=initiative_id,
            assignment_id="shared-assignment",
            title="Shared Assignment",
            objective="Preserve both authority claims for one subject",
            actor=actor,
            actor_type=actor_type,
        )

    state = work_control.query_state(
        str(runtime), initiative_id="agent-mission", storage_source_id="kungfu"
    )
    matching = [
        row
        for row in state["assignments"]
        if row["subject_key"] == "kungfu:shared-assignment"
    ]
    assert len(matching) == 2
    assert {row["source_id"] for row in matching} == {
        "kungfu-agent",
        "kungfu-user",
    }

    work_control.claim_completion(
        str(runtime),
        initiative_id="agent-mission",
        assignment_id="shared-assignment",
        statement="The shared Assignment is ready for review",
        actor="test-agent",
        storage_source_id="kungfu",
    )
    review = work_control.review_completion(
        str(runtime),
        initiative_id="agent-mission",
        assignment_id="shared-assignment",
        reviewer="independent-reviewer",
        reviewer_source="independent-review-run",
        storage_source_id="kungfu",
    )
    assert review["review"]["claimant"] == "test-agent"
    assert review["review"]["reviewer"] == "independent-reviewer"


def test_work_control_accepts_only_exact_retired_atlas_source_history(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "runtime"
    _activate(SOURCE, runtime)
    migration = profile_sdk.ProfileSdkError(
        "fact-surface-authority-migration-required",
        "removed source authorities retain admitted facts and require an explicit migration",
        factSurface="kungfu.initiative-assignment.initiative",
        admittedSourceAuthorities=["atlas-adapter"],
    )
    monkeypatch.setattr(
        profile_composition,
        "contract_materialization_plan",
        lambda _source, _runtime: (_ for _ in ()).throw(migration),
    )
    monkeypatch.setattr(
        storage_service,
        "fact_state",
        lambda _runtime: {
            "observation_history": [
                {
                    "outcome": "admitted",
                    "fact_surface_id": "kungfu.initiative-assignment.initiative",
                    "source_id": "atlas-adapter",
                },
                {
                    "outcome": "admitted",
                    "fact_surface_id": "kungfu.initiative-assignment.assignment",
                    "source_id": "kungfu-agent",
                },
            ]
        },
    )

    contract = work_control._ensure_contract(str(runtime))

    assert contract["status"] == "retained-history-compatible"
    assert contract["retained_source_authorities"] == ["atlas-adapter"]


def test_work_control_rejects_unrecognized_retired_source_history(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "runtime"
    _activate(SOURCE, runtime)
    migration = profile_sdk.ProfileSdkError(
        "fact-surface-authority-migration-required",
        "removed source authorities retain admitted facts and require an explicit migration",
        factSurface="kungfu.initiative-assignment.initiative",
        admittedSourceAuthorities=["atlas-adapter"],
    )
    monkeypatch.setattr(
        profile_composition,
        "contract_materialization_plan",
        lambda _source, _runtime: (_ for _ in ()).throw(migration),
    )
    monkeypatch.setattr(
        storage_service,
        "fact_state",
        lambda _runtime: {
            "observation_history": [
                {
                    "outcome": "admitted",
                    "fact_surface_id": "kungfu.initiative-assignment.initiative",
                    "source_id": "atlas-adapter",
                },
                {
                    "outcome": "admitted",
                    "fact_surface_id": "kungfu.initiative-assignment.assignment",
                    "source_id": "unknown-adapter",
                },
            ]
        },
    )

    with pytest.raises(
        profile_sdk.ProfileSdkError,
        match="outside its exact retained compatibility boundary",
    ):
        work_control._ensure_contract(str(runtime))


@pytest.mark.parametrize(
    ("agent_request_root", "expected_verdict", "expected_conflict_count"),
    [
        ("sha256:" + "1" * 64, "fit", 0),
        ("sha256:" + "2" * 64, "conflicted", 1),
    ],
)
def test_completion_review_converges_only_exact_native_assignment_definitions(
    tmp_path, agent_request_root, expected_verdict, expected_conflict_count
):
    runtime = tmp_path / "runtime"
    _activate(SOURCE, runtime)
    _materialize_contract(SOURCE, runtime)
    work_control.create_initiative(
        str(runtime),
        initiative_id="initiative-a",
        title="Initiative A",
        intent="Prove exact cross-authority Assignment convergence",
        actor="test-agent",
        actor_type="agent",
    )
    work_definition = {
        "assignment_id": "assignment-a",
        "initiative_id": "initiative-a",
        "title": "Assignment A",
        "objective": "Preserve provenance without inventing a semantic conflict",
    }
    for actor, actor_type, request_root in (
        ("test-user", "user", "sha256:" + "1" * 64),
        ("test-agent", "agent", agent_request_root),
    ):
        work_control.create_assignment(
            str(runtime),
            initiative_id="initiative-a",
            assignment_id="assignment-a",
            title="Assignment A",
            objective="Preserve provenance without inventing a semantic conflict",
            actor=actor,
            actor_type=actor_type,
            responsibility="assignment-a-owner",
            request_root=request_root,
            work_definition=work_definition,
            storage_source_id="kungfu",
        )

    raw_state = work_control.query_state(
        str(runtime), initiative_id="initiative-a", storage_source_id="kungfu"
    )
    assert len(raw_state["lineage"]["conflicts"]) == 1
    assert len(raw_state["assignments"]) == 2

    rewind_reporting.begin_run(
        str(runtime),
        run_id="assignment-a-run",
        provider="codex",
        cwd=None,
        work_id="assignment-a",
    )
    rewind_reporting.report_cost(
        str(runtime),
        run_id="assignment-a-run",
        provider="codex",
        surface="exec-json",
        source="codex-exec-json",
        attribution="exact_run",
        work_id="assignment-a",
        input_tokens=8,
        output_tokens=2,
        cost_usd=0.01,
    )
    rewind_reporting.end_run(
        str(runtime), run_id="assignment-a-run", status="succeeded", exit_code=0
    )
    work_episode = next(
        row
        for row in storage_service.episode_list(runtime)["episodes"]
        if row["open"]["source"] == "rewind:assignment-a-run"
    )
    work_control.claim_completion(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        statement="Assignment A is complete with exact evidence",
        actor="test-agent",
        actor_type="agent",
        storage_source_id="kungfu",
        evidence_episode_ids=[int(work_episode["episode_id"])],
    )
    review = work_control.review_completion(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        reviewer="independent-reviewer",
        reviewer_source="independent-review-run",
        storage_source_id="kungfu",
    )
    assert review["review"]["verdict"] == expected_verdict
    assert (
        review["trust_report"]["assessment"]["report"]["evidence"]["conflict_count"]
        == expected_conflict_count
    )
    assert len(review["trust_report"]["state"]["lineage"]["conflicts"]) == 1


def _copy_source(tmp_path: Path) -> Path:
    root = tmp_path / "extensions"
    source = root / "work-control"
    shutil.copytree(SOURCE, source, ignore=shutil.ignore_patterns("node_modules"))
    shutil.copytree(
        SOURCE.parent / "work-dashboard",
        root / "work-dashboard",
        ignore=shutil.ignore_patterns("node_modules"),
    )
    return source


def _write_json(path: Path, value: object) -> str:
    data = (json.dumps(value, indent=2) + "\n").encode()
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def test_first_party_work_control_suite_closes_and_activates(tmp_path):
    validated = profile_sdk.validate_source(SOURCE, tmp_path / "runtime")

    assert validated["ok"] is True
    assert validated["inspection"]["verified"] is True
    assert set(validated["source"]["memberRoots"]) == {
        "work-control-actions",
        "work-control-assessment",
        "work-control-contract",
        "work-control-views",
        "work-dashboard",
    }
    assert profile_sdk.qualify_source(SOURCE, tmp_path / "runtime")["status"] == (
        "qualified-for-install-plan"
    )

    runtime = tmp_path / "active-runtime"
    _activate(SOURCE, runtime)
    discovered = profile_sdk.discover_source(
        "kungfu.work-control", runtime, search_roots=[SOURCE.parent]
    )
    assert discovered["source"] == str(SOURCE.resolve())
    catalog = profile_composition.catalog(SOURCE, runtime, require_active=True)
    managed = profile_composition.manager(runtime)["profiles"][0]
    contract = profile_composition.contract_materialization_plan(SOURCE, runtime)
    world = json.loads((SOURCE / "contracts" / "world.json").read_text())
    assert [operation["kind"] for operation in contract["operations"]] == [
        "declare-contract-world",
        "declare-fact-surface",
        "declare-fact-surface",
        "declare-fact-surface",
    ]
    receipt = profile_composition.authorized_contract_materialize(
        runtime,
        contract,
        profile_sdk.answer_decision(contract["decisionCard"], "approve", "test-owner"),
    )

    assert catalog["activeExactRoot"] is True
    assert {row["id"] for row in catalog["views"]} == {
        "assignment-cards",
        "initiative-state",
        "initiative-timeline",
        "initiative-diff",
        "initiative-causal-graph",
        "initiative-attention",
    }
    assert catalog["diagnostics"] == []
    assert managed["health"] == "active"
    assert managed["profileSuiteRoot"] == catalog["profileSuiteRoot"]
    assert receipt["status"] == "materialized"
    assert world["contractWorld"] == {
        "id": "kungfu.initiative-assignment",
        "version": "1",
        "factSurfaceIds": [
            "kungfu.initiative-assignment.initiative",
            "kungfu.initiative-assignment.assignment",
            "kungfu.initiative-assignment.completion-claim",
        ],
    }
    assert all(
        "exact_identity" not in surface["schema"]["properties"]["source"]["properties"]
        for surface in world["factSurfaces"]
    )
    assert (
        profile_composition.contract_materialization_plan(SOURCE, runtime)["operations"]
        == []
    )


def test_public_profile_validate_and_qualify_share_work_conformance(tmp_path):
    source = _copy_source(tmp_path)
    repository = Path(__file__).resolve().parents[4]
    reference = json.loads(
        (
            repository
            / "framework"
            / "work-profile-conformance"
            / "qualification"
            / "reference-scenarios.json"
        ).read_text(encoding="utf-8")
    )
    declaration = reference["scenarios"][0]["declaration"]
    declaration_path = source / "qualification" / "work-profile-conformance.json"
    declaration_sha = _write_json(declaration_path, declaration)
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    profile["work"] = {
        "conformance": {
            "path": "qualification/work-profile-conformance.json",
            "sha256": declaration_sha,
        }
    }
    _write_json(profile_path, profile)

    runtime = tmp_path / "runtime"
    validated = profile_sdk.validate_source(source, runtime)["workConformance"]
    qualified = profile_sdk.qualify_source(source, runtime)["workConformance"]

    assert validated["publicSurface"] == "validate"
    assert qualified["publicSurface"] == "qualify"
    for key in (
        "conformanceRoot",
        "verdict",
        "constraints",
        "diagnostics",
        "residualRisk",
        "nonClaims",
    ):
        assert validated[key] == qualified[key]
    assert validated["verdict"] == "compatible"


def test_public_profile_validate_denies_failed_work_conformance(tmp_path):
    source = _copy_source(tmp_path)
    repository = Path(__file__).resolve().parents[4]
    reference = json.loads(
        (
            repository
            / "framework/work-profile-conformance/qualification/reference-scenarios.json"
        ).read_text()
    )
    declaration = reference["scenarios"][0]["declaration"]
    declaration["behaviorEvidence"][0]["status"] = "failed"
    declaration_path = source / "qualification/work-profile-conformance.json"
    declaration_sha = _write_json(declaration_path, declaration)
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["work"] = {
        "conformance": {
            "path": "qualification/work-profile-conformance.json",
            "sha256": declaration_sha,
        }
    }
    _write_json(profile_path, profile)

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_sdk.validate_source(source, tmp_path / "runtime")
    assert raised.value.diagnosis["code"] == "work-profile-conformance-denied"


def test_work_capable_profile_rejects_missing_conformance_binding(tmp_path):
    source = _copy_source(tmp_path)
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    profile.pop("work")
    _write_json(profile_path, profile)

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_sdk.validate_source(source, tmp_path / "runtime")

    assert raised.value.diagnosis["code"] == "work-profile-conformance-required"


def test_first_party_work_control_suite_rejects_missing_member(tmp_path):
    source = _copy_source(tmp_path)
    shutil.rmtree(source / "work-control-actions")

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_sdk.resolve_source(source)

    assert raised.value.diagnosis["code"] == "member-resolution-failed"
    assert raised.value.diagnosis["decisionCards"][0]["kind"] == (
        "profile-member-missing"
    )


def test_first_party_work_control_suite_resolves_installed_dependency(tmp_path):
    source = _copy_source(tmp_path)
    shutil.rmtree(source / "node_modules", ignore_errors=True)
    installed_dependency = (
        source / "node_modules" / "@kungfu-tech" / "kfx-view-work-dashboard"
    )
    installed_dependency.parent.mkdir(parents=True)
    shutil.move(source.parent / "work-dashboard", installed_dependency)

    resolved = profile_sdk.resolve_source(source)

    assert resolved["memberPackages"]["work-dashboard"] == str(
        installed_dependency.resolve()
    )


def test_member_action_stays_bound_to_its_invocation_profile_source(tmp_path):
    source = _copy_source(tmp_path)
    (source.parent / "work-dashboard" / "installed-only.txt").write_text(
        "installed closure\n", encoding="utf-8"
    )
    runtime = tmp_path / "runtime"
    _activate(source, runtime)
    contract = profile_composition.contract_materialization_plan(source, runtime)
    profile_composition.authorized_contract_materialize(
        runtime,
        contract,
        profile_sdk.answer_decision(contract["decisionCard"], "approve", "test-owner"),
    )

    assert (
        profile_sdk.validate_source(source, runtime)["inspection"]["profile_suite_root"]
        != profile_sdk.validate_source(SOURCE, runtime)["inspection"][
            "profile_suite_root"
        ]
    )

    receipt = profile_sdk.invoke_member_adapter(
        source,
        runtime,
        "work-control-actions",
        "create-initiative",
        {
            "initiativeId": "installed-source",
            "title": "Installed source",
            "intent": "Stay on the invocation-bound Profile root",
            "actor": "test-agent",
            "actorType": "agent",
        },
        authorized_action=True,
    )

    assert receipt["result"]["coreReceipt"]["schema"] == (
        "kungfu.initiative-assignment.initiative-write/v1"
    )
    assert (
        receipt["profileSuiteRoot"]
        == profile_sdk.validate_source(source, runtime)["inspection"][
            "profile_suite_root"
        ]
    )


def test_native_work_control_receipts_do_not_leak_compatibility_vocabulary(
    tmp_path,
):
    runtime = tmp_path / "runtime"
    _activate(SOURCE, runtime)
    contract = profile_composition.contract_materialization_plan(SOURCE, runtime)
    profile_composition.authorized_contract_materialize(
        runtime,
        contract,
        profile_sdk.answer_decision(contract["decisionCard"], "approve", "test-owner"),
    )
    profile_sdk.invoke_member_adapter(
        SOURCE,
        runtime,
        "work-control-actions",
        "create-initiative",
        {
            "initiativeId": "initiative-a",
            "title": "Initiative A",
            "intent": "Keep one continuing intent",
            "actor": "test-agent",
        },
        authorized_action=True,
    )
    profile_sdk.invoke_member_adapter(
        SOURCE,
        runtime,
        "work-control-actions",
        "create-assignment",
        {
            "initiativeId": "initiative-a",
            "assignmentId": "assignment-a",
            "title": "Assignment A",
            "objective": "Deliver one bounded result",
            "actor": "test-agent",
        },
        authorized_action=True,
    )
    status = profile_sdk.invoke_member_adapter(
        SOURCE,
        runtime,
        "work-control-actions",
        "assignment-status",
        {
            "initiativeId": "initiative-a",
            "assignmentId": "assignment-a",
        },
    )["result"]
    assert status["initiative_subject"] == "kungfu:initiative-a"
    assert status["assignment"]["initiative_id"] == "initiative-a"
    assert status["assignment"]["assignment_id"] == "assignment-a"
    assert status["phase"] == "admitted"


def test_public_work_control_adapter_rejects_legacy_completion_root_names(tmp_path):
    runtime = tmp_path / "runtime"
    _activate(SOURCE, runtime)
    _materialize_contract(SOURCE, runtime)

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_sdk.invoke_member_adapter(
            SOURCE,
            runtime,
            "work-control-actions",
            "claim-completion",
            {
                "initiativeId": "initiative-a",
                "assignmentId": "assignment-a",
                "inputAtlasRoot": "sha256:legacy-input",
                "resultAtlasRoot": "sha256:legacy-result",
            },
            authorized_action=True,
        )

    assert raised.value.diagnosis["code"] == "member-adapter-invoke-failed"


def test_native_initiative_bundle_roundtrip(tmp_path):
    source = tmp_path / "source-runtime"
    destination = tmp_path / "destination-runtime"
    _activate(SOURCE, source)
    _activate(SOURCE, destination)
    contract = profile_composition.contract_materialization_plan(SOURCE, source)
    profile_composition.authorized_contract_materialize(
        source,
        contract,
        profile_sdk.answer_decision(contract["decisionCard"], "approve", "test-owner"),
    )
    work_control.create_initiative(
        str(source),
        initiative_id="native-initiative",
        title="Native Initiative",
        intent="Prove native portable closure",
        actor="test-user",
        actor_type="user",
    )
    bundle = initiative_bundle.build_initiative_bundle(
        str(source), initiative_id="native-initiative", mode="full"
    )

    assert bundle["schema"] == "kungfu.work-control.initiative-bundle/v1"
    assert bundle["initiative_subject"] == "kungfu:native-initiative"
    assert bundle["bundle_id"].startswith("initiative:")
    imported = initiative_bundle.import_initiative_bundle(
        str(destination), bundle, execute=True
    )
    assert imported["schema"] == "kungfu.work-control.initiative-bundle-import/v1"
    assert imported["status"] == "imported", imported
    assert imported["accepted"] is True
    assert imported["initiative_subject"] == "kungfu:native-initiative"


def test_first_party_work_control_suite_rejects_artifact_drift(tmp_path):
    source = _copy_source(tmp_path)
    (source / "views" / "registry.json").write_text("{}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="artifact hash mismatch"):
        profile_sdk.validate_source(source, tmp_path / "runtime")


def test_work_control_domain_is_owned_by_the_profile_member():
    member = SOURCE / "work-control-actions"
    assert (member / "domain" / "work_control.py").is_file()
    assert (member / "domain" / "initiative_bundle.py").is_file()
    assert not list((member / "domain" / "compatibility").glob("*.py"))


def test_initiative_assignment_capabilities_are_native_and_preserve_pursuit():
    domain = profile_sdk.load_member_python_package(
        str(SOURCE), "work-control-actions", "domain"
    )
    assert callable(domain.work_control.ensure_profile_contract)
    capabilities = domain.work_control.capabilities()
    pursuit = work_profile.capabilities_python(conformance=True)

    assert capabilities["contractWorld"] == {
        "id": "kungfu.initiative-assignment",
        "version": "1",
    }
    assert "compatibility" not in capabilities
    assert capabilities["unchangedRoles"] == ["pursuit"]
    assert pursuit["roleBodySchemas"]["pursuit"] == (
        "kungfu.agent-work.pursuit-role/v2"
    )
    assert pursuit["roleSchemaRoots"]["pursuit"] == (
        "sha256:705f541dec68b8f18aa4b3968e0db83a4dc8ff53331b0e772999a3054cb8db7b"
    )


def test_family_protocol_adds_no_parent_execution_authority():
    domain = profile_sdk.load_member_python_package(
        str(SOURCE), "work-control-actions", "domain"
    )
    capabilities = domain.work_control.capabilities()
    contract = initiative_family.family_contract()

    assert contract["authority"] == {
        "initiativeParent": "inert",
        "waveGate": "membership-only-terminal",
        "assignment": "bounded-execution-unit",
    }
    assert contract["parentDeniedAuthorities"] == [
        "execution-claim",
        "execution-lease",
        "task-worktree",
        "code-pull-request",
        "merge-queue-lease",
    ]
    assert capabilities["contractWorld"] == {
        "id": "kungfu.initiative-assignment",
        "version": "1",
    }
