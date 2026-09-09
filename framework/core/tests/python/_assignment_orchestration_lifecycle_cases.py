# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F403,F405

from _assignment_orchestration_support import *


def test_work_resume_prepare_rebinds_stale_profile_without_losing_assignment(
    tmp_path,
    monkeypatch,
):
    source = tmp_path / "work-control"
    shutil.copytree(
        SOURCE,
        source,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"),
    )
    shutil.copytree(
        SOURCE.parent / "work-dashboard",
        source / "node_modules" / "@kungfu-tech" / "kfx-view-work-dashboard",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"),
    )
    workspace = inspect_workspace(
        str(tmp_path), env={"HOME": str(tmp_path.parent / "home")}
    )
    assert workspace is not None
    ensure_workspace_data_home(workspace, "retained-work-resume-fixture")
    runtime = tmp_path / ".kungfu" / "runtime"
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(
            runtime,
            action,
            source,
            **({"granted_permissions": ["storage"]} if action == "activate" else {}),
        )["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")
    contract = profile_composition.contract_materialization_plan(source, runtime)
    if contract["operations"]:
        profile_composition.authorized_contract_materialize(
            runtime,
            contract,
            profile_sdk.answer_decision(
                contract["decisionCard"],
                "approve",
                "test-owner",
            ),
        )
    work_control.create_initiative(
        str(runtime),
        initiative_id="retained-project",
        title="Retained Project",
        intent="Keep Work readable across a product Profile upgrade",
        actor="local-user",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="retained-project",
        assignment_id="retained-assignment",
        title="Retained Assignment",
        objective="Resume the exact retained Work after upgrade",
        actor="local-user",
    )
    previous_root = profile_sdk.validate_source(source, runtime)["inspection"][
        "profile_suite_root"
    ]
    adapter = source / "work-control-actions" / "adapter.py"
    adapter.write_text(
        adapter.read_text(encoding="utf-8")
        + "\n# Product-upgrade regression source root.\n",
        encoding="utf-8",
    )
    desired_root = profile_sdk.validate_source(source, runtime)["inspection"][
        "profile_suite_root"
    ]
    assert desired_root != previous_root
    monkeypatch.setattr(ASSIGNMENT_CLI, "profile_source", lambda: source)

    with pytest.raises(LocalRuntimeError) as stale_profile:
        ASSIGNMENT_CLI._status(
            runtime,
            "retained-project",
            "retained-assignment",
        )
    assert stale_profile.value.code == "backend-unavailable"
    assert stale_profile.value.diagnostics[0]["code"] == (
        "work-control-profile-source-root-drift"
    )

    prepared = ASSIGNMENT_CLI._prepare_resume_profile(
        runtime,
        "kungfu-product-project-resume",
    )

    assert prepared["status"] == "reconciled"
    assert prepared["previousProfileSuiteRoot"] == previous_root
    assert prepared["profileSuiteRoot"] == desired_root
    assert prepared["profileLifecycleReceiptCount"] >= 3
    assert prepared["writeOccurred"] is True
    status = ASSIGNMENT_CLI._status(
        runtime,
        "retained-project",
        "retained-assignment",
    )
    assert status["phase"] == "admitted"
    assert status["assignment"]["assignment_id"] == "retained-assignment"

    repeated = ASSIGNMENT_CLI._prepare_resume_profile(
        runtime,
        "kungfu-product-project-resume",
    )
    assert repeated["status"] == "ready"
    assert repeated["profileLifecycleReceiptCount"] == 0
    assert repeated["writeOccurred"] is False


