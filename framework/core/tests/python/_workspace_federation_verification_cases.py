# SPDX-License-Identifier: Apache-2.0
"""Proof verification, graph traversal, and global outcome cases."""
# ruff: noqa: F401,F403

from _workspace_federation_support import *
from _workspace_federation_support import (
    _bind_work_control_profile,
    _component_fixture,
    _outcome_binding,
    _qualified_project,
    _ref,
    _retained_state,
)


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
