# SPDX-License-Identifier: Apache-2.0
"""Public contract, projection, and relation identity cases."""
# ruff: noqa: F401,F403

from _workspace_federation_support import *
from _workspace_federation_support import (
    _bind_work_control_profile,
    _component_fixture,
    _human_initiative_group_line,
    _human_work_line,
    _qualified_project,
    _ref,
)


def test_workspace_cli_responsibility_modules_are_bounded():
    workspace_path = Path(workspace_command_module.__file__).resolve()
    budgets = {
        workspace_path: 950,
        workspace_path.parent / "_workspace" / "admission.py": 160,
        workspace_path.parent / "_workspace" / "presentation.py": 60,
    }
    for source, maximum in budgets.items():
        assert len(source.read_text(encoding="utf-8").splitlines()) <= maximum


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
