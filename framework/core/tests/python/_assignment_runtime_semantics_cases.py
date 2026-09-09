# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from _assignment_runtime_support import *  # noqa: F403


# The stable facade is the only pytest collection surface.
def test_embedded_discovery_and_reads_keep_exact_root_parity(local_runtime):
    runtime, _authority, runtime_dir = local_runtime
    discovery = _handle(
        runtime,
        _request(
            "capabilities.discover",
            "assignment.capabilities.discover",
            client_kind="agent",
        ),
    )
    assert discovery["result"]["transports"] == {
        "supported": ["embedded"],
        "unavailable": ["loopback"],
        "outOfScope": ["cluster"],
    }
    assert discovery["result"]["protocol"]["minimumVersion"] == 1
    assert discovery["result"]["protocol"]["maximumVersion"] == 1

    roots = []
    for kind in ("gui", "cli", "agent", "kfx"):
        response = _handle(
            runtime,
            _request(
                "assignment.snapshot",
                "assignment.snapshot.read",
                request_id=f"snapshot.{kind}",
                client_kind=kind,
            ),
        )
        roots.append(response["revision"]["root"])
        assert response["factRefs"][0]["factRoot"].startswith("sha256:")
        assert ".kungfu" not in json.dumps(response)
        assert str(runtime_dir) not in json.dumps(response)
    assert len(set(roots)) == 1

    listed = _handle(
        runtime,
        _request(
            "assignment.list", "assignment.list.read", payload={"phase": "admitted"}
        ),
    )
    assert [row["assignmentId"] for row in listed["result"]["assignments"]] == [
        "assignment-a"
    ]
    fetched = _handle(
        runtime,
        _request(
            "assignment.get",
            "assignment.get.read",
            payload={"initiativeId": "initiative-a", "assignmentId": "assignment-a"},
        ),
    )
    assert fetched["result"]["assignment"]["phase"] == "admitted"
    queried = _handle(
        runtime,
        _request(
            "assignment.query",
            "assignment.query.read",
            payload={"initiativeId": "initiative-a"},
        ),
    )
    assert queried["result"]["queryRoot"].startswith("sha256:")


def test_typed_embedded_client_preserves_envelopes_roots_and_receipts(local_runtime):
    runtime, authority, _runtime_dir = local_runtime
    client = EmbeddedAssignmentRuntimeClient(
        runtime, client_id="r1.test-client", kind="test"
    )
    discovery = client.discover()
    assert discovery["result"]["transports"]["supported"] == ["embedded"]
    snapshot = client.snapshot()
    listed = client.list_assignments({"initiativeId": "initiative-a"})
    fetched = client.get_assignment("initiative-a", "assignment-a")
    queried = client.query_assignments({"phase": "admitted"})
    assert listed["revision"] == snapshot["revision"]
    assert fetched["revision"] == snapshot["revision"]
    assert queried["revision"] == snapshot["revision"]
    watched = client.watch(runtime.genesis_cursor(REALM["generation"]))
    assert watched["status"] == "ok"

    command = _command(snapshot["revision"])
    applied = client.submit(command)
    inspected = client.inspect_command(command_id=command["commandId"])
    assert (
        inspected["result"]["command"]["receiptRoot"]
        == applied["receipts"][0]["receiptRoot"]
    )
    assert client.diagnostics()["status"] == "ok"
    assert client.recovery_plan()["result"]["status"] == "not-required"
    assert len(authority._read()["effects"]) == 1


