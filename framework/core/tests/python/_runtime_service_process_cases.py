# SPDX-License-Identifier: Apache-2.0
"""Runtime process control, identity, and atomic state cases."""
# ruff: noqa: F401,F403

from _runtime_service_support import *


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
    assert runtime_service.CoordinatorProcess.__name__ == "CoordinatorProcess"
    assert runtime_service.CoordinatorProcess.__qualname__ == "CoordinatorProcess"
    assert runtime_service.CoordinatorProcess.__module__ == runtime_service.__name__
    assert (
        runtime_service._terminate_process_if_matches
        is runtime_processes._terminate_process_if_matches
    )
    assert (
        runtime_service._terminate_process_tree_if_matches
        is runtime_processes._terminate_process_tree_if_matches
    )
    assert runtime_service._terminate_and_reap_child.__name__ == (
        "_terminate_and_reap_child"
    )
    assert runtime_service._terminate_and_reap_child.__qualname__ == (
        "_terminate_and_reap_child"
    )
    assert (
        runtime_service._terminate_and_reap_child.__module__ == runtime_service.__name__
    )
    assert not hasattr(runtime_processes, "_terminate_and_reap_child")
    assert runtime_service._is_pid_running.__module__ == runtime_service.__name__
    assert (
        runtime_service._process_start_identity.__module__ == runtime_service.__name__
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

    class _ExitedParent(_Process):
        def terminate(self):
            raise runtime_service.psutil.NoSuchProcess(self.pid)

    monkeypatch.setattr(
        runtime_service.psutil,
        "Process",
        lambda pid: _ExitedParent(pid),
    )
    assert runtime_service._terminate_process_tree_if_matches(42, "42.000000")

    class _DeniedParent(_Process):
        def terminate(self):
            raise runtime_service.psutil.AccessDenied(self.pid)

    monkeypatch.setattr(
        runtime_service.psutil,
        "Process",
        lambda pid: _DeniedParent(pid),
    )
    assert not runtime_service._terminate_process_tree_if_matches(42, "42.000000")

    def _denied_process(pid):
        raise runtime_service.psutil.AccessDenied(pid=pid)

    monkeypatch.setattr(runtime_service.psutil, "Process", _denied_process)
    assert not runtime_service._terminate_process_tree_if_matches(42, "42.000000")


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

    events.clear()

    def _denied_process(pid):
        raise runtime_service.psutil.AccessDenied(pid=pid)

    monkeypatch.setattr(runtime_service.psutil, "Process", _denied_process)
    runtime_service._terminate_and_reap_child(_Host(), _Child(), timeout=2.5)
    assert events == ["coordinator-terminate", ("coordinator-wait", 2.5)]


def test_pid_liveness_probe_never_sends_a_signal(monkeypatch):
    monkeypatch.setattr(runtime_service.psutil, "pid_exists", lambda pid: pid == 42)

    def fail_on_signal(*_args):
        raise AssertionError("PID liveness must not use os.kill(pid, 0)")

    monkeypatch.setattr(runtime_service.os, "kill", fail_on_signal)

    assert runtime_service._is_pid_running(42) is True
    assert runtime_service._is_pid_running(43) is False

    def _denied_pid_exists(pid):
        raise runtime_service.psutil.AccessDenied(pid=pid)

    def _denied_process(pid):
        raise runtime_service.psutil.AccessDenied(pid=pid)

    monkeypatch.setattr(runtime_service.psutil, "pid_exists", _denied_pid_exists)
    monkeypatch.setattr(runtime_service.psutil, "Process", _denied_process)
    assert runtime_service._is_pid_running(42) is False
    assert runtime_service._process_start_identity(42) is None
