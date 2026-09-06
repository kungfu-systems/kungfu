# SPDX-License-Identifier: Apache-2.0
"""Finding immutability, Issue lifecycle, and reconciliation cases."""
# ruff: noqa: F401,F403

from _dogfood_profile_support import *
from _dogfood_profile_support import _active_runtime, _admit, _capture


def test_finding_is_immutable_and_issue_resolution_requires_independent_roots(
    tmp_path,
):
    _, runtime = _active_runtime(tmp_path)
    captured = _capture(runtime)
    finding = captured["finding"]

    repeated = _capture(runtime)
    assert repeated["status"] == "already-present"
    assert repeated["finding"]["finding_root"] == finding["finding_root"]
    implicit_time = _capture(runtime, suffix="implicit-time", observedAt="")
    implicit_retry = _capture(runtime, suffix="implicit-time", observedAt="")
    assert implicit_retry["status"] == "already-present"
    assert (
        implicit_retry["finding"]["finding_root"]
        == implicit_time["finding"]["finding_root"]
    )
    with pytest.raises(ValueError, match="immutable"):
        _capture(runtime, summary="mutated observation")

    admitted = _admit(runtime, finding["finding_root"])
    issue = admitted["issue"]
    with pytest.raises(ValueError, match="illegal Issue transition"):
        dogfood_api.action(
            str(runtime),
            "transition-issue",
            {
                "issueId": "issue-one",
                "expectedIssueRoot": issue["issue_root"],
                "toState": "resolved",
                "actor": "test-agent",
                "reason": "not independently verified",
            },
            "test-owner",
        )
    accepted = dogfood_api.action(
        str(runtime),
        "transition-issue",
        {
            "issueId": "issue-one",
            "expectedIssueRoot": issue["issue_root"],
            "toState": "accepted",
            "actor": "test-agent",
            "reason": "owned for the current Assignment",
            "transitionedAt": "2026-07-03T00:00:00Z",
        },
        "test-owner",
    )["issue"]
    readmitted = _admit(runtime, finding["finding_root"])
    assert readmitted["status"] == "already-present"
    assert readmitted["issue"]["issue_root"] == accepted["issue_root"]
    in_progress = dogfood_api.action(
        str(runtime),
        "transition-issue",
        {
            "issueId": "issue-one",
            "expectedIssueRoot": accepted["issue_root"],
            "toState": "in-progress",
            "actor": "test-agent",
            "reason": "implementation started",
            "transitionedAt": "2026-07-04T00:00:00Z",
        },
        "test-owner",
    )["issue"]
    with pytest.raises(ValueError, match="independent_assessment_root"):
        dogfood_api.action(
            str(runtime),
            "transition-issue",
            {
                "issueId": "issue-one",
                "expectedIssueRoot": in_progress["issue_root"],
                "toState": "resolved",
                "actor": "test-agent",
                "reason": "missing independent evidence",
            },
            "test-owner",
        )
    resolved = dogfood_api.action(
        str(runtime),
        "transition-issue",
        {
            "issueId": "issue-one",
            "expectedIssueRoot": in_progress["issue_root"],
            "toState": "resolved",
            "actor": "test-agent",
            "reason": "independently reproduced and verified",
            "independentAssessmentRoot": ROOT_A,
            "authorizedDecisionRoot": ROOT_B,
            "successorFactRoot": ROOT_C,
            "productRoot": ROOT_D,
            "verificationEvidenceRoots": [ROOT_A],
            "transitionedAt": "2026-07-05T00:00:00Z",
        },
        "test-owner",
    )["issue"]

    assert resolved["state"] == "resolved"
    assert resolved["predecessor_root"] == in_progress["issue_root"]
    assert resolved["resolution"]["product_root"] == ROOT_D


