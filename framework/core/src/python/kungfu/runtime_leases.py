# SPDX-License-Identifier: Apache-2.0

"""Generation-fenced runtime lease and drain lifecycle owner."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from kungfu.coordination import locks as coordination_locks
from kungfu.runtime_contract import stable_id as _stable_id
from kungfu.runtime_contract import validate_value as _validate_value
from kungfu.runtime_ports import (
    RuntimeDrainHost,
    RuntimeLeaseClock,
    RuntimeLifecycleError,
    SystemRuntimeLeaseClock,
)
from kungfu.runtime_state import (
    _activation_state_path,
    _expire_leases,
    _read_activation_state,
    _set_snapshot_lifecycle,
    _snapshot_handle,
    _write_activation_state,
)


class RuntimeLeaseManager:
    """Persist generation-fenced local leases without treating PIDs as holders."""

    def __init__(
        self,
        config_home: str | Path,
        workspace: str,
        *,
        clock: RuntimeLeaseClock | None = None,
        contract: Mapping[str, Any] | None = None,
    ) -> None:
        self.workspace = workspace
        self.state_path = _activation_state_path(config_home, workspace)
        self.lock_root = self.state_path.parent / "locks"
        self.clock = clock or SystemRuntimeLeaseClock()
        self.contract = contract

    def _read_state(self) -> dict[str, Any]:
        try:
            state = _read_activation_state(self.state_path)
            if state is None:
                raise RuntimeLifecycleError(
                    "stale_generation", "runtime activation snapshot is absent"
                )
            _validate_value("runtimeSnapshot", state, self.contract)
        except RuntimeLifecycleError:
            raise
        except ValueError as error:
            raise RuntimeLifecycleError("stale_generation", str(error)) from error
        if state.get("workspaceId") != self.workspace:
            raise RuntimeLifecycleError(
                "stale_generation", "runtime activation workspace is inconsistent"
            )
        return state

    def _write_state(self, state: Mapping[str, Any]) -> None:
        _validate_value("runtimeSnapshot", state, self.contract)
        _write_activation_state(self.state_path, state)

    def acquire(
        self,
        handle: Mapping[str, Any],
        *,
        holder_id: str,
        capabilities: list[str],
        ttl_ns: int,
        lease_id: str | None = None,
    ) -> dict[str, Any]:
        if not holder_id or ttl_ns <= 0:
            raise RuntimeLifecycleError(
                "invalid_requirement", "lease holder and positive TTL are required"
            )
        with coordination_locks.held(
            self.lock_root,
            self.workspace,
            label=f"runtime-lease-acquire:{holder_id}",
        ):
            state = self._read_state()
            current = _snapshot_handle(state)
            _validate_value("runtimeHandle", handle, self.contract)
            generation = str(handle.get("generation") or "")
            if (
                handle.get("runtimeId") != current.get("runtimeId")
                or handle.get("workspaceId") != self.workspace
                or generation != current.get("generation")
                or handle.get("state") != "ready"
                or current.get("state") != "ready"
                or "runtime.lease" not in set(handle.get("grantedAuthorities") or [])
                or "runtime.lease" not in set(current.get("grantedAuthorities") or [])
            ):
                raise RuntimeLifecycleError(
                    "stale_generation",
                    "lease handle is not the active ready generation",
                )
            requested = set(capabilities)
            if not requested.issubset(set(handle.get("capabilities") or [])) or not (
                requested.issubset(set(current.get("capabilities") or []))
            ):
                raise RuntimeLifecycleError(
                    "authority_conflict", "lease capabilities exceed the runtime handle"
                )
            now_ns = self.clock.now_ns()
            _expire_leases(state, now_ns)
            resolved_id = lease_id or _stable_id(
                "lease",
                {
                    "runtimeId": str(handle["runtimeId"]),
                    "generation": generation,
                    "holderId": holder_id,
                    "issuedAtNs": str(now_ns),
                },
            )
            leases = state["leases"]
            if any(
                isinstance(item, Mapping) and item.get("leaseId") == resolved_id
                for item in leases
            ):
                raise RuntimeLifecycleError(
                    "authority_conflict", "runtime lease id already exists"
                )
            lease = {
                "schema": "kungfu.runtime.lease/v1",
                "leaseId": resolved_id,
                "runtimeId": handle["runtimeId"],
                "generation": generation,
                "holderId": holder_id,
                "capabilities": capabilities,
                "issuedAtNs": str(now_ns),
                "expiresAtNs": str(now_ns + ttl_ns),
                "state": "active",
            }
            _validate_value("runtimeLease", lease, self.contract)
            leases.append(lease)
            self._write_state(state)
            return copy.deepcopy(lease)

    def renew(
        self,
        lease_id: str,
        generation: str,
        ttl_ns: int,
        *,
        holder_id: str,
    ) -> dict[str, Any]:
        if not holder_id or ttl_ns <= 0:
            raise RuntimeLifecycleError(
                "invalid_requirement", "lease holder and positive TTL are required"
            )
        with coordination_locks.held(
            self.lock_root,
            self.workspace,
            label=f"runtime-lease-renew:{lease_id}",
        ):
            state = self._read_state()
            if state.get("activeGeneration") != generation:
                raise RuntimeLifecycleError(
                    "stale_generation", "lease generation is no longer active"
                )
            now_ns = self.clock.now_ns()
            _expire_leases(state, now_ns)
            for lease in state["leases"]:
                if not isinstance(lease, dict) or lease.get("leaseId") != lease_id:
                    continue
                if lease.get("generation") != generation:
                    raise RuntimeLifecycleError(
                        "stale_generation", "lease belongs to another generation"
                    )
                if lease.get("holderId") != holder_id:
                    raise RuntimeLifecycleError(
                        "authority_conflict", "lease belongs to another holder"
                    )
                if lease.get("state") != "active":
                    raise RuntimeLifecycleError(
                        "lease_expired", "runtime lease is no longer active"
                    )
                lease["expiresAtNs"] = str(now_ns + ttl_ns)
                self._write_state(state)
                return copy.deepcopy(lease)
            raise RuntimeLifecycleError("lease_expired", "runtime lease is unknown")

    def release(
        self, lease_id: str, generation: str, *, holder_id: str
    ) -> dict[str, Any]:
        if not holder_id:
            raise RuntimeLifecycleError(
                "invalid_requirement", "lease holder is required"
            )
        with coordination_locks.held(
            self.lock_root,
            self.workspace,
            label=f"runtime-lease-release:{lease_id}",
        ):
            state = self._read_state()
            if state.get("activeGeneration") != generation:
                raise RuntimeLifecycleError(
                    "stale_generation", "lease generation is no longer active"
                )
            now_ns = self.clock.now_ns()
            _expire_leases(state, now_ns)
            for lease in state["leases"]:
                if not isinstance(lease, dict) or lease.get("leaseId") != lease_id:
                    continue
                if lease.get("generation") != generation:
                    raise RuntimeLifecycleError(
                        "stale_generation", "lease belongs to another generation"
                    )
                if lease.get("holderId") != holder_id:
                    raise RuntimeLifecycleError(
                        "authority_conflict", "lease belongs to another holder"
                    )
                if lease.get("state") == "active":
                    lease["state"] = "released"
                    lease["expiresAtNs"] = str(now_ns)
                    self._write_state(state)
                return copy.deepcopy(lease)
            raise RuntimeLifecycleError("lease_expired", "runtime lease is unknown")

    def inspect(self) -> dict[str, Any]:
        with coordination_locks.held(
            self.lock_root,
            self.workspace,
            label="runtime-lease-inspect",
        ):
            state = self._read_state()
            if _expire_leases(state, self.clock.now_ns()):
                self._write_state(state)
            return copy.deepcopy(state)

    @staticmethod
    def _idle_status(
        state: dict[str, Any], now_ns: int, grace_ns: int
    ) -> tuple[dict[str, Any], bool]:
        changed = _expire_leases(state, now_ns)
        active = [
            lease
            for lease in state["leases"]
            if isinstance(lease, Mapping) and lease.get("state") == "active"
        ]
        if active:
            return {"state": "active", "activeLeaseCount": len(active)}, changed
        handle = _snapshot_handle(state)
        readiness = handle.get("readiness")
        anchors = [
            int(str(lease.get("expiresAtNs")))
            for lease in state["leases"]
            if isinstance(lease, Mapping) and lease.get("expiresAtNs") is not None
        ]
        if isinstance(readiness, Mapping):
            anchors.append(int(str(readiness.get("observedAtNs") or "0")))
        idle_since = max(anchors, default=now_ns)
        deadline = idle_since + grace_ns
        return (
            {
                "state": "drain-ready" if now_ns >= deadline else "idle-grace",
                "activeLeaseCount": 0,
                "idleSinceNs": str(idle_since),
                "drainAtNs": str(deadline),
            },
            changed,
        )

    def idle_status(self, grace_ns: int) -> dict[str, Any]:
        if grace_ns < 0:
            raise RuntimeLifecycleError(
                "invalid_requirement", "idle grace cannot be negative"
            )
        with coordination_locks.held(
            self.lock_root,
            self.workspace,
            label="runtime-lease-idle-status",
        ):
            state = self._read_state()
            handle = _snapshot_handle(state)
            handle_state = str(handle.get("state") or "")
            if handle_state == "draining":
                return {
                    "state": "draining",
                    "activeLeaseCount": 0,
                    "generation": str(state["activeGeneration"]),
                }
            if handle_state != "ready":
                return {
                    "state": handle_state,
                    "activeLeaseCount": 0,
                    "generation": str(state["activeGeneration"]),
                }
            status, changed = self._idle_status(state, self.clock.now_ns(), grace_ns)
            if changed:
                self._write_state(state)
            return status

    def begin_idle_drain(self, grace_ns: int) -> dict[str, Any]:
        if grace_ns < 0:
            raise RuntimeLifecycleError(
                "invalid_requirement", "idle grace cannot be negative"
            )
        with coordination_locks.held(
            self.lock_root,
            self.workspace,
            label="runtime-lease-begin-idle-drain",
        ):
            state = self._read_state()
            handle = _snapshot_handle(state)
            handle_state = str(handle.get("state") or "")
            if handle_state == "draining":
                return {
                    "state": "draining",
                    "activeLeaseCount": 0,
                    "generation": str(state["activeGeneration"]),
                }
            if handle_state != "ready":
                return {
                    "state": handle_state,
                    "activeLeaseCount": 0,
                    "generation": str(state["activeGeneration"]),
                }
            status, changed = self._idle_status(state, self.clock.now_ns(), grace_ns)
            if status["state"] != "drain-ready":
                if changed:
                    self._write_state(state)
                return status
            generation = str(state["activeGeneration"])
            _set_snapshot_lifecycle(state, "draining")
            self._write_state(state)
            return {**status, "state": "draining", "generation": generation}

    def complete_drain(self, generation: str, *, stopped: bool) -> dict[str, Any]:
        with coordination_locks.held(
            self.lock_root,
            self.workspace,
            label=f"runtime-lease-complete-drain:{generation}",
        ):
            state = self._read_state()
            handle = _snapshot_handle(state)
            if (
                state.get("activeGeneration") != generation
                or handle.get("state") != "draining"
            ):
                raise RuntimeLifecycleError(
                    "stale_generation",
                    "runtime drain no longer owns the active draining generation",
                )
            lifecycle = "stopped" if stopped else "failed"
            _set_snapshot_lifecycle(state, lifecycle)
            self._write_state(state)
            return {
                "state": lifecycle,
                "activeLeaseCount": 0,
                "generation": generation,
            }

    def begin_restart(self, coordinator_pid: int) -> dict[str, Any]:
        with coordination_locks.held(
            self.lock_root,
            self.workspace,
            label=f"runtime-lease-begin-restart:{coordinator_pid}",
        ):
            state = self._read_state()
            handle = _snapshot_handle(state)
            host = handle.get("host")
            diagnostics = host.get("diagnostics") if isinstance(host, Mapping) else None
            if (
                handle.get("state") != "ready"
                or not isinstance(diagnostics, Mapping)
                or diagnostics.get("coordinatorPid") != coordinator_pid
            ):
                raise RuntimeLifecycleError(
                    "stale_generation",
                    "runtime restart does not own the recorded ready coordinator",
                )
            for lease in state["leases"]:
                if isinstance(lease, dict) and lease.get("state") == "active":
                    lease["state"] = "expired"
            _set_snapshot_lifecycle(state, "restarting")
            self._write_state(state)
            return {
                "state": "restarting",
                "generation": str(state["activeGeneration"]),
            }

    def drain_if_idle(
        self,
        host: RuntimeDrainHost,
        home: str,
        runtime_dir: str,
        *,
        grace_ns: int,
    ) -> dict[str, Any]:
        status = self.begin_idle_drain(grace_ns)
        if status["state"] != "draining":
            return status
        generation = str(status["generation"])
        try:
            result = dict(host.drain(home, runtime_dir))
            coordinator = result.get("coordinator")
            stopped = not (
                isinstance(coordinator, Mapping) and coordinator.get("running") is True
            )
        except Exception:
            self.complete_drain(generation, stopped=False)
            raise
        completed = self.complete_drain(generation, stopped=stopped)
        return {**completed, "host": result}
