# SPDX-License-Identifier: Apache-2.0
"""Legacy dependency and retained sealed-state resolution cases."""
# ruff: noqa: F401,F403

from _workspace_federation_support import *
from _workspace_federation_support import (
    _bind_work_control_profile,
    _component_fixture,
    _qualified_project,
    _ref,
    _retained_state_dominates,
)


def test_legacy_dependencies_resolve_after_complete_identity_composition(tmp_path):
    config_home = tmp_path / "config"
    source = _qualified_project(tmp_path, "dependency-source")
    target = _qualified_project(tmp_path, "dependency-target")
    for identity in (target, source):
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    assignments = {
        source.identity_root: [
            {
                "title": "Source",
                "work_ref": _ref(source, "kungfu:source", ROOT_A, ROOT_D).as_dict(),
            }
        ],
        target.identity_root: [
            {
                "title": "Target",
                "work_ref": _ref(target, "kungfu:target", ROOT_B, ROOT_D).as_dict(),
            }
        ],
    }

    def loader(identity):
        component = _component_fixture(identity, assignments)
        if identity.identity_root == source.identity_root:
            component["problems"] = [
                {
                    "code": "unresolved-assignment-dependency",
                    "assignment_subject": "kungfu:source",
                    "dependency_id": "target",
                }
            ]
        return component

    result = query_federation(
        source,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    resolution = result["global_work"]["reference_resolution"]
    assert resolution["unresolved"] == []
    assert resolution["resolved"][0]["dependency_subject"] == "kungfu:target"
    assert result["aggregate"]["complete"] is True


def test_retained_sealed_state_closes_deleted_worktree_dependency(tmp_path):
    source = _qualified_project(tmp_path, "sealed-dependency-source")
    target_root = "sha256:" + "e" * 64
    state_root = "sha256:" + "f" * 64
    assignments = {
        source.identity_root: [
            {
                "title": "Source",
                "work_ref": _ref(source, "kungfu:source", ROOT_A, ROOT_D).as_dict(),
            }
        ]
    }

    def loader(identity):
        component = _component_fixture(identity, assignments)
        component["problems"] = [
            {
                "code": "unresolved-assignment-dependency",
                "assignment_subject": "kungfu:source",
                "dependency_id": "deleted-target",
            }
        ]
        component["retained_assignment_states"] = [
            {
                "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
                "assignment_subject": "kungfu:deleted-target",
                "workspace_identity_root": target_root,
                "assignment_state_root": ROOT_B,
                "event_counts": {"completion_claims": 1},
                "state_root": state_root,
                "query_proof_root": ROOT_C,
                "phase": "continuation-decided",
                "settled": True,
                "storage_kind": "git-common-dir",
            }
        ]
        return component

    result = query_federation(
        source,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    resolution = result["global_work"]["reference_resolution"]
    assert resolution["unresolved"] == []
    assert resolution["resolved"][0]["resolution"] == (
        "retained-sealed-assignment-state"
    )
    assert resolution["resolved"][0]["work_ref"]["workspace_identity_root"] == (
        target_root
    )
    assert result["aggregate"]["retained_assignment_state_count"] == 1


def test_equivalent_retained_seals_resolve_one_legacy_dependency(tmp_path):
    source = _qualified_project(tmp_path, "equivalent-sealed-source")
    target_root = "sha256:" + "e" * 64
    assignment_state_root = "sha256:" + "f" * 64
    state_roots = ["sha256:" + "1" * 64, "sha256:" + "2" * 64]
    assignments = {
        source.identity_root: [
            {
                "title": "Source",
                "work_ref": _ref(source, "kungfu:source", ROOT_A, ROOT_D).as_dict(),
            }
        ]
    }

    def loader(identity):
        component = _component_fixture(identity, assignments)
        component["problems"] = [
            {
                "code": "unresolved-assignment-dependency",
                "assignment_subject": "kungfu:source",
                "dependency_id": "settled-target",
            }
        ]
        component["retained_assignment_states"] = [
            {
                "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
                "assignment_subject": "kungfu:settled-target",
                "workspace_identity_root": target_root,
                "assignment_state_root": assignment_state_root,
                "event_counts": {"completion_claims": 1},
                "state_root": state_root,
                "query_proof_root": ROOT_C,
                "phase": "continuation-decided",
                "settled": True,
                "storage_kind": "git-common-dir",
            }
            for state_root in state_roots
        ]
        return component

    result = query_federation(
        source,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    resolution = result["global_work"]["reference_resolution"]
    assert resolution["unresolved"] == []
    assert resolution["resolved"][0]["assignment_state_root"] == (assignment_state_root)
    assert resolution["resolved"][0]["equivalent_sealed_state_roots"] == state_roots
    assert result["aggregate"]["complete"] is True


def test_dominant_retained_seal_supersedes_earlier_settlement_snapshots(tmp_path):
    source = _qualified_project(tmp_path, "successor-sealed-source")
    target_root = "sha256:" + "e" * 64
    early_state_root = "sha256:" + "1" * 64
    final_state_root = "sha256:" + "2" * 64
    assignments = {
        source.identity_root: [
            {
                "title": "Source",
                "work_ref": _ref(source, "kungfu:source", ROOT_A, ROOT_D).as_dict(),
            }
        ]
    }

    def loader(identity):
        component = _component_fixture(identity, assignments)
        component["problems"] = [
            {
                "code": "unresolved-assignment-dependency",
                "assignment_subject": "kungfu:source",
                "dependency_id": "settled-target",
            }
        ]
        component["retained_assignment_states"] = [
            {
                "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
                "assignment_subject": "kungfu:settled-target",
                "workspace_identity_root": target_root,
                "assignment_state_root": ROOT_A,
                "event_counts": {
                    "completion_claims": 1,
                    "independent_reviews": 1,
                },
                "state_root": early_state_root,
                "query_proof_root": ROOT_C,
                "phase": "continuation-decided",
                "settled": True,
                "storage_kind": "git-common-dir",
            },
            {
                "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
                "assignment_subject": "kungfu:settled-target",
                "workspace_identity_root": target_root,
                "assignment_state_root": ROOT_B,
                "event_counts": {
                    "completion_claims": 2,
                    "independent_reviews": 2,
                },
                "state_root": final_state_root,
                "query_proof_root": ROOT_D,
                "phase": "continuation-decided",
                "settled": True,
                "storage_kind": "git-common-dir",
            },
        ]
        return component

    result = query_federation(
        source,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    resolution = result["global_work"]["reference_resolution"]
    assert resolution["unresolved"] == []
    assert resolution["resolved"][0]["sealed_state_root"] == final_state_root
    assert resolution["resolved"][0]["superseded_sealed_state_roots"] == [
        early_state_root
    ]
    assert result["aggregate"]["complete"] is True


def test_retained_state_dominance_rejects_equal_or_incomparable_histories():
    earlier = {"event_counts": {"completion_claims": 1, "independent_reviews": 1}}
    successor = {"event_counts": {"completion_claims": 2, "independent_reviews": 2}}
    incomparable = {"event_counts": {"completion_claims": 2, "independent_reviews": 0}}

    assert _retained_state_dominates(successor, earlier) is True
    assert _retained_state_dominates(earlier, earlier) is False
    assert _retained_state_dominates(incomparable, earlier) is False
    assert _retained_state_dominates({}, earlier) is False


def test_exact_work_ref_resolves_against_retained_sealed_state(tmp_path):
    source = _qualified_project(tmp_path, "exact-retained-source")
    target_root = "sha256:" + "e" * 64
    state_root = "sha256:" + "f" * 64
    target_ref = WorkRef(
        workspace_identity_root=target_root,
        object_kind="assignment",
        subject="kungfu:settled-target",
        version_root=state_root,
        cut_root=ROOT_C,
    )
    source_ref = _ref(source, "kungfu:source", ROOT_A, ROOT_D)
    assignments = {
        source.identity_root: [{"title": "Source", "work_ref": source_ref.as_dict()}]
    }

    def loader(identity):
        component = _component_fixture(identity, assignments)
        component["relations"] = [build_relation("depends-on", source_ref, target_ref)]
        component["retained_assignment_states"] = [
            {
                "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
                "assignment_subject": "kungfu:settled-target",
                "workspace_identity_root": target_root,
                "assignment_state_root": ROOT_B,
                "event_counts": {"completion_claims": 1},
                "state_root": state_root,
                "query_proof_root": ROOT_C,
                "phase": "continuation-decided",
                "settled": True,
                "storage_kind": "git-common-dir",
            }
        ]
        return component

    result = query_federation(
        source,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    resolution = result["global_work"]["reference_resolution"]
    assert resolution["unresolved"] == []
    retained_endpoint = next(
        row
        for row in resolution["resolved"]
        if row.get("sealed_state_root") == state_root
    )
    assert retained_endpoint["resolution"] == "retained-sealed-assignment-state"
    assert result["aggregate"]["complete"] is True


def test_explicit_catalog_exclusion_is_retained_but_not_required(tmp_path):
    config_home = tmp_path / "config"
    active = _qualified_project(tmp_path, "active")
    retired = _qualified_project(tmp_path, "retired")
    for identity in (active, retired):
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    retired_root = retired.identity_root
    os.rename(retired.workspace_root, tmp_path / "retired-moved")
    maintain_workspace_catalog(
        [retired_root],
        "retire",
        "disposable fixture retired",
        execute=True,
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )

    clean = query_federation(
        active,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )
    detailed = query_federation(
        active,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        include_excluded=True,
    )

    assert clean["aggregate"]["complete"] is True
    assert clean["aggregate"]["excluded_component_count"] == 1
    assert clean["aggregate"]["tombstoned_component_count"] == 1
    assert all(
        row["workspace"]["identity_root"] != retired_root for row in clean["components"]
    )
    excluded = [
        row for row in detailed["components"] if row["availability"] == "excluded"
    ]
    assert excluded[0]["workspace"]["identity_root"] == retired_root
    assert detailed["proof"]["excluded_entries"][0]["identity_root"] == retired_root


def test_catalog_churn_is_explicit_and_never_claims_complete(tmp_path):
    config_home = tmp_path / "config"
    current = _qualified_project(tmp_path, "catalog-current")
    concurrent = _qualified_project(tmp_path, "catalog-concurrent")
    observe_workspace_locator(
        current,
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )
    changed = False

    def loader(identity):
        nonlocal changed
        if not changed:
            changed = True
            observe_workspace_locator(
                concurrent,
                config_home=str(config_home),
                env={"HOME": str(tmp_path)},
            )
        return _component_fixture(identity, {})

    result = query_federation(
        current,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    assert result["proof"]["catalog_changed_during_query"] is True
    assert result["proof"]["catalog_cut"] != result["proof"]["catalog_cut_after"]
    assert result["aggregate"]["complete"] is False
    assert result["aggregate"]["false_zero_guard"] == "unknown-not-empty"
