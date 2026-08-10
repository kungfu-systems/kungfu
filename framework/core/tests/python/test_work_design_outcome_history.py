# SPDX-License-Identifier: Apache-2.0

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
