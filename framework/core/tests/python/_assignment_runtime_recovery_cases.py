# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from _assignment_runtime_support import *  # noqa: F403


# The stable facade is the only pytest collection surface.
def test_command_cas_idempotency_attempt_lease_warrant_and_receipts(local_runtime):
    runtime, authority, _runtime_dir = local_runtime
    snapshot = _handle(
        runtime, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    command = _command(snapshot["revision"])
    applied = _handle(
        runtime,
        _request(
            "command.submit",
            "assignment.command.submit",
            payload=command,
            request_id="submit.claim",
        ),
    )
    assert applied["result"]["command"]["disposition"] == "applied"
    assert applied["attempt"] == command["attempt"]
    assert applied["lease"] == command["lease"]
    assert applied["warrant"] == command["warrant"]
    assert applied["episodeRefs"] == [{"episodeRoot": ROOT_A}]
    assert len(applied["receipts"]) == 1
    assert authority._read()["phase"] == "claimed"

    replay = _handle(
        runtime,
        _request(
            "command.submit",
            "assignment.command.submit",
            payload=command,
            request_id="submit.claim.replay",
        ),
    )
    assert replay["result"]["command"]["disposition"] == "replayed"
    assert replay["receipts"] == applied["receipts"]
    assert len(authority._read()["effects"]) == 1

    conflict = copy.deepcopy(command)
    conflict["commandId"] = "command.conflict"
    conflict["arguments"]["reason"] = "different body"
    rejected = _handle(
        runtime,
        _request(
            "command.submit",
            "assignment.command.submit",
            payload=conflict,
            request_id="submit.claim.conflict",
        ),
    )
    assert rejected["error"]["code"] == "idempotency-conflict"

    stale = _command(
        snapshot["revision"],
        command_id="command.stage.stale",
        idempotency_key="idem.stage.stale",
        command_type="assignment.stage",
        expected_phase="claimed",
        to_phase="executing",
    )
    rejected = _handle(
        runtime,
        _request(
            "command.submit",
            "assignment.command.submit",
            payload=stale,
            request_id="submit.stage.stale",
        ),
    )
    assert rejected["error"]["code"] == "stale-revision"


def test_concurrent_duplicate_commands_apply_exactly_once(local_runtime):
    runtime, authority, _runtime_dir = local_runtime
    snapshot = _handle(
        runtime, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    command = _command(snapshot["revision"])

    def submit(index: int) -> dict[str, Any]:
        return _handle(
            runtime,
            _request(
                "command.submit",
                "assignment.command.submit",
                payload=command,
                request_id=f"submit.concurrent.{index}",
            ),
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(submit, range(8)))

    dispositions = [row["result"]["command"]["disposition"] for row in responses]
    assert dispositions.count("applied") == 1
    assert dispositions.count("replayed") == 7
    assert len({row["receipts"][0]["receiptRoot"] for row in responses}) == 1
    assert len(authority._read()["effects"]) == 1


def test_stage_rejects_expired_or_non_authoritative_lease(local_runtime):
    runtime, authority, _runtime_dir = local_runtime
    admitted = _handle(
        runtime, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    expired = _command(admitted["revision"])
    expired["lease"]["expiresAt"] = "2000-01-01T00:00:00Z"
    rejected = _handle(
        runtime,
        _request(
            "command.submit",
            "assignment.command.submit",
            payload=expired,
            request_id="submit.expired",
        ),
    )
    assert rejected["error"]["code"] == "lease-required"
    assert authority._read()["effects"] == []

    claim = _command(admitted["revision"])
    _handle(
        runtime,
        _request(
            "command.submit",
            "assignment.command.submit",
            payload=claim,
            request_id="submit.claim.authoritative",
        ),
    )
    claimed = _handle(
        runtime, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    stage = _command(
        claimed["revision"],
        command_id="command.stage.wrong-lease",
        idempotency_key="idem.stage.wrong-lease",
        command_type="assignment.stage",
        expected_phase="claimed",
        to_phase="executing",
    )
    stage["lease"]["leaseId"] = "lease-other"
    rejected = _handle(
        runtime,
        _request(
            "command.submit",
            "assignment.command.submit",
            payload=stage,
            request_id="submit.stage.wrong-lease",
        ),
    )
    assert rejected["error"]["code"] == "lease-required"
    assert authority._read()["phase"] == "claimed"
    assert len(authority._read()["effects"]) == 1


def test_negative_fences_bypass_capabilities_and_authority_fail_closed(local_runtime):
    runtime, authority, _runtime_dir = local_runtime
    wrong_generation = _request(
        "assignment.snapshot",
        "assignment.snapshot.read",
        realm={**REALM, "generation": "gen-old"},
    )
    assert _handle(runtime, wrong_generation)["error"]["code"] == "generation-fenced"

    malformed = _request("assignment.get", "assignment.get.read")
    malformed["realm"]["realmId"] = ""
    response = runtime.handle(malformed)
    assert response["error"]["code"] == "malformed-identity"

    unsupported = _request(
        "capabilities.discover",
        "assignment.cluster.rebalance",
        client_kind="kfx",
    )
    response = runtime.handle(unsupported)
    assert response["error"]["code"] == "unsupported-capability"

    snapshot = _handle(
        runtime, _request("assignment.snapshot", "assignment.snapshot.read")
    )
    bypass = _command(snapshot["revision"])
    bypass["idempotencyKey"] = "idem.bypass"
    bypass["commandId"] = "command.bypass"
    bypass["arguments"]["directStorageMutation"] = {"storagePath": "private"}
    rejected = _handle(
        runtime,
        _request("command.submit", "assignment.command.submit", payload=bypass),
    )
    assert rejected["error"]["code"] == "authority-bypass"
    assert authority._read()["phase"] == "admitted"

    bad_warrant = _command(
        snapshot["revision"],
        command_id="command.bad-warrant",
        idempotency_key="idem.bad-warrant",
        warrant_state="revoked",
    )
    rejected = _handle(
        runtime,
        _request("command.submit", "assignment.command.submit", payload=bad_warrant),
    )
    assert rejected["error"]["code"] == "warrant-invalid"

    authority.unavailable = True
    response = runtime.handle(
        _request("assignment.snapshot", "assignment.snapshot.read", request_id="down")
    )
    assert response["error"]["code"] == "backend-unavailable"
    authority.unavailable = False

    authority.ambiguous = True
    response = runtime.handle(
        _request(
            "assignment.snapshot", "assignment.snapshot.read", request_id="ambiguous"
        )
    )
    assert response["error"]["code"] == "ambiguous-identity"


def test_second_writer_startup_is_rejected(tmp_path):
    runtime_dir = tmp_path / "home" / ".kungfu" / "runtime"
    authority = FakeAuthority(runtime_dir)
    first = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    second = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    )
    try:
        with pytest.raises(LocalRuntimeError) as raised:
            second.start()
        assert raised.value.code == "ambiguous-identity"
    finally:
        first.close()


def test_watch_reconnect_and_resume_gap_are_explicit(tmp_path):
    runtime_dir = tmp_path / "home" / ".kungfu" / "runtime"
    authority = FakeAuthority(runtime_dir)
    runtime = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
        event_retention=2,
    ).start()
    genesis = runtime.genesis_cursor(REALM["generation"])
    first = _handle(
        runtime,
        _request(
            "events.watch",
            "assignment.events.watch",
            cursor=genesis,
            request_id="watch.first",
        ),
    )
    assert first["result"]["events"][0]["schema"] == EVENT_SCHEMA
    retained_cursor = first["cursor"]
    runtime.close()

    reconnected = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
        event_retention=2,
    ).start()
    try:
        resumed = _handle(
            reconnected,
            _request(
                "events.watch",
                "assignment.events.watch",
                cursor=retained_cursor,
                request_id="watch.reconnected",
            ),
        )
        assert resumed["status"] == "ok"
        for index in range(3):
            authority.external_change()
            _handle(
                reconnected,
                _request(
                    "assignment.snapshot",
                    "assignment.snapshot.read",
                    request_id=f"snapshot.external.{index}",
                ),
            )
        gap = _handle(
            reconnected,
            _request(
                "events.watch",
                "assignment.events.watch",
                cursor=retained_cursor,
                request_id="watch.gap",
            ),
        )
        assert gap["error"]["code"] == "event-resume-gap"
        assert "recoverySnapshotRevision" in gap["error"]["details"]
    finally:
        reconnected.close()


@pytest.mark.parametrize("fault_point", ["after-intent", "after-authority-result"])
def test_restart_deterministically_recovers_durable_interrupted_commands(
    tmp_path, fault_point
):
    runtime_dir = tmp_path / fault_point / ".kungfu" / "runtime"
    authority = FakeAuthority(runtime_dir)

    def crash(point: str) -> None:
        if point == fault_point:
            raise RuntimeError(f"simulated crash at {point}")

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
    with pytest.raises(RuntimeError, match="simulated crash"):
        crashed.handle(
            _request("command.submit", "assignment.command.submit", payload=command)
        )
    crashed.close()

    recovered = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    ).start()
    try:
        replay = _handle(
            recovered,
            _request(
                "command.submit",
                "assignment.command.submit",
                payload=command,
                request_id=f"replay.{fault_point}",
            ),
        )
        assert replay["result"]["command"]["disposition"] == "replayed"
        inspected = _handle(
            recovered,
            _request(
                "command.get",
                "assignment.command.inspect",
                payload={"commandId": command["commandId"]},
            ),
        )
        assert inspected["result"]["command"]["recovered"] is True
        assert len(authority._read()["effects"]) == 1
    finally:
        recovered.close()


