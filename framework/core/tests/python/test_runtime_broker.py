# SPDX-License-Identifier: Apache-2.0

import copy
import json
import multiprocessing
from pathlib import Path

import pytest

from kungfu import runtime_broker


ROOT = Path(__file__).parents[4]
READINESS_FIXTURES = json.loads(
    (ROOT / "tests/fixtures/runtime-activation-readiness/cases.json").read_text()
)


def _cut(sequence="1", frame_uid="1"):
    return {
        "stream_id": "1",
        "container_epoch": "1",
        "sequence": sequence,
        "frame_uid": frame_uid,
    }


def _reconciliation(cut=None):
    cut = cut or _cut()
    return {
        "schema": "kungfu.durability.reconciliation/v1",
        "state": "reconciled",
        "recovered": True,
        "receipt": {
            "schema": "kungfu.durability.receipt/v1",
            "request_id": 17,
            "status": "succeeded",
            "durable_watermark": cut,
            "barrier_id": 23,
        },
    }


def _projection_status(cut=None):
    cut = cut or _cut()
    return {
        "schema": "kungfu.projection-candidate-status/v1",
        "authority": "libkungfu",
        "outcome": "ready",
        "hydrated": True,
        "qualification_profile": "candidate/test-local-filesystem/v1",
        "projection_watermark": cut,
    }


class _CutReadinessAuthority:
    def __init__(self, cut=None):
        self.cut = cut

    def establish(self, requirement, generation, diagnostics):
        cut = self.cut or requirement["minimumCut"] or _cut()
        return {
            "schema": "kungfu.runtime.readiness/v1",
            "state": "ready",
            "durableCut": cut,
            "projectionCut": cut
            if "runtime.live-projection" in requirement["requiredCapabilities"]
            else None,
            "evidence": [
                {
                    "kind": "durability-receipt",
                    "ref": f"receipt:durability:generation-{generation}",
                }
            ],
            "observedAtNs": "1",
        }


class _FileProcessHost:
    def __init__(self, counter_path, supervisor_pid=1200, coordinator_pid=1201):
        self.counter_path = Path(counter_path)
        self.supervisor_pid = supervisor_pid
        self.coordinator_pid = coordinator_pid

    def _diagnostics(self, running):
        return {
            "supervisor": {
                "pid": self.supervisor_pid if running else None,
                "running": running,
            },
            "coordinator": {
                "pid": self.coordinator_pid if running else None,
                "running": running,
            },
        }

    def inspect(self, home, runtime_dir):
        return self._diagnostics(self.counter_path.exists())

    def activate(self, home, runtime_dir):
        count = int(self.counter_path.read_text()) if self.counter_path.exists() else 0
        self.counter_path.write_text(str(count + 1))
        return self._diagnostics(True)


def _activation_worker(config_home, runtime_dir, counter_path, request_id, queue):
    requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
        request_id=request_id,
    )["requirement"]
    client = runtime_broker.ProcessRuntimeActivationClient(
        str(Path(runtime_dir).parent),
        runtime_dir,
        config_home=config_home,
        host=_FileProcessHost(counter_path),
        readiness_authority=_CutReadinessAuthority(),
    )
    receipt = client.activate(requirement, "python")
    queue.put(
        {
            "outcome": receipt["outcome"],
            "generation": receipt["handle"]["generation"],
        }
    )


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
        "assessment.request",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
        request_id="request-assessment",
    )["requirement"]
    expanded_requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
        request_id="request-projection",
    )["requirement"]

    first = client.activate(first_requirement, "python")
    expanded = client.activate(expanded_requirement, "python")

    assert first["handle"]["generation"] == "1"
    assert expanded["outcome"] == "activated"
    assert expanded["handle"]["generation"] == "1"
    assert counter_path.read_text() == "1"


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


