# SPDX-License-Identifier: Apache-2.0

import json
import os
import sys
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest


class _FakeCoordinator:
    def __init__(
        self,
        location,
        low_latency=False,
        durability_config=None,
        runtime_generation=1,
        coordinator_epoch=1,
    ):
        self.location = location
        self.low_latency = low_latency
        self.durability_config = durability_config
        self.runtime_generation = runtime_generation
        self.coordinator_epoch = coordinator_epoch

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
    runtime.compute_content_hash = lambda payload, algorithm="sha256": (
        algorithm + ":" + __import__("hashlib").sha256(payload).hexdigest()
    )
    runtime.durability_capability_typed = lambda: {
        "schema": "kungfu.durability.capability/v1",
        "profile": "single-host-institutional-production-candidate-v1",
        "qualification_profile": "candidate/current-hardware-single-host/v1",
        "production_eligible": False,
        "admission": {
            "current_hardware_candidate_complete": True,
            "evidence_sha256": "8" * 64,
        },
    }
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

from kungfu import (  # noqa: E402
    runtime_broker,
    runtime_processes,
    runtime_service,
    runtime_service_config,
)


ROOT = Path(__file__).parents[4]
LEASE_FIXTURES = json.loads(
    (ROOT / "tests/fixtures/runtime-lease-recovery/cases.json").read_text()
)


def test_runtime_service_config_preserves_compatibility_exports():
    for name in (
        "ServicePlan",
        "entry_command",
        "command_env",
        "coordinator_run_command",
        "assessment_worker_command",
        "run_assessment_worker",
        "supervisor_command",
        "supervisor_state_dir",
        "supervisor_log_path",
    ):
        assert getattr(runtime_service, name) is getattr(runtime_service_config, name)


def test_runtime_process_control_preserves_the_runtime_service_facade():
    assert runtime_service.CoordinatorProcess is runtime_processes.CoordinatorProcess
    assert (
        runtime_service._is_pid_running
        is runtime_processes.RuntimeProcessControl.is_pid_running
    )
    assert (
        runtime_service._process_start_identity
        is runtime_processes.RuntimeProcessControl.start_identity
    )
    assert (
        runtime_service._terminate_process_if_matches
        is runtime_processes.RuntimeProcessControl.terminate_if_matches
    )
    assert (
        runtime_service._terminate_process_tree_if_matches
        is runtime_processes.RuntimeProcessControl.terminate_tree_if_matches
    )
    assert (
        runtime_service._terminate_and_reap_child
        is runtime_processes.RuntimeProcessControl.terminate_and_reap_child
    )


def test_windows_json_write_retries_transient_replace_lock(tmp_path, monkeypatch):
    target = tmp_path / "runtime" / "state.json"
    original_replace = runtime_service.os.replace
    attempts = []
    sleeps = []

    def replace_after_transient_lock(source, destination):
        attempts.append((source, destination))
        if len(attempts) == 1:
            raise PermissionError(5, "Access is denied", str(destination))
        original_replace(source, destination)

    monkeypatch.setattr(runtime_service.platform, "system", lambda: "Windows")
    monkeypatch.setattr(runtime_service.os, "replace", replace_after_transient_lock)
    monkeypatch.setattr(runtime_service.time, "sleep", sleeps.append)

    runtime_service._json_write(target, {"status": "running"})

    assert runtime_service._json_read(target) == {"status": "running"}
    assert len(attempts) == 2
    assert sleeps == [0.05]


def test_json_write_is_atomic_across_interleaved_writers(tmp_path, monkeypatch):
    target = tmp_path / "runtime" / "state.json"
    original_replace = runtime_service.os.replace
    interleaved = False

    def replace_with_interleaved_writer(source, destination):
        nonlocal interleaved
        if not interleaved:
            interleaved = True
            runtime_service._json_write(target, {"writer": "nested"})
        original_replace(source, destination)

    monkeypatch.setattr(runtime_service.os, "replace", replace_with_interleaved_writer)

    runtime_service._json_write(target, {"writer": "outer"})

    assert runtime_service._json_read(target) == {"writer": "outer"}
    assert list(target.parent.glob(f".{target.name}.*.tmp")) == []


def test_adopted_coordinator_kill_uses_portable_hard_signal(monkeypatch):
    delivered = []
    monkeypatch.setattr(
        runtime_service,
        "_terminate_process_if_matches",
        lambda pid, start, *, force=False: delivered.append((pid, start, force)),
    )

    runtime_service.AdoptedCoordinatorProcess(42, "start-42").kill()

    assert delivered == [(42, "start-42", True)]