@pytest.mark.parametrize("attempt_id", [None, "attempt-r3"])
def test_cli_agent_and_kfx_application_edges_share_runtime_state(
    tmp_path, monkeypatch, attempt_id
):
    runtime_dir = tmp_path / ".kungfu" / "runtime"
    runtime_dir.parent.mkdir(parents=True)
    (runtime_dir.parent / "workspace-identity.json").write_text(
        json.dumps(
            {
                "schema": "kungfu.workspace.identity-material/v1",
                "workspaceKind": "project",
                "workspaceKey": "workspace:test",
                "identityRoot": ROOT_A,
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    authority = FakeAuthority(runtime_dir)

    def application(kind: str) -> LocalAssignmentRuntimeApplication:
        app = LocalAssignmentRuntimeApplication(
            runtime_dir,
            client_id=f"kungfu.{kind}.test",
            kind=kind,
            source=PROFILE_SOURCE,
        )
        monkeypatch.setattr(
            app,
            "_runtime",
            lambda: EmbeddedLocalAssignmentRuntime(
                runtime_dir,
                realm_id=f"project:{ROOT_A[7:23]}",
                generation=ROOT_A,
                authority=authority,
                contract=ASSIGNMENT_RUNTIME_CONTRACT,
                request_schema=ENVELOPE_SCHEMA,
            ),
        )
        return app

    cli = application("cli")
    agent = application("agent")
    kfx = application("kfx")
    assert cli.status("initiative-a", "assignment-a") == agent.status(
        "initiative-a", "assignment-a"
    )
    assert kfx.status("initiative-a", "assignment-a")["phase"] == "admitted"

    expires = (
        (datetime.now(UTC) + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    )
    claim_values = {
        "initiativeId": "initiative-a",
        "assignmentId": "assignment-a",
        "leaseId": "lease-r3",
        "leaseExpiresAt": expires,
        "owner": "owner-r3",
        "agent": "agent-r3",
        "slot": "slot-r3",
        "authorizedBy": "owner-r3",
    }
    if attempt_id is None:
        expected_attempt_id = (
            "attempt:"
            + _root(
                {
                    "intentId": "claim-assignment",
                    "arguments": claim_values,
                    "authorizedBy": "owner-r3",
                }
            )[7:39]
        )
    else:
        claim_values["attemptId"] = attempt_id
        expected_attempt_id = attempt_id
    claimed = cli.authorize("claim-assignment", claim_values, "owner-r3")
    assert claimed["status"] == "admitted"
    assert authority._read()["attempt"]["attemptId"] == expected_attempt_id
    advanced = agent.authorize(
        "advance-assignment",
        {
            "initiativeId": "initiative-a",
            "assignmentId": "assignment-a",
            "expectedPhase": "claimed",
            "toPhase": "executing",
            "actor": "agent-r3",
            "reason": "prove the shared Runtime application edge",
        },
        "agent-r3",
    )
    assert advanced["status"] == "admitted"
    assert kfx.status("initiative-a", "assignment-a")["phase"] == "executing"

    state = json.loads(
        (runtime_dir / "assignment-runtime" / "local-v1" / "state.json").read_text(
            encoding="utf-8"
        )
    )
    assert len(state["commands"]) == 2
    assert all(record["authorityReceipt"] for record in state["commands"].values())


def test_application_status_does_not_compete_with_active_runtime_writer(
    tmp_path, monkeypatch
):
    runtime_dir = tmp_path / ".kungfu" / "runtime"
    runtime_dir.parent.mkdir(parents=True)
    (runtime_dir.parent / "workspace-identity.json").write_text(
        json.dumps(
            {
                "schema": "kungfu.workspace.identity-material/v1",
                "workspaceKind": "project",
                "workspaceKey": "workspace:test",
                "identityRoot": ROOT_A,
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    authority = FakeAuthority(runtime_dir)

    def runtime():
        return EmbeddedLocalAssignmentRuntime(
            runtime_dir,
            realm_id=f"project:{ROOT_A[7:23]}",
            generation=ROOT_A,
            authority=authority,
            contract=ASSIGNMENT_RUNTIME_CONTRACT,
            request_schema=ENVELOPE_SCHEMA,
        )

    writer = runtime().start()
    try:
        state_path = runtime_dir / "assignment-runtime" / "local-v1" / "state.json"
        before = state_path.read_bytes()
        application = LocalAssignmentRuntimeApplication(
            runtime_dir,
            client_id="kungfu.cli.test",
            kind="cli",
            source=PROFILE_SOURCE,
        )
        monkeypatch.setattr(application, "_runtime", runtime)

        assert application.status("initiative-a", "assignment-a")["phase"] == "admitted"
        assert writer._started is True
        assert state_path.read_bytes() == before
    finally:
        writer.close()


def test_work_control_status_uses_direct_read_only_profile_query(tmp_path, monkeypatch):
    authority = WorkControlAuthority(tmp_path, source=PROFILE_SOURCE)
    lifecycle = {"phase": "executing", "query_proof_root": ROOT_A}
    captured = {}

    def invoke(operation, values, *, write=False):
        captured.update(operation=operation, values=values, write=write)
        return {"result": lifecycle}

    monkeypatch.setattr(authority, "_invoke", invoke)

    assert authority.assignment_status("initiative-a", "assignment-a") == lifecycle
    assert captured == {
        "operation": "assignment-status",
        "values": {
            "initiativeId": "initiative-a",
            "assignmentId": "assignment-a",
            "source": "kungfu",
        },
        "write": False,
    }


def test_work_control_authority_strips_runtime_only_routing_ids(tmp_path, monkeypatch):
    authority = WorkControlAuthority(tmp_path, source=PROFILE_SOURCE)
    captured = {}

    def invoke(operation, values, *, write=False):
        captured.update(operation=operation, values=values, write=write)
        return {"result": {"coreReceipt": {"status": "imported"}}}

    monkeypatch.setattr(authority, "_invoke", invoke)
    result = authority.apply(
        {
            "type": "assignment.atlas.import",
            "target": {
                "initiativeId": "runtime:initiative:route",
                "assignmentId": "runtime:assignment:route",
            },
            "arguments": {
                "_runtimeInitiativeId": "runtime:initiative:route",
                "_runtimeAssignmentId": "runtime:assignment:route",
                "repo": "/repo",
                "source": "atlas",
            },
        }
    )
    assert captured == {
        "operation": "import-atlas",
        "values": {"repo": "/repo", "source": "atlas"},
        "write": True,
    }
    assert result["authorityReceipt"]["result"]["coreReceipt"]["status"] == "imported"


def test_work_control_authority_normalizes_legacy_completion_context_roots(
    tmp_path, monkeypatch
):
    authority = WorkControlAuthority(tmp_path, source=PROFILE_SOURCE)
    captured = {}

    def invoke(
        _source,
        _runtime,
        member,
        operation,
        values,
        *,
        authorized_action,
        inactive_projection_read,
    ):
        captured.update(
            member=member,
            operation=operation,
            values=values,
            write=authorized_action,
            inactiveProjectionRead=inactive_projection_read,
        )
        return {"result": {"coreReceipt": {"status": "admitted"}}}

    monkeypatch.setattr(authority, "_profile_source", lambda: str(PROFILE_SOURCE))
    monkeypatch.setattr(profile_sdk, "invoke_member_adapter", invoke)
    command = {
        "type": "assignment.completion.claim",
        "target": {
            "initiativeId": "initiative-a",
            "assignmentId": "assignment-a",
        },
        "arguments": {
            "inputAtlasRoot": ROOT_A,
            "resultAtlasRoot": ROOT_B,
        },
    }

    authority.apply(command)

    assert command["arguments"] == {
        "inputAtlasRoot": ROOT_A,
        "resultAtlasRoot": ROOT_B,
    }
    assert captured == {
        "member": "work-control-actions",
        "operation": "claim-completion",
        "values": {
            "initiativeId": "initiative-a",
            "assignmentId": "assignment-a",
            "inputContextRoot": ROOT_A,
            "resultContextRoot": ROOT_B,
        },
        "write": True,
        "inactiveProjectionRead": False,
    }


def test_work_semantics_commands_bind_exact_runtime_attempt_and_lease(
    tmp_path, monkeypatch
):
    authority = WorkControlAuthority(tmp_path, source=PROFILE_SOURCE)
    captured = {}

    def invoke(
        _source,
        _runtime,
        member,
        operation,
        values,
        *,
        authorized_action,
        inactive_projection_read,
    ):
        captured.update(
            member=member,
            operation=operation,
            values=values,
            write=authorized_action,
            inactiveProjectionRead=inactive_projection_read,
        )
        return {"result": {"coreReceipt": {"status": "admitted"}}}

    monkeypatch.setattr(authority, "_profile_source", lambda: str(PROFILE_SOURCE))
    monkeypatch.setattr(profile_sdk, "invoke_member_adapter", invoke)
    command = {
        "type": "work.input.snapshot",
        "target": {
            "initiativeId": "initiative-a",
            "assignmentId": "assignment-a",
        },
        "attempt": {"attemptId": "attempt-a", "state": "executing"},
        "lease": {"leaseId": "lease-a", "state": "active"},
        "arguments": {
            "snapshotId": "snapshot-a",
            "inputRoot": ROOT_A,
            "actor": "agent-a",
        },
    }

    authority.apply(command)

    assert captured == {
        "member": "work-control-actions",
        "operation": "work-input-snapshot",
        "values": {
            "initiativeId": "initiative-a",
            "assignmentId": "assignment-a",
            "snapshotId": "snapshot-a",
            "inputRoot": ROOT_A,
            "actor": "agent-a",
            "attemptId": "attempt-a",
            "leaseId": "lease-a",
        },
        "write": True,
        "inactiveProjectionRead": False,
    }


def test_work_control_authority_binds_attempt_from_active_lease():
    status = {
        "phase": "executing",
        "execution_claims": [
            {"attempt_id": "attempt-new", "claim_id": "claim-new"},
            {"attempt_id": "attempt-middle", "claim_id": "claim-middle"},
            {"attempt_id": "attempt-old", "claim_id": "claim-old"},
        ],
        "active_lease": {
            "attempt_id": "attempt-new",
            "claim_id": "claim-new",
            "lease_id": "lease-new",
        },
    }

    assert WorkControlAuthority._attempt(status) == {
        "attemptId": "attempt-new",
        "claimId": "claim-new",
        "state": "executing",
    }


def test_work_control_authority_rejects_active_lease_without_exact_attempt():
    status = {
        "phase": "executing",
        "execution_claims": [
            {"attempt_id": "attempt-old", "claim_id": "claim-old"},
        ],
        "active_lease": {
            "attempt_id": "attempt-new",
            "claim_id": "claim-new",
            "lease_id": "lease-new",
        },
    }

    with pytest.raises(LocalRuntimeError, match="does not bind exactly one") as error:
        WorkControlAuthority._attempt(status)

    assert error.value.code == "ambiguous-identity"


def test_work_semantics_projection_invalidates_stale_inputs_and_forbids_blind_retry():
    domain_path = PROFILE_SOURCE / "work-control-actions" / "domain"
    package_name = "test_work_semantics_domain"
    package = types.ModuleType(package_name)
    package.__path__ = [str(domain_path)]
    sys.modules[package_name] = package
    sys.modules[f"{package_name}.work_control_runtime"] = types.ModuleType(
        f"{package_name}.work_control_runtime"
    )
    spec = importlib.util.spec_from_file_location(
        f"{package_name}.work_semantics", domain_path / "work_semantics.py"
    )
    assert spec is not None and spec.loader is not None
    semantics = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = semantics
    spec.loader.exec_module(semantics)
    project = semantics.project
    lease = {"attempt_id": "attempt-a", "lease_id": "lease-a"}
    snapshot_a = {
        "record_type": "work-input-snapshot",
        "record_root": ROOT_A,
        "recorded_at_system_time": 1,
    }
    run_a = {
        "record_type": "work-managed-run",
        "record_root": ROOT_B,
        "input_snapshot_root": ROOT_A,
        "result_state": "succeeded",
        "recorded_at_system_time": 2,
    }
    authorization_a = {
        "record_type": "work-effect-authorization",
        "record_root": "sha256:" + "c" * 64,
        "effect_id": "effect-a",
        "input_snapshot_root": ROOT_A,
        "recorded_at_system_time": 3,
    }
    attempt_a = {
        "record_type": "work-effect-attempt",
        "record_root": "sha256:" + "d" * 64,
        "authorization_root": authorization_a["record_root"],
        "recorded_at_system_time": 4,
    }
    ambiguous = {
        "record_type": "work-effect-outcome",
        "record_root": "sha256:" + "e" * 64,
        "effect_attempt_root": attempt_a["record_root"],
        "transport_state": "accepted",
        "business_state": "unknown",
        "recorded_at_system_time": 5,
    }
    status = project(
        [snapshot_a, run_a, authorization_a, attempt_a, ambiguous],
        phase="executing",
        active_lease=lease,
        query_proof_root=ROOT_A,
    )
    assert status["blind_retry_allowed"] is False
    assert status["completion_eligible"] is False
    assert status["next_actions"] == [
        {
            "action": "reconcile-effect-outcome",
            "reason": "business-outcome-unrecorded",
        }
    ]

    snapshot_b = {
        "record_type": "work-input-snapshot",
        "record_root": "sha256:" + "f" * 64,
        "recorded_at_system_time": 6,
    }
    invalidated = project(
        [snapshot_a, run_a, authorization_a, attempt_a, ambiguous, snapshot_b],
        phase="executing",
        active_lease=lease,
        query_proof_root=ROOT_B,
    )
    assert invalidated["current_input_snapshot"] == snapshot_b
    assert invalidated["managed_runs"] == []
    assert invalidated["effect_authorizations"] == []
    assert invalidated["next_actions"] == [
        {"action": "record-managed-run", "reason": "current-input-not-executed"}
    ]


def test_work_semantics_fault_matrix_rejects_stale_attempt_lease_and_input(
    monkeypatch,
):
    domain_path = PROFILE_SOURCE / "work-control-actions" / "domain"
    package_name = "test_work_semantics_fault_domain"
    package = types.ModuleType(package_name)
    package.__path__ = [str(domain_path)]
    sys.modules[package_name] = package
    runtime_module = types.ModuleType(f"{package_name}.work_control_runtime")
    sys.modules[runtime_module.__name__] = runtime_module
    spec = importlib.util.spec_from_file_location(
        f"{package_name}.work_semantics", domain_path / "work_semantics.py"
    )
    assert spec is not None and spec.loader is not None
    semantics = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = semantics
    spec.loader.exec_module(semantics)
    lifecycle = {
        "phase": "executing",
        "active_lease": {
            "attempt_id": "attempt-current",
            "lease_id": "lease-current",
            "agent": "agent-a",
        },
    }
    monkeypatch.setattr(
        runtime_module,
        "assignment_orchestration_status",
        lambda *_args, **_kwargs: lifecycle,
        raising=False,
    )
    monkeypatch.setattr(
        runtime_module,
        "_root_id",
        lambda value, *_args, **_kwargs: value,
        raising=False,
    )
    common = {
        "runtime_dir": "/fixture",
        "initiative_id": "initiative-a",
        "assignment_id": "assignment-a",
        "snapshot_id": "snapshot-a",
        "input_root": ROOT_A,
        "actor": "agent-a",
    }
    with pytest.raises(ValueError, match="attempt changed"):
        semantics.record_input_snapshot(
            **common,
            attempt_id="attempt-stale",
            lease_id="lease-current",
        )
    with pytest.raises(ValueError, match="lease changed"):
        semantics.record_input_snapshot(
            **common,
            attempt_id="attempt-current",
            lease_id="lease-stale",
        )

    monkeypatch.setattr(
        semantics,
        "_execution_context",
        lambda *_args, **_kwargs: {
            **lifecycle,
            "work_semantics": {"current_input_snapshot": {"record_root": ROOT_A}},
        },
    )
    with pytest.raises(ValueError, match="input snapshot changed"):
        semantics.record_managed_run(
            runtime_dir="/fixture",
            initiative_id="initiative-a",
            assignment_id="assignment-a",
            attempt_id="attempt-current",
            lease_id="lease-current",
            run_id="run-a",
            input_snapshot_root=ROOT_B,
            role="executor",
            result_state="succeeded",
            result_root=ROOT_A,
            actor="agent-a",
        )


def test_work_control_authority_rejects_conflicting_completion_context_roots(
    tmp_path, monkeypatch
):
    authority = WorkControlAuthority(tmp_path, source=PROFILE_SOURCE)
    invoked = False

    def invoke(*_args, **_kwargs):
        nonlocal invoked
        invoked = True
        return {}

    monkeypatch.setattr(profile_sdk, "invoke_member_adapter", invoke)

    with pytest.raises(LocalRuntimeError, match="Conflicting inputAtlasRoot"):
        authority.apply(
            {
                "type": "assignment.completion.claim",
                "target": {
                    "initiativeId": "initiative-a",
                    "assignmentId": "assignment-a",
                },
                "arguments": {
                    "inputAtlasRoot": ROOT_A,
                    "inputContextRoot": ROOT_B,
                },
            }
        )

    assert invoked is False


def test_work_control_authority_projects_adapter_value_errors_as_invalid_commands(
    tmp_path, monkeypatch
):
    authority = WorkControlAuthority(tmp_path, source=PROFILE_SOURCE)

    def invoke(*_args, **_kwargs):
        cause = ValueError("independent review changed before continuation decision")
        raise profile_sdk.ProfileSdkError(
            "member-adapter-invoke-failed", str(cause)
        ) from cause

    monkeypatch.setattr(authority, "_profile_source", lambda: str(PROFILE_SOURCE))
    monkeypatch.setattr(profile_sdk, "invoke_member_adapter", invoke)

    with pytest.raises(
        LocalRuntimeError,
        match="independent review changed before continuation decision",
    ) as raised:
        authority.apply(
            {
                "type": "assignment.continuation.decide",
                "target": {
                    "initiativeId": "initiative-a",
                    "assignmentId": "assignment-a",
                },
                "arguments": {},
            }
        )

    assert raised.value.code == "invalid-command"
    assert raised.value.details == {"operation": "decide-continuation"}


def test_work_control_authority_snapshot_avoids_atlas_parity(tmp_path, monkeypatch):
    authority = WorkControlAuthority(tmp_path, source=PROFILE_SOURCE)
    operations = []

    def invoke(operation, values, *, write=False):
        operations.append((operation, values, write))
        if operation == "portfolio":
            return {
                "result": {"assignments": []},
                "profileSuiteRoot": "sha256:" + "1" * 64,
                "memberRoot": "sha256:" + "2" * 64,
            }
        assert operation == "runtime-authority-status"
        return {
            "result": {
                "authority": {
                    "state": "native-only",
                    "write_authority": "kungfu-native",
                }
            }
        }

    monkeypatch.setattr(authority, "_invoke", invoke)
    snapshot = authority.inspect()

    assert operations == [
        ("portfolio", {}, False),
        ("runtime-authority-status", {}, False),
    ]
    assert snapshot["authority"] == {
        "profileId": "kungfu.work-control",
        "profileSuiteRoot": "sha256:" + "1" * 64,
        "memberRoot": "sha256:" + "2" * 64,
        "state": "native-only",
        "writeAuthority": "kungfu-native",
    }


__all__ = [name for name in globals() if name.startswith("test_")]
