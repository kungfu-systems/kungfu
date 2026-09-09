# SPDX-License-Identifier: Apache-2.0
"""Coordinator engine, repair, compatibility, and service-plan cases."""
# ruff: noqa: F401,F403

from _runtime_service_support import *
from _runtime_service_route_cases import _activation_snapshot


def test_runtime_demand_status_reaches_drain_after_idle_grace(tmp_path):
    fixture = LEASE_FIXTURES["adoption"]
    config_home = tmp_path / "config"
    runtime_dir = tmp_path / "workspace" / ".kungfu" / "runtime"
    workspace = runtime_broker.workspace_id(runtime_dir)
    runtime_broker._write_activation_state(
        runtime_broker._activation_state_path(config_home, workspace),
        _activation_snapshot(
            workspace,
            fixture["previousSupervisorPid"],
            fixture["coordinatorPid"],
        ),
    )
    grace_ns = 3_000_000_000
    clock = types.SimpleNamespace(now_ns=lambda: grace_ns + 1)

    demand = runtime_service._runtime_demand_status(
        str(config_home),
        str(runtime_dir),
        grace_ns=grace_ns,
        clock=clock,
    )

    assert demand is not None
    assert demand["state"] == "draining"
    assert demand["activeLeaseCount"] == 0
    assert demand["generation"] == fixture["generation"]
    assert runtime_service._complete_runtime_drain(
        str(config_home),
        str(runtime_dir),
        fixture["generation"],
        stopped=True,
    )
    snapshot = runtime_broker._read_activation_state(
        runtime_broker._activation_state_path(config_home, workspace)
    )
    assert snapshot["handles"][0]["state"] == "stopped"


def test_restart_window_blocks_crash_loop_until_old_attempt_expires():
    fixture = LEASE_FIXTURES["crashLoop"]
    attempts = [float(value) for value in fixture["attempts"]]

    blocked = runtime_service._restart_permitted(
        attempts,
        float(fixture["blockedAt"]),
        window_seconds=float(fixture["windowSeconds"]),
        max_attempts=fixture["maxAttempts"],
    )
    admitted = runtime_service._restart_permitted(
        attempts,
        float(fixture["admittedAt"]),
        window_seconds=float(fixture["windowSeconds"]),
        max_attempts=fixture["maxAttempts"],
    )

    assert blocked is False
    assert admitted is True
    assert attempts == [105.0, 110.0, 115.0, 120.0]


def test_read_routes_normalizes_legacy_master_schema(tmp_path):
    config_home = tmp_path / "config"
    runtime_service._json_write(
        runtime_service.routes_path(str(config_home)),
        {
            "schema": runtime_service.LEGACY_SCHEMA_ROUTES,
            "routes": {"legacy": {"masterPid": 123, "desired": True}},
        },
    )

    payload = runtime_service.read_routes(str(config_home))

    assert payload["schema"] == runtime_service.SCHEMA_ROUTES
    assert payload["routes"]["legacy"]["coordinatorPid"] == 123
    assert "masterPid" not in payload["routes"]["legacy"]


def test_status_reads_legacy_coordinator_pid_and_state(tmp_path):
    runtime_dir = tmp_path / "runtime"
    runtime_service.write_pid(
        runtime_service.legacy_coordinator_pid_path(str(runtime_dir)), os.getpid()
    )
    runtime_service._json_write(
        runtime_service.legacy_state_path(str(runtime_dir)),
        {"schema": "kungfu.master-service.status/v1", "status": "master-running"},
    )

    payload = runtime_service.route_status(
        str(tmp_path / "home"), str(runtime_dir), str(tmp_path / "config")
    )

    assert payload["coordinator"]["pid"] == os.getpid()
    assert payload["lastState"]["status"] == "master-running"


def test_coordinator_keeps_wire_v1_location_identity(tmp_path):
    coordinator = runtime_service.Coordinator(
        str(tmp_path / "home"), str(tmp_path / "runtime")
    )

    assert coordinator.location["namespace"] == "master"
    assert coordinator.location["name"] == "master"


def test_coordinator_engine_handles_inspect_request_without_process_state(
    tmp_path, monkeypatch
):
    def _process_boundary_used(*args, **kwargs):
        raise AssertionError("no-fork engine crossed the process boundary")

    monkeypatch.setattr(runtime_service.subprocess, "Popen", _process_boundary_used)
    monkeypatch.setattr(runtime_service.os, "getpid", _process_boundary_used)
    monkeypatch.setattr(runtime_service.signal, "signal", _process_boundary_used)

    engine = runtime_service.CoordinatorEngine(
        str(tmp_path / "home"),
        str(tmp_path / "runtime"),
    )
    receipt = engine.handle_request(runtime_service.RuntimeEngineRequest("inspect"))

    assert receipt.accepted is True
    assert receipt.state == "constructed"
    assert receipt.capabilities == (
        "runtime.peer-registry",
        "runtime.channel-routing",
        "runtime.assessment-scheduling",
    )


