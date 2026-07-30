# SPDX-License-Identifier: Apache-2.0

import json
import threading
import time
from pathlib import Path

from kungfu import config, durability


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_durability_policy_is_kfd1_hashed_and_workspace_wins(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    workspace_home = workspace / ".kungfu"
    workspace_home.mkdir()
    config_home = tmp_path / "config"
    _write(
        config_home / "config.json",
        {
            "schema": "kungfu.config.override/v1",
            "storage": {
                "durability": {
                    "activation": "qualified-candidate",
                    "defaultProfile": "durable_group",
                    "group": {"maxRecords": 64},
                }
            },
        },
    )
    _write(
        workspace_home / "config.json",
        {
            "schema": "kungfu.config.override/v1",
            "storage": {
                "durability": {
                    "defaultProfile": "durable_sync",
                    "requestTimeoutMs": 7500,
                }
            },
        },
    )

    first = config.durability_policy(
        runtime_home=str(workspace_home),
        config_home=str(config_home),
        cwd=str(workspace),
    )
    second = config.durability_policy(
        runtime_home=str(workspace_home),
        config_home=str(config_home),
        cwd=str(workspace),
    )

    assert first["contract"]["version"] == 3
    assert first["policy"]["activation"] == "qualified-candidate"
    assert first["policy"]["defaultProfile"] == "durable_sync"
    assert first["policy"]["group"]["maxRecords"] == 64
    assert first["policy"]["requestTimeoutMs"] == 7500
    assert first["policyDigest"].startswith("sha256:")
    assert first["policyDigest"] == second["policyDigest"]
    assert first["sources"][-1] == {
        "type": "workspace",
        "schema": "kungfu.config.override/v1",
        "path": str(workspace_home / "config.json"),
        "exists": True,
        "active": True,
    }


def test_policy_refuses_strong_profile_when_activation_is_off(tmp_path):
    config_home = tmp_path / "config"
    _write(
        config_home / "config.json",
        {
            "schema": "kungfu.config.override/v1",
            "storage": {"durability": {"defaultProfile": "durable_sync"}},
        },
    )

    policy = durability.resolve_policy(
        runtime_home=str(tmp_path / "home"),
        config_home=str(config_home),
        cwd=str(tmp_path),
    )

    assert policy["admission"]["admitted"] is False
    assert policy["effective"] == {
        "activation": "refused",
        "defaultProfile": None,
        "policyDigest": None,
    }
    assert policy["admission"]["reasons"] == [
        "strong_profile_requested_while_activation_is_off"
    ]


def test_profile_rules_are_priority_then_id_deterministic():
    policy = {
        "requested": {
            "defaultProfile": "visible",
            "rules": [
                {
                    "id": "z-last",
                    "priority": 20,
                    "match": {"carrierTypes": [1001]},
                    "profile": "durable_group",
                },
                {
                    "id": "a-first",
                    "priority": 20,
                    "match": {"carrierTypes": [1001], "sourceIds": [7]},
                    "profile": "durable_sync",
                },
            ],
        }
    }

    assert (
        durability.select_profile(
            policy, carrier_type=1001, source_id=7, destination_id=9
        )
        == "durable_sync"
    )
    assert (
        durability.select_profile(
            policy, carrier_type=2002, source_id=7, destination_id=9
        )
        == "visible"
    )


class _FakeCoordinator:
    def __init__(self) -> None:
        self.pending_records = 0
        self.pending_bytes = 0
        self.requests: list[tuple] = []
        self.request_event = threading.Event()

    def _status(self) -> dict:
        return {
            "pendingRecords": self.pending_records,
            "pendingBytes": self.pending_bytes,
        }

    def durability_open(self, *args):
        return self._status()

    def durability_append(self, *args):
        payload = args[6]
        self.pending_records += 1
        self.pending_bytes += len(payload)
        return self._status()

    def durability_request(self, *args):
        self.requests.append(args)
        self.request_event.set()
        request_id, stream_id, epoch, sequence, frame_uid, profile, _ = args
        self.pending_records = 0
        self.pending_bytes = 0
        return {
            "schema": "kungfu.durability.execution/v1",
            "receipt": {
                "schema": "kungfu.durability.receipt/v1",
                "request_id": str(request_id),
                "position": {
                    "stream_id": str(stream_id),
                    "container_epoch": str(epoch),
                    "sequence": str(sequence),
                    "frame_uid": str(frame_uid),
                },
                "requested_profile": profile,
                "achieved_profile": profile,
                "status": "succeeded",
                "error": "none",
            },
            "status": self._status(),
            "error": "none",
            "message": "",
        }

    def durability_reconcile(self, *args):
        return {"state": "unknown", "receipt": None}


def test_configured_runtime_honors_group_threshold_and_policy_identity(tmp_path):
    coordinator = _FakeCoordinator()
    policy = {
        "contract": {"hash": "sha256:" + "a" * 64},
        "policyDigest": "sha256:" + "b" * 64,
        "effective": {"activation": "qualified-candidate"},
        "requested": {
            "defaultProfile": "durable_group",
            "requestTimeoutMs": 5000,
            "reconcileOnTimeout": True,
            "group": {"maxDelayMs": 1000, "maxRecords": 2, "maxBytes": 4096},
            "rules": [],
        },
        "native": {"qualificationProfile": "candidate/current-hardware-single-host/v1"},
    }
    runtime = durability.ConfiguredDurabilityRuntime(
        coordinator, policy, data_root=str(tmp_path)
    )
    stream = runtime.open_stream(
        stream_id=7, container_epoch=11, writer_resource_id="writer-7"
    )
    first = stream.append(b"first", carrier_type=1001, sequence=1, frame_uid=101)
    second = stream.append(b"second", carrier_type=1001, sequence=2, frame_uid=102)

    assert first["state"] == "pending"
    assert first["acknowledged"] is False
    assert second["state"] == "succeeded"
    assert second["acknowledged"] is True
    assert second["policyIdentity"] == {
        "contractHash": "sha256:" + "a" * 64,
        "policyDigest": "sha256:" + "b" * 64,
        "qualificationProfile": "candidate/current-hardware-single-host/v1",
    }
    assert coordinator.requests[0][5] == "durable_group"
    assert coordinator.requests[0][0] == 102
    runtime.close()


def _effective_policy(*, default_profile: str, group: dict) -> dict:
    return {
        "contract": {"hash": "sha256:" + "a" * 64},
        "policyDigest": "sha256:" + "b" * 64,
        "effective": {"activation": "qualified-candidate"},
        "requested": {
            "defaultProfile": default_profile,
            "requestTimeoutMs": 5000,
            "reconcileOnTimeout": True,
            "group": group,
            "rules": [],
        },
        "native": {"qualificationProfile": "candidate/current-hardware-single-host/v1"},
    }


def test_configured_runtime_honors_group_byte_and_delay_thresholds(tmp_path):
    byte_coordinator = _FakeCoordinator()
    byte_runtime = durability.ConfiguredDurabilityRuntime(
        byte_coordinator,
        _effective_policy(
            default_profile="durable_group",
            group={"maxDelayMs": 1000, "maxRecords": 99, "maxBytes": 4096},
        ),
        data_root=str(tmp_path / "bytes"),
    )
    byte_stream = byte_runtime.open_stream(
        stream_id=8, container_epoch=1, writer_resource_id="writer-bytes"
    )
    byte_result = byte_stream.append(
        b"x" * 4096, carrier_type=1001, sequence=1, frame_uid=201
    )
    assert byte_result["state"] == "succeeded"
    assert byte_coordinator.requests[0][0] == 201
    byte_runtime.close()

    delay_coordinator = _FakeCoordinator()
    delay_runtime = durability.ConfiguredDurabilityRuntime(
        delay_coordinator,
        _effective_policy(
            default_profile="durable_group",
            group={"maxDelayMs": 10, "maxRecords": 99, "maxBytes": 4096},
        ),
        data_root=str(tmp_path / "delay"),
    )
    delay_stream = delay_runtime.open_stream(
        stream_id=9, container_epoch=1, writer_resource_id="writer-delay"
    )
    pending = delay_stream.append(
        b"delayed", carrier_type=1001, sequence=1, frame_uid=301
    )
    assert pending["state"] == "pending"
    assert delay_coordinator.request_event.wait(timeout=1.0)
    deadline = time.monotonic() + 1.0
    while delay_stream.last_async_result is None and time.monotonic() < deadline:
        time.sleep(0.001)
    assert delay_stream.last_async_error is None
    assert delay_stream.last_async_result is not None
    assert delay_stream.last_async_result["state"] == "succeeded"
    delay_runtime.close()


class _TimeoutThenReconcileCoordinator(_FakeCoordinator):
    def durability_request(self, *args):
        self.requests.append(args)
        self.request_event.set()
        request_id, stream_id, epoch, sequence, frame_uid, profile, _ = args
        return {
            "schema": "kungfu.durability.execution/v1",
            "receipt": {
                "schema": "kungfu.durability.receipt/v1",
                "request_id": str(request_id),
                "position": {
                    "stream_id": str(stream_id),
                    "container_epoch": str(epoch),
                    "sequence": str(sequence),
                    "frame_uid": str(frame_uid),
                },
                "requested_profile": profile,
                "achieved_profile": "visible",
                "status": "unknown",
                "error": "timeout",
            },
            "status": self._status(),
            "error": "timeout",
            "message": "deadline expired after barrier I/O began",
        }

    def durability_reconcile(self, *args):
        request_id, stream_id, epoch, sequence, frame_uid, profile = args
        return {
            "state": "reconciled",
            "receipt": {
                "schema": "kungfu.durability.receipt/v1",
                "request_id": str(request_id),
                "position": {
                    "stream_id": str(stream_id),
                    "container_epoch": str(epoch),
                    "sequence": str(sequence),
                    "frame_uid": str(frame_uid),
                },
                "requested_profile": profile,
                "achieved_profile": profile,
                "status": "succeeded",
                "error": "none",
            },
        }


def test_configured_runtime_uses_absolute_deadline_and_exact_reconciliation(tmp_path):
    coordinator = _TimeoutThenReconcileCoordinator()
    policy = _effective_policy(
        default_profile="durable_sync",
        group={"maxDelayMs": 10, "maxRecords": 32, "maxBytes": 4096},
    )
    policy["requested"]["requestTimeoutMs"] = 25
    runtime = durability.ConfiguredDurabilityRuntime(
        coordinator, policy, data_root=str(tmp_path)
    )
    stream = runtime.open_stream(
        stream_id=10, container_epoch=2, writer_resource_id="writer-sync"
    )
    before = time.monotonic_ns()
    result = stream.append(b"sync", carrier_type=1001, sequence=3, frame_uid=401)
    after = time.monotonic_ns()

    assert result["selectedProfile"] == "durable_sync"
    assert result["state"] == "succeeded"
    assert result["reconciliation"]["state"] == "reconciled"
    request = coordinator.requests[0]
    assert request[:6] == (401, 10, 2, 3, 401, "durable_sync")
    assert before + 25_000_000 <= request[6] <= after + 25_000_000
    runtime.close()
