# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Protocol

from kungfu import contract as contract_runtime


PLAN_SCHEMA = "kungfu.runtime.invocation-plan/v1"
RECEIPT_SCHEMA = "kungfu.runtime.invocation-receipt/v1"
REQUIREMENT_SCHEMA = "kungfu.runtime.requirement/v1"
ACTIVATION_RECEIPT_SCHEMA = "kungfu.runtime.activation-receipt/v1"
REQUEST_SOURCES = {"libkungfu", "cli", "python", "node", "gui", "kfx"}


class RuntimeActivationClient(Protocol):
    def activate(
        self, requirement: Mapping[str, Any], request_source: str
    ) -> Mapping[str, Any]: ...


def _stable_id(prefix: str, value: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode()
    return f"{prefix}-{hashlib.sha256(encoded).hexdigest()[:24]}"


def workspace_id(runtime_dir: str | Path) -> str:
    path = str(Path(runtime_dir).expanduser().resolve())
    return f"workspace-{hashlib.sha256(path.encode()).hexdigest()[:24]}"


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


def _validate_value(
    target: str,
    value: Mapping[str, Any],
    contract: Mapping[str, Any] | None = None,
) -> None:
    contract_value = (
        contract_runtime.load_contract("runtime") if contract is None else contract
    )
    bundle = contract_value["valueSchemaBundle"]
    schema = {
        "$schema": bundle["$schema"],
        "$defs": bundle["$defs"],
        "$ref": f"#/$defs/{target}",
    }
    contract_runtime.validate_json_schema(value, schema, f"runtime {target}")


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
    return (
        achieved == required
        and granted == requested
        and set(handle.get("capabilities") or []) == required
        and set(handle.get("grantedAuthorities") or []) == requested
        and handle.get("requirementId") == requirement.get("requestId")
        and handle.get("workspaceId") == requirement.get("workspaceId")
        and isinstance(readiness, Mapping)
        and readiness.get("state") == "ready"
        and readiness.get("durableCut") is not None
        and (
            "runtime.live-projection" not in required
            or readiness.get("projectionCut") is not None
        )
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
    ) -> None:
        from kungfu import runtime_service

        self.home = home
        self.runtime_dir = runtime_dir
        self.host = runtime_service.ProcessRuntimeHost(log_level, config_home)
        self.diagnostics: Mapping[str, Any] | None = None

    def activate(
        self, requirement: Mapping[str, Any], request_source: str
    ) -> Mapping[str, Any]:
        try:
            self.diagnostics = self.host.activate(self.home, self.runtime_dir)
        except (OSError, RuntimeError, ValueError) as error:
            return _failed_activation(
                requirement,
                request_source,
                "activation_failed",
                str(error),
                retryable=True,
            )
        return _failed_activation(
            requirement,
            request_source,
            "readiness_not_established",
            "The process host was requested, but semantic readiness at a durable cut is not implemented yet.",
            retryable=True,
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
        contract: Mapping[str, Any] | None = None,
    ) -> RuntimeCapabilityBroker:
        return cls(
            lambda: ProcessRuntimeActivationClient(
                home,
                runtime_dir,
                log_level=log_level,
                config_home=config_home,
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