def test_process_runtime_host_wraps_engine_with_pid_lifecycle(tmp_path, monkeypatch):
    events = []

    class _FakeEngine:
        def __init__(self, *args, **kwargs):
            events.append(("constructed", args, kwargs))

        def run(self):
            events.append(("run",))

        def close(self):
            events.append(("close",))

    monkeypatch.setattr(runtime_service, "CoordinatorEngine", _FakeEngine)
    runtime_dir = tmp_path / "runtime"
    result = runtime_service.ProcessRuntimeHost().run_foreground(
        str(tmp_path / "home"), str(runtime_dir)
    )

    assert result == 0
    assert [event[0] for event in events] == ["constructed", "run", "close"]
    assert runtime_service.read_coordinator_pid(str(runtime_dir)) is None
    state = runtime_service._json_read(runtime_service.state_path(str(runtime_dir)))
    assert state["status"] == "coordinator-running"
    assert state["coordinatorPid"] == os.getpid()
    assert state["runtimeGeneration"] == "1"
    assert state["coordinatorEpoch"] == "1"
    assert events[0][2]["runtime_generation"] == "1"
    assert events[0][2]["coordinator_epoch"] == "1"


def test_process_runtime_host_never_reports_ready_when_native_bind_fails(
    tmp_path, monkeypatch
):
    class _BindFailure:
        def __init__(self, *args, **kwargs):
            raise OSError("nanomsg bind failed")

    monkeypatch.setattr(runtime_service, "CoordinatorEngine", _BindFailure)
    runtime_dir = tmp_path / "runtime"

    with pytest.raises(OSError, match="nanomsg bind failed"):
        runtime_service.ProcessRuntimeHost().run_foreground(
            str(tmp_path / "home"), str(runtime_dir)
        )

    assert runtime_service.read_coordinator_pid(str(runtime_dir)) is None
    assert not runtime_service.state_path(str(runtime_dir)).exists()


def test_repair_route_state_removes_dead_pid_files(tmp_path, monkeypatch):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"
    runtime_service.supervisor_state_dir(str(config_home)).mkdir(parents=True)
    runtime_service.state_dir(str(runtime_dir)).mkdir(parents=True)
    runtime_service.write_pid(
        runtime_service.supervisor_pid_path(str(config_home)), 123
    )
    runtime_service.write_pid(
        runtime_service.coordinator_pid_path(str(runtime_dir)), 456
    )
    monkeypatch.setattr(runtime_service, "_is_pid_running", lambda pid: False)

    repairs = runtime_service.repair_route_state(
        str(home),
        str(runtime_dir),
        str(config_home),
    )

    assert repairs == ["removed-dead-supervisor-pid", "removed-dead-coordinator-pid"]
    assert (
        runtime_service.read_pid(runtime_service.supervisor_pid_path(str(config_home)))
        is None
    )
    assert (
        runtime_service.read_pid(runtime_service.coordinator_pid_path(str(runtime_dir)))
        is None
    )


def test_ensure_coordinator_reports_repairs(tmp_path, monkeypatch):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"
    runtime_service.state_dir(str(runtime_dir)).mkdir(parents=True)
    runtime_service.write_pid(
        runtime_service.coordinator_pid_path(str(runtime_dir)), 456
    )
    monkeypatch.setattr(runtime_service, "_is_pid_running", lambda pid: False)

    class _FakeProcess:
        pid = 789

    monkeypatch.setattr(
        runtime_service.subprocess, "Popen", lambda *a, **k: _FakeProcess()
    )

    def _fake_wait(
        home, runtime_dir, config_home, *, changed, route, repairs, command=None
    ):
        return {
            "schema": runtime_service.SCHEMA_STATUS,
            "changed": changed,
            "route": route,
            "repairs": repairs,
            "command": command,
        }

    monkeypatch.setattr(runtime_service, "_wait_for_coordinator", _fake_wait)

    payload = runtime_service.ensure_coordinator(
        str(home),
        str(runtime_dir),
        "warning",
        str(config_home),
    )

    assert payload["changed"] is True
    assert payload["repairs"] == ["removed-dead-coordinator-pid"]


def test_wait_for_coordinator_preserves_enriched_route_status(tmp_path, monkeypatch):
    route = runtime_service.route_record(
        str(tmp_path / "home"),
        str(tmp_path / "runtime"),
    )

    def _fake_status(home, runtime_dir, config_home):
        return {
            "schema": runtime_service.SCHEMA_STATUS,
            "status": "running",
            "lifecycle": {"healthy": True},
            "supervisor": {"running": True, "identityVerified": True},
            "coordinator": {
                "pid": 42,
                "running": True,
                "identityVerified": True,
            },
            "lastState": {"status": "coordinator-running", "coordinatorPid": 42},
            "route": {
                **route,
                "registered": True,
                "freshness": {"state": "fresh", "stale": False},
                "stale": False,
            },
        }

    monkeypatch.setattr(runtime_service, "route_status", _fake_status)

    payload = runtime_service._wait_for_coordinator(
        str(tmp_path / "home"),
        str(tmp_path / "runtime"),
        str(tmp_path / "config"),
        changed=False,
        route=route,
    )

    assert payload["route"]["registered"] is True
    assert payload["route"]["freshness"]["state"] == "fresh"


def test_service_plan_is_dry_run_material(tmp_path):
    config_home = tmp_path / "config"
    plan = runtime_service.service_plan(
        str(tmp_path / "home"),
        str(tmp_path / "runtime"),
        "warning",
        str(config_home),
    ).as_dict()

    assert plan["schema"] == "kungfu.runtime.service-plan/v2"
    assert "supervisor" in plan["content"].lower()
    assert "KF_CONFIG_HOME" in plan["content"]
    assert f"{runtime_service.SUPERVISOR_ALWAYS_ON_ENV}" in plan["content"]
    assert "supervise" in plan["content"]
    assert plan["path"]
    assert plan["installNote"]
    assert plan["uninstallNote"]
