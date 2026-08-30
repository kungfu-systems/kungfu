# SPDX-License-Identifier: Apache-2.0
"""Assignment relevance, starvation, and workspace federation cases."""
# ruff: noqa: F401,F403

from _dogfood_profile_support import *
from _dogfood_profile_support import (
    _active_runtime,
    _admit,
    _assignment,
    _capture,
)


def test_relevance_is_bounded_explainable_and_consideration_fails_closed(
    tmp_path,
):
    identity, runtime = _active_runtime(tmp_path)
    captured = _capture(runtime)
    issue = _admit(runtime, captured["finding"]["finding_root"])["issue"]
    assignment = _assignment()
    values = {
        "workspaceRoot": identity.workspace_root,
        "assignment": assignment,
        "scope": "local",
        "limit": 10,
    }

    first = dogfood_api.read(str(runtime), "relevance", values)
    second = dogfood_api.read(str(runtime), "relevance", values)
    assert [
        (row["finding_root"], row["score"], row["matches"])
        for row in first["candidates"]
    ] == [
        (row["finding_root"], row["score"], row["matches"])
        for row in second["candidates"]
    ]
    assert first["candidate_count"] == 1
    assert first["truncated"] is False
    assert first["candidates"][0]["matches"][0]["dimension"] in {
        "repository",
        "component",
        "capability",
        "error",
        "platform",
    }
    assert first["federation"]["atomic_global_cut"] is False
    assert first["federation"]["proof"]["component_cuts"][0]["cut_root"]

    for stage in ("design", "admission", "kickoff", "closeout"):
        dogfood_api.consider_assignment(
            str(runtime),
            workspace_root=identity.workspace_root,
            home=False,
            assignment=assignment,
            stage=stage,
            actor="test-agent",
        )
    blocked = dogfood_api.consideration_gate(
        str(runtime), assignment_definition_root=ROOT_C
    )
    assert blocked["ok"] is False
    assert {row["code"] for row in blocked["blockers"]} == {
        "relevant-issue-unaccounted"
    }

    dogfood_api.consider_assignment(
        str(runtime),
        workspace_root=identity.workspace_root,
        home=False,
        assignment=assignment,
        stage="closeout",
        actor="test-agent",
        dispositions=[
            {
                "issue_root": issue["issue_root"],
                "disposition": "deferred",
                "reason": "separate bounded follow-up retains ownership",
            }
        ],
    )
    still_blocked = dogfood_api.consideration_gate(
        str(runtime), assignment_definition_root=ROOT_C
    )
    assert still_blocked["ok"] is False
    assert any(
        row["stage"] != "closeout"
        for row in still_blocked["blockers"]
        if row["code"] == "relevant-issue-unaccounted"
    )
    for stage in ("design", "admission", "kickoff"):
        dogfood_api.consider_assignment(
            str(runtime),
            workspace_root=identity.workspace_root,
            home=False,
            assignment=assignment,
            stage=stage,
            actor="test-agent",
            dispositions=[
                {
                    "issue_root": issue["issue_root"],
                    "disposition": "deferred",
                    "reason": "separate bounded follow-up retains ownership",
                }
            ],
        )
    passed = dogfood_api.consideration_gate(
        str(runtime), assignment_definition_root=ROOT_C
    )
    assert passed["ok"] is True
    assert set(passed["consideration_roots"]) == {
        "design",
        "admission",
        "kickoff",
        "closeout",
    }


def test_starvation_escalates_hard_class_and_repeated_deferral(tmp_path):
    _, runtime = _active_runtime(tmp_path)
    finding = _capture(
        runtime,
        hardClass="security",
        recurrence=4,
    )["finding"]
    issue = _admit(
        runtime,
        finding["finding_root"],
        hardClass="security",
    )["issue"]
    for index in range(5):
        if issue["state"] != "deferred":
            target = "deferred"
        else:
            target = "triaged"
        issue = dogfood_api.action(
            str(runtime),
            "transition-issue",
            {
                "issueId": "issue-one",
                "expectedIssueRoot": issue["issue_root"],
                "toState": target,
                "actor": "test-agent",
                "reason": f"review cycle {index}",
                "transitionedAt": f"2026-07-0{3 + index}T00:00:00Z",
            },
            "test-owner",
        )["issue"]
    result = dogfood_api.read(
        str(runtime), "starvation", {"now": "2026-08-01T00:00:00Z"}
    )

    assert result["attention"][0]["initiative_review"] is True
    assert result["attention"][0]["release_blocking"] is True
    assert "aged" in result["attention"][0]["reasons"]
    assert "recurrent" in result["attention"][0]["reasons"]
    assert "repeated-deferral" in result["attention"][0]["reasons"]
    assert "hard-class:security" in result["attention"][0]["reasons"]
    assert result["automatic_closure"] is False


