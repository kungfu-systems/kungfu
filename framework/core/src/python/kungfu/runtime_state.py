# SPDX-License-Identifier: Apache-2.0

"""Fenced runtime activation state, readiness, and product-status owner."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from kungfu import runtime_paths
from kungfu.runtime_contract import PRODUCT_STATUS_SCHEMA
from kungfu.runtime_contract import stable_id as _stable_id
from kungfu.runtime_contract import validate_value as _validate_value
from kungfu.runtime_ports import RuntimeLeaseClock, RuntimeLifecycleError
from kungfu.runtime_ports import SystemRuntimeLeaseClock


def workspace_id(runtime_dir: str | Path) -> str:
    path = str(Path(runtime_dir).expanduser().resolve())
    return f"workspace-{hashlib.sha256(path.encode()).hexdigest()[:24]}"


def native_readiness_evidence_path(
    runtime_dir: str | Path, config_home: str | Path | None = None
) -> Path:
    """Return the product discovery path for one workspace's evidence coordinates."""

    workspace = workspace_id(runtime_dir)
    digest = hashlib.sha256(workspace.encode()).hexdigest()[:24]
    resolved_config_home = runtime_paths.resolve_config_home(
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
