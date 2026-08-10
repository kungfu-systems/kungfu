# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path
import shutil

from click.testing import CliRunner
import pytest

from kungfu import dogfood as dogfood_api
from kungfu import profile_sdk
from kungfu.cli.commands import kfc
from kungfu.cli.commands import dogfood as _dogfood_command  # noqa: F401
from kungfu.storage import service as storage_service
from kungfu.workspace import (
    ensure_workspace_data_home,
    inspect_workspace,
    observe_workspace_locator,
)


SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "dogfood"
ROOT_A = "sha256:" + "a" * 64
ROOT_B = "sha256:" + "b" * 64
ROOT_C = "sha256:" + "c" * 64
ROOT_D = "sha256:" + "d" * 64
EXACT_ROOT_DRIFT_FINDING = (
    "sha256:f9ffba0229835b0521c566fb82c8c4bb48730a8b235ff63600d502f0e8290cd7"
)
INSTALLED_REGRESSION_CASES = (
    (
        EXACT_ROOT_DRIFT_FINDING,
        "Installed Dogfood exact Profile-root drift",
    ),
    (
        "sha256:7d2d57c2a3eb89e5ae40aa3b2a59f78d6133b9d16ad434e938313135084cff97",
        "Installed CLI package omits a declared Work Control Suite member",
    ),
    (
        "sha256:9de6878fe13c157c4003af332e5769cea8e12fcf1e2c1cd9188dfaf670ca26d7",
        "Work Dashboard refresh starvation hides Initiative data",
    ),
    (
        "sha256:30e7c086ece6ee836b73bc39e819c28f061eda5ed2c5704f2cd53ebbd8a6544f",
        "Embedded Python writes into the signed macOS App bundle",
    ),
)


def _workspace(tmp_path: Path, name: str):
    root = tmp_path / name
    root.mkdir()
    identity = inspect_workspace(str(root), env={"HOME": str(tmp_path)})
    assert identity is not None
    ensure_workspace_data_home(identity, "dogfood-test")
    identity = inspect_workspace(str(root), env={"HOME": str(tmp_path)})
    assert identity is not None
    return identity, Path(identity.data_home) / "runtime"


def _active_runtime(tmp_path: Path, name: str = "repo"):
    identity, runtime = _workspace(tmp_path, name)
    dogfood_api.ensure_profile(str(runtime), "test-owner")
    return identity, runtime


def _capture(runtime: Path, suffix: str = "one", **overrides):
    values = {
        "findingId": f"finding-{suffix}",
        "title": f"Finding {suffix}",
        "summary": "The installed command returned the wrong contract.",
        "episodeRoot": ROOT_A,
        "evidenceRoots": [ROOT_B],
        "dimensions": {
            "repository": ["kungfu"],
            "component": ["profile"],
            "capability": ["installed-product"],
            "error": ["contract-mismatch"],
            "platform": ["macos"],
        },
        "privacy": "internal",
        "runtimeSurface": "source-checkout",
        "runtimeReceiptRoot": ROOT_D,
        "actor": "test-agent",
        "observedAt": "2026-07-01T00:00:00Z",
        "impact": "normal",
    }
    values.update(overrides)
    return dogfood_api.action(str(runtime), "capture-finding", values, "test-owner")


def _admit(runtime: Path, finding_root: str, suffix: str = "one", **overrides):
    values = {
        "issueId": f"issue-{suffix}",
        "title": f"Issue {suffix}",
        "owner": "owner-a",
        "findingRoots": [finding_root],
        "impact": "normal",
        "verificationCriteria": ["installed command returns the declared schema"],
        "actor": "test-agent",
        "admittedAt": "2026-07-02T00:00:00Z",
    }
    values.update(overrides)
    return dogfood_api.action(str(runtime), "admit-issue", values, "test-owner")


def _assignment(root: str = ROOT_C):
    return {
        "assignment_id": "assignment-a",
        "work_definition_root": root,
        "work_definition": {
            "context_admission": {
                "required_capabilities": ["installed-product"],
                "subjects": ["profile"],
            }
        },
        "dogfood_dimensions": {
            "repository": ["kungfu"],
            "component": ["profile"],
            "capability": ["installed-product"],
            "error": ["contract-mismatch"],
            "platform": ["macos"],
        },
    }


def test_cli_runtime_failure_is_a_stable_json_diagnosis(tmp_path):
    workspace = tmp_path / "uninitialized"
    workspace.mkdir()

    result = CliRunner().invoke(
        kfc,
        ["dogfood", "query", "--workspace", str(workspace)],
    )

    assert result.exit_code == 2
    assert "Traceback" not in result.output
    diagnosis = json.loads(result.output)
    assert diagnosis == {
        "cause": None,
        "code": "dogfood-operation-failed",
        "message": "Dogfood requires an initialized project or Home workspace",
        "next_actions": [],
        "ok": False,
        "schema": "kungfu.dogfood-feedback.diagnosis/v1",
    }


