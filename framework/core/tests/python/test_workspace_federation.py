# SPDX-License-Identifier: Apache-2.0

import os
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import kungfu
import pytest

from kungfu import assignment_graph
from kungfu import workspace_federation as federation
from kungfu import workspace_federation_projection as federation_projection
from kungfu.workspace import (
    WorkspaceIdentity,
    ensure_workspace_data_home,
    inspect_workspace,
    maintain_workspace_catalog,
    observe_workspace_locator,
    select_workspace,
)
from kungfu.workspace_federation import (
    RELATION_TYPES,
    WorkRef,
    _retained_state_dominates,
    assignment_lifecycle_projection,
    build_dogfood_gate_receipt,
    build_relation,
    build_work_ref,
    qualify_assignment_graph,
    query_federation,
    traverse_assignment_graph,
    portfolio_state,
    verify_federation_query,
    verify_dogfood_gate_receipt,
)
from kungfu.workspace_federation_observer import _runtime_signal
from kungfu.cli.commands.workspace import (
    _human_initiative_group_line,
    _human_work_line,
)


ROOT_A = "sha256:" + "a" * 64
ROOT_B = "sha256:" + "b" * 64
ROOT_C = "sha256:" + "c" * 64
ROOT_D = "sha256:" + "d" * 64
CONTRACT = (
    Path(__file__).resolve().parents[4]
    / "framework"
    / "workspace-federation"
    / "workspace-federation.contract.json"
)
WORK_CONTROL_SOURCE = (
    Path(__file__).resolve().parents[4] / "extensions" / "work-control"
)


@pytest.fixture(autouse=True)
def _bind_work_control_profile(monkeypatch):
    monkeypatch.setenv("KF_EXTENSION_PATH", str(WORK_CONTROL_SOURCE.parent))


def test_workspace_federation_preserves_extracted_read_model_exports():
    assert federation.WorkRef is assignment_graph.WorkRef
    assert federation.build_work_ref is assignment_graph.build_work_ref
    assert federation.build_relation is assignment_graph.build_relation
    assert (
        federation.qualify_assignment_graph is assignment_graph.qualify_assignment_graph
    )
    assert (
        federation.traverse_assignment_graph
        is assignment_graph.traverse_assignment_graph
    )
    assert (
        federation._retained_state_dominates
        is federation_projection._retained_state_dominates
    )
    assert federation._compose_global_work is federation_projection._compose_global_work


def test_default_component_reader_does_not_resolve_work_control_profile(monkeypatch):
    identity = WorkspaceIdentity(
        workspace_id="project:reader",
        workspace_kind="project",
        workspace_root="/missing-reader-fixture",
        display_path="/missing-reader-fixture",
        data_home="/missing-reader-fixture/.kungfu",
        config_home="/missing-reader-fixture/.config",
        identity_root=ROOT_A,
        identity_state="qualified",
        initialized=True,
        resolution_reason="test",
    )

    original_getattr = kungfu.__getattr__

    def fail_profile_resolution(name):
        if name == "work_control":
            raise AssertionError("federation reader resolved Work Control Profile")
        return original_getattr(name)

    monkeypatch.setattr(kungfu, "__getattr__", fail_profile_resolution)
    component = federation._load_parallel_component(identity)

    assert component["availability"] == "unavailable"
    assert component["problems"] == [{"code": "workspace-unavailable", "locator": None}]


def test_material_relation_verifies_without_work_control_profile():
    relation = federation.build_relation(
        "depends-on",
        {
            "schema": federation.WORK_REF_SCHEMA,
            "workspace_identity_root": ROOT_A,
            "object_kind": "assignment",
            "subject": "kungfu:left",
            "version_root": ROOT_B,
            "cut_root": ROOT_C,
        },
        {
            "schema": federation.WORK_REF_SCHEMA,
            "workspace_identity_root": ROOT_A,
            "object_kind": "assignment",
            "subject": "kungfu:right",
            "version_root": ROOT_C,
            "cut_root": ROOT_D,
        },
    )

    assert (
        federation._material_relation(
            {"claim_type": "assignment-relation-event", "relation": relation}
        )
        == relation
    )


@pytest.mark.parametrize(
    ("record", "phase"),
    [
        (
            {
                "claim_type": "assignment-phase-transition",
                "to_phase": "stage-ready",
            },
            "stage-ready",
        ),
        ({"claim_type": "task-completed"}, "completion-claimed"),
        (
            {"review_type": "independent-completion-review"},
            "independently-reviewed",
        ),
        (
            {"review_type": "continuation-decision", "action": "close"},
            "continuation-decided",
        ),
        (
            {"review_type": "continuation-decision", "action": "reopen"},
            "stage-ready",
        ),
    ],
)
def test_fact_material_completion_phase_matches_work_control(record, phase):
    assert federation._material_completion_phase(record) == phase


