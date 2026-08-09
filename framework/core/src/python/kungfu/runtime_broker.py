# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from kungfu import contract as contract_runtime
from kungfu.coordination import locks as coordination_locks
from kungfu.runtime_contract import (
    ACTIVATION_RECEIPT_SCHEMA,
    NATIVE_READINESS_EVIDENCE_SCHEMA as NATIVE_READINESS_EVIDENCE_SCHEMA,
    PLAN_SCHEMA,
    RECEIPT_SCHEMA,
    REQUEST_SOURCES,
    REQUIREMENT_SCHEMA,
)
from kungfu.runtime_contract import stable_id as _stable_id
from kungfu.runtime_contract import validate_value as _validate_value
from kungfu.runtime_leases import RuntimeLeaseManager as RuntimeLeaseManager
from kungfu.runtime_ports import (
    RuntimeActivationClient,
    RuntimeDrainHost as RuntimeDrainHost,
    RuntimeLeaseClock as RuntimeLeaseClock,
    RuntimeLifecycleError,
    RuntimeProcessHost,
    RuntimeReadinessAuthority,
    SystemRuntimeLeaseClock as SystemRuntimeLeaseClock,
)
from kungfu.runtime_state import (
    NativeReadinessAuthority as NativeReadinessAuthority,
    _activation_state_path,
    _persisted_generation_handle,
    _process_diagnostics,
    _process_running,
    _read_activation_state,
    _readiness_admits_requirement,
    _recorded_process_generation,
    _reusable_handle,
    _runtime_handle,
    _snapshot_handle,
    _validate_native_readiness_evidence,
    _write_activation_state,
    _write_runtime_json,
    discover_native_readiness_evidence,
    fenced_coordinator_generation as fenced_coordinator_generation,
    native_readiness_authority,
    native_readiness_evidence_path,
    product_status as product_status,
    workspace_id,
)