@pytest.mark.parametrize("action", ["reopen", "request-evidence"])
def test_nonterminal_continuation_decision_starts_a_new_completion_cycle(
    tmp_path, action
):
    runtime = tmp_path / ".kungfu" / "runtime"
    _activate(runtime)
    work_control.create_initiative(
        str(runtime),
        initiative_id="initiative-a",
        title="Initiative A",
        intent="Keep failed review cycles open",
        actor="owner-a",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        title="Assignment A",
        objective="Require a new claim after a nonterminal decision",
        actor="agent-a",
    )
    first_claim = work_control.claim_completion(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        statement="The first claim is intentionally missing independent evidence",
        actor="agent-a",
    )
    first_review = work_control.review_completion(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        reviewer="reviewer-a",
        reviewer_source="independent-session-a",
    )
    assert action in first_review["review"]["continuation_plan"]["allowed_actions"]

    work_control.decide_continuation(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        review_id=first_review["review"]["review_id"],
        expected_review_root=first_review["review_root"],
        expected_plan_root=first_review["continuation_plan_root"],
        action=action,
        actor="agent-b",
        reason="return the Assignment to an evidence-bearing completion cycle",
    )
    reopened = work_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert reopened["phase"] == "stage-ready"
    assert assignment_orchestration.gate(reopened, "closeout")["ok"] is False
    assert assignment_orchestration.next_actions(reopened)[0]["action"] == (
        "claim-completion"
    )

    second_claim = work_control.claim_completion(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        statement="A later claim begins a new completion cycle",
        actor="agent-a",
    )
    assert second_claim["claim"]["claim_id"] != first_claim["claim"]["claim_id"]
    claimed = work_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert claimed["phase"] == "completion-claimed"
    second_review = work_control.review_completion(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        reviewer="reviewer-a",
        reviewer_source="independent-session-a",
    )
    reviewed = work_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert reviewed["phase"] == "independently-reviewed"
    assert reviewed["completion_claim_count"] == 2
    assert reviewed["independent_review_count"] == 2
    assert second_review["review"]["claim_id"] == second_claim["claim"]["claim_id"]


@pytest.mark.parametrize(
    ("phase", "snapshot", "action", "reason"),
    [
        ("executing", True, "authorize-effect", "no-fresh-effect-authorization"),
        (
            "recovered-closeout",
            True,
            "authorize-effect",
            "no-fresh-effect-authorization",
        ),
        ("stage-ready", True, "authorize-effect", "no-fresh-effect-authorization"),
        (
            "recovered-closeout",
            False,
            "record-input-snapshot",
            "no-current-input-snapshot",
        ),
        ("stage-ready", False, "record-input-snapshot", "no-current-input-snapshot"),
    ],
)
def test_next_actions_defers_to_incomplete_work_semantics(
    phase, snapshot, action, reason
):
    status = {
        "initiative_id": "initiative-a",
        "assignment_id": "assignment-a",
        "phase": phase,
        "active_lease": {"lease_id": "lease-a"},
        "work_semantics": {
            "current_input_snapshot": (
                {"record_root": _sha256("a")} if snapshot else None
            ),
            "completion_eligible": False,
            "next_actions": [{"action": action, "reason": reason}],
        },
    }

    assert assignment_orchestration.next_actions(status) == [
        {
            "action": action,
            "description": (
                "Complete current Work semantics before publishing completion"
            ),
            "input": {
                "initiative_id": "initiative-a",
                "assignment_id": "assignment-a",
            },
            "reason": reason,
        }
    ]


def test_next_actions_keeps_completion_after_work_semantics_settle():
    status = {
        "initiative_id": "initiative-a",
        "assignment_id": "assignment-a",
        "phase": "stage-ready",
        "active_lease": {"lease_id": "lease-a"},
        "work_semantics": {
            "current_input_snapshot": {"record_root": _sha256("a")},
            "completion_eligible": True,
            "next_actions": [
                {
                    "action": "claim-completion",
                    "reason": "effects-settled-and-accepted",
                }
            ],
        },
    }

    assert assignment_orchestration.next_actions(status)[0]["action"] == (
        "claim-completion"
    )


