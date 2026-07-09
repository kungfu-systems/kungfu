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
    runtime_dir = tmp_path / "runtime"

    payload = master_service.status(str(tmp_path / "home"), str(runtime_dir))

    assert payload["schema"] == "kungfu.master-service.status/v1"
    assert payload["status"] == "stopped"
    assert payload["runtimeDir"] == str(runtime_dir)
    assert payload["supervisor"]["running"] is False
    assert payload["master"]["running"] is False


def test_master_status_detects_live_recorded_pid(tmp_path):
    runtime_dir = tmp_path / "runtime"
    service_dir = master_service.state_dir(str(runtime_dir))
    service_dir.mkdir(parents=True)
    master_service.write_pid(
        master_service.supervisor_pid_path(str(runtime_dir)), os.getpid()
    )

    payload = master_service.status(str(tmp_path / "home"), str(runtime_dir))

    assert payload["status"] == "running"
    assert payload["supervisor"]["pid"] == os.getpid()
    assert payload["supervisor"]["running"] is True


def test_service_plan_is_dry_run_material(tmp_path):
    plan = master_service.service_plan(
        str(tmp_path / "home"),
        str(tmp_path / "runtime"),
        "warning",
    ).as_dict()

    assert plan["schema"] == "kungfu.master-service.plan/v1"
    assert "master" in plan["content"]
    assert "supervise" in plan["content"]
    assert plan["path"]
    assert plan["installNote"]
    assert plan["uninstallNote"]
