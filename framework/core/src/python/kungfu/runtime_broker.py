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
PRODUCT_STATUS_SCHEMA = "kungfu.runtime.product-status/v1"
NATIVE_READINESS_EVIDENCE_SCHEMA = "kungfu.runtime.native-readiness-evidence/v1"
REQUEST_SOURCES = {"libkungfu", "cli", "python", "node", "gui", "kfx"}


class RuntimeActivationClient(Protocol):
    def activate(
        self, requirement: Mapping[str, Any], request_source: str
    ) -> Mapping[str, Any]: ...


class RuntimeProcessHost(Protocol):
    def activate(self, home: str, runtime_dir: str) -> Mapping[str, Any]: ...

    def inspect(self, home: str, runtime_dir: str) -> Mapping[str, Any]: ...


class RuntimeDrainHost(Protocol):
    def drain(self, home: str, runtime_dir: str) -> Mapping[str, Any]: ...


class RuntimeReadinessAuthority(Protocol):
    def establish(
        self,
        requirement: Mapping[str, Any],
        generation: str,
        diagnostics: Mapping[str, Any],
    ) -> Mapping[str, Any]: ...


class RuntimeLeaseClock(Protocol):
    def now_ns(self) -> int: ...


class SystemRuntimeLeaseClock:
    def now_ns(self) -> int:
        return time.time_ns()


class RuntimeLifecycleError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


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


def native_readiness_evidence_path(
    runtime_dir: str | Path, config_home: str | Path | None = None
) -> Path:
    """Return the product discovery path for one workspace's evidence coordinates."""

    from kungfu import runtime_service

    workspace = workspace_id(runtime_dir)
    digest = hashlib.sha256(workspace.encode()).hexdigest()[:24]
    resolved_config_home = runtime_service.resolve_config_home(
        str(config_home) if config_home is not None else None
    )
    return Path(resolved_config_home) / "runtime" / "readiness" / f"{digest}.json"


