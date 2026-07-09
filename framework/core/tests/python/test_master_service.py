# SPDX-License-Identifier: Apache-2.0

import os
import sys
import types


class _FakeMaster:
    def __init__(self, location, low_latency=False):
        self.location = location
        self.low_latency = low_latency

    def run(self):
        return None


def _install_fake_pykungfu():
    fake = types.ModuleType("pykungfu")
    fake.yijinjing = types.SimpleNamespace(
        enums=types.SimpleNamespace(
            mode=types.SimpleNamespace(LIVE="LIVE"),
            location_role=types.SimpleNamespace(SYSTEM="SYSTEM"),
        )
    )
    fake.runtime = types.SimpleNamespace(
        master=_FakeMaster,
        locator=lambda runtime_dir: {"runtime_dir": runtime_dir},
        location=lambda mode, role, group, name, locator: {
            "mode": mode,
            "role": role,
            "group": group,
            "name": name,
            "locator": locator,
        },
    )
    sys.modules.setdefault("pykungfu", fake)


_install_fake_pykungfu()

from kungfu import master_service  # noqa: E402


def test_master_status_reports_runtime_state(tmp_path):
    config_home = tmp_path / "config"
    home = tmp_path / "home"
    runtime_dir = tmp_path / "runtime"

    payload = master_service.route_status(
        str(home),
        str(runtime_dir),
        str(config_home),
    )

    assert payload["schema"] == "kungfu.master-service.status/v1"
    assert payload["status"] == "stopped"
    assert payload["configHome"] == str(config_home.resolve())
    assert payload["dataRoot"] == str(home.resolve())
    assert payload["runtimeDir"] == str(runtime_dir.resolve())
    assert payload["supervisorStateDir"] == str(
        config_home.resolve() / "runtime" / "supervisor"
    )
    assert payload["stateDir"] == str(runtime_dir.resolve() / "master")
    assert payload["supervisor"]["running"] is False
    assert payload["master"]["running"] is False
    assert payload["route"]["registered"] is False
    assert payload["lifecycle"]["state"] == "stopped"
    assert payload["lifecycle"]["healthy"] is False


def test_master_status_detects_live_recorded_pid(tmp_path):
    config_home = tmp_path / "config"
    runtime_dir = tmp_path / "runtime"
    master_service.supervisor_state_dir(str(config_home)).mkdir(parents=True)
    master_service.state_dir(str(runtime_dir)).mkdir(parents=True)
    master_service.write_pid(
        master_service.supervisor_pid_path(str(config_home)), os.getpid()
    )
    master_service.write_pid(
        master_service.master_pid_path(str(runtime_dir)), os.getpid()
    )

    payload = master_service.route_status(
        str(tmp_path / "home"),
        str(runtime_dir),
        str(config_home),
    )

    assert payload["status"] == "running"
    assert payload["supervisor"]["pid"] == os.getpid()
    assert payload["supervisor"]["running"] is True
    assert payload["master"]["pid"] == os.getpid()
    assert payload["master"]["running"] is True
    assert payload["lifecycle"]["state"] == "running"
    assert payload["lifecycle"]["healthy"] is True


def test_upsert_route_registers_data_root_under_user_supervisor(tmp_path):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"

    route = master_service.upsert_route(
        str(config_home),
        str(home),
        str(runtime_dir),
    )
    routes = master_service.read_routes(str(config_home))
    payload = master_service.route_status(
        str(home),
        str(runtime_dir),
        str(config_home),
    )

    assert routes["schema"] == "kungfu.master-service.routes/v1"
    assert route["routeId"] in routes["routes"]
    assert routes["routes"][route["routeId"]]["dataRoot"] == str(home.resolve())
    assert payload["route"]["registered"] is True
    assert payload["route"]["freshness"]["state"] == "fresh"
    assert payload["routes"]["count"] == 1