def _qualified_project(tmp_path, name):
    root = tmp_path / name
    root.mkdir()
    candidate = inspect_workspace(str(root), env={"HOME": str(tmp_path)})
    assert candidate is not None
    ensure_workspace_data_home(candidate, "create-assignment")
    identity = inspect_workspace(str(root), env={"HOME": str(tmp_path)})
    assert identity is not None
    return identity


def _ref(identity, subject, version=ROOT_A, cut=ROOT_B):
    return build_work_ref(
        identity,
        object_kind="assignment",
        subject=subject,
        version_root=version,
        cut_root=cut,
    )


def _component_fixture(identity, assignments):
    return {
        "availability": "available",
        "stale": False,
        "cut_root": ROOT_D,
        "query_proof_root": ROOT_D,
        "initiatives": [],
        "assignments": assignments.get(identity.identity_root, []),
        "relations": [],
        "problems": [],
        "profile_root": ROOT_A,
        "reader_runtime": {"runtime_root": ROOT_B},
        "workspace_runtime": {"runtime_root": ROOT_C},
        "compatibility": {
            "state": "compatible",
            "protocol": "kungfu.fact-material-read/v1",
        },
    }


def test_public_contract_matches_runtime_relation_vocabulary():
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))

    assert contract["relationTypes"] == RELATION_TYPES
    assert contract["query"]["scopes"] == ["local", "related", "all"]
    assert contract["query"]["atomicGlobalCut"] is False
    assert contract["query"]["componentObservationTimeRequired"] is True
    assert contract["query"]["traversal"]["directions"] == [
        "forward",
        "backward",
        "both",
    ]
    assert contract["query"]["componentEnvelope"]["profileActivationAllowed"] is False
    assert contract["query"]["aggregate"]["falseZeroMeansUnknown"] is True
    assert contract["query"]["strictMode"]["nonzeroWhenProofInvalid"] is True
    assert contract["query"]["dogfoodGate"]["phases"] == [
        "kickoff",
        "stage-ready",
        "closeout",
    ]
    assert contract["catalog"]["filesystemScan"] is False
    assert contract["catalog"]["maintenanceDryRunDefault"] is True
    assert contract["query"]["globalWorkProjection"]["humanAndJsonShareProjection"]


def test_human_projection_is_stable_at_realistic_scale_and_narrow_width():
    rows = [
        {
            "object_kind": "assignment",
            "display": {
                "title": f"Work item {index:02d} with a deliberately descriptive title",
                "portfolio_state": "open" if index % 3 else "awaiting-review",
            },
            "conflict": index == 17,
            "replica_count": 1 if index in {4, 21} else 0,
            "canonical_root": f"sha256:{index + 1:064x}",
        }
        for index in range(35)
    ]

    snapshot = [_human_work_line(row, 60) for row in rows]

    assert len(snapshot) == 35
    assert all(len(line) <= 60 for line in snapshot)
    assert len(set(snapshot)) == 35
    assert any("!conflict" in line for line in snapshot)
    assert sum(" x2 " in line for line in snapshot) == 2


def test_human_assignment_projection_keeps_phase_and_source_status_separate():
    row = {
        "object_kind": "assignment",
        "display": {
            "title": "Ready for independent review",
            "portfolio_state": "awaiting-review",
            "orchestration_phase": "stage-ready",
            "source_status": "active",
        },
        "conflict": False,
        "replica_count": 0,
        "canonical_root": ROOT_A,
    }

    rendered = _human_work_line(row, 100)

    assert "awaiting-review" in rendered
    assert "phase=stage-ready" in rendered
    assert "src=active" in rendered


def test_work_ref_requires_qualified_workspace_and_contains_no_locator(tmp_path):
    root = tmp_path / "candidate"
    root.mkdir()
    candidate = inspect_workspace(str(root), env={"HOME": str(tmp_path)})
    assert candidate is not None

    with pytest.raises(ValueError, match="qualified owning workspace"):
        _ref(candidate, "kungfu:assignment-a")

    identity = _qualified_project(tmp_path, "qualified")
    reference = _ref(identity, "kungfu:assignment-a").as_dict()
    encoded = str(reference)
    assert identity.workspace_root not in encoded
    assert str(tmp_path) not in encoded
    assert reference["workspace_identity_root"] == identity.identity_root


def test_relation_roots_survive_locator_move_and_symmetric_order(tmp_path):
    identity = _qualified_project(tmp_path, "original")
    left = _ref(identity, "kungfu:assignment-a", ROOT_A, ROOT_C)
    right = _ref(identity, "kungfu:assignment-b", ROOT_B, ROOT_C)
    forward = build_relation("related-to", left, right)
    reverse = build_relation("related-to", right, left)
    assert forward["relation_root"] == reverse["relation_root"]

    moved = tmp_path / "moved"
    os.rename(identity.workspace_root, moved)
    relocated = inspect_workspace(str(moved), env={"HOME": str(tmp_path)})
    assert relocated is not None
    rebuilt = build_relation(
        "related-to",
        _ref(relocated, "kungfu:assignment-a", ROOT_A, ROOT_C),
        _ref(relocated, "kungfu:assignment-b", ROOT_B, ROOT_C),
    )
    assert rebuilt["relation_root"] == forward["relation_root"]


