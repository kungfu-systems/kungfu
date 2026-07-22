#  SPDX-License-Identifier: Apache-2.0

from kungfu.work_facade import inspect_work, recover_work


def cut(status="current", confidence="high", gaps=None):
    return {
        "status": status,
        "confidence": confidence,
        "current": {"cutRoot": f"sha256:{'a' * 64}"},
        "gaps": gaps or [],
        "authority": "git-tracked-project-cut",
    }


def work(work_id, status, updated=1):
    return {"work_id": work_id, "status": status, "updated_time": updated}


def test_simple_session_selects_exactly_one_open_work():
    projection = inspect_work(cut(), {"w1": work("w1", "active")})
    assert projection["status"] == "active"
    assert projection["work"]["work_id"] == "w1"
    assert projection["nextActions"] == ["checkpoint", "complete"]
    assert projection["authority"]["projection"] == "non-authoritative"


def test_multiple_open_work_items_fail_visible():
    projection = inspect_work(
        cut(), {"w1": work("w1", "active"), "w2": work("w2", "waiting", 2)}
    )
    assert projection["status"] == "ambiguous"
    assert projection["work"] is None
    assert "multiple-open-work-items" in projection["gaps"]
    assert recover_work(projection)["action"] == "select-work"


def test_ready_work_requires_completion_evidence_before_settlement():
    projection = inspect_work(cut(), {"w1": work("w1", "ready")})
    plan = recover_work(projection)
    assert projection["status"] == "completion-pending"
    assert plan["code"] == "completion-evidence-required"
    assert plan["action"] == "complete"
    assert plan["writeOccurred"] is False


def test_thin_cut_recovery_precedes_work_resume():
    projection = inspect_work(
        cut("thin", "medium", ["receipt-missing"]),
        {"w1": work("w1", "waiting")},
    )
    plan = recover_work(projection)
    assert plan["code"] == "project-cut-thin"
    assert plan["action"] == "recover-project-cut"