def test_federation_preserves_independent_component_cuts_and_unavailable_state(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HOME", str(tmp_path))
    config_home = tmp_path / "config"
    left, left_runtime = _active_runtime(tmp_path, "left")
    right, right_runtime = _active_runtime(tmp_path, "right")
    observe_workspace_locator(
        left, config_home=str(config_home), env={"HOME": str(tmp_path)}
    )
    observe_workspace_locator(
        right, config_home=str(config_home), env={"HOME": str(tmp_path)}
    )
    _capture(left_runtime, "left")
    right_finding = _capture(
        right_runtime,
        "right",
        impact="workflow-blocking",
    )["finding"]
    right_issue = _admit(
        right_runtime,
        right_finding["finding_root"],
        suffix="right",
        impact="workflow-blocking",
    )["issue"]

    result = dogfood_api.read(
        str(left_runtime),
        "query",
        {
            "workspaceRoot": left.workspace_root,
            "scope": "all",
            "configHome": str(config_home),
        },
    )
    available = [
        row for row in result["components"] if row["availability"] == "available"
    ]
    assert {row["workspace"]["identity_root"] for row in available}.issuperset(
        {left.identity_root, right.identity_root}
    )
    assert all(row["cut_root"] for row in available)
    assert len({row["cut_root"] for row in available}) >= 2
    assert result["atomic_global_cut"] is False
    starvation = dogfood_api.read(
        str(left_runtime),
        "starvation",
        {
            "workspaceRoot": left.workspace_root,
            "scope": "all",
            "configHome": str(config_home),
            "now": "2026-07-03T00:00:00Z",
        },
    )
    projected = next(
        row
        for row in starvation["attention"]
        if row["issue_root"] == right_issue["issue_root"]
    )
    assert projected["workspace_identity_root"] == right.identity_root
    assert projected["component_cut_root"]
    assert projected["impact"] == "blocker"
    assert projected["release_blocking"] is True
    assert len(starvation["component_cuts"]) >= 2
    assert starvation["federation_proof_root"]
    assert starvation["atomic_global_cut"] is False
    assert starvation["state"] == "complete"

    moved = tmp_path / "right-unavailable"
    Path(right.workspace_root).rename(moved)
    degraded = dogfood_api.read(
        str(left_runtime),
        "query",
        {
            "workspaceRoot": left.workspace_root,
            "scope": "all",
            "configHome": str(config_home),
        },
    )
    unavailable = [
        row for row in degraded["components"] if row["availability"] == "unavailable"
    ]
    assert len(unavailable) == 1
    assert unavailable[0]["workspace"]["identity_root"] == right.identity_root
    assert degraded["proof"]["atomic_global_cut"] is False
    degraded_starvation = dogfood_api.read(
        str(left_runtime),
        "starvation",
        {
            "workspaceRoot": left.workspace_root,
            "scope": "all",
            "configHome": str(config_home),
            "now": "2026-07-03T00:00:00Z",
        },
    )
    assert degraded_starvation["state"] == "partial"
    assert degraded_starvation["omissions"] == [
        {
            "workspace_identity_root": right.identity_root,
            "availability": "unavailable",
            "stale": unavailable[0]["stale"],
            "problems": unavailable[0]["problems"],
            "cut_root": unavailable[0]["cut_root"],
        }
    ]
    assert all(
        row["issue_root"] != right_issue["issue_root"]
        for row in degraded_starvation["attention"]
    )