def test_relation_specific_cycle_qualification(tmp_path):
    identity = _qualified_project(tmp_path, "repo")
    a = _ref(identity, "kungfu:a", ROOT_A, ROOT_D)
    b = _ref(identity, "kungfu:b", ROOT_B, ROOT_D)
    c = _ref(identity, "kungfu:c", ROOT_C, ROOT_D)

    cyclic_dependency = [
        build_relation("depends-on", a, b),
        build_relation("depends-on", b, c),
        build_relation("depends-on", c, a),
    ]
    failed = qualify_assignment_graph(cyclic_dependency)
    assert failed["ok"] is False
    assert failed["issues"][0]["code"] == "relation-cycle"
    assert failed["issues"][0]["relation_type"] == "depends-on"

    related_cycle = [
        build_relation("related-to", a, b),
        build_relation("related-to", b, c),
        build_relation("related-to", c, a),
    ]
    passed = qualify_assignment_graph(related_cycle)
    assert passed["ok"] is True
    assert RELATION_TYPES["related-to"]["acyclic"] is False


def test_all_query_preserves_unavailable_catalog_entry_without_home_write(tmp_path):
    config_home = tmp_path / "config"
    identity = _qualified_project(tmp_path, "repo")
    select_workspace(
        identity,
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )
    unavailable = tmp_path / "unavailable"
    os.rename(identity.workspace_root, unavailable)
    home = inspect_workspace(home=True, env={"HOME": str(tmp_path)})
    assert home is not None
    home_data = tmp_path / ".kungfu"
    assert not home_data.exists()

    result = query_federation(
        home,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )

    assert result["atomic_global_cut"] is False
    assert result["writes"] == []
    assert all(row["observed_at"] for row in result["components"])
    assert all(row["observed_at"] for row in result["proof"]["component_cuts"])
    unavailable_rows = [
        row for row in result["components"] if row["availability"] == "unavailable"
    ]
    assert len(unavailable_rows) == 1
    assert unavailable_rows[0]["workspace"]["identity_root"] == identity.identity_root
    assert all(row["workspace"]["identity_root"] for row in result["components"])
    assert result["aggregate"]["state"] == "partial"
    assert result["aggregate"]["known_assignment_count"] == 0
    assert result["aggregate"]["false_zero_guard"] == "unknown-not-empty"
    assert not home_data.exists()