def test_windows_process_tree_stop_reaps_descendants(monkeypatch):
    events = []

    class _Process:
        def __init__(self, pid, children=()):
            self.pid = pid
            self._children = list(children)

        def create_time(self):
            return 42.0

        def children(self, recursive=False):
            assert recursive is True
            return self._children

        def terminate(self):
            events.append(("terminate", self.pid))

        def kill(self):
            events.append(("kill", self.pid))

    descendants = [_Process(43), _Process(44)]
    parent = _Process(42, descendants)
    waits = 0

    def _wait_procs(processes, timeout=None):
        nonlocal waits
        waits += 1
        events.append(("wait", [item.pid for item in processes], timeout))
        return ([], [descendants[0]]) if waits == 1 else (list(processes), [])

    monkeypatch.setattr(runtime_service.psutil, "Process", lambda pid: parent)
    monkeypatch.setattr(runtime_service.psutil, "wait_procs", _wait_procs)

    assert runtime_service._terminate_process_tree_if_matches(42, "42.000000")
    assert events == [
        ("terminate", 44),
        ("terminate", 43),
        ("terminate", 42),
        ("wait", [43, 44, 42], 5.0),
        ("kill", 43),
        ("wait", [43], 5.0),
    ]


def test_forced_coordinator_stop_waits_until_process_is_reaped():
    events = []

    class _Host:
        @staticmethod
        def terminate_child(child):
            events.append("terminate")

    class _Child:
        def __init__(self):
            self.waits = 0

        def wait(self, timeout=None):
            self.waits += 1
            events.append(("wait", timeout))
            if self.waits == 1:
                raise runtime_service.subprocess.TimeoutExpired(
                    ["coordinator"], timeout
                )
            return 1

        def kill(self):
            events.append("kill")

    runtime_service._terminate_and_reap_child(_Host(), _Child(), timeout=2.5)

    assert events == [
        "terminate",
        ("wait", 2.5),
        "kill",
        ("wait", 2.5),
    ]


def test_forced_coordinator_stop_reaps_descendants_before_cleanup(monkeypatch):
    events = []

    class _Descendant:
        def __init__(self, pid):
            self.pid = pid

        def terminate(self):
            events.append(("descendant-terminate", self.pid))

        def kill(self):
            events.append(("descendant-kill", self.pid))

    descendants = [_Descendant(43), _Descendant(44)]

    class _Process:
        def __init__(self, pid):
            assert pid == 42

        def children(self, recursive=False):
            assert recursive is True
            return descendants

    class _Host:
        @staticmethod
        def terminate_child(child):
            events.append("coordinator-terminate")

    class _Child:
        pid = 42

        def wait(self, timeout=None):
            events.append(("coordinator-wait", timeout))
            return 0

    waits = 0

    def _wait_procs(processes, timeout=None):
        nonlocal waits
        waits += 1
        events.append(("descendant-wait", [item.pid for item in processes], timeout))
        return ([], [descendants[0]]) if waits == 1 else (list(processes), [])

    monkeypatch.setattr(runtime_service.psutil, "Process", _Process)
    monkeypatch.setattr(runtime_service.psutil, "wait_procs", _wait_procs)

    runtime_service._terminate_and_reap_child(_Host(), _Child(), timeout=2.5)

    assert events == [
        ("descendant-terminate", 44),
        ("descendant-terminate", 43),
        "coordinator-terminate",
        ("coordinator-wait", 2.5),
        ("descendant-wait", [43, 44], 2.5),
        ("descendant-kill", 43),
        ("descendant-wait", [43], 2.5),
    ]


def test_pid_liveness_probe_never_sends_a_signal(monkeypatch):
    monkeypatch.setattr(runtime_service.psutil, "pid_exists", lambda pid: pid == 42)

    def fail_on_signal(*_args):
        raise AssertionError("PID liveness must not use os.kill(pid, 0)")

    monkeypatch.setattr(runtime_service.os, "kill", fail_on_signal)

    assert runtime_service._is_pid_running(42) is True
    assert runtime_service._is_pid_running(43) is False


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


