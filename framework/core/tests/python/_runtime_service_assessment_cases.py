# SPDX-License-Identifier: Apache-2.0
"""Assessment scheduling and subscription projection cases."""
# ruff: noqa: F401,F403

from _runtime_service_support import *


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