def test_root_bound_components_keep_distinct_profile_and_runtime_envelopes(tmp_path):
    config_home = tmp_path / "config"
    identities = [
        _qualified_project(tmp_path, name) for name in ("one", "two", "three")
    ]
    for identity in identities:
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    profile_roots = {
        identity.identity_root: f"sha256:{index:064x}"
        for index, identity in enumerate(identities, start=1)
    }

    def loader(identity):
        profile_root = profile_roots.get(identity.identity_root, ROOT_B)
        return {
            "availability": "available",
            "stale": False,
            "cut_root": ROOT_D,
            "query_proof_root": ROOT_D,
            "initiatives": [],
            "assignments": [],
            "relations": [],
            "problems": [],
            "profile_root": profile_root,
            "reader_runtime": {
                "schema": "kungfu.workspace-federation.reader-runtime/v1",
                "runtime_root": ROOT_C,
                "version": "4.0.0-controller",
            },
            "workspace_runtime": {
                "schema": "kungfu.workspace-federation.workspace-runtime/v1",
                "state": "identified",
                "runtime_root": profile_root,
                "version": f"4.0.0-workspace-{profile_root[-1]}",
            },
            "compatibility": {
                "state": "compatible",
                "protocol": "kungfu.fact-material-read/v1",
                "reason": "fixture",
            },
        }

    result = query_federation(
        identities[0],
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    assert len(result["components"]) == 4  # three projects plus logical Home
    project_components = [
        row
        for row in result["components"]
        if row["workspace"]["workspace_kind"] == "project"
    ]
    assert {row["envelope"]["profile_root"] for row in project_components} == set(
        profile_roots.values()
    )
    assert result["verification"]["ok"] is True
    assert result["aggregate"]["state"] == "complete"
    assert (
        len(
            {
                row["envelope"]["workspace_runtime"]["version"]
                for row in project_components
            }
        )
        == 3
    )


def test_incremental_query_reloads_only_changed_component(tmp_path):
    config_home = tmp_path / "config"
    identities = [_qualified_project(tmp_path, name) for name in ("one", "two")]
    for identity in identities:
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    initial = query_federation(
        identities[0],
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=lambda identity: _component_fixture(identity, {}),
    )
    cached = {row["workspace"]["identity_root"]: row for row in initial["components"]}
    unchanged_root = identities[0].identity_root
    changed_root = identities[1].identity_root
    unchanged_envelope = cached[unchanged_root]["envelope"]["envelope_root"]
    loaded = []

    def changed_loader(identity):
        loaded.append(identity.identity_root)
        return _component_fixture(identity, {})

    refreshed = query_federation(
        identities[0],
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=changed_loader,
        component_cache=cached,
        refresh_identity_roots={changed_root},
        max_workers=4,
    )

    assert loaded == [changed_root]
    refreshed_by_root = {
        row["workspace"]["identity_root"]: row for row in refreshed["components"]
    }
    assert (
        refreshed_by_root[unchanged_root]["envelope"]["envelope_root"]
        == unchanged_envelope
    )
    assert refreshed["verification"]["ok"] is True


def test_append_journal_signal_is_workspace_scoped_and_monotonic(tmp_path):
    runtime = tmp_path / "runtime"
    journal = (
        runtime
        / "journal"
        / "system"
        / "storage"
        / "episode-manifest"
        / "live"
        / "00000000.1.journal"
    )
    journal.parent.mkdir(parents=True)
    journal.write_bytes(b"before")
    before = _runtime_signal(str(runtime))
    journal.write_bytes(b"before-after")

    assert before
    assert _runtime_signal(str(runtime)) != before
    assert _runtime_signal(str(tmp_path / "other-runtime")) == ""


def test_false_zero_regression_preserves_31_unavailable_components(tmp_path):
    config_home = tmp_path / "config"
    home = inspect_workspace(home=True, env={"HOME": str(tmp_path)})
    assert home is not None
    catalog_path = config_home / "workspaces" / "catalog.json"
    catalog_path.parent.mkdir(parents=True)
    catalog_path.write_text(
        json.dumps(
            {
                "schema": "kungfu.workspace.locator-catalog/v1",
                "entries": [
                    {
                        "schema": "kungfu.workspace.locator-entry/v1",
                        "workspace_id": f"project:missing-{index}",
                        "identity_root": f"sha256:{index + 1:064x}",
                        "identity_state": "qualified",
                        "workspace_kind": "project",
                        "locator": str(tmp_path / f"missing-{index}"),
                        "data_home": str(tmp_path / f"missing-{index}" / ".kungfu"),
                        "observed_at": "2026-07-24T00:00:00Z",
                    }
                    for index in range(31)
                ],
                "updated_at": "2026-07-24T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )

    result = query_federation(
        home,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )

    assert result["aggregate"]["known_assignment_count"] == 0
    assert result["aggregate"]["unavailable_component_count"] == 31
    assert result["aggregate"]["false_zero_guard"] == "unknown-not-empty"
    assert result["aggregate"]["complete"] is False


def test_global_projection_folds_only_root_proven_replicas(tmp_path):
    config_home = tmp_path / "config"
    left = _qualified_project(tmp_path, "replica-left")
    right = _qualified_project(tmp_path, "replica-right")
    for identity in (left, right):
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    assignments = {
        left.identity_root: [
            {
                "title": "Shared delivery",
                "status": "active",
                "work_ref": _ref(left, "kungfu:shared", ROOT_A, ROOT_D).as_dict(),
            }
        ],
        right.identity_root: [
            {
                "title": "Shared delivery",
                "status": "active",
                "work_ref": _ref(right, "kungfu:shared", ROOT_A, ROOT_D).as_dict(),
            }
        ],
    }

    result = query_federation(
        left,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=lambda identity: _component_fixture(identity, assignments),
        max_workers=2,
    )

    rows = result["global_work"]["canonical_work"]
    assert len(rows) == 1
    assert rows[0]["equivalence"]["state"] == "proven-replica"
    assert rows[0]["replica_count"] == 1
    assert len(rows[0]["authority_roots"]) == 2
    assert result["aggregate"]["canonical_work_count"] == 1
    assert result["aggregate"]["work_observation_count"] == 2
    assert result["aggregate"]["replica_count"] == 1


def test_same_label_divergent_roots_remain_distinct_without_unsafe_collapse(tmp_path):
    config_home = tmp_path / "config"
    left = _qualified_project(tmp_path, "conflict-left")
    right = _qualified_project(tmp_path, "conflict-right")
    for identity in (left, right):
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    assignments = {
        left.identity_root: [
            {
                "title": "Same label",
                "work_ref": _ref(left, "kungfu:same", ROOT_A, ROOT_D).as_dict(),
            }
        ],
        right.identity_root: [
            {
                "title": "Same label",
                "work_ref": _ref(right, "kungfu:same", ROOT_B, ROOT_D).as_dict(),
            }
        ],
    }

    result = query_federation(
        left,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=lambda identity: _component_fixture(identity, assignments),
    )

    assert result["aggregate"]["canonical_work_count"] == 2
    assert result["aggregate"]["conflict_count"] == 0
    assert result["aggregate"]["label_collision_count"] == 1
    assert not any(row["conflict"] for row in result["global_work"]["canonical_work"])
    collision = result["global_work"]["label_collisions"][0]
    assert collision["state"] == "authority-distinct"
    assert len(collision["canonical_roots"]) == 2


def test_initiative_group_preserves_authority_distinct_canonical_roots(tmp_path):
    config_home = tmp_path / "config"
    left = _qualified_project(tmp_path, "initiative-left")
    right = _qualified_project(tmp_path, "initiative-right")
    for identity in (left, right):
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )

    def loader(identity):
        component = _component_fixture(identity, {})
        version_root = ROOT_A if identity == left else ROOT_B
        component["initiatives"] = [
            {
                "title": "Technical stewardship",
                "status": "active",
                "lifecycle": {
                    "portfolio_state": "open",
                    "orchestration_phase": "executing",
                },
                "work_ref": build_work_ref(
                    identity,
                    object_kind="initiative",
                    subject="kungfu:technical-stewardship",
                    version_root=version_root,
                    cut_root=ROOT_D,
                ).as_dict(),
            }
        ]
        return component

    result = query_federation(
        left,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    projection = result["global_work"]
    assert len(projection["initiative_groups"]) == 1
    group = projection["initiative_groups"][0]
    raw_roots = sorted(
        row["canonical_root"]
        for row in projection["canonical_work"]
        if row["object_kind"] == "initiative"
    )
    assert group["authority_state"] == "authority-distinct"
    assert group["canonical_roots"] == raw_roots
    expected_authority_roots = sorted(
        {
            root
            for row in projection["canonical_work"]
            if row["object_kind"] == "initiative"
            for root in row["authority_roots"]
        }
    )
    assert group["authority_roots"] == expected_authority_roots
    assert {left.identity_root, right.identity_root}.issubset(group["authority_roots"])
    assert projection["visible_initiative_groups"] == [group]
    rendered = _human_initiative_group_line(group, 100)
    assert "authority-distinct" in rendered
    assert f"authorities={len(expected_authority_roots)}" in rendered


@pytest.mark.parametrize("terminal_status", ["complete", "merged"])
def test_default_portfolio_filter_normalizes_legacy_terminal_statuses(
    tmp_path, terminal_status
):
    identity = _qualified_project(tmp_path, terminal_status)
    assignments = {
        identity.identity_root: [
            {
                "title": f"Legacy {terminal_status}",
                "status": terminal_status,
                "updated_at": "2026-07-29T12:34:56Z",
                "lifecycle": {
                    "portfolio_state": "open",
                    "orchestration_phase": "stage-ready",
                },
                "work_ref": _ref(
                    identity, f"kungfu:legacy-{terminal_status}"
                ).as_dict(),
            }
        ]
    }

    default = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=lambda current: _component_fixture(current, assignments),
    )
    settled = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=lambda current: _component_fixture(current, assignments),
        include_settled=True,
    )

    assert default["global_work"]["visible_work"] == []
    assert len(settled["global_work"]["visible_work"]) == 1
    display = settled["global_work"]["visible_work"][0]["display"]
    assert display["source_status"] == terminal_status
    assert display["orchestration_phase"] == "stage-ready"
    assert display["portfolio_state"] == "open"
    assert display["updated_at"] == "2026-07-29T12:34:56Z"


def test_same_authority_divergent_versions_are_a_strict_conflict(tmp_path):
    identity = _qualified_project(tmp_path, "authority-conflict")
    assignments = {
        identity.identity_root: [
            {
                "title": "Version A",
                "work_ref": _ref(identity, "kungfu:conflict", ROOT_A, ROOT_D).as_dict(),
            },
            {
                "title": "Version B",
                "work_ref": _ref(identity, "kungfu:conflict", ROOT_B, ROOT_D).as_dict(),
            },
        ]
    }

    result = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=lambda current: _component_fixture(current, assignments),
    )

    assert result["aggregate"]["conflict_count"] == 1
    assert result["aggregate"]["complete"] is False
    assert result["global_work"]["canonical_work"][0]["conflict_reasons"] == [
        "same-authority-divergent-version"
    ]


def test_ambiguous_legacy_dependency_has_distinct_fail_closed_reason(tmp_path):
    source = _qualified_project(tmp_path, "ambiguous-source")
    left = _qualified_project(tmp_path, "ambiguous-left")
    right = _qualified_project(tmp_path, "ambiguous-right")
    config_home = tmp_path / "config"
    for identity in (source, left, right):
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    assignments = {
        source.identity_root: [
            {
                "title": "Source",
                "work_ref": _ref(source, "kungfu:source", ROOT_C, ROOT_D).as_dict(),
            }
        ],
        left.identity_root: [
            {
                "title": "Target A",
                "work_ref": _ref(left, "kungfu:target", ROOT_A, ROOT_D).as_dict(),
            }
        ],
        right.identity_root: [
            {
                "title": "Target B",
                "work_ref": _ref(right, "kungfu:target", ROOT_B, ROOT_D).as_dict(),
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

    unresolved = result["global_work"]["reference_resolution"]["unresolved"]
    assert unresolved[0]["code"] == "ambiguous-reference"
    assert len(unresolved[0]["candidate_canonical_roots"]) == 2
    assert result["aggregate"]["complete"] is False


def test_stale_required_component_fails_strict_completeness(tmp_path):
    identity = _qualified_project(tmp_path, "stale-required")

    def loader(current):
        component = _component_fixture(current, {})
        component["stale"] = True
        return component

    result = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    assert result["aggregate"]["stale_component_count"] == 1
    assert result["aggregate"]["unknown_component_count"] == 1
    assert result["aggregate"]["complete"] is False


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


def test_query_verifier_rejects_replayed_or_tampered_component_envelope(tmp_path):
    identity = _qualified_project(tmp_path, "verified")
    result = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
    )
    assert result["verification"]["ok"] is True
    result["components"][0]["envelope"]["workspace_identity_root"] = ROOT_A

    verification = verify_federation_query(result)

    assert verification["ok"] is False
    assert {row["code"] for row in verification["issues"]} == {
        "component-envelope-root",
        "component-workspace-root-mismatch",
    }


@pytest.mark.parametrize("phase", ["kickoff", "stage-ready", "closeout"])
def test_dogfood_gate_receipts_bind_controller_and_component_proofs(tmp_path, phase):
    identity = _qualified_project(tmp_path, phase)
    query = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
    )
    controller = {
        "schema": "kungfu.product-dogfood-residency/v1",
        "state": "qualified",
        "sourceCommit": "1" * 40,
        "productManifestDigest": ROOT_B.removeprefix("sha256:"),
        "controllerProfileRoots": [ROOT_A],
        "qualification": {
            "qualified": True,
            "identityMatches": True,
            "artifactMatchesRuntime": True,
            "promotionMatches": True,
            "rollbackAvailable": True,
        },
        "rollback": {"available": True, "artifactId": "prior-build"},
        "writes": [],
    }

    receipt = build_dogfood_gate_receipt(query, controller, phase)

    assert receipt["phase"] == phase
    assert receipt["controller_identity_root"].startswith("sha256:")
    assert receipt["query_proof_root"] == query["proof"]["proof_root"]
    assert (
        receipt["components"][0]["component_envelope_root"]
        == (query["components"][0]["envelope"]["envelope_root"])
    )
    assert receipt["coverage"] == query["aggregate"]
    assert receipt["verification"]["ok"] is True
    assert receipt["writes"] == []


def test_dogfood_gate_verifier_rejects_replayed_component_proof(tmp_path):
    identity = _qualified_project(tmp_path, "gate-replay")
    query = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
    )
    receipt = build_dogfood_gate_receipt(
        query,
        {
            "schema": "kungfu.product-dogfood-residency/v1",
            "state": "qualified",
            "productManifestDigest": ROOT_B.removeprefix("sha256:"),
            "qualification": {
                "qualified": True,
                "identityMatches": True,
                "artifactMatchesRuntime": True,
                "promotionMatches": True,
                "rollbackAvailable": True,
            },
            "rollback": {"available": True, "artifactId": "prior-build"},
        },
        "closeout",
    )
    receipt["components"][0]["component_envelope_root"] = ROOT_A

    verification = verify_dogfood_gate_receipt(receipt, query)

    assert verification["ok"] is False
    assert {row["code"] for row in verification["issues"]} == {
        "gate-receipt-root",
        "gate-component-envelope-mismatch",
    }


def test_query_verifier_rejects_result_root_and_runtime_identity_mismatch(tmp_path):
    identity = _qualified_project(tmp_path, "result-mismatch")
    result = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
    )
    result["components"][0]["assignments"].append({"unexpected": "replayed"})
    result["components"][0]["envelope"]["reader_runtime"]["runtime_root"] = "unknown"

    verification = verify_federation_query(result)

    codes = {row["code"] for row in verification["issues"]}
    assert "component-envelope-root" in codes
    assert "component-result-root-mismatch" in codes
    assert "component-reader-runtime-root-untrusted" in codes