def test_concurrent_activation_spawns_one_supervisor(tmp_path, monkeypatch):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"
    spawned = []

    class _FakeProcess:
        pid = 789

    def _spawn(*args, **kwargs):
        spawned.append((args, kwargs))
        return _FakeProcess()

    monkeypatch.setattr(runtime_service.subprocess, "Popen", _spawn)
    monkeypatch.setattr(
        runtime_service, "_process_start_identity", lambda pid: f"start-{pid}"
    )
    monkeypatch.setattr(runtime_service, "_is_pid_running", lambda pid: pid == 789)
    monkeypatch.setattr(
        runtime_service,
        "_wait_for_coordinator",
        lambda home, runtime_dir, config_home, **kwargs: kwargs,
    )
    host = runtime_service.ProcessRuntimeHost(config_home=str(config_home))

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(
            executor.map(
                lambda _: host.activate_with_generation(
                    str(home), str(runtime_dir), "17"
                ),
                range(16),
            )
        )

    assert len(spawned) == 1
    assert spawned[0][1]["env"]["KF_RUNTIME_GENERATION"] == "17"
    assert sum(result["changed"] is True for result in results) == 1
    assert (
        runtime_service.read_pid(runtime_service.supervisor_pid_path(str(config_home)))
        == 789
    )


def test_on_demand_supervisor_retires_routes_for_100_start_stop_rounds(
    tmp_path, monkeypatch
):
    config_home = tmp_path / "config"
    monkeypatch.delenv(runtime_service.SUPERVISOR_ALWAYS_ON_ENV, raising=False)
    monkeypatch.setattr(
        runtime_service.ProcessRuntimeHost,
        "install_stop_handlers",
        lambda self, callback: None,
    )

    for round_id in range(100):
        home = tmp_path / f"workspace-{round_id}" / ".kungfu"
        runtime_dir = home / "runtime"
        runtime_service.upsert_route(
            str(config_home), str(home), str(runtime_dir), str(round_id + 1)
        )
        runtime_service.set_route_desired(
            str(config_home), str(home), str(runtime_dir), False
        )

        assert (
            runtime_service.run_supervisor(
                "warning", config_home=str(config_home), restart_delay=0
            )
            == 0
        )
        assert runtime_service.read_routes(str(config_home))["routes"] == {}
        assert (
            runtime_service.read_pid(
                runtime_service.supervisor_pid_path(str(config_home))
            )
            is None
        )
        state = runtime_service._json_read(
            runtime_service.supervisor_state_path(str(config_home))
        )
        assert state["status"] == "stopped"
        assert state["stopReason"] == "idle"


def test_idle_exiting_supervisor_cannot_overwrite_replacement(tmp_path):
    config_home = str(tmp_path / "config")
    old_pid = 4100
    old_start = "old-start"
    replacement_pid = 4200
    replacement_start = "replacement-start"
    runtime_service.write_pid(runtime_service.supervisor_pid_path(config_home), old_pid)
    runtime_service._json_write(
        runtime_service.supervisor_state_path(config_home),
        {
            "schema": runtime_service.SCHEMA_STATUS,
            "status": "running",
            "supervisorPid": old_pid,
            "supervisorStartIdentity": old_start,
        },
    )

    assert runtime_service._retire_idle_routes(
        config_home,
        has_children=False,
        supervisor_pid=old_pid,
        supervisor_start_identity=old_start,
    )
    assert (
        runtime_service.read_pid(runtime_service.supervisor_pid_path(config_home))
        is None
    )

    runtime_service.write_pid(
        runtime_service.supervisor_pid_path(config_home), replacement_pid
    )
    runtime_service._json_write(
        runtime_service.supervisor_state_path(config_home),
        {
            "schema": runtime_service.SCHEMA_STATUS,
            "status": "running",
            "supervisorPid": replacement_pid,
            "supervisorStartIdentity": replacement_start,
        },
    )
    runtime_service._finalize_supervisor_state(
        config_home,
        supervisor_pid=old_pid,
        supervisor_start_identity=old_start,
        stop_reason="idle",
    )

    assert (
        runtime_service.read_pid(runtime_service.supervisor_pid_path(config_home))
        == replacement_pid
    )
    assert (
        runtime_service._json_read(runtime_service.supervisor_state_path(config_home))[
            "supervisorStartIdentity"
        ]
        == replacement_start
    )


def test_always_on_supervisor_does_not_retire_empty_routes(tmp_path, monkeypatch):
    config_home = str(tmp_path / "config")
    monkeypatch.setenv(runtime_service.SUPERVISOR_ALWAYS_ON_ENV, "1")

    assert not runtime_service._retire_idle_routes(
        config_home,
        has_children=False,
        supervisor_pid=4300,
        supervisor_start_identity="always-on-start",
    )


