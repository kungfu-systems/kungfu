# SPDX-License-Identifier: Apache-2.0

import json
import os
import sys
import types
from pathlib import Path


class _FakeCoordinator:
    def __init__(self, location, low_latency=False):
        self.location = location
        self.low_latency = low_latency

    def run(self):
        return None


def _install_fake_pykungfu():
    fake = types.ModuleType("pykungfu")
    fake.__file__ = "/nonexistent/pykungfu.so"
    fake.yijinjing = types.SimpleNamespace(
        enums=types.SimpleNamespace(
            mode=types.SimpleNamespace(LIVE="LIVE"),
            location_role=types.SimpleNamespace(SYSTEM="SYSTEM"),
        )
    )
    runtime = types.ModuleType("pykungfu.runtime")
    runtime.coordinator = _FakeCoordinator
    runtime.locator = lambda runtime_dir: {"runtime_dir": runtime_dir}
    runtime.location = lambda mode, role, namespace, name, locator: {
        "mode": mode,
        "role": role,
        "namespace": namespace,
        "name": name,
        "locator": locator,
    }
    fake.runtime = runtime
    sys.modules.setdefault("pykungfu", fake)
    sys.modules.setdefault("pykungfu.runtime", runtime)


_install_fake_pykungfu()

from kungfu import runtime_broker, runtime_service  # noqa: E402


ROOT = Path(__file__).parents[4]
LEASE_FIXTURES = json.loads(
    (ROOT / "tests/fixtures/runtime-lease-recovery/cases.json").read_text()
)


def test_adopted_coordinator_kill_uses_portable_hard_signal(monkeypatch):
    delivered = []
    monkeypatch.setattr(runtime_service, "_is_pid_running", lambda pid: True)
    monkeypatch.setattr(runtime_service.platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        runtime_service,
        "_signal_pid",
        lambda pid, sig: delivered.append((pid, sig)),
    )

    runtime_service.AdoptedCoordinatorProcess(42).kill()

    assert delivered == [
        (
            42,
            getattr(
                runtime_service.signal,
                "SIGKILL",
                runtime_service.signal.SIGTERM,
            ),
        )
    ]


def _activation_snapshot(workspace, supervisor_pid, coordinator_pid):
    runtime_id = "runtime-test"
    generation = LEASE_FIXTURES["adoption"]["generation"]
    return {
        "schema": "kungfu.runtime.snapshot/v1",
        "workspaceId": workspace,
        "runtimeId": runtime_id,
        "activeGeneration": generation,
        "handles": [
            {
                "schema": "kungfu.runtime.handle/v1",
                "runtimeId": runtime_id,
                "requirementId": "request-adoption",
                "workspaceId": workspace,
                "generation": generation,
                "state": "ready",
                "capabilities": ["runtime.assessment-scheduling"],
                "grantedAuthorities": [
                    "runtime.coordinate",
                    "runtime.capability-use",
                    "runtime.lease",
                ],
                "readiness": {
                    "schema": "kungfu.runtime.readiness/v1",
                    "state": "ready",
                    "durableCut": {
                        "stream_id": "1",
                        "container_epoch": "1",
                        "sequence": "1",
                        "frame_uid": "1",
                    },
                    "projectionCut": None,
                    "evidence": [{"kind": "durability-receipt", "ref": "receipt:test"}],
                    "observedAtNs": "1",
                },
                "host": {
                    "kind": "process",
                    "hostId": "process-test",
                    "diagnostics": {
                        "supervisorPid": supervisor_pid,
                        "coordinatorPid": coordinator_pid,
                        "socketPath": None,
                        "serviceInstalled": None,
                        "guiVisible": None,
                    },
                },
            }
        ],
        "leases": [],
    }


def test_coordinator_status_reports_runtime_state(tmp_path):
    config_home = tmp_path / "config"
    home = tmp_path / "home"
    runtime_dir = tmp_path / "runtime"

    payload = runtime_service.route_status(
        str(home),
        str(runtime_dir),
        str(config_home),
    )

    assert payload["schema"] == "kungfu.runtime.status/v2"
    assert payload["status"] == "stopped"
    assert payload["configHome"] == str(config_home.resolve())
    assert payload["dataRoot"] == str(home.resolve())
    assert payload["runtimeDir"] == str(runtime_dir.resolve())
    assert payload["supervisorStateDir"] == str(
        config_home.resolve() / "runtime" / "supervisor"
    )
    assert payload["stateDir"] == str(runtime_dir.resolve() / "coordinator")
    assert payload["supervisor"]["running"] is False
    assert payload["coordinator"]["running"] is False
    assert payload["route"]["registered"] is False
    assert payload["lifecycle"]["state"] == "stopped"
    assert payload["lifecycle"]["healthy"] is False
    assert payload["product"] == {
        "schema": "kungfu.runtime.product-status/v1",
        "workspaceId": runtime_broker.workspace_id(runtime_dir),
        "availability": "available",
        "liveState": "inactive",
        "handle": None,
        "leases": {"activeCount": 0, "items": []},
        "error": None,
    }