def operation_catalog(
    contract: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    contract_value = (
        contract_runtime.load_contract("runtime") if contract is None else contract
    )
    registry = contract_value.get("operationRegistry")
    if not isinstance(registry, Mapping):
        raise ValueError("runtime contract has no operation registry")
    if registry.get("schema") != "kungfu.runtime-operation-registry/v1":
        raise ValueError("runtime operation registry schema mismatch")
    operations = registry.get("operations")
    if not isinstance(operations, list):
        raise ValueError("runtime operation registry has no operations")
    return copy.deepcopy(dict(registry))


def operation_definition(
    operation_id: str, contract: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    for operation in operation_catalog(contract)["operations"]:
        if operation.get("id") == operation_id:
            return operation
    raise KeyError(f"runtime operation is not registered: {operation_id}")


def publish_native_readiness_evidence(
    runtime_dir: str | Path,
    evidence: Mapping[str, Any],
    *,
    operation_id: str,
    config_home: str | Path | None = None,
    contract: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Establish native readiness before atomically publishing its coordinates.

    The descriptor remains a discovery aid rather than proof: every consumer
    reconstructs and invokes the native authorities again.  Publication only
    proves that the same coordinates established one explicit live-required
    operation at the descriptor's minimum cut at publication time.
    """

    _validate_native_readiness_evidence(runtime_dir, evidence, contract)
    operation = operation_definition(operation_id, contract)
    if operation.get("operationClass") != "live-required":
        raise ValueError(
            "native readiness publication requires a live-required operation"
        )
    minimum_cut = evidence.get("minimumCut")
    if not isinstance(minimum_cut, Mapping):
        raise ValueError(
            "native readiness publication requires an explicit minimum cut"
        )
    plan = plan_operation(
        operation_id,
        workspace=workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=minimum_cut,
        contract=contract,
    )
    requirement = plan["requirement"]
    readiness = native_readiness_authority(evidence, contract=contract).establish(
        requirement,
        "publication",
        {"source": "native-readiness-publication"},
    )
    _validate_value("runtimeReadiness", readiness, contract)
    if not _readiness_admits_requirement(requirement, readiness):
        raise ValueError(
            "native readiness authority did not establish the publication requirement"
        )

    path = native_readiness_evidence_path(runtime_dir, config_home)
    _write_runtime_json(path, evidence)
    discovered = discover_native_readiness_evidence(
        runtime_dir,
        config_home,
        contract=contract,
    )
    if discovered != dict(evidence):
        raise ValueError("published native readiness evidence did not round-trip")
    return copy.deepcopy(discovered)


def plan_operation(
    operation_id: str,
    *,
    workspace: str,
    request_source: str,
    minimum_cut: Mapping[str, Any] | None = None,
    request_id: str | None = None,
    contract: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if request_source not in REQUEST_SOURCES:
        raise ValueError(f"unsupported runtime request source: {request_source}")
    operation = operation_definition(operation_id, contract)
    requirement_identity = {
        "workspaceId": workspace,
        "operationId": operation_id,
        "operationClass": operation["operationClass"],
        "requiredCapabilities": operation["requiredCapabilities"],
        "requestedAuthorities": operation["requestedAuthorities"],
        "minimumCut": minimum_cut,
        "requestSource": request_source,
    }
    resolved_request_id = request_id or _stable_id("request", requirement_identity)
    requirement = {
        "schema": REQUIREMENT_SCHEMA,
        "requestId": resolved_request_id,
        "workspaceId": workspace,
        "operationClass": operation["operationClass"],
        "requiredCapabilities": operation["requiredCapabilities"],
        "requestedAuthorities": operation["requestedAuthorities"],
        "minimumCut": copy.deepcopy(minimum_cut),
        "allowDegraded": operation["operationClass"] == "live-optional",
    }
    _validate_value("runtimeRequirement", requirement, contract)
    identity = {
        "operation": operation,
        "requirement": requirement,
        "requestSource": request_source,
    }
    return {
        "schema": PLAN_SCHEMA,
        "planId": _stable_id("plan", identity),
        **identity,
    }


def _activation_receipt(
    requirement: Mapping[str, Any],
    request_source: str,
    *,
    outcome: str,
    error: Mapping[str, Any] | None,
    handle: Mapping[str, Any] | None = None,
    achieved_capabilities: list[str] | None = None,
    missing_capabilities: list[str] | None = None,
    granted_authorities: list[str] | None = None,
    degraded: bool = False,
) -> dict[str, Any]:
    return {
        "schema": ACTIVATION_RECEIPT_SCHEMA,
        "requestId": requirement["requestId"],
        "requirement": copy.deepcopy(dict(requirement)),
        "outcome": outcome,
        "activatedBy": "core-broker",
        "requestSource": request_source,
        "handle": copy.deepcopy(dict(handle)) if handle is not None else None,
        "achievedCapabilities": achieved_capabilities or [],
        "missingCapabilities": missing_capabilities or [],
        "grantedAuthorities": granted_authorities or [],
        "degraded": degraded,
        "error": copy.deepcopy(dict(error)) if error is not None else None,
    }


def _failed_activation(
    requirement: Mapping[str, Any],
    request_source: str,
    code: str,
    message: str,
    *,
    retryable: bool,
) -> dict[str, Any]:
    return _activation_receipt(
        requirement,
        request_source,
        outcome="failed",
        missing_capabilities=list(requirement["requiredCapabilities"]),
        error={"code": code, "message": message, "retryable": retryable},
    )


def _activation_admits(
    requirement: Mapping[str, Any], receipt: Mapping[str, Any]
) -> bool:
    if receipt.get("schema") != ACTIVATION_RECEIPT_SCHEMA:
        return False
    if receipt.get("requestId") != requirement.get("requestId"):
        return False
    if receipt.get("requirement") != requirement:
        return False
    operation_class = requirement["operationClass"]
    if operation_class == "storage-only":
        return (
            receipt.get("outcome") == "daemonless"
            and receipt.get("handle") is None
            and not receipt.get("achievedCapabilities")
            and not receipt.get("missingCapabilities")
            and not receipt.get("grantedAuthorities")
        )
    if operation_class == "live-optional" and receipt.get("outcome") == "degraded":
        return bool(receipt.get("degraded"))
    if receipt.get("outcome") not in {"activated", "reused"}:
        return False
    handle = receipt.get("handle")
    if not isinstance(handle, Mapping) or handle.get("state") != "ready":
        return False
    achieved = set(receipt.get("achievedCapabilities") or [])
    granted = set(receipt.get("grantedAuthorities") or [])
    required = set(requirement["requiredCapabilities"])
    requested = set(requirement["requestedAuthorities"])
    readiness = handle.get("readiness")
    generation = str(handle.get("generation") or "")
    return (
        achieved == required
        and granted == requested
        and set(handle.get("capabilities") or []) == required
        and set(handle.get("grantedAuthorities") or []) == requested
        and generation.isdigit()
        and generation != "0"
        and handle.get("requirementId") == requirement.get("requestId")
        and handle.get("workspaceId") == requirement.get("workspaceId")
        and isinstance(readiness, Mapping)
        and _readiness_admits_requirement(requirement, readiness)
    )


class ProcessRuntimeActivationClient:
    """Bridge to the current process host without promoting PID state to readiness."""

    def __init__(
        self,
        home: str,
        runtime_dir: str,
        *,
        log_level: str = "warning",
        config_home: str | None = None,
        host: RuntimeProcessHost | None = None,
        readiness_authority: RuntimeReadinessAuthority | None = None,
        contract: Mapping[str, Any] | None = None,
    ) -> None:
        self.home = home
        self.runtime_dir = runtime_dir
        if host is None:
            from kungfu import runtime_service

            self.config_home = runtime_service.resolve_config_home(config_home)
            self.host: RuntimeProcessHost = runtime_service.ProcessRuntimeHost(
                log_level, config_home
            )
        else:
            self.config_home = str(
                Path(config_home or "~/.kungfu-config").expanduser().resolve()
            )
            self.host = host
        self.readiness_authority = readiness_authority
        self.contract = contract
        self.diagnostics: Mapping[str, Any] | None = None

    def activate(
        self, requirement: Mapping[str, Any], request_source: str
    ) -> Mapping[str, Any]:
        expected_workspace = workspace_id(self.runtime_dir)
        if requirement.get("workspaceId") != expected_workspace:
            return _failed_activation(
                requirement,
                request_source,
                "invalid_requirement",
                "The requirement workspace does not match the process host runtime directory.",
                retryable=False,
            )
        state_path = _activation_state_path(
            self.config_home, str(requirement["workspaceId"])
        )
        lock_root = state_path.parent / "locks"
        with coordination_locks.held(
            lock_root,
            str(requirement["workspaceId"]),
            label=f"runtime-activation:{requirement['requestId']}",
        ):
            try:
                stored_state = _read_activation_state(state_path)
                if stored_state is not None:
                    _validate_value("runtimeSnapshot", stored_state, self.contract)
                state = stored_state or {}
            except ValueError as error:
                return _failed_activation(
                    requirement,
                    request_source,
                    "stale_generation",
                    str(error),
                    retryable=False,
                )
            try:
                inspected = dict(self.host.inspect(self.home, self.runtime_dir))
            except (OSError, RuntimeError, ValueError):
                inspected = {}
            process_running = _process_running(inspected)
            recorded_generation = None
            if process_running:
                reused_handle = _reusable_handle(requirement, state, inspected)
                if reused_handle is not None:
                    state["runtimeId"] = reused_handle["runtimeId"]
                    state["handles"] = [
                        _persisted_generation_handle(state, reused_handle)
                    ]
                    _validate_value("runtimeSnapshot", state, self.contract)
                    _write_activation_state(state_path, state)
                    return _activation_receipt(
                        requirement,
                        request_source,
                        outcome="reused",
                        error=None,
                        handle=reused_handle,
                        achieved_capabilities=list(requirement["requiredCapabilities"]),
                        granted_authorities=list(requirement["requestedAuthorities"]),
                    )
                if stored_state is None:
                    return _failed_activation(
                        requirement,
                        request_source,
                        "stale_generation",
                        "A process runtime is running without a fenced activation generation; explicit adoption is required.",
                        retryable=False,
                    )
                try:
                    active_handle = _snapshot_handle(state)
                except RuntimeLifecycleError:
                    active_handle = {}
                active_host = active_handle.get("host")
                active_diagnostics = (
                    active_host.get("diagnostics")
                    if isinstance(active_host, Mapping)
                    else None
                )
                current_diagnostics = _process_diagnostics(inspected)
                if (
                    isinstance(active_diagnostics, Mapping)
                    and active_diagnostics.get("coordinatorPid")
                    == current_diagnostics.get("coordinatorPid")
                    and active_handle.get("state") != "ready"
                ):
                    return _failed_activation(
                        requirement,
                        request_source,
                        "operation_cancelled",
                        "The active generation is draining or stopped; wait for a new process generation.",
                        retryable=True,
                    )
                recorded_generation = _recorded_process_generation(state, inspected)
                if recorded_generation is None and not state.get("handles"):
                    return _failed_activation(
                        requirement,
                        request_source,
                        "stale_generation",
                        "The activation snapshot cannot identify the running process generation; explicit adoption is required.",
                        retryable=False,
                    )
            previous_generation = state.get("activeGeneration")
            if recorded_generation is not None:
                generation = recorded_generation
                self.diagnostics = inspected
            else:
                generation = str(int(str(previous_generation or "0")) + 1)
                try:
                    activate_with_generation = getattr(
                        self.host, "activate_with_generation", None
                    )
                    if callable(activate_with_generation):
                        activated = activate_with_generation(
                            self.home, self.runtime_dir, generation
                        )
                    else:
                        activated = self.host.activate(self.home, self.runtime_dir)
                    self.diagnostics = dict(activated)
                except (OSError, RuntimeError, ValueError) as error:
                    return _failed_activation(
                        requirement,
                        request_source,
                        "activation_failed",
                        str(error),
                        retryable=True,
                    )
            if not _process_running(self.diagnostics):
                return _failed_activation(
                    requirement,
                    request_source,
                    "activation_failed",
                    "The process host did not establish one running supervisor and coordinator.",
                    retryable=True,
                )
            if self.readiness_authority is None:
                return _failed_activation(
                    requirement,
                    request_source,
                    "readiness_not_established",
                    "The process host is running, but no DurableEngine readiness authority is configured.",
                    retryable=True,
                )
            try:
                readiness = dict(
                    self.readiness_authority.establish(
                        requirement, generation, self.diagnostics
                    )
                )
                _validate_value("runtimeReadiness", readiness, self.contract)
            except (OSError, RuntimeError, TypeError, ValueError) as error:
                return _failed_activation(
                    requirement,
                    request_source,
                    "readiness_not_established",
                    str(error),
                    retryable=True,
                )
            if not _readiness_admits_requirement(requirement, readiness):
                return _failed_activation(
                    requirement,
                    request_source,
                    "readiness_cut_unavailable",
                    "The readiness authority did not prove the required durable and projection cuts.",
                    retryable=True,
                )
            handle = _runtime_handle(
                requirement, generation, readiness, self.diagnostics
            )
            leases = copy.deepcopy(state.get("leases") or [])
            if generation != str(previous_generation or ""):
                for lease in leases:
                    if isinstance(lease, dict) and lease.get("state") == "active":
                        lease["state"] = "expired"
            snapshot = {
                "schema": "kungfu.runtime.snapshot/v1",
                "workspaceId": requirement["workspaceId"],
                "runtimeId": handle["runtimeId"],
                "activeGeneration": generation,
                "handles": [_persisted_generation_handle(state, handle)],
                "leases": leases,
            }
            _validate_value("runtimeSnapshot", snapshot, self.contract)
            _write_activation_state(state_path, snapshot)
            return _activation_receipt(
                requirement,
                request_source,
                outcome="activated",
                error=None,
                handle=handle,
                achieved_capabilities=list(requirement["requiredCapabilities"]),
                granted_authorities=list(requirement["requestedAuthorities"]),
            )


class RuntimeCapabilityBroker:
    def __init__(
        self,
        activation_client_factory: Callable[[], RuntimeActivationClient] | None = None,
        *,
        contract: Mapping[str, Any] | None = None,
    ) -> None:
        self._activation_client_factory = activation_client_factory
        self._contract = contract

    @classmethod
    def for_process(
        cls,
        home: str,
        runtime_dir: str,
        *,
        log_level: str = "warning",
        config_home: str | None = None,
        readiness_authority: RuntimeReadinessAuthority | None = None,
        contract: Mapping[str, Any] | None = None,
    ) -> RuntimeCapabilityBroker:
        return cls(
            lambda: ProcessRuntimeActivationClient(
                home,
                runtime_dir,
                log_level=log_level,
                config_home=config_home,
                readiness_authority=readiness_authority,
                contract=contract,
            ),
            contract=contract,
        )

    def catalog(self) -> dict[str, Any]:
        return operation_catalog(self._contract)

    def plan(
        self,
        operation_id: str,
        *,
        workspace: str,
        request_source: str,
        minimum_cut: Mapping[str, Any] | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        return plan_operation(
            operation_id,
            workspace=workspace,
            request_source=request_source,
            minimum_cut=minimum_cut,
            request_id=request_id,
            contract=self._contract,
        )

    def invoke(
        self,
        plan: Mapping[str, Any],
        operation: Callable[[Mapping[str, Any]], Any],
    ) -> dict[str, Any]:
        if plan.get("schema") != PLAN_SCHEMA:
            raise ValueError("runtime invoke requires an invocation plan")
        requirement = plan.get("requirement")
        if not isinstance(requirement, Mapping):
            raise ValueError("runtime invocation plan has no requirement")
        request_source = str(plan.get("requestSource") or "")
        operation_value = plan.get("operation")
        if not isinstance(operation_value, Mapping):
            raise ValueError("runtime invocation plan has no operation")
        expected = self.plan(
            str(operation_value.get("id") or ""),
            workspace=str(requirement.get("workspaceId") or ""),
            request_source=request_source,
            minimum_cut=requirement.get("minimumCut"),
            request_id=str(requirement.get("requestId") or ""),
        )
        if dict(plan) != expected:
            raise ValueError("runtime invocation plan is stale or altered")
        operation_class = requirement.get("operationClass")
        if operation_class == "storage-only":
            activation = _activation_receipt(
                requirement,
                request_source,
                outcome="daemonless",
                error=None,
            )
        elif self._activation_client_factory is None:
            activation = _failed_activation(
                requirement,
                request_source,
                "runtime_unavailable",
                str((plan.get("operation") or {}).get("recoveryGuidance") or ""),
                retryable=True,
            )
        else:
            activation = dict(
                self._activation_client_factory().activate(requirement, request_source)
            )
            if activation.get("requirement") != requirement:
                activation = _failed_activation(
                    requirement,
                    request_source,
                    "activation_failed",
                    "The runtime host returned a receipt for a different requirement.",
                    retryable=False,
                )
        try:
            _validate_value("activationReceipt", activation, self._contract)
        except ValueError:
            activation = _failed_activation(
                requirement,
                request_source,
                "activation_failed",
                "The runtime host returned an invalid activation receipt.",
                retryable=False,
            )
        accepted = _activation_admits(requirement, activation)
        result = operation(activation) if accepted else None
        return {
            "schema": RECEIPT_SCHEMA,
            "planId": plan["planId"],
            "operationId": operation_value.get("id"),
            "accepted": accepted,
            "activation": activation,
            "result": result,
        }
