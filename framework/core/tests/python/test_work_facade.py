#  SPDX-License-Identifier: Apache-2.0

from kungfu.work_facade import (
    READ_ONLY_FACADE_ACTIONS,
    inspect_work,
    plan_completion,
    plan_managed_run_link,
    plan_settlement,
    recover_work,
    work_loop_capabilities,
)


ROOT = f"sha256:{'f' * 64}"


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


def test_managed_run_link_is_idempotent_and_unknown_work_fails_closed():
    items = {"w1": {**work("w1", "active"), "runs": [{"run_id": "r1"}]}}
    assert plan_managed_run_link(items, "w1", "r1")["reused"] is True
    assert plan_managed_run_link(items, "w1", "r2")["code"] == "run-link-required"
    assert plan_managed_run_link(items, "missing", "r2")["ok"] is False


def test_completion_needs_ready_work_and_passing_validation():
    item = {**work("w1", "ready"), "validations": [{"result": "pass"}]}
    projection = inspect_work(cut(), {"w1": item})
    plan = plan_completion(projection, "w1")
    assert plan["status"] == "plan"
    assert plan["requiresIndependentReview"] is True
    assert plan["writeOccurred"] is False


def test_settlement_requires_four_exact_roots_and_never_self_executes():
    plan = plan_settlement(
        "w1",
        claim_root=ROOT,
        review_root=ROOT,
        decision_root=ROOT,
        project_cut_root=ROOT,
    )
    assert plan["status"] == "plan"
    assert plan["writeOccurred"] is False
    blocked = plan_settlement(
        "w1",
        claim_root="",
        review_root=ROOT,
        decision_root=ROOT,
        project_cut_root=ROOT,
    )
    assert blocked["missingRoots"] == ["claimRoot"]


def test_only_facade_plans_bypass_legacy_runtime_initialization():
    assert READ_ONLY_FACADE_ACTIONS == {
        "capabilities",
        "inspect",
        "recover",
        "complete",
        "settle",
    }
    assert "create" not in READ_ONLY_FACADE_ACTIONS
    assert "checkpoint" not in READ_ONLY_FACADE_ACTIONS


def test_work_loop_capabilities_are_complete_and_fail_visible():
    payload = work_loop_capabilities()
    operations = {row["id"]: row for row in payload["operations"]}
    assert set(operations) == {
        "inspect",
        "begin",
        "checkpoint",
        "complete",
        "settle",
        "resume",
        "recover",
        "export",
        "import",
    }
    assert operations["inspect"]["availability"] == "available"
    assert operations["complete"]["availability"] == "plan-only"
    assert operations["begin"]["availability"] == "unavailable"
    assert operations["begin"]["command"] is None
    assert payload["surfaces"]["cli"]["availability"] == "available"
    assert payload["surfaces"]["agent"]["availability"] == "available"
    assert payload["surfaces"]["gui"]["availability"] == "unavailable"
    assert payload["surfaces"]["tui"]["availability"] == "unavailable"