def test_coordinator_status_detects_live_recorded_pid(tmp_path):
    config_home = tmp_path / "config"
    runtime_dir = tmp_path / "runtime"
    runtime_service.supervisor_state_dir(str(config_home)).mkdir(parents=True)
    runtime_service.state_dir(str(runtime_dir)).mkdir(parents=True)
    runtime_service.write_pid(
        runtime_service.supervisor_pid_path(str(config_home)), os.getpid()
    )
    runtime_service.write_pid(
        runtime_service.coordinator_pid_path(str(runtime_dir)), os.getpid()
    )

    payload = runtime_service.route_status(
        str(tmp_path / "home"),
        str(runtime_dir),
        str(config_home),
    )

    assert payload["status"] == "running"
    assert payload["supervisor"]["pid"] == os.getpid()
    assert payload["supervisor"]["running"] is True
    assert payload["coordinator"]["pid"] == os.getpid()
    assert payload["coordinator"]["running"] is True
    assert payload["lifecycle"]["state"] == "running"
    assert payload["lifecycle"]["healthy"] is True
    assert payload["product"]["liveState"] == "inactive"
    assert payload["product"]["availability"] == "available"


def test_upsert_route_registers_data_root_under_user_supervisor(tmp_path):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"

    route = runtime_service.upsert_route(
        str(config_home),
        str(home),
        str(runtime_dir),
    )
    routes = runtime_service.read_routes(str(config_home))
    payload = runtime_service.route_status(
        str(home),
        str(runtime_dir),
        str(config_home),
    )

    assert routes["schema"] == "kungfu.runtime.routes/v2"
    assert route["routeId"] in routes["routes"]
    assert routes["routes"][route["routeId"]]["dataRoot"] == str(home.resolve())
    assert payload["route"]["registered"] is True
    assert payload["route"]["freshness"]["state"] == "fresh"
    assert payload["routes"]["count"] == 1


def test_coordinator_status_detects_stale_route_lease(tmp_path, monkeypatch):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"

    monkeypatch.setattr(runtime_service, "_now", lambda: 1000.0)
    runtime_service.upsert_route(str(config_home), str(home), str(runtime_dir))
    monkeypatch.setattr(runtime_service, "_now", lambda: 1035.0)

    payload = runtime_service.route_status(
        str(home),
        str(runtime_dir),
        str(config_home),
    )

    assert payload["status"] == "stale-route"
    assert payload["route"]["stale"] is True
    assert payload["route"]["freshness"]["ageSeconds"] == 35.0
    assert payload["routes"]["staleCount"] == 1
    assert "route-stale" in payload["lifecycle"]["warnings"]


def test_route_drain_intent_preserves_heartbeat_diagnostics(tmp_path, monkeypatch):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"
    monkeypatch.setattr(runtime_service, "_now", lambda: 1000.0)
    route = runtime_service.upsert_route(str(config_home), str(home), str(runtime_dir))
    runtime_service.touch_route_heartbeat(
        str(config_home),
        route["routeId"],
        supervisor_pid=1200,
        coordinator_pid=1201,
    )
    monkeypatch.setattr(runtime_service, "_now", lambda: 1001.0)

    drained = runtime_service.set_route_desired(
        str(config_home), str(home), str(runtime_dir), False
    )

    assert drained["desired"] is False
    assert drained["heartbeatAt"] == 1000.0
    assert drained["supervisorPid"] == 1200
    assert drained["coordinatorPid"] == 1201


def test_fenced_orphan_coordinator_is_preserved_for_supervisor_adoption(
    tmp_path, monkeypatch
):
    fixture = LEASE_FIXTURES["adoption"]
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"
    workspace = runtime_broker.workspace_id(runtime_dir)
    runtime_service.write_pid(
        runtime_service.supervisor_pid_path(str(config_home)),
        fixture["previousSupervisorPid"],
    )
    runtime_service.write_pid(
        runtime_service.coordinator_pid_path(str(runtime_dir)),
        fixture["coordinatorPid"],
    )
    runtime_broker._write_activation_state(
        runtime_broker._activation_state_path(config_home, workspace),
        _activation_snapshot(
            workspace,
            fixture["previousSupervisorPid"],
            fixture["coordinatorPid"],
        ),
    )
    monkeypatch.setattr(
        runtime_service,
        "_is_pid_running",
        lambda pid: pid == fixture["coordinatorPid"],
    )

    repairs = runtime_service.repair_route_state(
        str(home), str(runtime_dir), str(config_home)
    )
    adopted = runtime_service._fenced_adopted_coordinator(
        str(config_home.resolve()), str(runtime_dir.resolve())
    )

    assert repairs == [
        "removed-dead-supervisor-pid",
        "preserved-fenced-orphan-coordinator",
    ]
    assert adopted is not None
    assert adopted.pid == fixture["coordinatorPid"]
    assert (
        runtime_service.read_coordinator_pid(str(runtime_dir))
        == fixture["coordinatorPid"]
    )


