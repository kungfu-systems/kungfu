# SPDX-License-Identifier: Apache-2.0

import inspect
import pickle

import pytest

from kungfu import assignment_orchestration
from kungfu.initiative_family import canonical as assignment_canonical


def _sha256(marker):
    return "sha256:" + marker * 64


def _work_design_outcome(state_root, query_root, *, complete=True, marker="a"):
    cohort_body = {
        "deliveryClass": "native-proof-required",
        "workClass": "control-plane",
        "repositoryClass": "kungfu",
    }
    coverage_body = {
        "qualifiedMetrics": (
            ["acceptanceFailure", "dependencyCorrection", "rework", "timeout"]
            if complete
            else ["rework"]
        ),
        "unknownMetrics": (
            [] if complete else ["acceptanceFailure", "dependencyCorrection", "timeout"]
        ),
        "complete": complete,
    }
    body = {
        "schema": assignment_orchestration.OUTCOME_SCHEMA,
        "assignmentId": "assignment-outcome-a",
        "asOf": "2026-08-01T00:30:00Z",
        "bindings": {
            "workDefinitionRoot": _sha256("1"),
            "adviceRoot": _sha256("2"),
            "policyRoot": _sha256("3"),
        },
        "cohort": {
            **cohort_body,
            "cohortRoot": assignment_canonical.semantic_root(cohort_body),
        },
        "window": {
            "admittedAt": "2026-08-01T00:00:00Z",
            "settledAt": "2026-08-01T00:20:00Z",
            "attributableActiveSeconds": 600,
            "excludedWaitSeconds": {
                "ci-queue": 60,
                "external-review": 120,
                "human-decision": 0,
                "platform-approval": 0,
            },
        },
        "metrics": {
            "acceptanceFailure": {
                "status": "qualified" if complete else "unknown",
                "count": 0 if complete else None,
                "assessmentRoots": [],
            },
            "dependencyCorrection": {
                "status": "qualified" if complete else "unknown",
                "count": 0 if complete else None,
                "revisionRoots": [],
            },
            "rework": {"status": "qualified", "count": 1, "eventRoots": []},
            "timeout": {
                "status": "qualified" if complete else "unknown",
                "plannedBudgetSeconds": 900 if complete else None,
                "attributableActiveSeconds": 600 if complete else None,
                "overrunSeconds": 0 if complete else None,
                "exceeded": False if complete else None,
            },
        },
        "coverage": {
            **coverage_body,
            "coverageRoot": assignment_canonical.semantic_root(coverage_body),
        },
        "evidence": {
            "settledStateRoot": state_root,
            "queryProofRoot": query_root,
            "sourceEvidenceRoots": [_sha256(marker)],
        },
        "authority": {
            "mode": "settled-work-observation",
            "factAuthority": False,
            "episodeAuthority": False,
            "assignmentAuthority": False,
            "workControlAuthority": False,
            "policyAuthority": False,
            "mayMutate": False,
        },
    }
    return {**body, "outcomeRoot": assignment_canonical.semantic_root(body)}


def _settled_coordinate(state_root, query_root):
    return {
        "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
        "assignment_subject": "kungfu:assignment-outcome-a",
        "workspace_identity_root": _sha256("4"),
        "state_root": state_root,
        "query_proof_root": query_root,
        "phase": "continuation-decided",
        "settled": True,
        "storage_kind": "git-common-dir",
    }


def test_outcome_facade_keeps_public_call_contract_and_schema_authority():
    assert assignment_orchestration.OUTCOME_SCHEMA == "kungfu.work-design.outcome/v1"
    assert assignment_orchestration.OUTCOME_BINDING_SCHEMA == (
        "kungfu.assignment-orchestration.work-design-outcome-binding/v1"
    )
    assert assignment_orchestration.OUTCOME_INDEX_SCHEMA == (
        "kungfu.assignment-orchestration.work-design-outcome-index/v1"
    )
    assert (
        str(inspect.signature(assignment_orchestration._validate_outcome_artifact))
        == "(value: 'Any') -> 'dict[str, Any]'"
    )
    assert str(inspect.signature(assignment_orchestration.outcome_binding_plan)) == (
        "(workspace_root: 'str | Path', sealed_state: 'Mapping[str, Any]', "
        "outcome: 'Any', *, opening_estimate_root: 'str | None' = None, "
        "published_at: 'str') -> 'dict[str, Any]'"
    )
    assert str(inspect.signature(assignment_orchestration.verify_outcome_binding)) == (
        "(value: 'Any') -> 'dict[str, Any]'"
    )
    assert str(inspect.signature(assignment_orchestration.apply_outcome_binding)) == (
        "(plan: 'Mapping[str, Any]', expected_binding_root: 'str') -> 'dict[str, Any]'"
    )
    assert str(inspect.signature(assignment_orchestration.list_outcome_bindings)) == (
        "(workspace_root: 'str | Path') -> 'dict[str, Any]'"
    )


