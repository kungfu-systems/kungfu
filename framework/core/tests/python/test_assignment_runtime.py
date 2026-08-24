# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import sys
import types
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


def test_work_profile_ensure_uses_profile_owned_retained_history_compatibility(
    monkeypatch, tmp_path
):
    from kungfu.cli.commands import assignment as work_commands

    runtime = tmp_path / "runtime"
    monkeypatch.setattr(work_commands, "profile_source", lambda: PROFILE_SOURCE)
    monkeypatch.setattr(
        profile_sdk,
        "validate_source",
        lambda _source, _runtime: {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": ROOT_A,
            }
        },
    )
    monkeypatch.setattr(
        work_commands.storage_service,
        "profile_lifecycle",
        lambda _runtime, operation, **_values: (
            {
                "profiles": [
                    {
                        "profile_id": "kungfu.work-control",
                        "profile_suite_root": ROOT_A,
                        "qualified": True,
                        "activated": True,
                        "removed": False,
                    }
                ]
            }
            if operation == "list"
            else {}
        ),
    )
    compatibility = {
        "schema": "kungfu.work-control.profile-contract/v1",
        "status": "retained-history-compatible",
        "retained_source_authorities": ["atlas-adapter"],
    }
    domain = types.SimpleNamespace(
        work_control=types.SimpleNamespace(
            ensure_profile_contract=lambda _runtime, _source, _actor: [
                {
                    "schema": "kungfu.work.profile-contract-compatibility-receipt/v1",
                    "profileContract": compatibility,
                    "writeOccurred": False,
                }
            ]
        )
    )
    monkeypatch.setattr(
        profile_sdk,
        "load_member_python_package",
        lambda _source, _member, _package: domain,
    )

    receipts = work_commands._ensure_profile(runtime, "test-agent")

    assert receipts == [
        {
            "schema": "kungfu.work.profile-contract-compatibility-receipt/v1",
            "profileContract": compatibility,
            "writeOccurred": False,
        }
    ]


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


class AssignmentCreateAuthority(FakeAuthority):
    """Fake authority that exposes a configurable local Assignment snapshot."""

    def __init__(self, root: Path, assignment_ids: list[str] | None = None):
        super().__init__(root)
        self.assignment_ids = list(assignment_ids or ["assignment-a"])
        self.applied_commands: list[dict[str, Any]] = []

    def inspect(self) -> dict[str, Any]:
        snapshot = super().inspect()
        template = snapshot["assignments"][0]
        snapshot["assignments"] = [
            {
                **copy.deepcopy(template),
                "assignmentId": assignment_id,
                "subject": f"kungfu:{assignment_id}",
            }
            for assignment_id in self.assignment_ids
        ]
        return snapshot

    def apply(self, command: dict[str, Any]) -> dict[str, Any]:
        if command["type"] != "assignment.create":
            return super().apply(command)
        self.applied_commands.append(copy.deepcopy(command))
        state = self._read()
        state["version"] += 1
        state["effects"].append(_root(command))
        self._write(state)
        return {
            "authorityReceipt": {"result": {"coreReceipt": {"status": "admitted"}}},
            "episodeRefs": [],
        }


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


def _assignment_create_command(
    revision: dict[str, Any],
    *,
    assignment_id: str = "assignment-child",
    parent_assignment_id: str = "",
    parent_assignment_ref: dict[str, Any] | None = None,
    depends_on: list[str] | None = None,
    dependency_refs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    command = _command(
        revision,
        command_id=f"command.create.{assignment_id}",
        idempotency_key=f"idem.create.{assignment_id}",
        command_type="assignment.create",
    )
    command["target"] = {
        "initiativeId": "initiative-a",
        "assignmentId": assignment_id,
    }
    command["attempt"] = None
    command["lease"] = None
    command["warrant"] = None
    command["arguments"] = {
        "initiativeId": "initiative-a",
        "assignmentId": assignment_id,
        "title": "Child assignment",
        "objective": "Exercise exact local parent validation",
        "actor": "agent-a",
        "actorType": "agent",
        "source": "kungfu",
        "status": "active",
        "parentAssignmentId": parent_assignment_id,
        "parentAssignmentRef": dict(parent_assignment_ref or {}),
        "dependsOn": list(depends_on or []),
        "dependencyRefs": copy.deepcopy(dependency_refs or []),
    }
    return command


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


def test_work_control_authority_normalizes_legacy_completion_context_roots(
    tmp_path, monkeypatch
):
    authority = WorkControlAuthority(tmp_path, source=PROFILE_SOURCE)
    captured = {}

    def invoke(_source, _runtime, member, operation, values, *, authorized_action):
        captured.update(
            member=member,
            operation=operation,
            values=values,
            write=authorized_action,
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
    }


def test_work_semantics_commands_bind_exact_runtime_attempt_and_lease(
    tmp_path, monkeypatch
):
    authority = WorkControlAuthority(tmp_path, source=PROFILE_SOURCE)
    captured = {}

    def invoke(_source, _runtime, member, operation, values, *, authorized_action):
        captured.update(
            member=member,
            operation=operation,
            values=values,
            write=authorized_action,
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
    ):
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

        submit_work(
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
        submit_work(
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

        submit_work(
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
