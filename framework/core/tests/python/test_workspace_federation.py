# SPDX-License-Identifier: Apache-2.0

import os
import json
from concurrent.futures import ThreadPoolExecutor
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
    assert contract["query"]["componentEnvelope"]["profileActivationAllowed"] is False
    assert contract["query"]["aggregate"]["falseZeroMeansUnknown"] is True
    assert contract["query"]["strictMode"]["nonzeroWhenProofInvalid"] is True
    assert contract["query"]["dogfoodGate"]["phases"] == [
        "kickoff",
        "stage-ready",
        "closeout",
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