def test_installed_regression_cases_include_one_legally_reconciled_fix(tmp_path):
    _, runtime = _active_runtime(tmp_path)
    findings = []
    for index, (source_root, title) in enumerate(INSTALLED_REGRESSION_CASES):
        findings.append(
            _capture(
                runtime,
                suffix=f"installed-regression-{index}",
                title=title,
                summary="Sanitized installed-product regression evidence.",
                episodeRoot=source_root,
                evidenceRoots=[source_root],
                observedAt=f"2026-07-{10 + index:02d}T00:00:00Z",
            )["finding"]
        )

    assert [row["episode_root"] for row in findings] == [
        source_root for source_root, _ in INSTALLED_REGRESSION_CASES
    ]
    fixed = findings[0]
    proposal = dogfood_api.read(
        str(runtime),
        "issue-proposal",
        {
            "findingIdentity": fixed["finding_root"],
            "ownerCandidates": ["dogfood-runtime"],
        },
    )
    assert proposal["admission_ready"] is True
    admitted = _admit(
        runtime,
        fixed["finding_root"],
        suffix="installed-exact-root-fix",
        title="Reconcile installed exact-root recovery",
        owner="dogfood-runtime",
    )["issue"]
    accepted = dogfood_api.action(
        str(runtime),
        "transition-issue",
        {
            "issueId": admitted["issue_id"],
            "expectedIssueRoot": admitted["issue_root"],
            "toState": "accepted",
            "actor": "authorized-owner",
            "reason": "accept the bounded installed-product fix",
            "transitionedAt": "2026-07-14T00:00:00Z",
        },
        "test-owner",
    )["issue"]
    in_progress = dogfood_api.action(
        str(runtime),
        "transition-issue",
        {
            "issueId": accepted["issue_id"],
            "expectedIssueRoot": accepted["issue_root"],
            "toState": "in-progress",
            "actor": "authorized-owner",
            "reason": "qualify exact-root diagnosis and explicit recovery",
            "transitionedAt": "2026-07-15T00:00:00Z",
        },
        "test-owner",
    )["issue"]
    evidence = {
        "expectedIssueRoot": in_progress["issue_root"],
        "implementationRoots": [ROOT_A],
        "protectedPrs": ["https://example.invalid/kungfu/pull/1"],
        "independentAssessmentRoot": ROOT_B,
        "authorizedDecisionRoot": ROOT_C,
        "successorFactRoot": fixed["finding_root"],
        "productRoot": ROOT_D,
        "verificationEvidenceRoots": [EXACT_ROOT_DRIFT_FINDING],
    }
    reconciliation = dogfood_api.read(
        str(runtime),
        "issue-reconciliation",
        {"issueIdentity": in_progress["issue_root"], "evidence": evidence},
    )

    assert reconciliation["resolution_transition_eligible"] is True
    assert reconciliation["automatic_transition"] is False
    assert reconciliation["writes"] == []
    resolved = dogfood_api.action(
        str(runtime),
        "transition-issue",
        {
            "issueId": in_progress["issue_id"],
            "expectedIssueRoot": in_progress["issue_root"],
            "toState": "resolved",
            "actor": "authorized-owner",
            "reason": "independent installed-product qualification passed",
            "independentAssessmentRoot": evidence["independentAssessmentRoot"],
            "authorizedDecisionRoot": evidence["authorizedDecisionRoot"],
            "successorFactRoot": evidence["successorFactRoot"],
            "productRoot": evidence["productRoot"],
            "verificationEvidenceRoots": evidence["verificationEvidenceRoots"],
            "transitionedAt": "2026-07-16T00:00:00Z",
        },
        "test-owner",
    )["issue"]
    assert resolved["state"] == "resolved"
    assert resolved["predecessor_root"] == in_progress["issue_root"]
    assert resolved["resolution"]["independent_assessment_root"] == ROOT_B
    assert resolved["resolution"]["successor_fact_root"] == fixed["finding_root"]


