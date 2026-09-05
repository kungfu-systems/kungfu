# SPDX-License-Identifier: Apache-2.0

from _work_authority_surface_support import *  # noqa: F401,F403


def _fresh_recovery_fixture():
    def root(digit):
        return f"sha256:{digit * 64}"

    status = {
        "schema": "kungfu.assignment-orchestration.status/v1",
        "phase": "completion-claimed",
        "query_proof_root": root("5"),
        "completion_claim_count": 1,
        "completion_claims": [{"claim_id": "claim:one", "root": root("6")}],
        "independent_review_count": 0,
        "independent_reviews": [],
        "continuation_decision_count": 0,
        "continuation_decisions": [],
        "next_actions": [{"action": "review"}],
        "assignment": {
            "initiative_id": "initiative:test",
            "assignment_id": "assignment:test",
            "request_root": root("1"),
            "work_definition_root": root("2"),
            "evidence_episode_roots": [root("7")],
        },
    }
    work_ref = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "project:test",
        "profileId": "kungfu.work-control",
        "profileRoot": root("3"),
        "entityType": "assignment",
        "entityId": "assignment:test",
        "entityRoot": assignment_fresh_recovery._root(status["assignment"]),
        "purpose": "continue-project-assignment",
        "systemTimeCut": root("5"),
        "initiativeId": "initiative:test",
    }
    binding = {
        "workRef": work_ref,
        "session": {
            "workConsoleId": "assistant:project:test",
            "sessionAttemptId": "native:new",
        },
    }
    plan = assignment_fresh_recovery.build_plan(
        workspace={
            "id": "project:test",
            "root": "/project",
            "identityRoot": root("4"),
        },
        status=status,
        binding=binding,
        previous_attempt_id="native:old",
        expected_request_root=root("1"),
        expected_work_definition_root=root("2"),
        expected_profile_root=root("3"),
        recovery_profile={
            "profileId": "kungfu.work-control",
            "profileRoot": root("3"),
            "sourceContractRoot": root("6"),
            "sourceLocator": "/profile/work-control",
        },
        profile_active=False,
        now="2026-08-25T09:00:00Z",
    )
    return status, binding, plan


def test_retained_assignment_authority_ignores_arbitrary_reader_fields():
    status, _binding, _plan = _fresh_recovery_fixture()
    retained_root = work_authority.semantic_root(
        work_authority.retained_assignment_authority(status)
    )
    projected = json.loads(json.dumps(status))
    projected.update(
        query_proof_root=f"sha256:{'a' * 64}",
        active_lease={"lease_id": "reader-only"},
        work_semantics={"next_actions": [{"action": "authorize-effect"}]},
        next_actions=[{"action": "reader-projection"}],
        arbitrary_future_reader_field={"revision": 99},
    )

    assert (
        work_authority.semantic_root(
            work_authority.retained_assignment_authority(projected)
        )
        == retained_root
    )
    projected["completion_claim_count"] = 2
    assert (
        work_authority.semantic_root(
            work_authority.retained_assignment_authority(projected)
        )
        != retained_root
    )


def test_planned_native_binder_never_rediscovers_work_authority(monkeypatch):
    _status, binding, _plan = _fresh_recovery_fixture()
    requests = []
    endpoint = "/tmp/exact-agent-session.sock"
    monkeypatch.setattr(
        planned_work_binding.session_surface,
        "endpoint_for_runtime",
        lambda _runtime: endpoint,
    )

    def invoke(request, **options):
        requests.append((request, options))
        if request["operation"] == "plan-native-bind-work":
            return {"root": f"sha256:{'9' * 64}"}
        return {"status": "bound", "receiptRoot": f"sha256:{'8' * 64}"}

    monkeypatch.setattr(planned_work_binding.session_surface, "invoke", invoke)

    result = planned_work_binding.bind_planned_native_work(
        "/exact/console/runtime",
        work_ref=binding["workRef"],
        session=binding["session"],
        binding_scope="same-project",
        source_workspace_id=binding["workRef"]["workspaceId"],
        actor_id="agent:test",
    )

    assert result["workRef"] == binding["workRef"]
    assert [request[0]["operation"] for request in requests] == [
        "plan-native-bind-work",
        "bind-native-work",
    ]
    assert [options["endpoint"] for _request, options in requests] == [
        endpoint,
        endpoint,
    ]


