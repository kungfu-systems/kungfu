# SPDX-License-Identifier: Apache-2.0

import pytest

from kungfu import assignment_orchestration, work_authority
from kungfu.initiative_family import canonical as assignment_canonical


def _sha256(marker):
    return "sha256:" + marker * 64


def test_continuation_decision_is_the_rooted_single_next_action_projection():
    status = {
        "initiative_id": "initiative-a",
        "assignment_id": "assignment-a",
        "phase": "stage-ready",
        "active_lease": {"lease_id": "lease-a"},
        "assignment": {"assignment_id": "assignment-a"},
        "completion_claim_count": 0,
        "work_semantics": {
            "current_input_snapshot": {"record_root": _sha256("a")},
            "completion_eligible": True,
            "next_actions": [{"action": "claim-completion"}],
        },
    }

    decision = work_authority.continuation_decision(
        status, assignment_orchestration.next_actions(status)
    )

    assert decision["schema"] == "kungfu.work.continuation-decision/v1"
    assert decision["nextAction"] == assignment_orchestration.next_actions(status)[0]
    assert decision["decisionRoot"] == assignment_canonical.semantic_root(
        {key: value for key, value in decision.items() if key != "decisionRoot"}
    )


def test_continuation_decision_rejects_multiple_semantic_actions(monkeypatch):
    monkeypatch.setattr(
        assignment_orchestration._NextActionProjection,
        "project",
        lambda _status: [{"action": "one"}, {"action": "two"}],
    )

    with pytest.raises(ValueError, match="more than one semantic next action"):
        work_authority.continuation_decision(
            {}, assignment_orchestration.next_actions({})
        )
