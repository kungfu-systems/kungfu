# SPDX-License-Identifier: Apache-2.0

import copy
import multiprocessing

import pytest

from kungfu import runtime_broker

from _runtime_broker_scaffold_cases import (
    READINESS_FIXTURES,
    _activation_worker,
    _CutReadinessAuthority,
    _cut,
    _FileProcessHost,
    _GenerationAwareProcessHost,
    _LeaseClock,
    _ready_receipt,
)


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


def test_process_activation_converges_concurrent_callers_to_one_generation(tmp_path):
    context = multiprocessing.get_context("spawn")
    config_home = tmp_path / "config"
    runtime_dir = tmp_path / "home" / "runtime"
    counter_path = tmp_path / "activation-count"
    queue = context.Queue()
    processes = [
        context.Process(
            target=_activation_worker,
            args=(
                str(config_home),
                str(runtime_dir),
                str(counter_path),
                f"request-{index}",
                queue,
            ),
        )
        for index in range(4)
    ]

    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=15)

    assert [process.exitcode for process in processes] == [0, 0, 0, 0]
    receipts = [queue.get(timeout=2) for _ in processes]
    assert counter_path.read_text() == "1"
    assert {receipt["generation"] for receipt in receipts} == {"1"}
    assert sorted(receipt["outcome"] for receipt in receipts) == [
        "activated",
        "reused",
        "reused",
        "reused",
    ]


def test_process_activation_fences_a_replaced_process_generation(tmp_path):
    config_home = tmp_path / "config"
    runtime_dir = tmp_path / "home" / "runtime"
    counter_path = tmp_path / "activation-count"
    requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
        request_id="request-first",
    )["requirement"]
    first = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(counter_path),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(requirement, "python")
    replacement_requirement = {
        **requirement,
        "requestId": "request-replacement",
    }
    replacement = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(counter_path, 2200, 2201),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(replacement_requirement, "python")

    assert first["handle"]["generation"] == "1"
    assert replacement["outcome"] == "activated"
    assert replacement["handle"]["generation"] == "2"
    assert counter_path.read_text() == "2"


def test_process_activation_projects_planned_generation_to_capable_host(tmp_path):
    config_home = tmp_path / "config"
    runtime_dir = tmp_path / "home" / "runtime"
    host = _GenerationAwareProcessHost(tmp_path / "activation-count")
    requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
        request_id="request-generation-aware",
    )["requirement"]

    receipt = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=host,
        readiness_authority=_CutReadinessAuthority(),
    ).activate(requirement, "python")

    assert receipt["outcome"] == "activated"
    assert receipt["handle"]["generation"] == "1"
    assert host.generations == ["1"]


def test_same_process_expands_readiness_without_advancing_generation(tmp_path):
    config_home = tmp_path / "config"
    runtime_dir = tmp_path / "home" / "runtime"
    counter_path = tmp_path / "activation-count"
    client = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(counter_path),
        readiness_authority=_CutReadinessAuthority(),
    )
    first_requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
        request_id="request-projection",
    )["requirement"]
    expanded_requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
        request_id="request-assessment",
    )["requirement"]

    first = client.activate(first_requirement, "python")
    lease_manager = runtime_broker.RuntimeLeaseManager(
        config_home,
        first_requirement["workspaceId"],
        clock=_LeaseClock(100),
    )
    lease_manager.acquire(
        first["handle"],
        holder_id="work-console:projection",
        capabilities=["runtime.live-projection"],
        ttl_ns=100,
    )
    expanded = client.activate(expanded_requirement, "python")
    reused = client.activate(
        {**first_requirement, "requestId": "request-projection-reused"}, "python"
    )
    with pytest.raises(runtime_broker.RuntimeLifecycleError) as caller_broadening:
        lease_manager.acquire(
            first["handle"],
            holder_id="work-console:assessment-with-projection-handle",
            capabilities=["runtime.assessment-scheduling"],
            ttl_ns=100,
        )
    snapshot = lease_manager.inspect()

    assert first["handle"]["generation"] == "1"
    assert expanded["outcome"] == "activated"
    assert expanded["handle"]["generation"] == "1"
    assert reused["outcome"] == "reused"
    assert caller_broadening.value.code == "authority_conflict"
    assert counter_path.read_text() == "1"
    assert set(snapshot["handles"][0]["capabilities"]) == {
        "runtime.assessment-scheduling",
        "runtime.channel-routing",
        "runtime.live-projection",
    }
    assert snapshot["leases"][0]["state"] == "active"


def test_process_activation_rejects_readiness_behind_the_required_cut(tmp_path):
    fixture = READINESS_FIXTURES["behind"]
    runtime_dir = tmp_path / "home" / "runtime"
    requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=fixture["minimumCut"],
    )["requirement"]
    receipt = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(tmp_path / "config"),
        host=_FileProcessHost(tmp_path / "activation-count"),
        readiness_authority=_CutReadinessAuthority(fixture["observedCut"]),
    ).activate(requirement, "python")

    assert receipt["outcome"] == "failed"
    assert receipt["error"]["code"] == fixture["expectedError"]
    assert receipt["handle"] is None


def test_broker_rejects_a_host_receipt_behind_the_required_cut():
    calls = []

    class _BehindClient:
        def activate(self, requirement, request_source):
            return _ready_receipt(requirement, request_source)

    broker = runtime_broker.RuntimeCapabilityBroker(_BehindClient)
    plan = broker.plan(
        "assessment.request",
        workspace="workspace-test",
        request_source="python",
        minimum_cut=_cut("5", "5"),
    )
    receipt = broker.invoke(plan, lambda activation: calls.append(activation))

    assert receipt["accepted"] is False
    assert calls == []


def test_process_activation_without_a_readiness_authority_fails_closed(tmp_path):
    runtime_dir = tmp_path / "home" / "runtime"
    requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
    )["requirement"]
    receipt = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(tmp_path / "config"),
        host=_FileProcessHost(tmp_path / "activation-count"),
    ).activate(requirement, "python")

    assert receipt["outcome"] == "failed"
    assert receipt["error"]["code"] == "readiness_not_established"
    assert receipt["handle"] is None
