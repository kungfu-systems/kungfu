# SPDX-License-Identifier: Apache-2.0

import json


from kungfu import runtime_broker

from _runtime_broker_scaffold_cases import (
    _CutReadinessAuthority,
    _cut,
    _FileProcessHost,
    _LeaseClock,
)


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


def test_product_status_treats_an_absent_live_runtime_as_available(tmp_path):
    runtime_dir = tmp_path / "home" / "runtime"

    status = runtime_broker.product_status(tmp_path / "config", runtime_dir)

    assert status == {
        "schema": "kungfu.runtime.product-status/v1",
        "workspaceId": runtime_broker.workspace_id(runtime_dir),
        "availability": "available",
        "liveState": "inactive",
        "handle": None,
        "leases": {"activeCount": 0, "items": []},
        "error": None,
    }


def test_product_status_projects_the_exact_handle_cut_and_effective_leases(tmp_path):
    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="kfx",
        minimum_cut=_cut("7", "17"),
    )["requirement"]
    activation = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(tmp_path / "activation-count"),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(requirement, "kfx")
    clock = _LeaseClock(100)
    manager = runtime_broker.RuntimeLeaseManager(
        config_home,
        requirement["workspaceId"],
        clock=clock,
    )
    manager.acquire(
        activation["handle"],
        holder_id="kfx:projection",
        capabilities=["runtime.live-projection"],
        ttl_ns=20,
        lease_id="lease-projection",
    )

    current = runtime_broker.product_status(
        config_home, runtime_dir, clock=_LeaseClock(110)
    )
    expired = runtime_broker.product_status(
        config_home, runtime_dir, clock=_LeaseClock(121)
    )

    assert current["liveState"] == "ready"
    assert current["handle"] == activation["handle"]
    assert current["handle"]["readiness"]["durableCut"] == _cut("7", "17")
    assert current["leases"]["activeCount"] == 1
    assert expired["leases"]["activeCount"] == 0
    assert expired["leases"]["items"][0]["state"] == "expired"


def test_product_status_preserves_a_failed_generation_with_a_stable_error(tmp_path):
    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    workspace = runtime_broker.workspace_id(runtime_dir)
    requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace=workspace,
        request_source="python",
        minimum_cut=_cut(),
    )["requirement"]
    runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(config_home),
        host=_FileProcessHost(tmp_path / "activation-count"),
        readiness_authority=_CutReadinessAuthority(),
    ).activate(requirement, "python")
    state_path = runtime_broker._activation_state_path(config_home, workspace)
    state = json.loads(state_path.read_text())
    state["handles"][0]["state"] = "failed"
    state["handles"][0]["readiness"]["state"] = "failed"
    runtime_broker._write_activation_state(state_path, state)

    status = runtime_broker.product_status(config_home, runtime_dir)

    assert status["liveState"] == "failed"
    assert status["handle"]["generation"] == "1"
    assert status["error"] == {
        "code": "activation_failed",
        "message": "The fenced runtime generation is in the failed state.",
        "retryable": True,
    }


def test_product_status_reports_a_stable_error_without_using_process_health(
    tmp_path,
):
    runtime_dir = tmp_path / "home" / "runtime"
    workspace = runtime_broker.workspace_id(runtime_dir)
    state_path = runtime_broker._activation_state_path(tmp_path / "config", workspace)
    state_path.parent.mkdir(parents=True)
    state_path.write_text("{not-json")

    status = runtime_broker.product_status(tmp_path / "config", runtime_dir)

    assert status["availability"] == "available"
    assert status["liveState"] == "failed"
    assert status["handle"] is None
    assert status["error"]["code"] == "stale_generation"