def discover_native_readiness_evidence(
    runtime_dir: str | Path,
    config_home: str | Path | None = None,
    *,
    contract: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Discover coordinates for native authorities without treating them as proof."""

    path = native_readiness_evidence_path(runtime_dir, config_home)
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        raise ValueError("native runtime readiness evidence is unreadable") from None
    if not isinstance(value, dict):
        raise ValueError("native runtime readiness evidence is not an object")
    _validate_native_readiness_evidence(runtime_dir, value, contract)
    return copy.deepcopy(value)


def _validate_native_readiness_evidence(
    runtime_dir: str | Path,
    value: Mapping[str, Any],
    contract: Mapping[str, Any] | None = None,
) -> None:
    """Validate descriptor shape plus its exact workspace and root binding."""

    _validate_value("nativeReadinessEvidence", value, contract)
    expected_workspace = workspace_id(runtime_dir)
    if value.get("workspaceId") != expected_workspace:
        raise ValueError(
            "native runtime readiness evidence belongs to another workspace"
        )
    expected_data_root_path = Path(runtime_dir).expanduser().resolve()
    expected_data_root = str(expected_data_root_path)
    actual_data_root = str(Path(str(value.get("dataRoot"))).expanduser().resolve())
    if actual_data_root != expected_data_root:
        raise ValueError("native runtime readiness evidence data root does not match")
    expected_runtime_home = str(expected_data_root_path.parent)
    actual_runtime_home = str(
        Path(str(value.get("runtimeHome"))).expanduser().resolve()
    )
    if actual_runtime_home != expected_runtime_home:
        raise ValueError(
            "native runtime readiness evidence runtime home does not match"
        )


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


def _write_runtime_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as state_file:
            json.dump(value, state_file, indent=2, sort_keys=True)
            state_file.write("\n")
            state_file.flush()
            os.fsync(state_file.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
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


def _write_activation_state(path: Path, value: Mapping[str, Any]) -> None:
    _write_runtime_json(path, value)


def product_status(
    config_home: str | Path,
    runtime_dir: str | Path,
    *,
    clock: RuntimeLeaseClock | None = None,
    contract: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Project one topology-neutral product status from the fenced snapshot.

    An absent live snapshot is a normal daemonless workspace, not an offline
    workspace. Process facts deliberately stay on the separate diagnostic
    status surface and cannot promote this projection to ready.
    """

    workspace = workspace_id(runtime_dir)
    status: dict[str, Any] = {
        "schema": PRODUCT_STATUS_SCHEMA,
        "workspaceId": workspace,
        "availability": "available",
        "liveState": "inactive",
        "handle": None,
        "leases": {"activeCount": 0, "items": []},
        "error": None,
    }
    try:
        state = _read_activation_state(_activation_state_path(config_home, workspace))
        if state is None:
            _validate_value("runtimeProductStatus", status, contract)
            return status
        _validate_value("runtimeSnapshot", state, contract)
        if state.get("workspaceId") != workspace:
            raise RuntimeLifecycleError(
                "stale_generation",
                "runtime activation workspace is inconsistent",
            )
        projected = copy.deepcopy(state)
        _expire_leases(projected, (clock or SystemRuntimeLeaseClock()).now_ns())
        handle = _snapshot_handle(projected)
        leases = [
            copy.deepcopy(dict(item))
            for item in projected["leases"]
            if isinstance(item, Mapping)
        ]
        status.update(
            {
                "liveState": str(handle["state"]),
                "handle": handle,
                "leases": {
                    "activeCount": sum(
                        1 for item in leases if item.get("state") == "active"
                    ),
                    "items": leases,
                },
            }
        )
        if handle["state"] == "failed":
            status["error"] = {
                "code": "activation_failed",
                "message": "The fenced runtime generation is in the failed state.",
                "retryable": True,
            }
        _validate_value("runtimeProductStatus", status, contract)
        return status
    except (OSError, ValueError, RuntimeLifecycleError) as error:
        code = (
            error.code
            if isinstance(error, RuntimeLifecycleError)
            else "stale_generation"
        )
        status.update(
            {
                "liveState": "failed",
                "handle": None,
                "leases": {"activeCount": 0, "items": []},
                "error": {
                    "code": code,
                    "message": str(error),
                    "retryable": False,
                },
            }
        )
    _validate_value("runtimeProductStatus", status, contract)
    return status


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


def native_readiness_authority(
    evidence: Mapping[str, Any],
    *,
    contract: Mapping[str, Any] | None = None,
) -> NativeReadinessAuthority:
    """Construct the existing native authority from validated discovery coordinates."""

    _validate_value("nativeReadinessEvidence", evidence, contract)
    durability_value = evidence["durability"]
    projection_value = evidence.get("projection")
    projection_mapping = (
        projection_value if isinstance(projection_value, Mapping) else {}
    )
    return NativeReadinessAuthority(
        data_root=str(evidence["dataRoot"]),
        durability_request_id=int(str(durability_value["requestId"])),
        requested_profile=str(durability_value["requestedProfile"]),
        writer_resource_id=str(durability_value["writerResourceId"]),
        durability_qualification_profile=str(durability_value["qualificationProfile"]),
        projection_writer_resource_id=(
            str(projection_mapping["writerResourceId"]) if projection_mapping else None
        ),
        projection_qualification_profile=(
            str(projection_mapping["qualificationProfile"])
            if projection_mapping
            else None
        ),
    )


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


def _persisted_generation_handle(
    state: Mapping[str, Any], handle: Mapping[str, Any]
) -> dict[str, Any]:
    persisted = copy.deepcopy(dict(handle))
    if state.get("activeGeneration") != handle.get("generation"):
        return persisted
    try:
        previous = _snapshot_handle(state)
    except RuntimeLifecycleError:
        return persisted
    persisted["capabilities"] = sorted(
        set(previous.get("capabilities") or []) | set(handle.get("capabilities") or [])
    )
    persisted["grantedAuthorities"] = sorted(
        set(previous.get("grantedAuthorities") or [])
        | set(handle.get("grantedAuthorities") or [])
    )
    previous_readiness = previous.get("readiness")
    current_readiness = handle.get("readiness")
    if isinstance(previous_readiness, Mapping) and isinstance(
        current_readiness, Mapping
    ):
        persisted["readiness"] = _merged_readiness(
            previous_readiness, current_readiness
        )
    return persisted


def _merged_readiness(
    previous: Mapping[str, Any], current: Mapping[str, Any]
) -> dict[str, Any]:
    """Preserve monotonic same-generation readiness without inventing a cut."""

    merged = copy.deepcopy(dict(current))
    previous_durable = previous.get("durableCut")
    current_durable = current.get("durableCut")
    if isinstance(previous_durable, Mapping) and _cut_at_or_after(
        previous_durable,
        current_durable if isinstance(current_durable, Mapping) else None,
    ):
        merged["durableCut"] = copy.deepcopy(dict(previous_durable))
    merged_durable = merged.get("durableCut")
    projection_candidates = [
        value
        for value in (current.get("projectionCut"), previous.get("projectionCut"))
        if isinstance(value, Mapping)
        and _cut_at_or_after(
            value,
            merged_durable if isinstance(merged_durable, Mapping) else None,
        )
    ]
    projection_cut = None
    for candidate in projection_candidates:
        if projection_cut is None or _cut_at_or_after(candidate, projection_cut):
            projection_cut = copy.deepcopy(dict(candidate))
    merged["projectionCut"] = projection_cut
    evidence: list[dict[str, Any]] = []
    seen_evidence: set[str] = set()
    for item in list(previous.get("evidence") or []) + list(
        current.get("evidence") or []
    ):
        if not isinstance(item, Mapping):
            continue
        value = copy.deepcopy(dict(item))
        identity = json.dumps(value, sort_keys=True, separators=(",", ":"))
        if identity not in seen_evidence:
            seen_evidence.add(identity)
            evidence.append(value)
    merged["evidence"] = evidence
    try:
        merged["observedAtNs"] = str(
            max(
                int(str(previous.get("observedAtNs") or "0")),
                int(str(current.get("observedAtNs") or "0")),
            )
        )
    except ValueError:
        pass
    return merged


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
        or previous.get("state") != "ready"
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
    if not previous_diagnostics.get("coordinatorPid") or previous_diagnostics.get(
        "coordinatorPid"
    ) != current_diagnostics.get("coordinatorPid"):
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


def fenced_coordinator_generation(
    config_home: str | Path,
    runtime_dir: str | Path,
    coordinator_pid: int,
    *,
    contract: Mapping[str, Any] | None = None,
) -> str | None:
    """Return the fenced generation only for the recorded coordinator authority."""

    workspace = workspace_id(runtime_dir)
    try:
        state = _read_activation_state(_activation_state_path(config_home, workspace))
        if state is None:
            return None
        _validate_value("runtimeSnapshot", state, contract)
    except ValueError:
        return None
    handles = state.get("handles")
    if not isinstance(handles, list) or len(handles) != 1:
        return None
    handle = handles[0]
    if not isinstance(handle, Mapping):
        return None
    host = handle.get("host")
    diagnostics = host.get("diagnostics") if isinstance(host, Mapping) else None
    generation = str(handle.get("generation") or "")
    if (
        handle.get("workspaceId") != workspace
        or handle.get("runtimeId") != state.get("runtimeId")
        or state.get("activeGeneration") != generation
        or handle.get("state") not in {"ready", "draining", "restarting"}
        or not isinstance(diagnostics, Mapping)
        or diagnostics.get("coordinatorPid") != coordinator_pid
    ):
        return None
    return generation


def _snapshot_handle(state: Mapping[str, Any]) -> dict[str, Any]:
    handles = state.get("handles")
    if not isinstance(handles, list) or len(handles) != 1:
        raise RuntimeLifecycleError(
            "stale_generation", "runtime snapshot has no single active handle"
        )
    handle = handles[0]
    if not isinstance(handle, Mapping):
        raise RuntimeLifecycleError(
            "stale_generation", "runtime snapshot handle is malformed"
        )
    generation = str(handle.get("generation") or "")
    if state.get("activeGeneration") != generation:
        raise RuntimeLifecycleError(
            "stale_generation", "runtime snapshot generation is inconsistent"
        )
    return copy.deepcopy(dict(handle))


def _expire_leases(state: dict[str, Any], now_ns: int) -> bool:
    changed = False
    leases = state.get("leases")
    if not isinstance(leases, list):
        raise RuntimeLifecycleError("lease_expired", "runtime leases are malformed")
    for lease in leases:
        if not isinstance(lease, dict) or lease.get("state") != "active":
            continue
        try:
            expires_at = int(str(lease.get("expiresAtNs")))
        except (TypeError, ValueError):
            raise RuntimeLifecycleError(
                "lease_expired", "runtime lease expiry is malformed"
            ) from None
        if expires_at <= now_ns:
            lease["state"] = "expired"
            changed = True
    return changed


def _set_snapshot_lifecycle(state: dict[str, Any], lifecycle: str) -> None:
    handle = _snapshot_handle(state)
    readiness = handle.get("readiness")
    if not isinstance(readiness, Mapping):
        raise RuntimeLifecycleError(
            "stale_generation", "runtime handle readiness is malformed"
        )
    handle["state"] = lifecycle
    handle["readiness"] = {**dict(readiness), "state": lifecycle}
    state["handles"] = [handle]


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
