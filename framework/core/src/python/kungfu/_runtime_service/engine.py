# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
import subprocess
from typing import Any

from kungfu.action_envelope import CARRIER_ACTION_ENVELOPE
from kungfu.coordination.arbiter import (
    ACTION_GRANT,
    ACTION_RELEASE,
    ACTION_REQUEST,
    LockTable,
    grant_payload,
    parse_name,
)
from kungfu.action_wire import unwrap_event, wrap_event
from pykungfu.runtime import coordinator as NativeCoordinator

from kungfu._runtime_service.common import (
    lf,
    yjj,
    COORDINATOR_WIRE_NAMESPACE,
    COORDINATOR_WIRE_NAME,
    _positive_generation,
    command_env_for_owner as command_env,
    assessment_worker_command_for_owner as assessment_worker_command,
    RuntimeEngineRequest,
    RuntimeEngineReceipt,
    AssessmentExecutor,
    _is_pid_running,
)
from kungfu._runtime_service.state import (
    coordinator_log_path,
    publish_assessment_snapshot,
)


class ProcessAssessmentExecutor:
    def __init__(self, home: str, runtime_dir: str, log_level: str) -> None:
        self.home = home
        self.runtime_dir = runtime_dir
        self.log_level = log_level
        self.current: tuple[str, subprocess.Popen[Any], int] | None = None

    @staticmethod
    def _timeout_ns() -> int:
        raw = os.environ.get("KF_ASSESSMENT_WORKER_TIMEOUT_SECONDS", "30")
        try:
            seconds = max(float(raw), 0.1)
        except ValueError:
            seconds = 30.0
        return int(seconds * 1_000_000_000)

    def ready(self, nanotime: int) -> bool:
        if self.current is None:
            return True
        _, child, started_at = self.current
        if child.poll() is not None:
            self.current = None
            return True
        if nanotime - started_at < self._timeout_ns():
            return False
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        self.current = None
        return True

    def start(self, assessment_key: str, nanotime: int) -> None:
        command = assessment_worker_command(self.runtime_dir, assessment_key)
        coordinator_log_path(self.runtime_dir).parent.mkdir(parents=True, exist_ok=True)
        with coordinator_log_path(self.runtime_dir).open("ab") as log:
            child = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=command_env(
                    self.home,
                    self.runtime_dir,
                    self.log_level,
                ),
            )
        self.current = (assessment_key, child, nanotime)

    def close(self) -> None:
        if self.current is None:
            return
        _, child, _ = self.current
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        self.current = None


