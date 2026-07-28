# SPDX-License-Identifier: Apache-2.0

import json
import re
import shutil
from pathlib import Path

import pytest

from kungfu import assignment_orchestration, profile_composition, profile_sdk
from kungfu.agent import work_profile


SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "mission-control"


def _activate(source: Path, runtime: Path) -> None:
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")


def _copy_source(tmp_path: Path) -> Path:
    root = tmp_path / "extensions"
    source = root / "mission-control"
    shutil.copytree(SOURCE, source, ignore=shutil.ignore_patterns("node_modules"))
    shutil.copytree(
        SOURCE.parent / "work-dashboard",
        root / "work-dashboard",
        ignore=shutil.ignore_patterns("node_modules"),
    )
    return source


def test_first_party_mission_control_suite_closes_and_activates(tmp_path):
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


def test_first_party_mission_control_suite_rejects_missing_member(tmp_path):
    source = _copy_source(tmp_path)
    shutil.rmtree(source / "mission-control-actions")

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_sdk.resolve_source(source)

    assert raised.value.diagnosis["code"] == "member-resolution-failed"
    assert raised.value.diagnosis["decisionCards"][0]["kind"] == (
        "profile-member-missing"
    )


def test_first_party_mission_control_suite_resolves_installed_dependency(tmp_path):
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
    serialized = json.dumps(status, sort_keys=True)

    assert not re.search(
        r'"(?:mission|goal|go)(?:_|")|kungfu\.mission-control|\bMission\b|\bGo\b',
        serialized,
    )
    assert status["initiative_subject"] == "kungfu:initiative-a"
    assert status["assignment"]["initiative_id"] == "initiative-a"
    assert status["assignment"]["assignment_id"] == "assignment-a"
    assert status["phase"] == "admitted"


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
    domain = profile_sdk.load_member_python_package(
        str(SOURCE), "work-control-actions", "domain"
    )
    domain.mission_control.create_initiative(
        str(source),
        initiative_id="native-initiative",
        title="Native Initiative",
        intent="Prove native portable closure",
        actor="test-user",
        actor_type="user",
    )
    bundle = domain.mission_bundle.build_initiative_bundle(
        str(source), initiative_id="native-initiative", mode="full"
    )

    assert bundle["schema"] == "kungfu.work-control.initiative-bundle/v1"
    assert bundle["initiative_subject"] == "kungfu:native-initiative"
    assert "mission_subject" not in bundle
    assert "mission_id" not in bundle
    assert bundle["bundle_id"].startswith("initiative:")
    imported = domain.mission_bundle.import_initiative_bundle(
        str(destination), bundle, execute=True
    )
    assert imported["schema"] == "kungfu.work-control.initiative-bundle-import/v1"
    assert imported["status"] == "imported", imported
    assert imported["accepted"] is True
    assert imported["initiative_subject"] == "kungfu:native-initiative"


def test_first_party_mission_control_suite_rejects_artifact_drift(tmp_path):
    source = _copy_source(tmp_path)
    (source / "views" / "registry.json").write_text("{}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="artifact hash mismatch"):
        profile_sdk.validate_source(source, tmp_path / "runtime")


def test_mission_control_domain_is_owned_by_the_profile_member():
    member = SOURCE / "mission-control-actions"
    adapter = (member / "adapter.py").read_text(encoding="utf-8")
    core = SOURCE.parents[1] / "framework" / "core" / "src" / "python" / "kungfu"

    assert (member / "domain" / "mission_control.py").is_file()
    assert (member / "domain" / "mission_bundle.py").is_file()
    assert "from kungfu.atlas import mission_control" not in adapter
    assert "from kungfu.atlas import mission_bundle" not in adapter

    store = (core / "atlas" / "store.py").read_text(encoding="utf-8")
    assert "from kungfu.atlas import mission_control" not in store
    for compatibility_name in ("mission_control.py", "mission_bundle.py"):
        compatibility = (core / "atlas" / compatibility_name).read_text(
            encoding="utf-8"
        )
        assert "Deprecated compatibility alias" in compatibility
        assert "CONTRACT_WORLD_ID" not in compatibility
        assert "def create_mission" not in compatibility


def test_initiative_assignment_capabilities_preserve_legacy_identity_and_pursuit():
    domain = profile_sdk.load_member_python_package(
        str(SOURCE), "work-control-actions", "domain"
    )
    capabilities = domain.mission_control.capabilities()
    pursuit = work_profile.capabilities_python(conformance=True)

    assert capabilities["contractWorld"] == {
        "id": "kungfu.initiative-assignment",
        "version": "1",
    }
    assert capabilities["compatibility"]["mode"] == "read-only-projection"
    assert capabilities["compatibility"]["policy"] == (
        "Legacy roots, bodies, receipts, fixtures, public commands, replay, "
        "recovery, and object identities retain their original meaning."
    )
    assert capabilities["compatibility"]["surfaceMap"] == {
        "kungfu.mission-control.mission": ("kungfu.initiative-assignment.initiative"),
        "kungfu.mission-control.go": "kungfu.initiative-assignment.assignment",
        "kungfu.mission-control.completion-claim": (
            "kungfu.initiative-assignment.completion-claim"
        ),
    }
    assert capabilities["unchangedRoles"] == ["pursuit"]
    assert pursuit["roleBodySchemas"]["pursuit"] == (
        "kungfu.agent-work.pursuit-role/v2"
    )
    assert pursuit["roleSchemaRoots"]["pursuit"] == (
        "sha256:705f541dec68b8f18aa4b3968e0db83a4dc8ff53331b0e772999a3054cb8db7b"
    )


def test_family_protocol_adds_no_parent_execution_or_legacy_fact_authority():
    domain = profile_sdk.load_member_python_package(
        str(SOURCE), "work-control-actions", "domain"
    )
    capabilities = domain.mission_control.capabilities()
    contract = assignment_orchestration.family_contract()

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
