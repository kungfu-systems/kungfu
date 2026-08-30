# SPDX-License-Identifier: Apache-2.0


import pytest

from kungfu import runtime_broker

from _runtime_broker_scaffold_cases import (
    LEASE_FIXTURES,
    _CutReadinessAuthority,
    _cut,
    _DrainHost,
    _FileProcessHost,
    _LeaseClock,
)


def test_runtime_lease_acquire_renew_release_and_idle_drain_are_deterministic(
    tmp_path,
):
    fixture = LEASE_FIXTURES["lease"]
    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
    )["requirement"]
    activation = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(tmp_path / "activation-count"),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(requirement, "python")
    clock = _LeaseClock(int(fixture["issuedAtNs"]))
    manager = runtime_broker.RuntimeLeaseManager(
        config_home,
        requirement["workspaceId"],
        clock=clock,
    )

    lease = manager.acquire(
        activation["handle"],
        holder_id="work-console:run-17",
        capabilities=["runtime.live-projection"],
        ttl_ns=int(fixture["ttlNs"]),
        lease_id="lease-run-17",
    )
    clock.value = int(fixture["renewedAtNs"])
    renewed = manager.renew(
        lease["leaseId"],
        lease["generation"],
        int(fixture["ttlNs"]),
        holder_id="work-console:run-17",
    )
    clock.value = int(fixture["releasedAtNs"])
    with pytest.raises(runtime_broker.RuntimeLifecycleError) as foreign_release:
        manager.release(
            lease["leaseId"],
            lease["generation"],
            holder_id="work-console:another-run",
        )
    released = manager.release(
        lease["leaseId"],
        lease["generation"],
        holder_id="work-console:run-17",
    )
    clock.value = int(fixture["drainAtNs"]) - 1
    idle = manager.idle_status(int(fixture["idleGraceNs"]))
    clock.value = int(fixture["drainAtNs"])
    host = _DrainHost()
    drained = manager.drain_if_idle(
        host,
        str(runtime_dir.parent),
        str(runtime_dir),
        grace_ns=int(fixture["idleGraceNs"]),
    )

    assert lease["state"] == "active"
    assert renewed["expiresAtNs"] == str(
        int(fixture["renewedAtNs"]) + int(fixture["ttlNs"])
    )
    assert released["state"] == "released"
    assert foreign_release.value.code == "authority_conflict"
    assert idle["state"] == "idle-grace"
    assert idle["drainAtNs"] == fixture["drainAtNs"]
    assert drained["state"] == "stopped"
    assert host.calls == [(str(runtime_dir.parent), str(runtime_dir))]
    assert manager.inspect()["handles"][0]["state"] == "stopped"


def test_runtime_lease_rejects_capability_broadening_and_expired_renewal(tmp_path):
    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
    )["requirement"]
    activation = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(tmp_path / "activation-count"),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(requirement, "python")
    clock = _LeaseClock(100)
    manager = runtime_broker.RuntimeLeaseManager(
        config_home,
        requirement["workspaceId"],
        clock=clock,
    )

    with pytest.raises(runtime_broker.RuntimeLifecycleError) as broadened:
        manager.acquire(
            activation["handle"],
            holder_id="holder",
            capabilities=["runtime.assessment-scheduling"],
            ttl_ns=10,
        )
    lease = manager.acquire(
        activation["handle"],
        holder_id="holder",
        capabilities=["runtime.live-projection"],
        ttl_ns=10,
    )
    with pytest.raises(runtime_broker.RuntimeLifecycleError) as foreign_holder:
        manager.renew(
            lease["leaseId"],
            lease["generation"],
            10,
            holder_id="another-holder",
        )
    clock.value = 110
    with pytest.raises(runtime_broker.RuntimeLifecycleError) as expired:
        manager.renew(
            lease["leaseId"],
            lease["generation"],
            10,
            holder_id="holder",
        )

    assert broadened.value.code == "authority_conflict"
    assert foreign_holder.value.code == "authority_conflict"
    assert expired.value.code == "lease_expired"
    assert manager.inspect()["leases"][0]["state"] == "expired"


