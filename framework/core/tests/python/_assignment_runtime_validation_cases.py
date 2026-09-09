# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from _assignment_runtime_support import *  # noqa: F403


# The stable facade is the only pytest collection surface.
def test_invalid_assessment_executor_is_rejected_before_pending_write(tmp_path):
    runtime_dir = tmp_path / "invalid-executor" / ".kungfu" / "runtime"
    authority = FakeAuthority(runtime_dir)
    with EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ) as runtime:
        snapshot = _handle(
            runtime, _request("assignment.snapshot", "assignment.snapshot.read")
        )
        command = _command(
            snapshot["revision"],
            command_type="assignment.completion.review",
        )
        command["arguments"] = {"executorProfile": "github-protected-review"}
        rejected = _handle(
            runtime,
            _request(
                "command.submit",
                "assignment.command.submit",
                payload=command,
            ),
        )

        assert rejected["error"]["code"] == "invalid-command"
        assert runtime._state["pending"] is None
        assert authority._read()["effects"] == []


@pytest.mark.parametrize(
    ("assignment_ids", "parent_assignment_id", "expected_matches"),
    [
        (["assignment-a"], "missing-parent", 0),
        (["duplicate-parent", "duplicate-parent"], "duplicate-parent", 2),
    ],
)
def test_assignment_create_rejects_unresolved_local_parent_before_pending_write(
    tmp_path, assignment_ids, parent_assignment_id, expected_matches
):
    runtime_dir = tmp_path / "invalid-local-parent" / ".kungfu" / "runtime"
    authority = AssignmentCreateAuthority(runtime_dir, assignment_ids)
    with EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ) as runtime:
        snapshot = _handle(
            runtime, _request("assignment.snapshot", "assignment.snapshot.read")
        )
        command = _assignment_create_command(
            snapshot["revision"], parent_assignment_id=parent_assignment_id
        )
        rejected = _handle(
            runtime,
            _request(
                "command.submit",
                "assignment.command.submit",
                payload=command,
            ),
        )

        assert rejected["error"]["code"] == "invalid-command"
        assert rejected["error"]["details"] == {
            "field": "parentAssignmentId",
            "matches": expected_matches,
        }
        assert runtime._state["pending"] is None
        assert authority.applied_commands == []


def test_assignment_create_accepts_local_parent_explicit_refs_and_dependencies(
    tmp_path,
):
    work_ref = {
        "workspace_identity_root": ROOT_A,
        "object_kind": "assignment",
        "subject": "kungfu:assignment-a",
        "version_root": ROOT_B,
        "cut_root": ROOT_A,
    }
    cases = [
        {"assignment_id": "local-parent", "parent_assignment_id": "assignment-a"},
        {
            "assignment_id": "explicit-parent",
            "parent_assignment_ref": work_ref,
        },
        {
            "assignment_id": "dependency-shorthand",
            "depends_on": ["not-yet-local"],
        },
        {
            "assignment_id": "dependency-ref",
            "dependency_refs": [work_ref],
        },
    ]
    for case in cases:
        runtime_dir = tmp_path / str(case["assignment_id"]) / ".kungfu" / "runtime"
        authority = AssignmentCreateAuthority(runtime_dir)
        with EmbeddedLocalAssignmentRuntime(
            runtime_dir,
            realm_id=REALM["realmId"],
            generation=REALM["generation"],
            authority=authority,
            contract=ASSIGNMENT_RUNTIME_CONTRACT,
            request_schema=ENVELOPE_SCHEMA,
        ) as runtime:
            snapshot = _handle(
                runtime, _request("assignment.snapshot", "assignment.snapshot.read")
            )
            command = _assignment_create_command(snapshot["revision"], **case)
            accepted = _handle(
                runtime,
                _request(
                    "command.submit",
                    "assignment.command.submit",
                    payload=command,
                ),
            )

            assert accepted["status"] == "ok"
            assert runtime._state["pending"] is None
            assert authority.applied_commands == [command]


