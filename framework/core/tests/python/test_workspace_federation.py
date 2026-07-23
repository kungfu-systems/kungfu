# SPDX-License-Identifier: Apache-2.0

import os
import json
from pathlib import Path

import pytest

from kungfu.workspace import (
    ensure_workspace_data_home,
    inspect_workspace,
    observe_workspace_locator,
    select_workspace,
)
from kungfu.workspace_federation import (
    RELATION_TYPES,
    assignment_lifecycle_projection,
    build_relation,
    build_work_ref,
    qualify_assignment_graph,
    query_federation,
    traverse_assignment_graph,
    portfolio_state,
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
    assert contract["catalog"]["filesystemScan"] is False


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
    assert not home_data.exists()


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
            "assignments": [],
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