def test_outcome_facade_keeps_function_identity_docs_and_pickle_contract():
    expected_docs = {
        "_validate_outcome_artifact": None,
        "outcome_binding_plan": (
            "Plan an additive immutable outcome binding beside portable Work seals."
        ),
        "verify_outcome_binding": None,
        "apply_outcome_binding": None,
        "list_outcome_bindings": (
            "Read and fail closed over additive rooted outcome bindings."
        ),
    }
    for name, expected_doc in expected_docs.items():
        function = getattr(assignment_orchestration, name)
        assert inspect.isfunction(function)
        assert function.__name__ == name
        assert function.__qualname__ == name
        assert function.__module__ == "kungfu.assignment_orchestration"
        assert function.__doc__ == expected_doc
        assert pickle.loads(pickle.dumps(function)) is function


def test_outcome_facade_resolves_storage_after_monkeypatch(tmp_path, monkeypatch):
    storage_root = tmp_path / "resolved-late"
    monkeypatch.setattr(
        assignment_orchestration,
        "_sealed_state_storage",
        lambda _root: (storage_root, "late-bound-test"),
    )

    result = assignment_orchestration.list_outcome_bindings(tmp_path)

    assert result["storage_kind"] == "late-bound-test"


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda outcome: outcome["coverage"].update(complete=False),
            "complete contradicts unknown metrics",
        ),
        (
            lambda outcome: outcome["metrics"]["rework"].update(count=-1),
            "rework count is invalid",
        ),
        (
            lambda outcome: outcome["authority"].update(mayMutate=True),
            "authority boundary is invalid",
        ),
        (
            lambda outcome: outcome["window"].update(settledAt="2026-07-31T23:59:59Z"),
            "settledAt precedes admittedAt",
        ),
    ],
)
def test_outcome_validation_remains_fail_closed_at_every_separated_rule(
    mutate, message
):
    outcome = _work_design_outcome(_sha256("5"), _sha256("6"))
    mutate(outcome)
    coverage = outcome["coverage"]
    coverage["coverageRoot"] = assignment_canonical.semantic_root(
        {key: value for key, value in coverage.items() if key != "coverageRoot"}
    )
    outcome["outcomeRoot"] = assignment_canonical.semantic_root(
        {key: value for key, value in outcome.items() if key != "outcomeRoot"}
    )

    with pytest.raises(ValueError, match=message):
        assignment_orchestration._validate_outcome_artifact(outcome)


def test_outcome_binding_is_additive_immutable_and_deduplicated(tmp_path):
    (tmp_path / ".git").mkdir()
    state_root = _sha256("5")
    query_root = _sha256("6")
    plan = assignment_orchestration.outcome_binding_plan(
        tmp_path,
        _settled_coordinate(state_root, query_root),
        _work_design_outcome(state_root, query_root),
        opening_estimate_root=_sha256("7"),
        published_at="2026-08-01T00:40:00Z",
    )
    receipt = assignment_orchestration.apply_outcome_binding(plan, plan["binding_root"])
    repeated = assignment_orchestration.apply_outcome_binding(
        plan, plan["binding_root"]
    )
    index = assignment_orchestration.list_outcome_bindings(tmp_path)

    assert receipt["bindingRoot"] == repeated["bindingRoot"]
    assert len(index["bindings"]) == 1
    assert index["issues"] == []
    assert index["writes"] == []


def test_outcome_binding_fails_closed_on_state_or_root_mismatch(tmp_path):
    state_root = _sha256("5")
    query_root = _sha256("6")
    outcome = _work_design_outcome(state_root, query_root)
    tampered = {**outcome, "asOf": "2026-08-01T00:31:00Z"}
    with pytest.raises(ValueError, match="outcome root mismatch"):
        assignment_orchestration.outcome_binding_plan(
            tmp_path,
            _settled_coordinate(state_root, query_root),
            tampered,
            published_at="2026-08-01T00:40:00Z",
        )
    with pytest.raises(ValueError, match="settled state root mismatch"):
        assignment_orchestration.outcome_binding_plan(
            tmp_path,
            _settled_coordinate(_sha256("8"), query_root),
            outcome,
            published_at="2026-08-01T00:40:00Z",
        )


def test_outcome_binding_rejects_private_payload_fields(tmp_path):
    state_root = _sha256("5")
    query_root = _sha256("6")
    outcome = _work_design_outcome(state_root, query_root)
    outcome["window"]["transcript"] = "private terminal bytes"
    outcome["outcomeRoot"] = assignment_canonical.semantic_root(
        {key: value for key, value in outcome.items() if key != "outcomeRoot"}
    )
    with pytest.raises(ValueError, match="window has an invalid field set"):
        assignment_orchestration.outcome_binding_plan(
            tmp_path,
            _settled_coordinate(state_root, query_root),
            outcome,
            published_at="2026-08-01T00:40:00Z",
        )
