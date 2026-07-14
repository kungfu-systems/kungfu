# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import hashlib
import json
import os
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Protocol

from kungfu import contract as contract_runtime
from kungfu.coordination import locks as coordination_locks


PLAN_SCHEMA = "kungfu.runtime.invocation-plan/v1"
RECEIPT_SCHEMA = "kungfu.runtime.invocation-receipt/v1"
REQUIREMENT_SCHEMA = "kungfu.runtime.requirement/v1"
ACTIVATION_RECEIPT_SCHEMA = "kungfu.runtime.activation-receipt/v1"
REQUEST_SOURCES = {"libkungfu", "cli", "python", "node", "gui", "kfx"}


class RuntimeActivationClient(Protocol):
    def activate(
        self, requirement: Mapping[str, Any], request_source: str
    ) -> Mapping[str, Any]: ...


class RuntimeProcessHost(Protocol):
    def activate(self, home: str, runtime_dir: str) -> Mapping[str, Any]: ...

    def inspect(self, home: str, runtime_dir: str) -> Mapping[str, Any]: ...


class RuntimeReadinessAuthority(Protocol):
    def establish(
        self,
        requirement: Mapping[str, Any],
        generation: str,
        diagnostics: Mapping[str, Any],
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


def _activation_state_path(config_home: str | Path, workspace: str) -> Path:
    digest = hashlib.sha256(workspace.encode()).hexdigest()[:24]
    return (
        Path(config_home).expanduser().resolve()
        / "runtime"
        / "activations"
        / f"{digest}.json"
    )


def _read_activation_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        raise ValueError("runtime activation state is unreadable") from None
    if not isinstance(value, dict):
        raise ValueError("runtime activation state is not an object")
    return value


def _write_activation_state(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    with temporary.open("w", encoding="utf-8") as state_file:
        json.dump(value, state_file, indent=2, sort_keys=True)
        state_file.write("\n")
        state_file.flush()
        os.fsync(state_file.fileno())
    os.replace(temporary, path)
    try:
        directory = os.open(path.parent, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(directory)
    except OSError:
        pass
    finally:
        os.close(directory)


def _process_diagnostics(value: Mapping[str, Any]) -> dict[str, Any]:
    supervisor = value.get("supervisor")
    coordinator = value.get("coordinator")
    supervisor_value = supervisor if isinstance(supervisor, Mapping) else {}
    coordinator_value = coordinator if isinstance(coordinator, Mapping) else {}
    return {
        "supervisorPid": supervisor_value.get("pid"),
        "coordinatorPid": coordinator_value.get("pid"),
        "socketPath": None,
        "serviceInstalled": None,
        "guiVisible": None,
    }


def _process_running(value: Mapping[str, Any]) -> bool:
    supervisor = value.get("supervisor")
    coordinator = value.get("coordinator")
    return bool(
        isinstance(supervisor, Mapping)
        and supervisor.get("running") is True
        and isinstance(coordinator, Mapping)
        and coordinator.get("running") is True
    )


def _cut_at_or_after(
    observed: Mapping[str, Any] | None, minimum: Mapping[str, Any] | None
) -> bool:
    if minimum is None:
        return observed is not None
    if observed is None:
        return False
    if observed.get("stream_id") != minimum.get("stream_id") or observed.get(
        "container_epoch"
    ) != minimum.get("container_epoch"):
        return False
    try:
        observed_sequence = int(str(observed.get("sequence")))
        minimum_sequence = int(str(minimum.get("sequence")))
    except (TypeError, ValueError):
        return False
    if observed_sequence != minimum_sequence:
        return observed_sequence > minimum_sequence
    return observed.get("frame_uid") == minimum.get("frame_uid")


def _readiness_admits_requirement(
    requirement: Mapping[str, Any], readiness: Mapping[str, Any]
) -> bool:
    required = set(requirement.get("requiredCapabilities") or [])
    durable_cut = readiness.get("durableCut")
    projection_cut = readiness.get("projectionCut")
    return bool(
        readiness.get("state") == "ready"
        and readiness.get("evidence")
        and _cut_at_or_after(
            durable_cut if isinstance(durable_cut, Mapping) else None,
            requirement.get("minimumCut")
            if isinstance(requirement.get("minimumCut"), Mapping)
            else None,
        )
        and (
            "runtime.live-projection" not in required
            or isinstance(projection_cut, Mapping)
            and _cut_at_or_after(
                projection_cut,
                durable_cut if isinstance(durable_cut, Mapping) else None,
            )
        )
    )


def _runtime_cut(value: Mapping[str, Any]) -> dict[str, str]:
    fields = ("stream_id", "container_epoch", "sequence", "frame_uid")
    if any(value.get(field) is None for field in fields):
        raise ValueError("runtime cut is incomplete")
    return {field: str(value[field]) for field in fields}


class _ReconciledReadinessProjection:
    """Project already-returned native evidence into runtime readiness."""

    def __init__(
        self,
        durability_reconciliation: Mapping[str, Any],
        projection_status: Mapping[str, Any] | None = None,
    ) -> None:
        self.durability_reconciliation = copy.deepcopy(dict(durability_reconciliation))
        self.projection_status = (
            copy.deepcopy(dict(projection_status))
            if projection_status is not None
            else None
        )

    def establish(
        self,
        requirement: Mapping[str, Any],
        generation: str,
        diagnostics: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        reconciliation = self.durability_reconciliation
        if (
            reconciliation.get("schema") != "kungfu.durability.reconciliation/v1"
            or reconciliation.get("state") != "reconciled"
            or reconciliation.get("recovered") is not True
        ):
            raise ValueError("durability reconciliation is not authoritative")
        receipt = reconciliation.get("receipt")
        if (
            not isinstance(receipt, Mapping)
            or receipt.get("schema") != "kungfu.durability.receipt/v1"
            or receipt.get("status") != "succeeded"
            or receipt.get("durable_watermark") is None
        ):
            raise ValueError("durability receipt did not establish a durable cut")
        durable_value = receipt["durable_watermark"]
        if not isinstance(durable_value, Mapping):
            raise ValueError("durability receipt cut is malformed")
        durable_cut = _runtime_cut(durable_value)
        evidence = [
            {
                "kind": "durability-receipt",
                "ref": (
                    f"receipt:durability:{receipt.get('request_id')}:"
                    f"{receipt.get('barrier_id')}"
                ),
            }
        ]
        projection_cut = None
        if "runtime.live-projection" in requirement.get("requiredCapabilities", []):
            projection = self.projection_status
            if (
                not isinstance(projection, Mapping)
                or projection.get("schema") != "kungfu.projection-candidate-status/v1"
                or projection.get("authority") != "libkungfu"
                or projection.get("outcome") != "ready"
                or projection.get("hydrated") is not True
                or projection.get("projection_watermark") is None
            ):
                raise ValueError("projection authority did not establish a ready cut")
            projection_value = projection["projection_watermark"]
            if not isinstance(projection_value, Mapping):
                raise ValueError("projection readiness cut is malformed")
            projection_cut = _runtime_cut(projection_value)
            evidence.append(
                {
                    "kind": "projection-status",
                    "ref": (
                        "status:projection:"
                        f"{projection.get('qualification_profile')}:"
                        f"{projection_cut['sequence']}"
                    ),
                }
            )
        return {
            "schema": "kungfu.runtime.readiness/v1",
            "state": "ready",
            "durableCut": durable_cut,
            "projectionCut": projection_cut,
            "evidence": evidence,
            "observedAtNs": str(time.time_ns()),
        }


class NativeReadinessAuthority:
    """Invoke the existing native authorities and project their exact evidence."""

    def __init__(
        self,
        *,
        data_root: str,
        durability_request_id: int,
        requested_profile: str,
        writer_resource_id: str,
        durability_qualification_profile: str,
        projection_writer_resource_id: str | None = None,
        projection_qualification_profile: str | None = None,
    ) -> None:
        self.data_root = data_root
        self.durability_request_id = durability_request_id
        self.requested_profile = requested_profile
        self.writer_resource_id = writer_resource_id
        self.durability_qualification_profile = durability_qualification_profile
        self.projection_writer_resource_id = (
            projection_writer_resource_id or writer_resource_id
        )
        self.projection_qualification_profile = projection_qualification_profile

    def establish(
        self,
        requirement: Mapping[str, Any],
        generation: str,
        diagnostics: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        minimum_cut = requirement.get("minimumCut")
        if not isinstance(minimum_cut, Mapping):
            raise ValueError("native readiness requires an explicit minimum cut")
        cut = _runtime_cut(minimum_cut)
        from kungfu import durability

        reconciliation = durability.reconcile(
            data_root=self.data_root,
            request_id=self.durability_request_id,
            stream_id=int(cut["stream_id"]),
            container_epoch=int(cut["container_epoch"]),
            sequence=int(cut["sequence"]),
            frame_uid=int(cut["frame_uid"]),
            requested_profile=self.requested_profile,
            writer_resource_id=self.writer_resource_id,
            qualification_profile=self.durability_qualification_profile,
        )
        projection_status = None
        if "runtime.live-projection" in requirement.get("requiredCapabilities", []):
            if not self.projection_qualification_profile:
                raise ValueError(
                    "native projection readiness requires a qualification profile"
                )
            from kungfu import projection

            projection_status = projection.candidate_status(
                data_root=self.data_root,
                stream_id=int(cut["stream_id"]),
                container_epoch=int(cut["container_epoch"]),
                writer_resource_id=self.projection_writer_resource_id,
                qualification_profile=self.projection_qualification_profile,
            )
        return _ReconciledReadinessProjection(
            reconciliation,
            projection_status,
        ).establish(requirement, generation, diagnostics)


def _runtime_handle(
    requirement: Mapping[str, Any],
    generation: str,
    readiness: Mapping[str, Any],
    diagnostics: Mapping[str, Any],
) -> dict[str, Any]:
    workspace = str(requirement["workspaceId"])
    return {
        "schema": "kungfu.runtime.handle/v1",
        "runtimeId": _stable_id("runtime", {"workspaceId": workspace}),
        "requirementId": requirement["requestId"],
        "workspaceId": workspace,
        "generation": generation,
        "state": "ready",
        "capabilities": list(requirement["requiredCapabilities"]),
        "grantedAuthorities": list(requirement["requestedAuthorities"]),
        "readiness": copy.deepcopy(dict(readiness)),
        "host": {
            "kind": "process",
            "hostId": _stable_id(
                "process-host",
                {"workspaceId": workspace, "generation": generation},
            ),
            "diagnostics": _process_diagnostics(diagnostics),
        },
    }


def _recorded_process_generation(
    state: Mapping[str, Any], diagnostics: Mapping[str, Any]
) -> str | None:
    handles = state.get("handles")
    if not isinstance(handles, list) or len(handles) != 1:
        return None
    previous = handles[0]
    if not isinstance(previous, Mapping):
        return None
    generation = str(previous.get("generation") or "")
    if (
        previous.get("workspaceId") != state.get("workspaceId")
        or state.get("activeGeneration") != generation
        or not generation.isdigit()
        or generation == "0"
    ):
        return None
    previous_host = previous.get("host")
    previous_diagnostics = (
        previous_host.get("diagnostics") if isinstance(previous_host, Mapping) else None
    )
    if not isinstance(previous_diagnostics, Mapping):
        return None
    current_diagnostics = _process_diagnostics(diagnostics)
    if any(
        not previous_diagnostics.get(key)
        or previous_diagnostics.get(key) != current_diagnostics.get(key)
        for key in ("supervisorPid", "coordinatorPid")
    ):
        return None
    return generation


def _reusable_handle(
    requirement: Mapping[str, Any],
    state: Mapping[str, Any],
    diagnostics: Mapping[str, Any],
) -> dict[str, Any] | None:
    handles = state.get("handles")
    if not isinstance(handles, list) or len(handles) != 1:
        return None
    previous = handles[0]
    if not isinstance(previous, Mapping) or previous.get("state") != "ready":
        return None
    if previous.get("workspaceId") != requirement.get("workspaceId"):
        return None
    if state.get("activeGeneration") != previous.get("generation"):
        return None
    generation = _recorded_process_generation(state, diagnostics)
    if generation is None:
        return None
    if not set(requirement.get("requiredCapabilities") or []).issubset(
        set(previous.get("capabilities") or [])
    ):
        return None
    if not set(requirement.get("requestedAuthorities") or []).issubset(
        set(previous.get("grantedAuthorities") or [])
    ):
        return None
    readiness = previous.get("readiness")
    if not isinstance(readiness, Mapping) or not _readiness_admits_requirement(
        requirement, readiness
    ):
        return None
    return _runtime_handle(
        requirement,
        generation,
        readiness,
        diagnostics,
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
                    self.diagnostics = dict(
                        self.host.activate(self.home, self.runtime_dir)
                    )
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
            snapshot = {
                "schema": "kungfu.runtime.snapshot/v1",
                "workspaceId": requirement["workspaceId"],
                "runtimeId": handle["runtimeId"],
                "activeGeneration": generation,
                "handles": [handle],
                "leases": [],
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