def test_query_verifier_rejects_component_proof_replay(tmp_path):
    identity = _qualified_project(tmp_path, "proof-replay")
    result = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
    )
    result["proof"]["component_cuts"][0]["component_envelope_root"] = ROOT_A

    verification = verify_federation_query(result)

    assert {row["code"] for row in verification["issues"]} == {
        "query-proof-component-mismatch"
    }


@pytest.mark.parametrize(
    ("message", "code"),
    [
        ("pinned runtime is missing", "component-query-failed"),
        ("component query timed out", "component-query-failed"),
    ],
)
def test_component_runtime_failures_remain_degraded_not_empty(tmp_path, message, code):
    identity = _qualified_project(tmp_path, message.replace(" ", "-"))

    def loader(_identity):
        raise RuntimeError(message)

    result = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    assert result["components"][0]["availability"] == "degraded"
    assert result["components"][0]["problems"][0]["code"] == code
    assert result["aggregate"]["complete"] is False
    assert result["aggregate"]["false_zero_guard"] == "unknown-not-empty"


def test_incompatible_component_protocol_fails_proof_verification(tmp_path):
    identity = _qualified_project(tmp_path, "incompatible")

    def loader(_identity):
        return {
            "availability": "available",
            "stale": False,
            "cut_root": ROOT_A,
            "query_proof_root": ROOT_B,
            "initiatives": [],
            "assignments": [],
            "relations": [],
            "problems": [],
            "profile_root": ROOT_C,
            "reader_runtime": {"runtime_root": ROOT_A},
            "workspace_runtime": {"runtime_root": ROOT_B},
            "compatibility": {
                "state": "incompatible",
                "protocol": "kungfu.fact-material-read/v0",
            },
        }

    result = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    assert result["verification"]["ok"] is False
    assert {row["code"] for row in result["verification"]["issues"]} == {
        "component-runtime-incompatible"
    }
    assert result["aggregate"]["complete"] is False