def test_master_status_detects_stale_route_lease(tmp_path, monkeypatch):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"

    monkeypatch.setattr(master_service, "_now", lambda: 1000.0)
    master_service.upsert_route(str(config_home), str(home), str(runtime_dir))
    monkeypatch.setattr(master_service, "_now", lambda: 1035.0)

    payload = master_service.route_status(
        str(home),
        str(runtime_dir),
        str(config_home),
    )

    assert payload["status"] == "stale-route"
    assert payload["route"]["stale"] is True
    assert payload["route"]["freshness"]["ageSeconds"] == 35.0
    assert payload["routes"]["staleCount"] == 1
    assert "route-stale" in payload["lifecycle"]["warnings"]


def test_repair_route_state_removes_dead_pid_files(tmp_path, monkeypatch):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"
    master_service.supervisor_state_dir(str(config_home)).mkdir(parents=True)
    master_service.state_dir(str(runtime_dir)).mkdir(parents=True)
    master_service.write_pid(master_service.supervisor_pid_path(str(config_home)), 123)
    master_service.write_pid(master_service.master_pid_path(str(runtime_dir)), 456)
    monkeypatch.setattr(master_service, "_is_pid_running", lambda pid: False)

    repairs = master_service.repair_route_state(
        str(home),
        str(runtime_dir),
        str(config_home),
    )

    assert repairs == ["removed-dead-supervisor-pid", "removed-dead-master-pid"]
    assert (
        master_service.read_pid(master_service.supervisor_pid_path(str(config_home)))
        is None
    )
    assert (
        master_service.read_pid(master_service.master_pid_path(str(runtime_dir)))
        is None
    )


def test_ensure_master_reports_repairs(tmp_path, monkeypatch):
    config_home = tmp_path / "config"
    home = tmp_path / "workspace" / ".kungfu"
    runtime_dir = home / "runtime"
    master_service.state_dir(str(runtime_dir)).mkdir(parents=True)
    master_service.write_pid(master_service.master_pid_path(str(runtime_dir)), 456)
    monkeypatch.setattr(master_service, "_is_pid_running", lambda pid: False)

    class _FakeProcess:
        pid = 789

    monkeypatch.setattr(
        master_service.subprocess, "Popen", lambda *a, **k: _FakeProcess()
    )

    def _fake_wait(
        home, runtime_dir, config_home, *, changed, route, repairs, command=None
    ):
        return {
            "schema": master_service.SCHEMA_STATUS,
            "changed": changed,
            "route": route,
            "repairs": repairs,
            "command": command,
        }

    monkeypatch.setattr(master_service, "_wait_for_master", _fake_wait)

    payload = master_service.ensure_master(
        str(home),
        str(runtime_dir),
        "warning",
        str(config_home),
    )

    assert payload["changed"] is True
    assert payload["repairs"] == ["removed-dead-master-pid"]


def test_wait_for_master_preserves_enriched_route_status(tmp_path, monkeypatch):
    route = master_service.route_record(
        str(tmp_path / "home"),
        str(tmp_path / "runtime"),
    )

    def _fake_status(home, runtime_dir, config_home):
        return {
            "schema": master_service.SCHEMA_STATUS,
            "status": "running",
            "supervisor": {"running": True},
            "master": {"running": True},
            "route": {
                **route,
                "registered": True,
                "freshness": {"state": "fresh", "stale": False},
                "stale": False,
            },
        }

    monkeypatch.setattr(master_service, "route_status", _fake_status)

    payload = master_service._wait_for_master(
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
    plan = master_service.service_plan(
        str(tmp_path / "home"),
        str(tmp_path / "runtime"),
        "warning",
        str(config_home),
    ).as_dict()

    assert plan["schema"] == "kungfu.master-service.plan/v1"
    assert "supervisor" in plan["content"]
    assert "KF_CONFIG_HOME" in plan["content"]
    assert "supervise" in plan["content"]
    assert plan["path"]
    assert plan["installNote"]
    assert plan["uninstallNote"]