def test_restart_recovers_legacy_completion_roots_without_rewriting_command_identity(
    tmp_path, monkeypatch
):
    runtime_dir = tmp_path / "legacy-completion-roots" / ".kungfu" / "runtime"
    authority = WorkControlAuthority(runtime_dir, source=PROFILE_SOURCE)
    native_state = {"phase": "stage-ready"}
    claim_values = []

    def invoke(
        _source,
        _runtime,
        _member,
        operation,
        values,
        *,
        authorized_action=False,
        inactive_projection_read=False,
    ):
        assert inactive_projection_read is (not authorized_action)
        if operation == "portfolio":
            return {
                "result": {
                    "assignments": [
                        {
                            "initiative_id": "initiative-a",
                            "assignment_id": "assignment-a",
                            "status": native_state["phase"],
                        }
                    ]
                },
                "profileSuiteRoot": ROOT_A,
                "memberRoot": ROOT_B,
            }
        if operation == "assignment-status":
            return {
                "result": {
                    "phase": native_state["phase"],
                    "execution_claims": [],
                    "active_lease": None,
                }
            }
        if operation == "runtime-authority-status":
            return {
                "result": {
                    "authority": {
                        "state": "native-only",
                        "write_authority": "kungfu-native",
                    }
                }
            }
        assert operation == "claim-completion"
        assert authorized_action is True
        claim_values.append(copy.deepcopy(values))
        native_state["phase"] = "completion-claimed"
        return {"result": {"coreReceipt": {"status": "admitted"}}}

    monkeypatch.setattr(authority, "_profile_source", lambda: str(PROFILE_SOURCE))
    monkeypatch.setattr(profile_sdk, "invoke_member_adapter", invoke)
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
        command_id="command.legacy.completion",
        idempotency_key="idem.legacy.completion",
        command_type="assignment.completion.claim",
    )
    command["arguments"] = {
        "inputAtlasRoot": ROOT_A,
        "resultAtlasRoot": ROOT_B,
    }
    original_command = copy.deepcopy(command)
    command_root = _root(command)
    runtime._state["pending"] = {
        "commandRoot": command_root,
        "command": command,
        "beforeRevision": snapshot["revision"],
        "requestId": "legacy.completion",
    }
    runtime._save_state()
    runtime.close()

    persisted = json.loads(
        (runtime_dir / "assignment-runtime" / "local-v1" / "state.json").read_text(
            encoding="utf-8"
        )
    )
    assert persisted["pending"]["command"] == original_command

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
        record = recovered._state["commands"]["idem.legacy.completion"]
        assert record["commandRoot"] == command_root
        assert record["recovered"] is True
        assert command == original_command
        assert claim_values == [
            {
                "initiativeId": "initiative-a",
                "assignmentId": "assignment-a",
                "inputContextRoot": ROOT_A,
                "resultContextRoot": ROOT_B,
            }
        ]
        readback = _handle(
            recovered,
            _request("assignment.snapshot", "assignment.snapshot.read"),
        )
        assert readback["status"] == "ok"
        assert readback["result"]["assignments"][0]["phase"] == ("completion-claimed")
    finally:
        recovered.close()


__all__ = [name for name in globals() if name.startswith("test_")]