def test_planned_console_observation_rejects_attempt_and_lifecycle_drift(
    monkeypatch,
):
    _status, binding, plan = _fresh_recovery_fixture()
    exact = binding["session"]
    observations = [
        {
            "workConsoleId": exact["workConsoleId"],
            "sessionAttemptId": "native:different",
            "lifecycleState": "running",
            "live": True,
        },
        {
            **exact,
            "lifecycleState": "ended",
            "live": False,
        },
    ]

    for observation in observations:
        monkeypatch.setattr(
            fresh_recovery_authority.session_surface,
            "invoke",
            lambda *_args, _observation=observation, **_kwargs: _observation,
        )
        with __import__("pytest").raises(
            ValueError, match="Console or SessionAttempt is not live"
        ):
            fresh_recovery_authority.observe_planned_console(plan)


def test_planned_workspace_verification_rejects_identity_drift(tmp_path):
    workspace_root = tmp_path / "project"
    runtime_dir = workspace_root / ".kungfu" / "runtime"
    runtime_dir.mkdir(parents=True)
    semantic = {
        "schema": "kungfu.workspace.identity-material/v1",
        "workspaceKind": "project",
        "workspaceKey": "workspace:test",
    }
    identity_root = assignment_fresh_recovery._root(semantic)
    identity_path = runtime_dir.parent / "workspace-identity.json"
    identity_path.write_text(
        json.dumps({**semantic, "identityRoot": identity_root}), encoding="utf-8"
    )
    plan = {
        "plannedTarget": {
            "workspace": {
                "id": f"project:{identity_root.removeprefix('sha256:')[:16]}",
                "root": str(workspace_root),
                "runtimeRoot": str(runtime_dir),
                "identityRoot": identity_root,
            }
        }
    }

    _runtime, observation = fresh_recovery_authority.verify_planned_workspace(plan)
    assert observation["identityRoot"] == identity_root
    identity_path.write_text(
        json.dumps({**semantic, "identityRoot": f"sha256:{'f' * 64}"}),
        encoding="utf-8",
    )
    with __import__("pytest").raises(ValueError, match="workspace identity changed"):
        fresh_recovery_authority.verify_planned_workspace(plan)


def test_planned_workspace_verification_accepts_home_runtime(tmp_path):
    runtime_dir = tmp_path / ".kungfu" / "runtime"
    runtime_dir.mkdir(parents=True)
    semantic = {
        "schema": "kungfu.workspace.identity-material/v1",
        "workspaceKind": "home",
        "workspaceKey": "home",
    }
    identity_root = assignment_fresh_recovery._root(semantic)
    identity_path = runtime_dir.parent / "workspace-identity.json"
    identity_path.write_text(
        json.dumps({**semantic, "identityRoot": identity_root}), encoding="utf-8"
    )
    plan = {
        "plannedTarget": {
            "workspace": {
                "id": "home",
                "root": None,
                "runtimeRoot": str(runtime_dir),
                "identityRoot": identity_root,
            }
        }
    }

    observed_runtime, observation = fresh_recovery_authority.verify_planned_workspace(
        plan
    )

    assert observed_runtime == runtime_dir
    assert observation["workspaceId"] == "home"
    assert observation["identityRoot"] == identity_root


def test_planned_profile_verification_never_accepts_a_caller_selected_source(
    tmp_path, monkeypatch
):
    _status, _binding, plan = _fresh_recovery_fixture()
    monkeypatch.setattr(
        fresh_recovery_authority,
        "validated_recovery_profile",
        lambda *_args: (_ for _ in ()).throw(
            AssertionError("must reject before validating another source")
        ),
    )

    with __import__("pytest").raises(ValueError, match="locator differs"):
        fresh_recovery_authority.verify_recovery_profile_source(
            plan, tmp_path / "different-profile", tmp_path / "runtime"
        )


def _expired_execution_recovery_fixture(*, profile_active=True):
    status, binding, _ = _fresh_recovery_fixture()
    status.update(
        phase="executing",
        active_lease=None,
        execution_claims=[
            {
                "claim_id": "execution:old",
                "claim_type": "assignment-execution-claim",
                "assignment_id": "assignment:test",
                "attempt_id": "native:old",
                "owner": "owner:test",
                "agent": "codex",
                "slot": "pro-test",
                "lease_id": "lease:old",
                "lease_expires_at": "2026-08-25T08:00:00Z",
                "authorized_by": "maintainer:test",
                "grant_scope": "assignment-execution",
            }
        ],
        phase_transitions=[
            {
                "claim_id": "phase:executing",
                "from_phase": "claimed",
                "to_phase": "executing",
            }
        ],
        completion_claim_count=0,
        completion_claims=[],
        next_actions=[{"action": "fresh-recovery-plan"}],
    )
    plan = assignment_fresh_recovery.build_plan(
        workspace={
            "id": "project:test",
            "root": "/project",
            "identityRoot": f"sha256:{'4' * 64}",
        },
        status=status,
        binding=binding,
        previous_attempt_id="native:old",
        expected_request_root=f"sha256:{'1' * 64}",
        expected_work_definition_root=f"sha256:{'2' * 64}",
        expected_profile_root=f"sha256:{'3' * 64}",
        recovery_profile={
            "profileId": "kungfu.work-control",
            "profileRoot": f"sha256:{'3' * 64}",
            "sourceContractRoot": f"sha256:{'6' * 64}",
            "sourceLocator": "/profile/work-control",
        },
        profile_active=profile_active,
        now="2026-08-25T09:00:00Z",
    )
    return status, binding, plan