@pytest.mark.parametrize(
    ("assignment_id", "request_id"),
    [
        (
            "producer-budget-activation-linear-r7",
            "legacy.r7.assignment.create",
        ),
        (
            "producer-budget-activation-linear-r8",
            "legacy.r8.assignment.create",
        ),
    ],
)
def test_restart_rejects_legacy_assignment_create_with_unresolved_parent(
    tmp_path, assignment_id, request_id
):
    runtime_dir = tmp_path / assignment_id / ".kungfu" / "runtime"
    authority = AssignmentCreateAuthority(runtime_dir)
    runtime = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    snapshot = _handle(
        runtime, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    command = _assignment_create_command(
        snapshot["revision"],
        assignment_id=assignment_id,
        parent_assignment_id="predecessor-not-in-current-snapshot",
        depends_on=["historical-dependency"],
    )
    command_root = _root(command)
    pending = {
        "commandRoot": command_root,
        "command": command,
        "beforeRevision": snapshot["revision"],
        "requestId": request_id,
    }
    runtime._state["pending"] = copy.deepcopy(pending)
    runtime._save_state()
    runtime.close()

    persisted_before = json.loads(
        (runtime_dir / "assignment-runtime" / "local-v1" / "state.json").read_text(
            encoding="utf-8"
        )
    )
    assert persisted_before["pending"] == pending

    recovered = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    try:
        assert recovered._state["pending"] is None
        assert authority.applied_commands == []
        event = recovered._state["events"][-1]
        assert event["kind"] == "command-rejected"
        assert event["revision"] == pending["beforeRevision"]
        assert event["payload"] == {
            "commandId": command["commandId"],
            "commandRoot": command_root,
            "errorCode": "invalid-command",
        }
        diagnostic = recovered._state["diagnostics"][-1]
        assert diagnostic["code"] == "interrupted-command-rejected"
        assert diagnostic["details"] == {
            "commandId": command["commandId"],
            "commandRoot": command_root,
            "errorCode": "invalid-command",
            "field": "parentAssignmentId",
            "matches": 0,
        }
    finally:
        recovered.close()


@pytest.mark.parametrize(
    "evidence_availability",
    [
        {"acceptance": "acceptance-a", "level": "full", "state": "available"},
        ["acceptance-a"],
        [{"acceptance": "", "level": "full", "state": "available"}],
        [{"acceptance": "acceptance-a", "level": "partial", "state": "available"}],
        [{"acceptance": "acceptance-a", "level": "full", "state": "unknown"}],
    ],
)
def test_invalid_completion_evidence_is_rejected_before_pending_write(
    tmp_path, evidence_availability
):
    runtime_dir = tmp_path / "invalid-completion-evidence" / ".kungfu" / "runtime"
    authority = FakeAuthority(runtime_dir)
    with EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ) as runtime:
        snapshot = _handle(
            runtime, _request("assignment.snapshot", "assignment.snapshot.read")
        )
        command = _command(
            snapshot["revision"],
            command_type="assignment.completion.claim",
        )
        command["arguments"] = {"evidenceAvailability": evidence_availability}
        rejected = _handle(
            runtime,
            _request(
                "command.submit",
                "assignment.command.submit",
                payload=command,
            ),
        )

        assert rejected["error"]["code"] == "invalid-command"
        assert runtime._state["pending"] is None
        assert authority._read()["effects"] == []