class CoordinatorEngine(NativeCoordinator):
    CAPABILITIES = (
        "runtime.peer-registry",
        "runtime.channel-routing",
        "runtime.assessment-scheduling",
    )

    def __init__(
        self,
        home: str,
        runtime_dir: str,
        low_latency: bool = False,
        *,
        assessment_executor: AssessmentExecutor | None = None,
        runtime_generation: str | int = "1",
        coordinator_epoch: str | int = "1",
    ) -> None:
        locator = yjj.locator(runtime_dir)
        location = yjj.location(
            lf.enums.mode.LIVE,
            lf.enums.location_role.SYSTEM,
            COORDINATOR_WIRE_NAMESPACE,
            COORDINATOR_WIRE_NAME,
            locator,
        )
        self.location = {
            "namespace": COORDINATOR_WIRE_NAMESPACE,
            "name": COORDINATOR_WIRE_NAME,
        }
        from kungfu import durability as durability_runtime

        self.durability_policy = durability_runtime.resolve_policy(
            runtime_home=home,
            config_home=os.environ.get("KF_CONFIG_HOME"),
            cwd=home,
        )
        super().__init__(
            location,
            low_latency,
            self.durability_policy["native"],
            int(_positive_generation(runtime_generation, "runtime generation")),
            int(_positive_generation(coordinator_epoch, "coordinator epoch")),
        )
        self.durability = durability_runtime.ConfiguredDurabilityRuntime(
            self, self.durability_policy, data_root=runtime_dir
        )
        self.home_dir = home
        self.runtime_dir = runtime_dir
        self._assessment_executor = assessment_executor
        self._assessment_last_check = 0
        # KF-ADR-019f86da-4f90-7332-a4cd-c9c9b549a5fb lock arbitration, merged into the per-workspace coordinator
        # (retiring the standalone Arbiter peer). The pure LockTable holds the
        # contention state; request/release frames arrive on the coordinator's
        # inbound stream (see on_react) and grants are written straight to the
        # holder's command journal. Liveness reclaim uses the registry pid the
        # coordinator already owns, so no request frame needs to carry a pid.
        self._lock_table = LockTable()

    # --- KF-ADR-019f86da-4f90-7332-a4cd-c9c9b549a5fb lock arbiter (merged into coordinator) ------------------
    def on_react(self) -> None:
        # Installed before coordinator::react() connects the event stream, so the
        # subscription is live from the first frame. Narrow surface: only the
        # coordination action envelope, so a lock bug can never disturb the
        # coordinator's native reactions.
        self.observe(CARRIER_ACTION_ENVELOPE, self._on_lock_action)

    def _on_lock_action(self, event: Any) -> None:
        # Error-isolated: lock arbitration must never crash the coordinator's
        # main react loop (the workspace lifeline). A bad frame is dropped.
        try:
            if event.carrier_type != CARRIER_ACTION_ENVELOPE:
                return
            decoded = unwrap_event(bytes(event.data_as_byte_array))
            if decoded is None:
                return
            action_type, payload = decoded
            name = parse_name(payload)
            if name is None:
                return
            source = int(event.source)
            if action_type == ACTION_REQUEST:
                grant = self._lock_table.request(name, source)
                if grant is not None:
                    self._emit_grant(name, grant)
            elif action_type == ACTION_RELEASE:
                nxt = self._lock_table.release(name, source)
                if nxt is not None:
                    self._emit_grant(name, nxt)
        except Exception:  # noqa: BLE001 - lock logic must never break serving
            pass

    def _emit_grant(self, name: str, holder: int) -> None:
        # Grant is addressed to the holder's command journal (the coordinator
        # already holds a writer to every registered peer). The holder observes
        # the action envelope on its own live stream — no public broadcast.
        if not self.has_writer(holder):
            return
        payload = grant_payload(name, holder)
        carrier, data = wrap_event(ACTION_GRANT, payload)
        self.get_writer(holder).write_bytes(self.now(), carrier, data)

    def _reap_dead_lock_holders(self) -> None:
        # Reclaim locks whose holder is gone. The holder's liveness comes from
        # the coordinator's registry pid (Register carries pid), not from a pid
        # smuggled in the lock request — this is the tax the standalone arbiter
        # paid for living outside the registry, removed by merging in.
        try:
            registry = self.get_registry()
        except Exception:  # noqa: BLE001
            return
        dead: list[int] = []
        seen: set[int] = set()
        for name in list(self._lock_table.snapshot()):
            holder = self._lock_table.holder(name)
            if holder is None or holder in seen:
                continue
            seen.add(holder)
            reg = registry.get(holder)
            pid = int(getattr(reg, "pid", 0)) if reg is not None else None
            if reg is None or not _is_pid_running(pid):
                dead.append(holder)
        for uid in dead:
            for name, nxt in self._lock_table.forget(uid):
                if nxt is not None:
                    self._emit_grant(name, nxt)

    def handle_request(self, request: RuntimeEngineRequest) -> RuntimeEngineReceipt:
        if request.operation == "inspect":
            return RuntimeEngineReceipt(
                operation=request.operation,
                accepted=True,
                state="constructed",
                capabilities=self.CAPABILITIES,
            )
        return RuntimeEngineReceipt(
            operation=request.operation,
            accepted=False,
            state="rejected",
            capabilities=(),
            error="unsupported-operation",
        )

    def on_register(self, gen_time: int, register_data: Any) -> None:
        return None

    def check_register(self, gen_time: int, register_data: Any) -> bool:
        return True

    def on_interval_check(self, nanotime: int) -> None:
        # Reclaim locks held by dead peers every interval, independent of the
        # assessment-worker throttle below.
        self._reap_dead_lock_holders()
        if nanotime - self._assessment_last_check < 500_000_000:
            return
        self._assessment_last_check = nanotime
        if (
            self._assessment_executor is not None
            and not self._assessment_executor.ready(nanotime)
        ):
            return

        snapshot = publish_assessment_snapshot(self.runtime_dir)
        pending = [
            assessment
            for assessment in snapshot["assessments"]
            if assessment["state"] == "pending"
        ]
        if not pending:
            return
        if self._assessment_executor is None:
            return
        assessment_key = str(pending[0]["assessment_key"])
        self._assessment_executor.start(assessment_key, nanotime)

    def close(self) -> None:
        self.durability.close()
        if self._assessment_executor is not None:
            self._assessment_executor.close()


class Coordinator(CoordinatorEngine):
    """Compatibility process coordinator; new no-fork code uses CoordinatorEngine."""

    def __init__(self, home: str, runtime_dir: str, low_latency: bool = False) -> None:
        super().__init__(
            home,
            runtime_dir,
            low_latency,
            assessment_executor=ProcessAssessmentExecutor(
                home,
                runtime_dir,
                os.environ.get("KF_LOG_LEVEL", "warning"),
            ),
        )