def test_fresh_recovery_plan_is_resume_new_attempt_without_lifecycle_replay():
    status, binding, plan = _fresh_recovery_fixture()

    assert plan["continuationMode"] == "resume/new-attempt"
    assert plan["attempt"] == {
        "previousSessionAttemptId": "native:old",
        "newSessionAttemptId": "native:new",
        "workConsoleId": "assistant:project:test",
    }
    assert plan["workRef"] == binding["workRef"]
    assert plan["recoveryProfile"] == plan["plannedProfileSource"]
    assert (
        plan["plannedProfileSource"]["profileRoot"]
        == (binding["workRef"]["profileRoot"])
    )
    assert plan["plannedProfileSource"]["sourceLocator"] == ("/profile/work-control")
    assert [effect["stage"] for effect in plan["effects"]] == [
        "activate-profile",
        "bind-new-attempt",
    ]
    assert set(plan["forbiddenEffects"]) == {"admit", "claim", "kickoff"}
    assert plan["work"]["phase"] == status["phase"]
    assert plan["writeOccurred"] is False


def test_fresh_recovery_plans_exact_lease_without_expanding_authority():
    status, binding, plan = _expired_execution_recovery_fixture()

    assert [effect["stage"] for effect in plan["effects"]] == [
        "bind-new-attempt",
        "claim-new-attempt-lease",
    ]
    effect = plan["effects"][-1]
    assert effect["attemptId"] == binding["session"]["sessionAttemptId"]
    assert effect["leaseId"].startswith("fresh-recovery-")
    assert effect["authority"] == {
        "owner": "owner:test",
        "agent": "codex",
        "slot": "pro-test",
        "authorizedBy": "maintainer:test",
        "grantScope": "assignment-execution",
    }
    assert plan["executionRecovery"] == {
        "previousExecutionClaimRoot": assignment_fresh_recovery._root(
            status["execution_claims"][0]
        ),
        "previousLeaseId": "lease:old",
        "previousLeaseExpiresAt": "2026-08-25T08:00:00Z",
        "authority": effect["authority"],
    }
    assert set(plan["forbiddenEffects"]) == {
        "admit",
        "kickoff",
        "completion-authority",
    }


def test_fresh_recovery_plan_adopts_current_native_console(monkeypatch, tmp_path):
    observed = {}

    def current_native_console(runtime_dir, **options):
        observed.update(runtime_dir=runtime_dir, options=options)
        return {
            "source": "ambient-provider-session",
            "envelope": {
                "consoleId": "assistant:project:test",
                "attemptId": "native:codex:ambient:current",
                "workspaceId": "project:test",
            },
        }

    monkeypatch.setattr(
        fresh_recovery_authority.session_surface,
        "current_native_console",
        current_native_console,
    )

    binding = assignment_fresh_recovery._current_binding_context(
        str(tmp_path), "project:test"
    )
    assert binding["session"] == {
        "workConsoleId": "assistant:project:test",
        "sessionAttemptId": "native:codex:ambient:current",
    }
    assert binding["console"]["sourceWorkspaceId"] == "project:test"
    assert binding["console"]["bindingScope"] == "same-project"
    assert observed == {
        "runtime_dir": str(tmp_path),
        "options": {"adopt": True, "project_work_binding": False},
    }