def test_idle_drain_fences_new_leases_and_same_generation_activation(tmp_path):
    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    counter_path = tmp_path / "activation-count"
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
        request_id="request-before-drain",
    )["requirement"]
    client = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(counter_path),
        readiness_authority=_CutReadinessAuthority(),
    )
    activation = client.activate(requirement, "python")
    manager = runtime_broker.RuntimeLeaseManager(
        config_home,
        requirement["workspaceId"],
        clock=_LeaseClock(2),
    )

    draining = manager.begin_idle_drain(0)
    retried = client.activate(
        {**requirement, "requestId": "request-during-drain"}, "python"
    )
    with pytest.raises(runtime_broker.RuntimeLifecycleError) as fenced:
        manager.acquire(
            activation["handle"],
            holder_id="late-holder",
            capabilities=["runtime.live-projection"],
            ttl_ns=10,
        )

    assert draining["state"] == "draining"
    assert retried["outcome"] == "failed"
    assert retried["error"]["code"] == "operation_cancelled"
    assert fenced.value.code == "stale_generation"
    assert counter_path.read_text() == "1"


def test_restart_expires_old_leases_before_replacement_generation(tmp_path):
    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    counter_path = tmp_path / "activation-count"
    workspace = runtime_broker.workspace_id(runtime_dir)
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=workspace,
        request_source="python",
        minimum_cut=_cut(),
        request_id="request-before-restart",
    )["requirement"]
    first = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(counter_path, 1200, 1201),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(requirement, "python")
    manager = runtime_broker.RuntimeLeaseManager(
        config_home, workspace, clock=_LeaseClock(100)
    )
    lease = manager.acquire(
        first["handle"],
        holder_id="work-console:run-before-crash",
        capabilities=["runtime.live-projection"],
        ttl_ns=1000,
    )

    restarting = manager.begin_restart(1201)
    snapshot = manager.inspect()
    replacement = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(counter_path, 2200, 2201),
        readiness_authority=_CutReadinessAuthority(),
    ).activate({**requirement, "requestId": "request-after-restart"}, "python")

    assert restarting == {"state": "restarting", "generation": "1"}
    assert snapshot["handles"][0]["state"] == "restarting"
    assert snapshot["leases"][0]["leaseId"] == lease["leaseId"]
    assert snapshot["leases"][0]["state"] == "expired"
    assert replacement["outcome"] == "activated"
    assert replacement["handle"]["generation"] == "2"
    assert counter_path.read_text() == "2"


def test_fenced_coordinator_survives_supervisor_adoption_in_same_generation(tmp_path):
    fixture = LEASE_FIXTURES["adoption"]
    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    counter_path = tmp_path / "activation-count"
    requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
        request_id="request-before-adoption",
    )["requirement"]
    first = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(
            counter_path,
            fixture["previousSupervisorPid"],
            fixture["coordinatorPid"],
        ),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(requirement, "python")
    adopted_requirement = {**requirement, "requestId": "request-after-adoption"}
    adopted = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(
            counter_path,
            fixture["adoptedSupervisorPid"],
            fixture["coordinatorPid"],
        ),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(adopted_requirement, "python")

    assert adopted["outcome"] == "reused"
    assert adopted["handle"]["generation"] == first["handle"]["generation"]
    assert (
        adopted["handle"]["host"]["diagnostics"]["supervisorPid"]
        == fixture["adoptedSupervisorPid"]
    )
    assert counter_path.read_text() == "1"
    assert (
        runtime_broker.fenced_coordinator_generation(
            config_home,
            runtime_dir,
            fixture["coordinatorPid"],
        )
        == first["handle"]["generation"]
    )
    assert (
        runtime_broker.fenced_coordinator_generation(
            config_home,
            runtime_dir,
            fixture["coordinatorPid"] + 1,
        )
        is None
    )
