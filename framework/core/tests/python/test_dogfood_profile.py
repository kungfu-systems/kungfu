# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path

from click.testing import CliRunner
import pytest

from kungfu import dogfood as dogfood_api
from kungfu import profile_sdk
from kungfu.cli.commands import kfc
from kungfu.cli.commands import dogfood as _dogfood_command  # noqa: F401
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


def test_profile_closes_and_declares_four_kfd1_fact_surfaces(tmp_path):
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
            "kungfu.dogfood-feedback.migration",
        ],
    }


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
    _capture(right_runtime, "right")

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


def test_atlas_jsonl_import_preserves_every_revision_and_source_root(tmp_path):
    _, runtime = _active_runtime(tmp_path)
    source = tmp_path / "items.jsonl"
    rows = [
        {
            "id": "dogfood-a",
            "revision": 1,
            "title": "Installed command mismatch",
            "status": "captured",
            "category": "cli",
            "created_at": "2026-07-01T00:00:00Z",
            "updated_at": "2026-07-01T00:00:00Z",
        },
        {
            "id": "dogfood-a",
            "revision": 2,
            "title": "Installed command mismatch",
            "status": "triaged",
            "category": "cli",
            "created_at": "2026-07-01T00:00:00Z",
            "updated_at": "2026-07-02T00:00:00Z",
        },
        {
            "id": "dogfood-b",
            "revision": 1,
            "title": "Installed command mismatch",
            "status": "captured",
            "category": "cli",
            "created_at": "2026-07-03T00:00:00Z",
            "updated_at": "2026-07-03T00:00:00Z",
        },
    ]
    source.write_bytes(
        b"".join(
            json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n"
            for row in rows
        )
    )
    plan = dogfood_api.read(str(runtime), "migration-plan", {"sourcePath": str(source)})
    assert plan["source"]["revision_count"] == 3
    assert plan["current_item_count"] == 2
    assert plan["automatic_resolution"] is False
    assert len(plan["candidate_duplicate_clusters"]) == 1

    imported = dogfood_api.action(
        str(runtime),
        "import-atlas-jsonl",
        {
            "sourcePath": str(source),
            "expectedSourceRoot": plan["source"]["source_root"],
            "actor": "test-owner",
            "importedAt": "2026-07-04T00:00:00Z",
        },
        "test-owner",
    )
    verified = dogfood_api.read(
        str(runtime), "migration-verify", {"sourcePath": str(source)}
    )
    retried = dogfood_api.action(
        str(runtime),
        "import-atlas-jsonl",
        {
            "sourcePath": str(source),
            "expectedSourceRoot": plan["source"]["source_root"],
            "actor": "test-owner",
        },
        "test-owner",
    )

    assert imported["source_revision_count"] == 3
    assert imported["admitted_revision_count"] == 3
    assert imported["migration"]["automatic_resolution"] is False
    assert (
        retried["migration"]["migration_root"]
        == imported["migration"]["migration_root"]
    )
    assert retried["admitted_revision_count"] == 3
    assert retried["migration_write"]["status"] == "already-present"
    assert all(write["status"] == "already-present" for write in retried["writes"])
    assert verified["ok"] is True
    assert verified["source_bytes_retained"] is True
    assert verified["imported_revision_count"] == 3
