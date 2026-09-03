# SPDX-License-Identifier: Apache-2.0

# ruff: noqa: F401

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

    def assignment_status(
        self, initiative_id: str, assignment_id: str
    ) -> dict[str, Any]:
        assignments = [
            row
            for row in self.inspect()["assignments"]
            if row["initiativeId"] == initiative_id
            and row["assignmentId"] == assignment_id
        ]
        if len(assignments) != 1:
            raise LocalRuntimeError(
                "ambiguous-identity", "Assignment status did not resolve exactly once"
            )
        return copy.deepcopy(assignments[0]["lifecycle"])

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


# Deliberate shared test vocabulary for the private responsibility modules.
__all__ = [name for name in globals() if not name.startswith("__")]
