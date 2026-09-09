# SPDX-License-Identifier: Apache-2.0
"""Route registration, authority, lease, and adoption cases."""
# ruff: noqa: F401,F403

from _runtime_service_support import *


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


def test_route_projects_runtime_generation_into_coordinator_environment(tmp_path):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"

    route = runtime_service.upsert_route(
        str(config_home), str(home), str(runtime_dir), "17"
    )
    env = runtime_service.command_env(
        str(home),
        str(runtime_dir),
        "warning",
        str(config_home),
        route["runtimeGeneration"],
    )

    assert route["runtimeGeneration"] == "17"
    assert env["KF_RUNTIME_GENERATION"] == "17"


def test_coordinator_authority_persists_epoch_and_rejects_stale_generation(
    tmp_path,
):
    runtime_dir = tmp_path / "runtime"

    first = runtime_service.allocate_coordinator_authority(str(runtime_dir), "7")
    restarted = runtime_service.allocate_coordinator_authority(str(runtime_dir), "7")
    replaced = runtime_service.allocate_coordinator_authority(str(runtime_dir), "8")

    assert first == {"runtimeGeneration": "7", "coordinatorEpoch": "1"}
    assert restarted == {"runtimeGeneration": "7", "coordinatorEpoch": "2"}
    assert replaced == {"runtimeGeneration": "8", "coordinatorEpoch": "3"}
    with pytest.raises(RuntimeError, match="older than the persisted"):
        runtime_service.allocate_coordinator_authority(str(runtime_dir), "7")


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
    runtime_service._json_write(
        runtime_service.state_path(str(runtime_dir)),
        {
            "schema": runtime_service.SCHEMA_STATUS,
            "status": "coordinator-running",
            "runtimeGeneration": fixture["generation"],
            "coordinatorPid": fixture["coordinatorPid"],
            "coordinatorStartIdentity": "start-coordinator",
        },
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
    monkeypatch.setattr(
        runtime_service,
        "_process_start_identity",
        lambda pid: "start-coordinator" if pid == fixture["coordinatorPid"] else None,
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


def test_untracked_orphan_coordinator_is_preserved_without_signalling(
    tmp_path, monkeypatch
):
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
    monkeypatch.setattr(
        runtime_service,
        "_terminate_process_if_matches",
        lambda pid, start, *, force=False: terminated.append((pid, start, force)),
    )

    repairs = runtime_service.repair_route_state(
        str(home), str(runtime_dir), str(config_home)
    )

    assert repairs == ["preserved-unowned-orphan-coordinator"]
    assert terminated == []
    assert runtime_service.read_coordinator_pid(str(runtime_dir)) == coordinator_pid


def test_adopted_coordinator_rejects_reused_pid_without_signalling(monkeypatch):
    delivered = []

    class _ReplacementProcess:
        def create_time(self):
            return 200.0

        def terminate(self):
            delivered.append("terminate")

        def kill(self):
            delivered.append("kill")

    monkeypatch.setattr(runtime_service, "_is_pid_running", lambda pid: True)
    monkeypatch.setattr(
        runtime_service.psutil,
        "Process",
        lambda pid: _ReplacementProcess(),
    )

    adopted = runtime_service.AdoptedCoordinatorProcess(42, "100.000000")
    adopted.terminate()
    adopted.kill()

    assert adopted.poll() == 0
    assert delivered == []

    def _denied_process(pid):
        raise runtime_service.psutil.AccessDenied(pid=pid)

    monkeypatch.setattr(runtime_service.psutil, "Process", _denied_process)
    assert not runtime_service._terminate_process_if_matches(42, "100.000000")
    assert delivered == []
