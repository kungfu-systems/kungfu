# SPDX-License-Identifier: Apache-2.0

import json
import shutil
from pathlib import Path

import pytest

from kungfu import profile_composition, profile_sdk
from kungfu.agent import work_profile


SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "mission-control"


def _activate(source: Path, runtime: Path) -> None:
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")


def _copy_source(tmp_path: Path) -> Path:
    root = tmp_path / "extensions"
    source = root / "mission-control"
    shutil.copytree(SOURCE, source)
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
        "mission-control-actions",
        "mission-control-assessment",
        "mission-control-contract",
        "mission-control-views",
        "work-dashboard",
    }
    assert profile_sdk.qualify_source(SOURCE, tmp_path / "runtime")["status"] == (
        "qualified-for-install-plan"
    )

    runtime = tmp_path / "active-runtime"
    _activate(SOURCE, runtime)
    discovered = profile_sdk.discover_source(
        "kungfu.mission-control", runtime, search_roots=[SOURCE.parent]
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
        "goal-cards",
        "mission-state",
        "mission-timeline",
        "mission-diff",
        "mission-causal-graph",
        "mission-attention",
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
        str(SOURCE), "mission-control-actions", "domain"
    )
    capabilities = domain.mission_control.capabilities()
    pursuit = work_profile.capabilities_python()

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