def test_untracked_orphan_coordinator_is_terminated(tmp_path, monkeypatch):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"
    coordinator_pid = 1301
    runtime_service.write_pid(
        runtime_service.coordinator_pid_path(str(runtime_dir)), coordinator_pid
    )
    monkeypatch.setattr(
        runtime_service,
        "_is_pid_running",
        lambda pid: pid == coordinator_pid,
    )
    terminated = []

    def _terminate(pid, timeout=2.0):
        terminated.append((pid, timeout))
        return True

    monkeypatch.setattr(
        runtime_service.ProcessRuntimeHost,
        "terminate_and_wait",
        staticmethod(_terminate),
    )

    repairs = runtime_service.repair_route_state(
        str(home), str(runtime_dir), str(config_home)
    )

    assert repairs == ["terminated-orphan-coordinator"]
    assert terminated == [(coordinator_pid, 2.0)]
    assert runtime_service.read_coordinator_pid(str(runtime_dir)) is None


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
            "supervisor": {"running": True},
            "coordinator": {"running": True},
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
    assert "supervisor" in plan["content"]
    assert "KF_CONFIG_HOME" in plan["content"]
    assert "supervise" in plan["content"]
    assert plan["path"]
    assert plan["installNote"]
    assert plan["uninstallNote"]


def test_workspace_coordinator_schedules_one_pending_assessment_process(
    tmp_path, monkeypatch
):
    runtime_dir = tmp_path / "runtime"
    pending_key = "sha256:" + "1" * 64
    monkeypatch.setattr(
        runtime_service,
        "publish_assessment_snapshot",
        lambda runtime_dir: {
            "assessments": [{"assessment_key": pending_key, "state": "pending"}]
        },
    )
    monkeypatch.setattr(
        runtime_service,
        "assessment_worker_command",
        lambda runtime_dir, key: ["worker", runtime_dir, key],
    )

    spawned = []

    class _FakeWorker:
        def poll(self):
            return None

    def _spawn(command, **kwargs):
        spawned.append((command, kwargs))
        return _FakeWorker()

    monkeypatch.setattr(runtime_service.subprocess, "Popen", _spawn)
    coordinator = runtime_service.Coordinator(str(tmp_path / "home"), str(runtime_dir))
    coordinator.on_interval_check(1_000_000_000)
    coordinator.on_interval_check(2_000_000_000)

    assert len(spawned) == 1
    assert spawned[0][0] == ["worker", str(runtime_dir), pending_key]
    assert coordinator._assessment_executor.current[0] == pending_key


def test_workspace_coordinator_cancels_timed_out_assessor_and_retries_pending_request(
    tmp_path, monkeypatch
):
    runtime_dir = tmp_path / "runtime"
    pending_key = "sha256:" + "2" * 64
    monkeypatch.setenv("KF_ASSESSMENT_WORKER_TIMEOUT_SECONDS", "1")
    monkeypatch.setattr(
        runtime_service,
        "publish_assessment_snapshot",
        lambda runtime_dir: {
            "assessments": [{"assessment_key": pending_key, "state": "pending"}]
        },
    )
    monkeypatch.setattr(
        runtime_service,
        "assessment_worker_command",
        lambda runtime_dir, key: ["worker", runtime_dir, key],
    )

    spawned = []

    class _FakeWorker:
        def __init__(self):
            self.terminated = False

        def poll(self):
            return None

        def terminate(self):
            self.terminated = True

        def wait(self, timeout=None):
            return 0

    def _spawn(command, **kwargs):
        worker = _FakeWorker()
        spawned.append(worker)
        return worker

    monkeypatch.setattr(runtime_service.subprocess, "Popen", _spawn)
    coordinator = runtime_service.Coordinator(str(tmp_path / "home"), str(runtime_dir))
    coordinator.on_interval_check(1_000_000_000)
    coordinator.on_interval_check(2_500_000_000)

    assert len(spawned) == 2
    assert spawned[0].terminated is True
    assert coordinator._assessment_executor.current[1] is spawned[1]


def test_assessment_subscription_snapshot_exposes_summary_before_proof(
    tmp_path, monkeypatch
):
    runtime_dir = tmp_path / "runtime"
    monkeypatch.setattr(
        runtime_service.storage_service,
        "assessment_list",
        lambda runtime_dir: {
            "schema": "kungfu.trust.assessment/v1",
            "assessment_count": 2,
            "assessments": [
                {"assessment_key": "fresh", "state": "fresh"},
                {"assessment_key": "pending", "state": "pending"},
            ],
        },
    )

    snapshot = runtime_service.publish_assessment_snapshot(str(runtime_dir))

    assert snapshot["schema"] == "kungfu.runtime.assessment-subscription/v2"
    assert snapshot["counts"] == {"fresh": 1, "pending": 1}
    persisted = runtime_service._json_read(
        runtime_service.assessment_subscription_path(str(runtime_dir))
    )
    assert persisted["counts"] == snapshot["counts"]
