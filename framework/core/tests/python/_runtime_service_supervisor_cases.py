# SPDX-License-Identifier: Apache-2.0
"""Supervisor lifecycle, retirement, and Windows process cases."""
# ruff: noqa: F401,F403

from _runtime_service_support import *


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

    def fail_route_read(_config_home):
        raise AssertionError("always-on short-circuit must not read routes")

    monkeypatch.setattr(runtime_service, "read_routes", fail_route_read)

    assert not runtime_service._retire_idle_routes(
        config_home,
        has_children=False,
        supervisor_pid=4300,
        supervisor_start_identity="always-on-start",
    )


def test_idle_route_retirement_does_not_read_env_when_children_exist(
    tmp_path, monkeypatch
):
    original_get = runtime_service.os.environ.get

    def fail_route_read(_config_home):
        raise AssertionError("child short-circuit must not read routes")

    def env_get(key, default=None):
        if key == runtime_service.SUPERVISOR_ALWAYS_ON_ENV:
            raise AssertionError("child short-circuit must not read the always-on env")
        return original_get(key, default)

    monkeypatch.setattr(runtime_service.os.environ, "get", env_get)
    monkeypatch.setattr(runtime_service, "read_routes", fail_route_read)

    assert not runtime_service._retire_idle_routes(
        str(tmp_path / "config"),
        has_children=True,
        supervisor_pid=4301,
        supervisor_start_identity="has-children-start",
    )


def test_idle_route_retirement_reads_env_on_every_call(tmp_path, monkeypatch):
    original_get = runtime_service.os.environ.get
    values = iter(["1", ""])
    calls = []

    def env_get(key, default=None):
        if key == runtime_service.SUPERVISOR_ALWAYS_ON_ENV:
            calls.append((key, default))
            return next(values)
        return original_get(key, default)

    monkeypatch.setattr(runtime_service.os.environ, "get", env_get)
    config_home = str(tmp_path / "config")

    assert not runtime_service._retire_idle_routes(
        config_home,
        has_children=False,
        supervisor_pid=4302,
        supervisor_start_identity="dynamic-env-start",
    )
    assert runtime_service._retire_idle_routes(
        config_home,
        has_children=False,
        supervisor_pid=4302,
        supervisor_start_identity="dynamic-env-start",
    )
    assert calls == [
        (runtime_service.SUPERVISOR_ALWAYS_ON_ENV, ""),
        (runtime_service.SUPERVISOR_ALWAYS_ON_ENV, ""),
    ]


def test_idle_route_retirement_checks_routes_in_insertion_order(tmp_path, monkeypatch):
    accesses = []

    class _TrackedRoute(dict):
        def __init__(self, label, desired):
            super().__init__(desired=desired)
            self.label = label

        def get(self, key, default=None):
            accesses.append((self.label, key))
            if self.label == "second":
                raise AssertionError(
                    "route scan must stop after the first desired route"
                )
            return super().get(key, default)

    monkeypatch.delenv(runtime_service.SUPERVISOR_ALWAYS_ON_ENV, raising=False)
    monkeypatch.setattr(
        runtime_service,
        "read_routes",
        lambda _config_home: {
            "schema": runtime_service.SCHEMA_ROUTES,
            "routes": {
                "first": _TrackedRoute("first", True),
                "second": _TrackedRoute("second", True),
            },
        },
    )

    assert not runtime_service._retire_idle_routes(
        str(tmp_path / "config"),
        has_children=False,
        supervisor_pid=4303,
        supervisor_start_identity="route-order-start",
    )
    assert accesses == [("first", "desired")]


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