def test_fresh_recovery_appends_one_exact_current_attempt_lease():
    status, binding, plan = _expired_execution_recovery_fixture()
    effect = plan["effects"][-1]
    after = json.loads(json.dumps(status))
    recovered_claim = {
        **status["execution_claims"][0],
        "claim_id": "execution:new",
        "attempt_id": effect["attemptId"],
        "lease_id": effect["leaseId"],
        "lease_expires_at": effect["leaseExpiresAt"],
    }
    after["execution_claims"].append(recovered_claim)
    after["active_lease"] = recovered_claim
    after["next_actions"] = [{"action": "stage"}]
    observations = iter(
        [
            json.loads(json.dumps(status)),
            json.loads(json.dumps(status)),
            json.loads(json.dumps(status)),
            after,
        ]
    )
    writes = []

    receipt = assignment_fresh_recovery.apply_plan(
        plan,
        expected_plan_root=plan["planRoot"],
        authorized_by="maintainer:test",
        status_reader=lambda: next(observations),
        session_reader=lambda: dict(binding["session"]),
        prepare_profile=lambda _actor: {"status": "ready"},
        bind_work=lambda expected: {
            "workRef": dict(expected["workRef"]),
            "session": dict(expected["session"]),
            "receipt": {"receiptRoot": f"sha256:{'8' * 64}"},
        },
        claim_execution=lambda values, actor: (
            writes.append((dict(values), actor))
            or {"runtimeReceipt": f"sha256:{'9' * 64}"}
        ),
        now="2026-08-25T09:01:00Z",
    )

    assert writes == [
        (
            {
                "initiativeId": "initiative:test",
                "assignmentId": "assignment:test",
                "owner": "owner:test",
                "agent": "codex",
                "slot": "pro-test",
                "leaseId": effect["leaseId"],
                "leaseExpiresAt": effect["leaseExpiresAt"],
                "attemptId": "native:new",
                "authorizedBy": "maintainer:test",
                "grantScope": "assignment-execution",
                "actorType": "user",
                "source": "kungfu",
            },
            "maintainer:test",
        )
    ]
    assert receipt["executionLease"] == {
        "attemptId": "native:new",
        "leaseId": effect["leaseId"],
        "leaseExpiresAt": effect["leaseExpiresAt"],
        "claimRoot": assignment_fresh_recovery._root(recovered_claim),
    }
    assert receipt["assignmentWrites"][0]["kind"] == "execution-claim"
    assert receipt["nextActions"][0]["action"] == "stage"
    assert receipt["continuationDecision"]["nextAction"] == (receipt["nextActions"][0])


def test_fresh_recovery_execution_lease_fails_closed_before_writes():
    status, binding, plan = _expired_execution_recovery_fixture()
    active = json.loads(json.dumps(status))
    active["active_lease"] = status["execution_claims"][0]
    with __import__("pytest").raises(ValueError, match="active execution lease"):
        assignment_fresh_recovery.build_plan(
            workspace=plan["workspace"],
            status=active,
            binding=binding,
            previous_attempt_id="native:old",
            expected_request_root=status["assignment"]["request_root"],
            expected_work_definition_root=status["assignment"]["work_definition_root"],
            expected_profile_root=plan["workRef"]["profileRoot"],
            recovery_profile=plan["recoveryProfile"],
            profile_active=True,
            now="2026-08-25T09:00:00Z",
        )
    with __import__("pytest").raises(ValueError, match="latest execution claim"):
        assignment_fresh_recovery.build_plan(
            workspace=plan["workspace"],
            status=status,
            binding=binding,
            previous_attempt_id="native:other",
            expected_request_root=status["assignment"]["request_root"],
            expected_work_definition_root=status["assignment"]["work_definition_root"],
            expected_profile_root=plan["workRef"]["profileRoot"],
            recovery_profile=plan["recoveryProfile"],
            profile_active=True,
            now="2026-08-25T09:00:00Z",
        )
    mutations = []
    with __import__("pytest").raises(ValueError, match="expired claim"):
        assignment_fresh_recovery.apply_plan(
            plan,
            expected_plan_root=plan["planRoot"],
            authorized_by="other-maintainer",
            status_reader=lambda: json.loads(json.dumps(status)),
            session_reader=lambda: dict(binding["session"]),
            prepare_profile=lambda _actor: mutations.append("profile") or {},
            bind_work=lambda _expected: mutations.append("bind") or {},
            claim_execution=lambda _values, _actor: mutations.append("claim") or {},
            now="2026-08-25T09:01:00Z",
        )
    assert mutations == []


def test_recovered_execution_status_requires_stage_before_completion():
    status, _binding, plan = _expired_execution_recovery_fixture()
    assert assignment_command.orchestration.next_actions(status)[0]["action"] == (
        "fresh-recovery-plan"
    )
    effect = plan["effects"][-1]
    recovered = json.loads(json.dumps(status))
    recovered["active_lease"] = {
        "attempt_id": effect["attemptId"],
        "lease_id": effect["leaseId"],
        "lease_expires_at": effect["leaseExpiresAt"],
    }
    assert assignment_command.orchestration.next_actions(recovered)[0]["action"] == (
        "stage"
    )