def test_restart_and_concurrent_queries_keep_result_proofs_verifiable(tmp_path):
    identity = _qualified_project(tmp_path, "concurrent")

    def query():
        return query_federation(
            identity,
            scope="local",
            config_home=str(tmp_path / "config"),
            env={"HOME": str(tmp_path)},
        )

    before_restart = query()
    after_restart = query()
    with ThreadPoolExecutor(max_workers=4) as pool:
        concurrent = list(pool.map(lambda _: query(), range(8)))

    results = [before_restart, after_restart, *concurrent]
    assert all(result["verification"]["ok"] for result in results)
    assert (
        len(
            {
                result["components"][0]["envelope"]["component_result_root"]
                for result in results
            }
        )
        == 1
    )


def test_related_query_resolves_catalog_workspace_from_typed_edge(tmp_path):
    config_home = tmp_path / "config"
    left_identity = _qualified_project(tmp_path, "left")
    right_identity = _qualified_project(tmp_path, "right")
    observe_workspace_locator(
        left_identity,
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )
    observe_workspace_locator(
        right_identity,
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )
    edge = build_relation(
        "contributes-to",
        _ref(left_identity, "kungfu:left", ROOT_A, ROOT_D),
        _ref(right_identity, "kungfu:right", ROOT_B, ROOT_D),
    )

    def loader(identity):
        return {
            "availability": "available",
            "stale": False,
            "cut_root": ROOT_D,
            "query_proof_root": ROOT_C,
            "initiatives": [],
            "assignments": [
                {
                    "title": "Left" if identity == left_identity else "Right",
                    "work_ref": (
                        _ref(left_identity, "kungfu:left", ROOT_A, ROOT_D)
                        if identity == left_identity
                        else _ref(right_identity, "kungfu:right", ROOT_B, ROOT_D)
                    ).as_dict(),
                }
            ],
            "relations": (
                [edge] if identity.identity_root == left_identity.identity_root else []
            ),
            "problems": [],
        }

    result = query_federation(
        left_identity,
        scope="related",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    roots = {row["workspace"]["identity_root"] for row in result["components"]}
    assert roots == {left_identity.identity_root, right_identity.identity_root}
    assert result["proof"]["unresolved_references"] == []


def test_assignment_graph_traversal_is_typed_bidirectional_and_read_only(tmp_path):
    identity = _qualified_project(tmp_path, "graph")
    a = _ref(identity, "kungfu:a", ROOT_A, ROOT_D)
    b = _ref(identity, "kungfu:b", ROOT_B, ROOT_D)
    c = _ref(identity, "kungfu:c", ROOT_C, ROOT_D)
    relations = [
        build_relation("delegates-to", a, b),
        build_relation("depends-on", b, c),
        build_relation("related-to", a, c),
    ]
    components = [{"relations": relations}]

    forward = traverse_assignment_graph(
        components,
        a,
        direction="forward",
        relation_types=["delegates-to", "depends-on"],
    )
    assert [row["subject"] for row in forward["nodes"]] == [
        "kungfu:a",
        "kungfu:b",
        "kungfu:c",
    ]
    assert len(forward["relation_roots"]) == 2
    assert forward["writes"] == []

    backward = traverse_assignment_graph(
        components,
        c,
        direction="backward",
        relation_types=["delegates-to", "depends-on"],
    )
    assert {row["subject"] for row in backward["nodes"]} == {
        "kungfu:a",
        "kungfu:b",
        "kungfu:c",
    }


@pytest.mark.parametrize(
    ("record_status", "claims", "reviews", "accepted", "settled", "expected"),
    [
        ("active", 0, 0, False, False, "open"),
        ("active", 1, 0, False, False, "awaiting-review"),
        ("active", 1, 1, False, False, "awaiting-decision"),
        ("active", 1, 1, True, False, "awaiting-settlement"),
        ("active", 1, 1, True, True, "completed"),
        ("blocked", 1, 1, True, True, "blocked"),
    ],
)
def test_portfolio_state_keeps_review_settlement_and_completion_distinct(
    record_status,
    claims,
    reviews,
    accepted,
    settled,
    expected,
):
    assert (
        portfolio_state(
            {"status": record_status},
            {
                "completion_claim_count": claims,
                "independent_review_count": reviews,
            },
            accepted=accepted,
            settlement_satisfied=settled,
        )
        == expected
    )


def test_global_completion_requires_project_cut_root_and_settlement_receipt():
    status = {
        "phase": "continuation-decided",
        "completion_claim_count": 1,
        "independent_review_count": 1,
        "continuation_decision_count": 1,
        "continuation_decisions": [{"action": "approve"}],
        "query_proof_root": ROOT_A,
    }
    pending = assignment_lifecycle_projection(
        {"status": "active"},
        {
            **status,
            "completion_claims": [{"project_cut_root": ROOT_B}],
        },
    )
    assert pending["portfolio_state"] == "awaiting-settlement"
    assert pending["project_cut_settlement"] == "pending-receipt"
    assert pending["globally_completed"] is False

    settled = assignment_lifecycle_projection(
        {"status": "active"},
        {
            **status,
            "completion_claims": [
                {
                    "project_cut_root": ROOT_B,
                    "project_cut_receipt_root": ROOT_C,
                }
            ],
        },
    )
    assert settled["portfolio_state"] == "completed"
    assert settled["project_cut_settlement"] == "satisfied"
    assert settled["globally_completed"] is True


def _retained_state(marker, assignment="kungfu:assignment-a"):
    return {
        "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
        "assignment_subject": assignment,
        "workspace_identity_root": ROOT_A,
        "state_root": "sha256:" + marker * 64,
        "query_proof_root": ROOT_B,
        "phase": "continuation-decided",
        "settled": True,
        "storage_kind": "git-common-dir",
    }


def _outcome_binding(state, marker, complete):
    return {
        "schema": "kungfu.assignment-orchestration.work-design-outcome-binding/v1",
        "assignment_subject": state["assignment_subject"],
        "workspace_identity_root": state["workspace_identity_root"],
        "settled_state_root": state["state_root"],
        "state_query_proof_root": state["query_proof_root"],
        "opening_estimate_root": None,
        "published_at": "2026-08-01T01:00:00Z",
        "outcome": {
            "outcomeRoot": "sha256:" + marker * 64,
            "coverage": {
                "complete": complete,
                "coverageRoot": ROOT_C,
            },
            "cohort": {"cohortRoot": ROOT_D},
            "evidence": {"settledStateRoot": state["state_root"]},
        },
        "binding_root": "sha256:" + marker * 64,
    }


def test_global_outcome_history_deduplicates_replicas_and_keeps_unknown_explicit():
    complete_state = _retained_state("1", "kungfu:assignment-complete")
    partial_state = _retained_state("2", "kungfu:assignment-partial")
    unknown_state = _retained_state("3", "kungfu:assignment-legacy")
    complete = _outcome_binding(complete_state, "4", True)
    partial = _outcome_binding(partial_state, "5", False)
    components = [
        {
            "workspace": {"identity_root": ROOT_A},
            "retained_assignment_states": [
                complete_state,
                partial_state,
                unknown_state,
            ],
            "unqualified_retained_assignment_states": [{"state_root": ROOT_D}],
            "retained_outcome_bindings": [complete, partial],
        },
        {
            "workspace": {"identity_root": ROOT_A},
            "retained_assignment_states": [complete_state],
            "retained_outcome_bindings": [complete],
        },
    ]

    projection = federation._compose_global_work(components, include_settled=True)
    history = projection["outcome_history"]

    assert len(history["bindings"]) == 2
    assert history["coverage"] == {
        "unique_settled_state_count": 3,
        "unique_assignment_count": 3,
        "complete": 1,
        "partial": 1,
        "sealed_only_unknown": 1,
        "unqualified_state_count": 1,
    }
    assert history["writes"] == 0
    assert projection["complete_outcome_count"] == 1


def test_global_outcome_history_reports_zero_coverage_without_guessing_legacy_time():
    state = _retained_state("6", "kungfu:assignment-sealed-only")
    projection = federation._compose_global_work(
        [{"retained_assignment_states": [state]}], include_settled=True
    )

    assert projection["outcome_history"]["bindings"] == []
    assert projection["outcome_history"]["coverage"] == {
        "unique_settled_state_count": 1,
        "unique_assignment_count": 1,
        "complete": 0,
        "partial": 0,
        "sealed_only_unknown": 1,
        "unqualified_state_count": 0,
    }


def test_global_outcome_history_rejects_distinct_binding_roots_for_one_state():
    state = _retained_state("7", "kungfu:assignment-conflict")
    first = _outcome_binding(state, "8", True)
    second = {**first, "binding_root": "sha256:" + "9" * 64}
    projection = federation._compose_global_work(
        [
            {
                "retained_assignment_states": [state],
                "retained_outcome_bindings": [first],
            },
            {
                "retained_assignment_states": [state],
                "retained_outcome_bindings": [second],
            },
        ],
        include_settled=True,
    )

    history = projection["outcome_history"]
    assert history["bindings"] == []
    assert history["coverage"]["sealed_only_unknown"] == 1
    assert history["issues"][0]["code"] == "conflicting-replica-outcome-bindings"