def test_local_lookup_issue_proposal_and_reconciliation_never_mutate(tmp_path):
    identity, runtime = _active_runtime(tmp_path)
    finding = _capture(runtime)["finding"]
    issue = _admit(runtime, finding["finding_root"])["issue"]
    accepted = dogfood_api.action(
        str(runtime),
        "transition-issue",
        {
            "issueId": issue["issue_id"],
            "expectedIssueRoot": issue["issue_root"],
            "toState": "accepted",
            "actor": "test-agent",
            "reason": "owned",
            "transitionedAt": "2026-07-03T00:00:00Z",
        },
        "test-owner",
    )["issue"]
    in_progress = dogfood_api.action(
        str(runtime),
        "transition-issue",
        {
            "issueId": issue["issue_id"],
            "expectedIssueRoot": accepted["issue_root"],
            "toState": "in-progress",
            "actor": "test-agent",
            "reason": "implementation started",
            "transitionedAt": "2026-07-04T00:00:00Z",
        },
        "test-owner",
    )["issue"]
    facts_before = storage_service.fact_state(str(runtime))

    lookup = dogfood_api.read(
        str(runtime), "lookup", {"identity": finding["finding_root"]}
    )
    no_owner = dogfood_api.read(
        str(runtime),
        "issue-proposal",
        {"findingIdentity": finding["finding_root"], "ownerCandidates": []},
    )
    owned = dogfood_api.read(
        str(runtime),
        "issue-proposal",
        {
            "findingIdentity": finding["finding_root"],
            "ownerCandidates": ["owner-a"],
        },
    )
    incomplete = dogfood_api.read(
        str(runtime),
        "issue-reconciliation",
        {
            "issueIdentity": in_progress["issue_root"],
            "evidence": {"implementationRoots": [ROOT_A]},
        },
    )
    complete = dogfood_api.read(
        str(runtime),
        "issue-reconciliation",
        {
            "issueIdentity": in_progress["issue_root"],
            "evidence": {
                "expectedIssueRoot": in_progress["issue_root"],
                "implementationRoots": [ROOT_A],
                "protectedPrs": ["https://example.invalid/pull/1"],
                "independentAssessmentRoot": ROOT_A,
                "authorizedDecisionRoot": ROOT_B,
                "successorFactRoot": ROOT_C,
                "productRoot": ROOT_D,
                "verificationEvidenceRoots": [ROOT_A],
            },
        },
    )

    assert lookup["scope"] == "local"
    assert lookup["match_count"] == 1
    assert "federation" not in lookup
    assert no_owner["admission_ready"] is False
    assert owned["admission_ready"] is True
    assert owned["requires_explicit_authorization"] is True
    assert owned["proposal"]["findingRoots"] == [finding["finding_root"]]
    assert incomplete["resolution_transition_eligible"] is False
    assert "independent_assessment_root" in incomplete["omissions"]
    assert incomplete["delivery_complete"] is False
    assert complete["resolution_transition_eligible"] is True
    assert complete["delivery_complete"] is True
    assert complete["resolution_complete"] is False
    assert complete["merged_code_not_resolved"] is True
    assert complete["automatic_transition"] is False
    assert storage_service.fact_state(str(runtime)) == facts_before
    current = dogfood_api.read(str(runtime), "lookup", {"identity": issue["issue_id"]})
    assert current["matches"][0]["record"]["state"] == "in-progress"
    health = dogfood_api.read(
        str(runtime),
        "health",
        {
            "workspaceRoot": identity.workspace_root,
            "scope": "local",
            "now": "2026-08-01T00:00:00Z",
        },
    )
    assert health["counts"]["raw_issue_observations"] == 3
    assert health["counts"]["latest_logical_issues"] == 1
    assert health["counts"]["issue_replicas_or_revisions"] == 2
    assert identity.identity_root


def test_reconciliation_requires_the_exact_current_issue_root(tmp_path):
    _, runtime = _active_runtime(tmp_path)
    finding = _capture(runtime)["finding"]
    issue = _admit(runtime, finding["finding_root"])["issue"]
    accepted = dogfood_api.action(
        str(runtime),
        "transition-issue",
        {
            "issueId": issue["issue_id"],
            "expectedIssueRoot": issue["issue_root"],
            "toState": "accepted",
            "actor": "test-agent",
            "reason": "owned",
            "transitionedAt": "2026-07-03T00:00:00Z",
        },
        "test-owner",
    )["issue"]
    in_progress = dogfood_api.action(
        str(runtime),
        "transition-issue",
        {
            "issueId": issue["issue_id"],
            "expectedIssueRoot": accepted["issue_root"],
            "toState": "in-progress",
            "actor": "test-agent",
            "reason": "implementation started",
            "transitionedAt": "2026-07-04T00:00:00Z",
        },
        "test-owner",
    )["issue"]
    evidence = {
        "expectedIssueRoot": accepted["issue_root"],
        "implementationRoots": [ROOT_A],
        "protectedPrs": ["https://example.invalid/pull/1"],
        "independentAssessmentRoot": ROOT_A,
        "authorizedDecisionRoot": ROOT_B,
        "successorFactRoot": ROOT_C,
        "productRoot": ROOT_D,
        "verificationEvidenceRoots": [ROOT_A],
    }

    mismatch = dogfood_api.read(
        str(runtime),
        "issue-reconciliation",
        {"issueIdentity": in_progress["issue_root"], "evidence": evidence},
    )
    evidence["expectedIssueRoot"] = in_progress["issue_root"]
    resolution_only = dogfood_api.read(
        str(runtime),
        "issue-reconciliation",
        {
            "issueIdentity": in_progress["issue_root"],
            "evidence": {
                key: value
                for key, value in evidence.items()
                if key not in {"implementationRoots", "protectedPrs"}
            },
        },
    )
    exact = dogfood_api.read(
        str(runtime),
        "issue-reconciliation",
        {"issueIdentity": in_progress["issue_root"], "evidence": evidence},
    )

    assert mismatch["delivery_complete"] is True
    assert mismatch["resolution"]["expected_root_matches"] is False
    assert "expected_current_issue_root_match" in mismatch["omissions"]
    assert mismatch["resolution_transition_eligible"] is False
    assert resolution_only["resolution"]["evidence_complete"] is True
    assert resolution_only["delivery_complete"] is False
    assert resolution_only["resolution_transition_eligible"] is False
    assert exact["resolution"]["expected_root_matches"] is True
    assert exact["resolution"]["evidence_complete"] is True
    assert exact["resolution_transition_eligible"] is True
    assert exact["merged_code_not_resolved"] is True