def test_reconciled_native_evidence_projects_exact_durable_and_projection_cuts(
    tmp_path,
):
    runtime_dir = tmp_path / "home" / "runtime"
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
    )["requirement"]
    authority = runtime_broker._ReconciledReadinessProjection(
        _reconciliation(),
        _projection_status(),
    )
    receipt = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(tmp_path / "config"),
        host=_FileProcessHost(tmp_path / "activation-count"),
        readiness_authority=authority,
    ).activate(requirement, "python")

    assert receipt["outcome"] == "activated"
    assert receipt["handle"]["readiness"]["durableCut"] == _cut()
    assert receipt["handle"]["readiness"]["projectionCut"] == _cut()
    assert [
        evidence["kind"] for evidence in receipt["handle"]["readiness"]["evidence"]
    ] == ["durability-receipt", "projection-status"]


def test_reconciled_readiness_rejects_non_authoritative_durability_evidence():
    authority = runtime_broker._ReconciledReadinessProjection(
        {**_reconciliation(), "recovered": False}
    )
    requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace="workspace-test",
        request_source="python",
        minimum_cut=_cut(),
    )["requirement"]

    with pytest.raises(ValueError, match="not authoritative"):
        authority.establish(requirement, "1", {})


def test_retained_readiness_fixture_binds_native_evidence_above_the_minimum_cut():
    fixture = READINESS_FIXTURES["valid"]
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace="workspace-retained-fixture",
        request_source="python",
        minimum_cut=fixture["minimumCut"],
    )["requirement"]
    readiness = runtime_broker._ReconciledReadinessProjection(
        fixture["durabilityReconciliation"],
        fixture["projectionStatus"],
    ).establish(requirement, "1", {})

    assert runtime_broker._readiness_admits_requirement(requirement, readiness)
    assert readiness["durableCut"]["sequence"] == "42"
    assert readiness["projectionCut"] == readiness["durableCut"]


def test_native_readiness_authority_invokes_existing_typed_authorities(
    tmp_path, monkeypatch
):
    from kungfu import durability, projection

    fixture = READINESS_FIXTURES["valid"]
    calls = []
    monkeypatch.setattr(
        durability,
        "reconcile",
        lambda **kwargs: (
            calls.append(("durability", kwargs)) or fixture["durabilityReconciliation"]
        ),
    )
    monkeypatch.setattr(
        projection,
        "candidate_status",
        lambda **kwargs: (
            calls.append(("projection", kwargs)) or fixture["projectionStatus"]
        ),
    )
    runtime_dir = tmp_path / "home" / "runtime"
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=fixture["minimumCut"],
    )["requirement"]
    authority = runtime_broker.NativeReadinessAuthority(
        data_root=str(runtime_dir),
        durability_request_id=17,
        requested_profile="durable_sync",
        writer_resource_id="00000007.0000000b",
        durability_qualification_profile="test/disposable-powercut/v1",
        projection_writer_resource_id="projection-restart-writer",
        projection_qualification_profile="candidate/test-local-filesystem/v1",
    )
    receipt = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(tmp_path / "config"),
        host=_FileProcessHost(tmp_path / "activation-count"),
        readiness_authority=authority,
    ).activate(requirement, "python")

    assert receipt["outcome"] == "activated"
    assert [kind for kind, _ in calls] == ["durability", "projection"]
    assert calls[0][1]["sequence"] == 41
    assert calls[1][1]["container_epoch"] == 11


def test_untracked_running_process_cannot_invent_generation_one(tmp_path):
    runtime_dir = tmp_path / "home" / "runtime"
    counter_path = tmp_path / "activation-count"
    counter_path.write_text("1")
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
        host=_FileProcessHost(counter_path),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(requirement, "python")

    assert receipt["outcome"] == "failed"
    assert receipt["error"]["code"] == "stale_generation"
    assert counter_path.read_text() == "1"


def test_corrupt_generation_snapshot_fails_closed(tmp_path):
    runtime_dir = tmp_path / "home" / "runtime"
    workspace = runtime_broker.workspace_id(runtime_dir)
    state_path = runtime_broker._activation_state_path(tmp_path / "config", workspace)
    state_path.parent.mkdir(parents=True)
    state_path.write_text("{not-json")
    requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace=workspace,
        request_source="python",
        minimum_cut=_cut(),
    )["requirement"]
    receipt = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(tmp_path / "config"),
        host=_FileProcessHost(tmp_path / "activation-count"),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(requirement, "python")

    assert receipt["outcome"] == "failed"
    assert receipt["error"]["code"] == "stale_generation"