def test_stop_supervisor_refuses_unverified_process_identity(tmp_path, monkeypatch):
    config_home = tmp_path / "config"
    runtime_service.write_pid(
        runtime_service.supervisor_pid_path(str(config_home)), 4242
    )
    runtime_service._json_write(
        runtime_service.supervisor_state_path(str(config_home)),
        {
            "schema": runtime_service.SCHEMA_STATUS,
            "status": "running",
            "supervisorPid": 4242,
            "supervisorStartIdentity": "recorded-start",
        },
    )
    delivered = []
    monkeypatch.setattr(runtime_service, "_is_pid_running", lambda pid: True)
    monkeypatch.setattr(
        runtime_service, "_process_start_identity", lambda pid: "replacement-start"
    )
    monkeypatch.setattr(
        runtime_service,
        "_terminate_process_if_matches",
        lambda pid, start, *, force=False: delivered.append((pid, start, force)),
    )

    result = runtime_service.stop_supervisor(str(config_home), timeout=0)

    assert result["changed"] is False
    assert result["error"] == "supervisor-identity-unverified"
    assert delivered == []


def test_windows_stop_supervisor_terminates_verified_process_tree(monkeypatch):
    running = {
        "supervisor": {
            "pid": 4242,
            "running": True,
            "identityVerified": True,
            "startIdentity": "recorded-start",
        }
    }
    stopped = {
        "supervisor": {
            "pid": 4242,
            "running": False,
            "identityVerified": False,
            "startIdentity": "recorded-start",
        }
    }
    statuses = iter([running, stopped])
    delivered = []
    monkeypatch.setattr(
        runtime_service, "supervisor_status", lambda _home: next(statuses)
    )
    monkeypatch.setattr(runtime_service.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        runtime_service,
        "_terminate_process_tree_if_matches",
        lambda pid, start: delivered.append((pid, start)) or True,
    )
    monkeypatch.setattr(
        runtime_service,
        "_terminate_process_if_matches",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Windows stop must terminate the full process tree")
        ),
    )

    host = runtime_service.ProcessRuntimeHost(
        config_home="test-config", runtime_image={}
    )
    result = host.stop_supervisor(timeout=1)

    assert result["changed"] is True
    assert delivered == [(4242, "recorded-start")]


def test_windows_supervisor_breaks_away_from_parent_job(tmp_path, monkeypatch):
    spawned = []

    class _FakeProcess:
        pid = 4242

    def _spawn(command, **kwargs):
        spawned.append((command, kwargs))
        return _FakeProcess()

    monkeypatch.setattr(runtime_service.platform, "system", lambda: "Windows")
    monkeypatch.setattr(runtime_service.subprocess, "Popen", _spawn)
    monkeypatch.setattr(runtime_service, "command_env", lambda *args, **kwargs: {})
    monkeypatch.setattr(
        runtime_service, "supervisor_command", lambda *args, **kwargs: ["supervisor"]
    )
    monkeypatch.setattr(
        runtime_service, "_process_start_identity", lambda pid: f"start-{pid}"
    )

    host = runtime_service.ProcessRuntimeHost(
        config_home=str(tmp_path / "config"), runtime_image={}
    )
    child, _ = host.spawn_supervisor(str(tmp_path / "home"), str(tmp_path / "runtime"))

    expected = (
        getattr(runtime_service.subprocess, "DETACHED_PROCESS", 0x00000008)
        | getattr(runtime_service.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        | getattr(runtime_service.subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)
    )
    assert child.pid == 4242
    assert spawned[0][1]["creationflags"] == expected


def test_windows_supervisor_falls_back_when_job_forbids_breakaway(
    tmp_path, monkeypatch
):
    spawned = []

    class _FakeProcess:
        pid = 4242

    def _spawn(command, **kwargs):
        spawned.append((command, kwargs))
        if len(spawned) == 1:
            error = OSError("job forbids breakaway")
            error.winerror = 5
            raise error
        return _FakeProcess()

    monkeypatch.setattr(runtime_service.platform, "system", lambda: "Windows")
    monkeypatch.setattr(runtime_service.subprocess, "Popen", _spawn)
    monkeypatch.setattr(runtime_service, "command_env", lambda *args, **kwargs: {})
    monkeypatch.setattr(
        runtime_service, "supervisor_command", lambda *args, **kwargs: ["supervisor"]
    )
    monkeypatch.setattr(
        runtime_service, "_process_start_identity", lambda pid: f"start-{pid}"
    )

    host = runtime_service.ProcessRuntimeHost(
        config_home=str(tmp_path / "config"), runtime_image={}
    )
    child, _ = host.spawn_supervisor(str(tmp_path / "home"), str(tmp_path / "runtime"))

    expected = getattr(
        runtime_service.subprocess, "DETACHED_PROCESS", 0x00000008
    ) | getattr(runtime_service.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
    assert child.pid == 4242
    assert len(spawned) == 2
    assert spawned[1][1]["creationflags"] == expected


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
