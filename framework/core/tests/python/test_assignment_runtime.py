# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from io import StringIO
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from kungfu import profile_sdk
from kungfu.assignment_runtime import (
    EVENT_SCHEMA,
    SNAPSHOT_SCHEMA,
    EmbeddedAssignmentRuntimeClient,
    EmbeddedLocalAssignmentRuntime,
    LocalAssignmentRuntimeApplication,
    LocalRuntimeError,
    WorkControlAuthority,
    profile_source,
    serve,
)
from kungfu.canonical_json import canonical_json_text


REPOSITORY = Path(__file__).resolve().parents[4]
PROFILE_SOURCE = REPOSITORY / "extensions" / "work-control"
ASSIGNMENT_RUNTIME_CONTRACT = json.loads(
    (
        REPOSITORY
        / "framework"
        / "assignment-runtime"
        / "assignment-runtime.contract.json"
    ).read_text(encoding="utf-8")
)
ENVELOPE_SCHEMA = json.loads(
    (
        REPOSITORY
        / "framework"
        / "assignment-runtime"
        / "schema"
        / "assignment-runtime-envelope-v1.schema.json"
    ).read_text(encoding="utf-8")
)
VALIDATE_ENVELOPE = Draft202012Validator(ENVELOPE_SCHEMA)
REALM = {"realmId": "home-test", "realmKind": "local", "generation": "gen-1"}
ROOT_A = "sha256:" + "a" * 64
ROOT_B = "sha256:" + "b" * 64


def test_profile_source_resolves_installed_bundled_root(monkeypatch, tmp_path):
    bundled = tmp_path / "installed" / "extensions"
    source = bundled / "work-control"
    observed = []
    monkeypatch.setenv("KF_BUNDLED_EXTENSION_ROOT", str(bundled))
    monkeypatch.delenv("KF_EXTENSION_PATH", raising=False)
    monkeypatch.setattr(
        profile_sdk,
        "discover_source",
        lambda profile_id, *, search_roots: (
            observed.append((profile_id, search_roots)) or {"source": str(source)}
        ),
    )

    assert profile_source() == source
    assert observed == [("kungfu.work-control", [bundled])]


def test_profile_source_prefers_bundled_root_before_dev_overrides(
    monkeypatch, tmp_path
):
    bundled = tmp_path / "installed" / "extensions"
    dev_one = tmp_path / "dev-one"
    dev_two = tmp_path / "dev-two"
    observed = []
    monkeypatch.setenv("KF_BUNDLED_EXTENSION_ROOT", str(bundled))
    monkeypatch.setenv(
        "KF_EXTENSION_PATH", os.pathsep.join([str(dev_one), str(dev_two)])
    )
    monkeypatch.setattr(
        profile_sdk,
        "discover_source",
        lambda profile_id, *, search_roots: (
            observed.append((profile_id, search_roots))
            or {"source": str(bundled / "work-control")}
        ),
    )

    assert profile_source() == bundled / "work-control"
    assert observed == [
        ("kungfu.work-control", [bundled, dev_one, dev_two]),
    ]


def _root(value: Any) -> str:
    return (
        "sha256:"
        + hashlib.sha256(canonical_json_text(value).encode("utf-8")).hexdigest()
    )