def test_cli_missing_lookup_is_one_stable_json_result(tmp_path):
    identity, _ = _active_runtime(tmp_path)

    result = CliRunner().invoke(
        kfc,
        [
            "dogfood",
            "show",
            ROOT_A,
            "--workspace",
            str(identity.workspace_root),
        ],
    )

    assert result.exit_code == 3
    assert "Traceback" not in result.output
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["identity"] == ROOT_A
    assert payload["match_count"] == 0


def test_profile_closes_and_declares_native_kfd1_fact_surfaces(tmp_path):
    validated = profile_sdk.validate_source(SOURCE, tmp_path / "runtime")
    world = json.loads((SOURCE / "contracts" / "world.json").read_text())

    assert validated["ok"] is True
    assert validated["inspection"]["verified"] is True
    assert set(validated["source"]["memberRoots"]) == {
        "dogfood-actions",
        "dogfood-assessment",
        "dogfood-contract",
        "work-dashboard",
    }
    assert {
        (
            intent["protocol"]["apiId"],
            intent["protocol"]["guiMember"],
            intent["protocol"]["guiMethod"],
        )
        for intent in validated["collaboration"]["intents"]
    } == {("kungfu.profile.application", "work-dashboard", "intentPlan")}
    release_manifest = profile_sdk.build_kfd3_release_manifest(
        [SOURCE], tmp_path / "release-runtime"
    )
    release_receipt = release_manifest["entries"][0]["receipt"]
    assert release_receipt["qualified"] is True
    assert release_receipt["qualificationSource"] == "release"
    assert all(probe["matched"] for probe in release_receipt["clientProbes"])
    assert world["contractWorld"] == {
        "id": "kungfu.dogfood-feedback",
        "version": "1",
        "factSurfaceIds": [
            "kungfu.dogfood-feedback.finding",
            "kungfu.dogfood-feedback.issue",
            "kungfu.dogfood-feedback.consideration",
        ],
    }


def test_exact_root_diagnosis_is_read_only_and_recovery_is_explicit_and_idempotent(
    tmp_path,
):
    identity, runtime = _active_runtime(tmp_path)
    alternate = tmp_path / "alternate-dogfood"

    def ignore_dangling_links(directory, names):
        return [
            name
            for name in names
            if (Path(directory) / name).is_symlink()
            and not (Path(directory) / name).exists()
        ]

    shutil.copytree(
        SOURCE,
        alternate,
        ignore=ignore_dangling_links,
    )
    readme = alternate / "dogfood-actions" / "README.md"
    readme.write_text(
        readme.read_text(encoding="utf-8") + "\nExact-root drift fixture.\n",
        encoding="utf-8",
    )
    for action in ("upgrade", "qualify", "activate"):
        values = {"granted_permissions": ["storage"]} if action == "activate" else {}
        plan = profile_sdk.lifecycle_plan(str(runtime), action, alternate, **values)
        answer = profile_sdk.answer_decision(
            plan["decisionCard"], "approve", "test-owner"
        )
        profile_sdk.authorized_lifecycle_apply(str(runtime), plan, answer)

    lifecycle_before = storage_service.profile_lifecycle(
        str(runtime), "list", include_removed=True
    )
    facts_before = storage_service.fact_state(str(runtime))
    first = dogfood_api.profile_diagnosis(str(runtime))
    second = dogfood_api.profile_diagnosis(str(runtime))
    with pytest.raises(
        profile_sdk.ProfileSdkError, match="exact active Profile root"
    ) as error:
        dogfood_api.read(
            str(runtime),
            "query",
            {"workspaceRoot": identity.workspace_root, "scope": "local"},
        )

    assert first == second
    assert first["current_root"] != first["desired_root"]
    assert first["cause"] == "exact-profile-root-drift"
    assert first["writes"] == []
    assert error.value.diagnosis["profileDiagnosis"] == first
    assert error.value.diagnosis["currentRoot"] == first["current_root"]
    assert error.value.diagnosis["desiredRoot"] == first["desired_root"]
    assert EXACT_ROOT_DRIFT_FINDING.startswith("sha256:")
    assert (
        storage_service.profile_lifecycle(str(runtime), "list", include_removed=True)
        == lifecycle_before
    )
    assert storage_service.fact_state(str(runtime)) == facts_before

    plan = dogfood_api.recovery_plan(str(runtime))
    assert plan["status"] == "ready"
    assert [row["operation"] for row in plan["operations"]] == [
        "upgrade",
        "qualify",
        "activate",
        "materialize-contract",
    ]
    recovered = dogfood_api.apply_recovery(
        str(runtime),
        expected_plan_root=plan["plan_root"],
        authorized_by="test-owner",
    )
    assert recovered["status"] == "recovered"
    assert recovered["diagnosis"]["ok"] is True

    repeated_plan = dogfood_api.recovery_plan(str(runtime))
    repeated = dogfood_api.apply_recovery(
        str(runtime),
        expected_plan_root=repeated_plan["plan_root"],
        authorized_by="test-owner",
    )
    assert repeated_plan["status"] == "no-op"
    assert repeated["status"] == "already-current"
    assert repeated["verified_no_op"] is True


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