def test_impact_policy_normalizes_aliases_and_rejects_unknown_writes(tmp_path):
    identity, runtime = _active_runtime(tmp_path)
    high_friction = _capture(
        runtime,
        suffix="high-friction",
        impact="high-friction",
    )["finding"]
    blocker_finding = _capture(
        runtime,
        suffix="blocker",
        impact="workflow-blocking",
    )["finding"]
    blocker_issue = _admit(
        runtime,
        blocker_finding["finding_root"],
        suffix="blocker",
        impact="workflow-blocking",
    )["issue"]

    with pytest.raises(ValueError, match="canonical values"):
        _capture(runtime, suffix="unknown-impact", impact="urgent-ish")

    starvation = dogfood_api.read(
        str(runtime),
        "starvation",
        {
            "workspaceRoot": identity.workspace_root,
            "scope": "local",
            "now": "2026-07-03T00:00:00Z",
        },
    )

    assert high_friction["impact"] == "high_friction"
    assert blocker_finding["impact"] == "blocker"
    assert blocker_issue["impact"] == "blocker"
    projected = next(
        row
        for row in starvation["attention"]
        if row["issue_root"] == blocker_issue["issue_root"]
    )
    assert projected["impact"] == "blocker"
    assert "impact:blocker" in projected["reasons"]
    assert projected["release_blocking"] is True
    assert projected in starvation["release_blockers"]


def test_recurrent_closeout_findings_cluster_without_rewriting_facts(tmp_path):
    identity, runtime = _active_runtime(tmp_path)
    findings = []
    for index, error in enumerate(
        (
            "closeout-retirement-residual",
            "closeout-unregistered-rebase",
            "closeout-plan-root-drift",
            "closeout-shadow-catalog-drift",
            "closeout-stale-locator",
        )
    ):
        findings.append(
            _capture(
                runtime,
                suffix=f"closeout-{index}",
                title=f"Worktree closeout failure {index}",
                dimensions={
                    "repository": ["kungfu"],
                    "component": ["project-cut-closeout"],
                    "capability": ["worktree-closeout"],
                    "command": ["shifu project-cut closeout"],
                    "error": [error],
                    "platform": ["macos"],
                },
            )["finding"]
        )

    proposal = dogfood_api.read(
        str(runtime),
        "issue-proposal",
        {
            "findingIdentity": findings[0]["finding_root"],
            "ownerCandidates": ["work-control"],
        },
    )
    issue = _admit(
        runtime,
        findings[0]["finding_root"],
        suffix="closeout-cluster",
        owner="work-control",
        findingRoots=proposal["proposal"]["findingRoots"],
    )["issue"]
    health = dogfood_api.read(
        str(runtime),
        "health",
        {
            "workspaceRoot": identity.workspace_root,
            "scope": "local",
            "now": "2026-08-01T00:00:00Z",
        },
    )

    expected_roots = sorted(row["finding_root"] for row in findings)
    assert proposal["proposal"]["findingRoots"] == expected_roots
    assert proposal["cluster"]["finding_count"] == 5
    assert proposal["cluster"]["recurrence"] >= 5
    assert issue["finding_roots"] == expected_roots
    attention = next(
        row for row in health["attention"] if row["issue_root"] == issue["issue_root"]
    )
    assert attention["recurrence"] >= 5
    for finding in findings:
        lookup = dogfood_api.read(
            str(runtime), "lookup", {"identity": finding["finding_root"]}
        )
        assert lookup["match_count"] == 1
        assert lookup["matches"][0]["record"] == finding