def test_gate_field_equivalence_and_runtime_independent_seal(tmp_path):
    status = {
        "initiative_id": "initiative-a",
        "assignment_id": "assignment-a",
        "initiative_subject": "kungfu:initiative-a",
        "assignment_subject": "kungfu:assignment-a",
        "assignment": {"assignment_id": "assignment-a"},
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "a" * 64,
        "execution_claims": [{}],
        "phase_transitions": [{}, {}],
        "completion_claim_count": 1,
        "independent_review_count": 1,
        "continuation_decision_count": 1,
    }
    closed = assignment_orchestration.gate(status, "closeout")
    assert "atlas_compatibility" not in closed
    assert closed["ok"] is True

    runtime = tmp_path / ".kungfu" / "runtime"
    runtime.mkdir(parents=True)
    plan = assignment_orchestration.sealed_state_plan(tmp_path, status)
    receipt = assignment_orchestration.apply_sealed_state(plan, plan["state_root"])
    state_file = Path(receipt["statePath"])
    shutil.rmtree(runtime)
    verified = assignment_orchestration.verify_sealed_state(state_file)
    assert verified == {
        "schema": "kungfu.assignment-orchestration.seal-verification/v1",
        "ok": True,
        "state_root": plan["state_root"],
        "phase": "continuation-decided",
        "next_actions": [],
    }


def test_sealed_state_survives_git_worktree_deletion(tmp_path):
    common = tmp_path / "repo.git"
    administration = common / "worktrees" / "assignment"
    administration.mkdir(parents=True)
    (administration / "commondir").write_text("../..\n", encoding="utf-8")
    workspace = tmp_path / "worktree"
    workspace.mkdir()
    (workspace / ".git").write_text(f"gitdir: {administration}\n", encoding="utf-8")
    status = {
        "initiative_subject": "kungfu:initiative-a",
        "assignment_subject": "kungfu:assignment-a",
        "assignment": {"assignment_id": "assignment-a"},
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "a" * 64,
    }

    plan = assignment_orchestration.sealed_state_plan(workspace, status)
    assert plan["storage_kind"] == "git-common-dir"
    receipt = assignment_orchestration.apply_sealed_state(plan, plan["state_root"])
    state_file = Path(receipt["statePath"])
    assert common in state_file.parents
    shutil.rmtree(workspace)

    assert receipt["worktreeDeletionSafe"] is True
    assert assignment_orchestration.verify_sealed_state(state_file)["ok"] is True


def test_sealed_state_index_retains_exact_work_coordinate(tmp_path):
    common = tmp_path / "repo.git"
    administration = common / "worktrees" / "assignment-index"
    administration.mkdir(parents=True)
    (administration / "commondir").write_text("../..\n", encoding="utf-8")
    workspace = tmp_path / "worktree"
    workspace.mkdir()
    (workspace / ".git").write_text(f"gitdir: {administration}\n", encoding="utf-8")
    owning_root = "sha256:" + "b" * 64
    status = {
        "initiative_subject": "kungfu:initiative-a",
        "assignment_subject": "kungfu:assignment-a",
        "assignment": {
            "assignment_id": "assignment-a",
            "owning_workspace_identity_root": owning_root,
        },
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "a" * 64,
    }
    plan = assignment_orchestration.sealed_state_plan(workspace, status)
    assignment_orchestration.apply_sealed_state(plan, plan["state_root"])

    index = assignment_orchestration.list_sealed_assignment_states(workspace)

    assert index["issues"] == []
    assert index["writes"] == []
    assert index["index_root"].startswith("sha256:")
    assert index["states"] == [
        {
            "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
            "assignment_subject": "kungfu:assignment-a",
            "workspace_identity_root": owning_root,
            "assignment_state_root": assignment_canonical.semantic_root(
                {
                    "schema": "kungfu.assignment-orchestration.retained-assignment-state/v1",
                    "workspace": {},
                    "initiative_subject": status["initiative_subject"],
                    "assignment_subject": status["assignment_subject"],
                    "assignment": status["assignment"],
                    "phase": status["phase"],
                    "active_lease": status["active_lease"],
                    "event_counts": plan["snapshot"]["counts"],
                }
            ),
            "event_counts": plan["snapshot"]["counts"],
            "state_root": plan["state_root"],
            "query_proof_root": status["query_proof_root"],
            "phase": "continuation-decided",
            "settled": True,
            "storage_kind": "git-common-dir",
        }
    ]
