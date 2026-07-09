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
    assert payload["routes"]["count"] == 1


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
