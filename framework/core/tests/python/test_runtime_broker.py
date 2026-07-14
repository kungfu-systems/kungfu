# SPDX-License-Identifier: Apache-2.0

import copy

import pytest

from kungfu import runtime_broker


def _ready_receipt(requirement, request_source):
    capabilities = list(requirement["requiredCapabilities"])
    authorities = list(requirement["requestedAuthorities"])
    cut = {
        "stream_id": "1",
        "container_epoch": "1",
        "sequence": "1",
        "frame_uid": "1",
    }
    return {
        "schema": runtime_broker.ACTIVATION_RECEIPT_SCHEMA,
        "requestId": requirement["requestId"],
        "requirement": dict(requirement),
        "outcome": "activated",
        "activatedBy": "test-host",
        "requestSource": request_source,
        "handle": {
            "schema": "kungfu.runtime.handle/v1",
            "runtimeId": "runtime-test",
            "requirementId": requirement["requestId"],
            "workspaceId": requirement["workspaceId"],
            "generation": "1",
            "state": "ready",
            "capabilities": capabilities,
            "grantedAuthorities": authorities,
            "readiness": {
                "schema": "kungfu.runtime.readiness/v1",
                "state": "ready",
                "durableCut": cut,
                "projectionCut": None,
                "evidence": [
                    {
                        "kind": "durability-receipt",
                        "ref": "receipt:durability:test-ready",
                    }
                ],
                "observedAtNs": "1",
            },
            "host": {
                "kind": "process",
                "hostId": "process-test",
                "diagnostics": {
                    "supervisorPid": None,
                    "coordinatorPid": None,
                    "socketPath": None,
                    "serviceInstalled": None,
                    "guiVisible": None,
                },
            },
        },
        "achievedCapabilities": capabilities,
        "missingCapabilities": [],
        "grantedAuthorities": authorities,
        "degraded": False,
        "error": None,
    }


def test_storage_only_invoke_never_constructs_an_activation_client():
    def _host_boundary_used():
        raise AssertionError("storage-only operation constructed a live host")

    broker = runtime_broker.RuntimeCapabilityBroker(_host_boundary_used)
    plan = broker.plan(
        "episode.append",
        workspace="workspace-test",
        request_source="python",
    )
    receipt = broker.invoke(plan, lambda activation: activation["outcome"])

    assert plan["requirement"]["operationClass"] == "storage-only"
    assert receipt["accepted"] is True
    assert receipt["activation"]["outcome"] == "daemonless"
    assert receipt["activation"]["handle"] is None
    assert receipt["result"] == "daemonless"


def test_live_required_invoke_waits_for_matching_ready_capabilities():
    class _ReadyClient:
        def activate(self, requirement, request_source):
            return _ready_receipt(requirement, request_source)

    broker = runtime_broker.RuntimeCapabilityBroker(_ReadyClient)
    plan = broker.plan(
        "assessment.request",
        workspace="workspace-test",
        request_source="kfx",
    )
    receipt = broker.invoke(
        plan,
        lambda activation: activation["handle"]["runtimeId"],
    )

    assert plan["requirement"]["operationClass"] == "live-required"
    assert plan["requirement"]["requiredCapabilities"] == [
        "runtime.assessment-scheduling"
    ]
    assert receipt["accepted"] is True
    assert receipt["result"] == "runtime-test"


def test_live_required_failure_does_not_accept_the_operation():
    calls = []

    class _UnavailableClient:
        def activate(self, requirement, request_source):
            return {
                "schema": runtime_broker.ACTIVATION_RECEIPT_SCHEMA,
                "requestId": requirement["requestId"],
                "requirement": dict(requirement),
                "outcome": "failed",
                "activatedBy": "test-host",
                "requestSource": request_source,
                "handle": None,
                "achievedCapabilities": [],
                "missingCapabilities": list(requirement["requiredCapabilities"]),
                "grantedAuthorities": [],
                "degraded": False,
                "error": {
                    "code": "readiness_not_established",
                    "message": "durable cut is not ready",
                    "retryable": True,
                },
            }

    broker = runtime_broker.RuntimeCapabilityBroker(_UnavailableClient)
    plan = broker.plan(
        "assessment.request",
        workspace="workspace-test",
        request_source="gui",
    )
    receipt = broker.invoke(plan, lambda activation: calls.append(activation))

    assert receipt["accepted"] is False
    assert receipt["result"] is None
    assert receipt["activation"]["error"]["code"] == "readiness_not_established"
    assert calls == []


def test_operation_catalog_is_machine_readable_and_plan_ids_are_deterministic():
    broker = runtime_broker.RuntimeCapabilityBroker()
    catalog = broker.catalog()
    ids = {operation["id"] for operation in catalog["operations"]}
    first = broker.plan(
        "episode.inspect",
        workspace="workspace-test",
        request_source="cli",
    )
    second = broker.plan(
        "episode.inspect",
        workspace="workspace-test",
        request_source="cli",
    )

    assert catalog["schema"] == "kungfu.runtime-operation-registry/v1"
    assert {"episode.inspect", "episode.append", "assessment.request"} <= ids
    assert first == second


def test_invoke_rejects_a_plan_that_downgrades_live_required_to_storage_only():
    broker = runtime_broker.RuntimeCapabilityBroker()
    plan = broker.plan(
        "assessment.request",
        workspace="workspace-test",
        request_source="python",
    )
    altered = copy.deepcopy(plan)
    altered["requirement"]["operationClass"] = "storage-only"
    altered["requirement"]["requiredCapabilities"] = []
    altered["requirement"]["requestedAuthorities"] = []

    with pytest.raises(ValueError, match="stale or altered"):
        broker.invoke(altered, lambda activation: activation)