def test_rejected_pending_replay_keeps_manual_recovery_reachable(tmp_path):
    runtime_dir = tmp_path / "rejected-replay" / ".kungfu" / "runtime"

    class RejectingReplayAuthority(FakeAuthority):
        def apply(self, command):
            raise LocalRuntimeError("backend-unavailable", "deterministic rejection")

    authority = RejectingReplayAuthority(runtime_dir)
    runtime = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    snapshot = _handle(
        runtime, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    command = _command(snapshot["revision"])
    runtime._state["pending"] = {
        "commandRoot": _root(command),
        "command": command,
        "beforeRevision": snapshot["revision"],
        "requestId": "rejected.pending.replay",
    }
    runtime._save_state()
    runtime.close()

    restarted = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    try:
        assert restarted._state["pending"]["commandRoot"] == _root(command)
        assert restarted._state["diagnostics"][-1] == {
            "code": "interrupted-write-retry-failed",
            "message": (
                "The interrupted command could not be replayed; its authority "
                "outcome remains unknown"
            ),
            "severity": "error",
            "recovery": ["diagnostics.get", "recovery.plan"],
            "details": {"causeCode": "backend-unavailable"},
        }
        blocked = restarted.handle(
            _request("assignment.snapshot", "assignment.snapshot.read")
        )
        assert blocked["error"]["code"] == "backend-unavailable"

        plan = _handle(restarted, _request("recovery.plan", "assignment.recovery.plan"))
        assert plan["result"]["status"] == "manual-review-required"
        assert plan["result"]["operatorResolution"]["commandRoot"] == _root(command)
    finally:
        restarted.close()


def test_restart_rejects_legacy_invalid_executor_pending_before_authority(tmp_path):
    runtime_dir = tmp_path / "legacy-invalid-executor" / ".kungfu" / "runtime"
    authority = FakeAuthority(runtime_dir)
    runtime = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    snapshot = _handle(
        runtime, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    command = _command(
        snapshot["revision"],
        command_type="assignment.completion.review",
    )
    command["arguments"] = {"executorProfile": "github-protected-review"}
    runtime._state["pending"] = {
        "commandRoot": _root(command),
        "command": command,
        "beforeRevision": snapshot["revision"],
        "requestId": "legacy.invalid.executor",
    }
    runtime._save_state()
    runtime.close()

    recovered = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    try:
        assert recovered._state["pending"] is None
        assert authority._read()["effects"] == []
        assert recovered._state["events"][-1]["kind"] == "command-rejected"
        assert recovered._state["diagnostics"][-1]["code"] == (
            "interrupted-command-rejected"
        )
    finally:
        recovered.close()


def test_restart_rejects_invalid_completion_pending_before_authority(tmp_path):
    runtime_dir = tmp_path / "invalid-completion-pending" / ".kungfu" / "runtime"
    authority = FakeAuthority(runtime_dir)
    runtime = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    snapshot = _handle(
        runtime, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    command = _command(
        snapshot["revision"],
        command_type="assignment.completion.claim",
    )
    command["arguments"] = {
        "evidenceAvailability": [
            {
                "acceptance": "acceptance-a",
                "level": "partial",
                "state": "available",
            }
        ]
    }
    runtime._state["pending"] = {
        "commandRoot": _root(command),
        "command": command,
        "beforeRevision": snapshot["revision"],
        "requestId": "invalid.completion.pending",
    }
    runtime._save_state()
    runtime.close()

    recovered = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    try:
        assert recovered._state["pending"] is None
        assert authority._read()["effects"] == []
        assert recovered._state["events"][-1]["kind"] == "command-rejected"
        diagnostic = recovered._state["diagnostics"][-1]
        assert diagnostic["code"] == "interrupted-command-rejected"
        assert diagnostic["details"]["field"] == "evidenceAvailability"
        assert diagnostic["details"]["index"] == 0
    finally:
        recovered.close()


def test_restart_rejects_deterministic_authority_error_without_sticky_pending(
    tmp_path, monkeypatch
):
    runtime_dir = tmp_path / "invalid-authority-pending" / ".kungfu" / "runtime"
    authority = FakeAuthority(runtime_dir)
    runtime = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    snapshot = _handle(
        runtime, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    command = _command(
        snapshot["revision"],
        command_type="assignment.continuation.decide",
    )
    pending = {
        "commandRoot": _root(command),
        "command": command,
        "beforeRevision": snapshot["revision"],
        "requestId": "invalid.authority.pending",
    }
    runtime._state["pending"] = copy.deepcopy(pending)
    runtime._save_state()
    runtime.close()

    def reject(_command):
        raise LocalRuntimeError(
            "invalid-command",
            "independent review changed before continuation decision",
            details={"operation": "decide-continuation"},
        )

    monkeypatch.setattr(authority, "apply", reject)
    recovered = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    try:
        assert recovered._state["pending"] is None
        assert recovered._state["events"][-1]["kind"] == "command-rejected"
        diagnostic = recovered._state["diagnostics"][-1]
        assert diagnostic["code"] == "interrupted-command-rejected"
        assert diagnostic["details"] == {
            "commandId": command["commandId"],
            "commandRoot": _root(command),
            "errorCode": "invalid-command",
            "operation": "decide-continuation",
        }
    finally:
        recovered.close()


def test_interrupted_authority_write_without_result_is_fail_visible(tmp_path):
    runtime_dir = tmp_path / "ambiguous-crash" / ".kungfu" / "runtime"
    authority = FakeAuthority(runtime_dir)

    def crash(point: str) -> None:
        if point == "after-authority":
            raise RuntimeError("simulated authority crash window")

    crashed = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
        fault_hook=crash,
    ).start()
    snapshot = _handle(
        crashed, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    command = _command(snapshot["revision"])
    with pytest.raises(RuntimeError, match="authority crash window"):
        crashed.handle(
            _request(
                "command.submit",
                "assignment.command.submit",
                payload=command,
            )
        )
    crashed.close()

    restarted = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    try:
        diagnostics = _handle(
            restarted,
            _request("diagnostics.get", "assignment.diagnostics.read"),
        )
        assert [row["code"] for row in diagnostics["diagnostics"]] == [
            "interrupted-write-ambiguous"
        ]
        plan = _handle(
            restarted,
            _request("recovery.plan", "assignment.recovery.plan"),
        )
        assert plan["result"]["status"] == "manual-review-required"
        resolution = plan["result"]["operatorResolution"]
        assert resolution["authorityOutcome"] == "unknown"
        assert resolution["commandRoot"] == _root(command)
        blocked = restarted.handle(
            _request("assignment.snapshot", "assignment.snapshot.read")
        )
        assert blocked["error"]["code"] == "backend-unavailable"
        assert authority._read()["phase"] == "claimed"
        assert len(authority._read()["effects"]) == 1

        payload = {
            "resolution": "abandon-local-pending",
            "expectedBasisRoot": plan["result"]["basisRoot"],
            "expectedCommandRoot": resolution["commandRoot"],
            "expectedRevision": resolution["currentRevision"],
            "idempotencyKey": "idempotency:recovery:ambiguous-command-a",
            "authorizedBy": "operator-a",
            "reason": "authority inspection confirms the current state is canonical",
            "evidenceRoots": [ROOT_A],
        }
        stale = copy.deepcopy(payload)
        stale["expectedBasisRoot"] = ROOT_B
        refused = _handle(
            restarted,
            _request(
                "recovery.execute",
                "assignment.recovery.execute",
                payload=stale,
            ),
        )
        assert refused["error"]["code"] == "stale-revision"
        assert restarted._state["pending"] is not None

        wrong_command = copy.deepcopy(payload)
        wrong_command["expectedCommandRoot"] = ROOT_B
        refused = _handle(
            restarted,
            _request(
                "recovery.execute",
                "assignment.recovery.execute",
                payload=wrong_command,
            ),
        )
        assert refused["error"]["code"] == "idempotency-conflict"
        assert restarted._state["pending"] is not None

        resolved = _handle(
            restarted,
            _request(
                "recovery.execute",
                "assignment.recovery.execute",
                payload=payload,
            ),
        )
        assert resolved["result"]["resolution"]["authorityOutcome"] == "unknown"
        assert resolved["result"]["resolution"]["localDisposition"] == (
            "local-pending-abandoned"
        )
        assert resolved["result"]["resolution"]["disposition"] == "applied"
        assert resolved["receipts"][0]["kind"] == "recovery-resolution"
        assert restarted._state["pending"] is None
        assert restarted._state["events"][-1]["kind"] == (
            "command-outcome-unknown-resolved"
        )
        assert authority._read()["phase"] == "claimed"
        assert len(authority._read()["effects"]) == 1

        missing_evidence = copy.deepcopy(payload)
        missing_evidence.pop("evidenceRoots")
        invalid_request = _request(
            "recovery.execute",
            "assignment.recovery.execute",
            payload=missing_evidence,
        )
        assert list(VALIDATE_ENVELOPE.iter_errors(invalid_request))

        observed = _handle(
            restarted,
            _request("assignment.snapshot", "assignment.snapshot.read"),
        )
        assert observed["status"] == "ok"
        inspected = _handle(
            restarted,
            _request(
                "command.get",
                "assignment.command.inspect",
                payload={"commandId": command["commandId"]},
            ),
        )
        assert inspected["result"]["command"]["disposition"] == (
            "authority-outcome-unknown"
        )
        replay = _handle(
            restarted,
            _request(
                "command.submit",
                "assignment.command.submit",
                payload=command,
            ),
        )
        assert replay["error"]["code"] == "unknown-outcome"
        assert replay["error"]["retryable"] is False
        assert len(authority._read()["effects"]) == 1
    finally:
        restarted.close()

    replayed = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    try:
        replay = _handle(
            replayed,
            _request(
                "recovery.execute",
                "assignment.recovery.execute",
                payload=payload,
            ),
        )
        assert replay["result"]["resolution"]["disposition"] == "replayed"
        assert replay["receipts"] == resolved["receipts"]
        assert len(authority._read()["effects"]) == 1
    finally:
        replayed.close()


@pytest.mark.skipif(
    importlib.util.find_spec("pykungfu") is None,
    reason="native Work Control integration requires the built pykungfu binding",
)
def test_production_adapter_reaches_existing_work_control_authority(
    tmp_path, monkeypatch
):
    from kungfu import profile_composition, profile_sdk

    home = tmp_path / "production-home"
    monkeypatch.setenv("HOME", str(home))
    runtime_dir = home / ".kungfu" / "runtime"
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(runtime_dir, action, PROFILE_SOURCE)[
            "corePlan"
        ]
        profile_sdk.lifecycle_apply(runtime_dir, plan, f"test:{action}")
    contract_plan = profile_composition.contract_materialization_plan(
        PROFILE_SOURCE, runtime_dir
    )
    profile_composition.authorized_contract_materialize(
        runtime_dir,
        contract_plan,
        profile_sdk.answer_decision(
            contract_plan["decisionCard"], "approve", "runtime-test"
        ),
    )
    profile_sdk.invoke_member_adapter(
        PROFILE_SOURCE,
        runtime_dir,
        "work-control-actions",
        "create-initiative",
        {
            "initiativeId": "initiative-a",
            "title": "Runtime integration",
            "intent": "Prove one existing authority",
            "actor": "runtime-test",
            "actorType": "agent",
        },
        authorized_action=True,
    )
    profile_sdk.invoke_member_adapter(
        PROFILE_SOURCE,
        runtime_dir,
        "work-control-actions",
        "create-assignment",
        {
            "initiativeId": "initiative-a",
            "assignmentId": "assignment-a",
            "title": "Exercise R1",
            "objective": "Reach Work Control through the Runtime adapter",
            "actor": "runtime-test",
            "actorType": "agent",
        },
        authorized_action=True,
    )

    authority = WorkControlAuthority(runtime_dir, source=PROFILE_SOURCE)
    with EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
    ) as runtime:
        snapshot = _handle(
            runtime, _request("assignment.snapshot", "assignment.snapshot.read")
        )
        assert snapshot["result"]["assignments"][0]["phase"] == "admitted"
        command = _command(snapshot["revision"])
        claimed = _handle(
            runtime,
            _request(
                "command.submit",
                "assignment.command.submit",
                payload=command,
            ),
        )
        assert claimed["status"] == "ok", claimed
        after = _handle(
            runtime, _request("assignment.snapshot", "assignment.snapshot.read")
        )
        assignment = after["result"]["assignments"][0]
        assert assignment["phase"] == "claimed"
        assert assignment["attempt"]["attemptId"] == command["attempt"]["attemptId"]
        assert assignment["lease"] == command["lease"]

        def submit_work(command_type, suffix, arguments):
            current = _handle(
                runtime, _request("assignment.snapshot", "assignment.snapshot.read")
            )
            current_assignment = current["result"]["assignments"][0]
            work_command = _command(
                current["revision"],
                command_id=f"command.{suffix}",
                idempotency_key=f"idem.{suffix}",
                command_type=command_type,
                expected_phase=current_assignment["phase"],
                to_phase="executing",
            )
            work_command["attempt"] = current_assignment["attempt"]
            work_command["lease"] = current_assignment["lease"]
            work_command["arguments"] = arguments
            response = _handle(
                runtime,
                _request(
                    "command.submit",
                    "assignment.command.submit",
                    payload=work_command,
                    request_id=f"request.{suffix}",
                ),
            )
            assert response["status"] == "ok", json.dumps(response, indent=2)
            return response["result"]["authorityReceipt"]["result"]["coreReceipt"]

        submit_work(
            "assignment.stage",
            "execute",
            {
                "actor": "agent-a",
                "reason": "enter the generic Work protocol",
                "expectedPhase": "claimed",
                "toPhase": "executing",
            },
        )
        before_input = _handle(
            runtime, _request("assignment.snapshot", "assignment.snapshot.read")
        )
        input_receipt = submit_work(
            "work.input.snapshot",
            "input",
            {
                "snapshotId": "snapshot-a",
                "inputRoot": ROOT_A,
                "actor": "agent-a",
                "evidenceRoots": [ROOT_B],
            },
        )
        input_root = input_receipt["record"]["record_root"]

        stale_command = _command(
            before_input["revision"],
            command_id="command.stale-run",
            idempotency_key="idem.stale-run",
            command_type="work.run.record",
        )
        stale_command["attempt"] = assignment["attempt"]
        stale_command["lease"] = assignment["lease"]
        stale_command["arguments"] = {
            "runId": "run-stale",
            "inputSnapshotRoot": input_root,
            "role": "executor",
            "resultState": "succeeded",
            "resultRoot": ROOT_B,
            "actor": "agent-a",
        }
        stale = _handle(
            runtime,
            _request(
                "command.submit",
                "assignment.command.submit",
                payload=stale_command,
                request_id="request.stale-run",
            ),
        )
        assert stale["error"]["code"] == "stale-revision"

        managed_run = submit_work(
            "work.run.record",
            "run",
            {
                "runId": "run-a",
                "inputSnapshotRoot": input_root,
                "role": "executor",
                "resultState": "succeeded",
                "resultRoot": ROOT_B,
                "actor": "agent-a",
                "evidenceRoots": [ROOT_A],
            },
        )
        authorization = submit_work(
            "work.effect.authorize",
            "authorize",
            {
                "authorizationId": "authorization-a",
                "effectId": "effect-a",
                "effectKind": "external-delivery",
                "inputSnapshotRoot": input_root,
                "scopeRoot": ROOT_A,
                "actor": "agent-a",
                "evidenceRoots": [ROOT_B],
            },
        )
        effect_attempt = submit_work(
            "work.effect.attempt",
            "effect-attempt",
            {
                "effectAttemptId": "effect-attempt-a",
                "authorizationRoot": authorization["record"]["record_root"],
                "transportRequestRoot": ROOT_B,
                "actor": "agent-a",
            },
        )
        ambiguous_outcome = submit_work(
            "work.effect.outcome",
            "ambiguous-outcome",
            {
                "effectAttemptRoot": effect_attempt["record"]["record_root"],
                "transportState": "accepted",
                "businessState": "unknown",
                "outcomeRoot": ROOT_A,
                "actor": "agent-a",
                "evidenceRoots": [ROOT_B],
            },
        )
        ambiguous = _handle(
            runtime, _request("assignment.snapshot", "assignment.snapshot.read")
        )["result"]["assignments"][0]["lifecycle"]["work_semantics"]
        assert ambiguous["blind_retry_allowed"] is False
        assert ambiguous["next_actions"] == [
            {
                "action": "reconcile-effect-outcome",
                "reason": "business-outcome-unrecorded",
            }
        ]

        settled_outcome = submit_work(
            "work.effect.outcome",
            "settled-outcome",
            {
                "effectAttemptRoot": effect_attempt["record"]["record_root"],
                "transportState": "accepted",
                "businessState": "accepted",
                "outcomeRoot": ROOT_B,
                "actor": "agent-a",
                "evidenceRoots": [ROOT_A],
            },
        )
        settled = _handle(
            runtime, _request("assignment.snapshot", "assignment.snapshot.read")
        )["result"]["assignments"][0]["lifecycle"]["work_semantics"]
        assert settled["completion_eligible"] is True
        settled_root = settled["effect_outcomes"][-1]["record_root"]

        expired_projection = profile_sdk.invoke_member_adapter(
            PROFILE_SOURCE,
            runtime_dir,
            "work-control-actions",
            "assignment-status",
            {
                "initiativeId": "initiative-a",
                "assignmentId": "assignment-a",
                "source": "kungfu",
                "now": "2999-01-01T00:00:00Z",
            },
            authorized_action=False,
            inactive_projection_read=True,
        )["result"]
        assert expired_projection["phase"] == "executing"
        assert expired_projection["active_lease"] is None

        before_completion = _handle(
            runtime, _request("assignment.snapshot", "assignment.snapshot.read")
        )
        completion = _command(
            before_completion["revision"],
            command_id="command.completion-after-recovery",
            idempotency_key="idem.completion-after-recovery",
            command_type="assignment.completion.claim",
            expected_phase="executing",
            to_phase="completion-claimed",
        )
        completion["attempt"] = None
        completion["lease"] = None
        completion["arguments"] = {
            "statement": "Complete through retained Work Control authority",
            "actor": "agent-a",
            "evidenceEpisodeIds": [],
            "assignmentSet": ["assignment-a"],
            "proofRoots": [
                input_root,
                managed_run["record"]["record_root"],
                ambiguous_outcome["record"]["record_root"],
                settled_outcome["record"]["record_root"],
            ],
        }
        completed = _handle(
            runtime,
            _request(
                "command.submit",
                "assignment.command.submit",
                payload=completion,
                request_id="request.completion-after-recovery",
            ),
        )
        assert completed["status"] == "ok", json.dumps(completed, indent=2)
        completed_status = _handle(
            runtime, _request("assignment.snapshot", "assignment.snapshot.read")
        )["result"]["assignments"][0]
        assert completed_status["phase"] == "completion-claimed"
        assert completed_status["lifecycle"]["completion_claim_count"] == 1

    with EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
    ) as restarted:
        restored = _handle(
            restarted, _request("assignment.snapshot", "assignment.snapshot.read")
        )["result"]["assignments"][0]["lifecycle"]["work_semantics"]
        assert restored["completion_eligible"] is True
        assert restored["effect_outcomes"][-1]["record_root"] == settled_root

    assert runtime_dir.is_relative_to(home)


__all__ = [name for name in globals() if name.startswith("test_")]