class FakeAuthority:
    """Disposable stand-in with the same one-authority behavior as Work Control."""

    def __init__(self, root: Path):
        self.path = root / "fake-authority.json"
        self.unavailable = False
        self.ambiguous = False
        if not self.path.exists():
            self._write(
                {
                    "phase": "admitted",
                    "version": 1,
                    "attempt": None,
                    "lease": None,
                    "external": 0,
                    "effects": [],
                }
            )

    def _read(self) -> dict[str, Any]:
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _write(self, value: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")

    def inspect(self) -> dict[str, Any]:
        if self.unavailable:
            raise LocalRuntimeError("backend-unavailable", "authority unavailable")
        if self.ambiguous:
            raise LocalRuntimeError("ambiguous-identity", "authority ambiguous")
        state = self._read()
        fact_root = _root(
            {
                "assignment": "assignment-a",
                "phase": state["phase"],
                "version": state["version"],
                "external": state["external"],
            }
        )
        return {
            "schema": SNAPSHOT_SCHEMA,
            "authority": {
                "profileId": "kungfu.work-control",
                "profileSuiteRoot": ROOT_A,
                "memberRoot": ROOT_B,
                "state": "native-only",
                "writeAuthority": "kungfu-native",
                "migrationId": "",
            },
            "assignments": [
                {
                    "initiativeId": "initiative-a",
                    "assignmentId": "assignment-a",
                    "subject": "kungfu:assignment-a",
                    "phase": state["phase"],
                    "attempt": state["attempt"],
                    "lease": state["lease"],
                    "lifecycle": {
                        "phase": state["phase"],
                        "execution_claims": (
                            [
                                {
                                    "attempt_id": state["attempt"]["attemptId"],
                                    "claim_id": state["attempt"].get("claimId"),
                                }
                            ]
                            if state["attempt"]
                            else []
                        ),
                        "active_lease": state["lease"],
                    },
                    "sealedIdentity": {
                        "contractWorldId": "kungfu.initiative-assignment",
                        "factSurfaceId": "kungfu.initiative-assignment.assignment",
                        "observationId": "observation-a",
                        "payloadRoot": fact_root,
                        "sourceId": "kungfu-agent",
                        "subject": "kungfu:assignment-a",
                        "typeVersion": "1",
                    },
                }
            ],
            "factRefs": [
                {
                    "factRoot": fact_root,
                    "surfaceId": "kungfu.initiative-assignment.assignment",
                    "subjectKey": "kungfu:assignment-a",
                }
            ],
            "episodeRefs": [],
            "diagnostics": [],
        }

    def apply(self, command: dict[str, Any]) -> dict[str, Any]:
        state = self._read()
        command_type = command["type"]
        effect_root = _root(command)
        if effect_root in state["effects"]:
            return {
                "authorityReceipt": {
                    "result": {
                        "coreReceipt": {
                            "status": "already-present",
                            "root": effect_root,
                        }
                    }
                },
                "episodeRefs": [{"episodeRoot": ROOT_A}],
            }
        if command_type == "assignment.claim":
            if state["phase"] != "admitted":
                raise LocalRuntimeError("stale-revision", "phase changed")
            state["phase"] = "claimed"
            state["attempt"] = command["attempt"]
            state["lease"] = command["lease"]
        elif command_type == "assignment.stage":
            expected = command["arguments"].get("expectedPhase")
            if state["phase"] != expected:
                raise LocalRuntimeError("stale-revision", "phase changed")
            state["phase"] = command["arguments"]["toPhase"]
            state["attempt"] = command["attempt"]
            state["lease"] = command["lease"]
        else:
            raise LocalRuntimeError("invalid-command", "unsupported fake command")
        state["version"] += 1
        state["effects"].append(effect_root)
        self._write(state)
        return {
            "authorityReceipt": {
                "result": {"coreReceipt": {"status": "admitted", "root": effect_root}}
            },
            "episodeRefs": [{"episodeRoot": ROOT_A}],
        }

    def diagnostics(self) -> list[dict[str, Any]]:
        if self.unavailable:
            return [
                {
                    "code": "fake-unavailable",
                    "message": "Fake authority is unavailable",
                    "severity": "error",
                    "recovery": ["recovery.plan"],
                }
            ]
        return []

    def external_change(self) -> None:
        state = self._read()
        state["external"] += 1
        state["version"] += 1
        self._write(state)


def _request(
    operation: str,
    capability: str,
    *,
    payload: dict[str, Any] | None = None,
    request_id: str | None = None,
    client_kind: str = "test",
    realm: dict[str, str] | None = None,
    cursor: dict[str, str] | None = None,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "schema": "kungfu.assignment-runtime.request/v1",
        "requestId": request_id or f"request.{operation}",
        "realm": dict(realm or REALM),
        "operation": operation,
        "client": {
            "clientId": f"{client_kind}.test",
            "kind": client_kind,
            "requestedCapabilities": [capability],
        },
        "payload": dict(payload or {}),
    }
    if cursor is not None:
        value["cursor"] = cursor
    return value


def _command(
    revision: dict[str, Any],
    *,
    command_id: str = "command.claim",
    idempotency_key: str = "idem.claim",
    command_type: str = "assignment.claim",
    expected_phase: str = "admitted",
    to_phase: str = "claimed",
    warrant_state: str = "active",
) -> dict[str, Any]:
    expires = (
        (datetime.now(UTC) + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    )
    return {
        "schema": "kungfu.assignment-runtime.command/v1",
        "commandId": command_id,
        "type": command_type,
        "target": {"initiativeId": "initiative-a", "assignmentId": "assignment-a"},
        "expectedRevision": copy.deepcopy(revision),
        "idempotencyKey": idempotency_key,
        "attempt": {"attemptId": "attempt-a", "state": "claimed", "claimId": "claim-a"},
        "lease": {"leaseId": "lease-a", "state": "active", "expiresAt": expires},
        "warrant": {
            "warrantRoot": ROOT_B,
            "state": warrant_state,
            "scope": [command_type],
        },
        "arguments": (
            {
                "owner": "owner-a",
                "agent": "agent-a",
                "slot": "slot-a",
                "authorizedBy": "owner-a",
            }
            if command_type == "assignment.claim"
            else {
                "actor": "agent-a",
                "reason": "exercise the local runtime",
                "expectedPhase": expected_phase,
                "toPhase": to_phase,
            }
        ),
    }


def _handle(runtime: EmbeddedLocalAssignmentRuntime, request: dict[str, Any]):
    assert list(VALIDATE_ENVELOPE.iter_errors(request)) == []
    response = runtime.handle(request)
    assert list(VALIDATE_ENVELOPE.iter_errors(response)) == [], response
    return response


def test_gui_stdio_host_announces_ready_after_start_and_preserves_envelopes(
    tmp_path,
):
    authority = FakeAuthority(tmp_path)
    runtime = EmbeddedLocalAssignmentRuntime(
        tmp_path,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    )
    request = _request(
        "assignment.snapshot",
        "assignment.snapshot.read",
        request_id="gui.work-dashboard:1",
    )
    output = StringIO()

    serve(runtime, StringIO(json.dumps(request) + "\n"), output)

    hello, response = [json.loads(line) for line in output.getvalue().splitlines()]
    assert hello["schema"] == "kungfu.gui.assignment-runtime-host/v1"
    assert hello["status"] == "ready"
    assert hello["realm"] == REALM
    assert hello["genesisCursor"] == runtime.genesis_cursor(REALM["generation"])
    assert response["schema"] == "kungfu.assignment-runtime.response/v1"
    assert response["requestId"] == request["requestId"]
    assert response["status"] == "ok"
    assert runtime._started is False


def test_gui_stdio_host_maps_unexpected_writer_start_failure_to_stable_error():
    class FailingRuntime:
        def start(self):
            raise OSError("private native bind detail")

    output = StringIO()

    with pytest.raises(LocalRuntimeError, match="writer failed to start") as raised:
        serve(FailingRuntime(), StringIO(), output)  # type: ignore[arg-type]

    assert raised.value.code == "backend-unavailable"
    envelope = json.loads(output.getvalue())
    assert envelope["status"] == "error"
    assert envelope["error"]["code"] == "backend-unavailable"
    assert "private native bind detail" not in output.getvalue()


@pytest.fixture
def local_runtime(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    runtime_dir = home / ".kungfu" / "runtime"
    authority = FakeAuthority(runtime_dir)
    runtime = EmbeddedLocalAssignmentRuntime(
        runtime_dir,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
        event_retention=4,
    ).start()
    try:
        yield runtime, authority, runtime_dir
    finally:
        runtime.close()


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

    assert runtime_dir.is_relative_to(home)
