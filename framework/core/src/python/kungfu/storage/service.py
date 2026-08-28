# SPDX-License-Identifier: Apache-2.0

"""Public compatibility facade for Kungfu storage operations.

Responsibility owners live in private capability modules; this module keeps the
established import surface and late-bound test seams stable.
"""

# Re-exports are the purpose of this compatibility facade.
# ruff: noqa: F401

from pathlib import Path
from typing import Any

import kungfu

from kungfu.action_envelope import canonical_json_bytes, payload_hash
from kungfu.storage._service_backend import (
    CONTENT_TYPE_JSON,
    MANIFEST_CATALOG_SCHEMA,
    PAYLOAD_STATE_PRESENT,
    PAYLOAD_STATES,
    PROJECTION_ATLAS_JOURNAL_FOLD,
    PROJECTION_MANIFEST_CATALOG,
    PROJECTION_SOURCE_REGISTRY,
    RUNTIME_STORAGE_SERVICE_SCHEMA,
    SOURCE_REGISTRY_SCHEMA,
    _entries_for_manifest,
    _typed_query_edge_projection,
    backend_rollback,
    backend_switch,
    compact_plan,
    fsck,
    gc_plan,
    layout,
    list_sources,
    load_latest_manifest,
    payload_path,
    query_projection,
    rebuild_index,
    repair_apply,
    repair_fetch,
    repair_plan,
    root_dir,
    source_inspect,
    source_register,
    status,
    verify_import_manifest,
    verify_local_sync,
)
from kungfu.storage._service_episode import (
    _episode_close_edge,
    _episode_write_edge,
    _episode_write_options,
    episode_abort,
    episode_attach_frame,
    episode_attach_ref,
    episode_begin,
    episode_end,
    episode_heartbeat,
    episode_inspect,
    episode_list,
    episode_projection_rebuild,
    episode_recover,
    episode_recovery_execute,
    episode_recovery_plan,
)
from kungfu.storage._service_fact import (
    action_runtime,
    assessment_contract,
    assessment_execute,
    assessment_invalidate,
    assessment_list,
    assessment_request,
    assessment_status,
    build_fact_query_definition,
    compile_fact_query_sql,
    fact_changelog,
    fact_contract,
    fact_declare_contract_world,
    fact_declare_surface,
    fact_kernel,
    fact_kernel_backend_parity,
    fact_kernel_export,
    fact_kernel_fsck,
    fact_kernel_import,
    fact_kernel_rebuild_projections,
    fact_kernel_retention_plan,
    fact_library_contract,
    fact_library_export,
    fact_library_import,
    fact_material_list,
    fact_material_put,
    fact_observe,
    fact_profile_shadow_compare,
    fact_profile_shadow_inspect,
    fact_profile_shadow_project,
    fact_query,
    fact_query_conformance,
    fact_query_definition,
    fact_state,
    fact_type_create,
    fact_type_list,
    kfx_registry,
    profile_lifecycle,
    query_plan,
    saved_query_catalog,
    trust_await,
    trust_require,
)
from kungfu.storage.kfx_service import (
    kfx_registry as _kfx_registry,
    kfx_runtime_contract as kfx_runtime_contract,
    validate_kfx_runtime_document as validate_kfx_runtime_document,
)
from kungfu.storage.transfer import StorageTransfer, _binding_json, _u64


def _runtime():
    return kungfu.__binding__.runtime


def service_capabilities() -> dict[str, Any]:
    return dict(_runtime().storage_service_capabilities())


def _runtime_service_request(
    operation: str,
    runtime_dir: str | Path,
    *,
    scope: str = "all",
    source_id: str | None = None,
    dry_run: bool = True,
    verify: bool = True,
    range_filter: dict[str, Any] | None = None,
    artifact_uri: str | None = None,
) -> dict[str, Any]:
    request = _runtime().make_storage_service_request(
        operation,
        str(runtime_dir),
        {
            "scope": scope,
            "source_id": source_id,
            "dry_run": dry_run,
            "verify": verify,
            "range": range_filter or {},
            "artifact_uri": artifact_uri or "",
        },
    )
    if request.get("schema") != RUNTIME_STORAGE_SERVICE_SCHEMA:
        raise RuntimeError(f"invalid runtime storage service request: {request}")
    return dict(request)


def write_payload_bytes(runtime_dir: str | Path, digest: str, raw: bytes) -> str:
    return str(_runtime().write_storage_payload_bytes(str(runtime_dir), digest, raw))


def accept_manifest(
    runtime_dir: str | Path, manifest: dict[str, Any]
) -> dict[str, Any]:
    """Accept one import manifest into the kernel journals (KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5).

    ``manifest`` is the adapter-edge input document; the accepted facts are
    Hana-core journal records and the return value is their JSON edge
    projection.
    """

    return dict(_runtime().accept_storage_manifest(str(runtime_dir), manifest))


def backend_status(
    runtime_dir: str | Path, *, provider: str | None = None
) -> dict[str, Any]:
    """Inspect the authoritative provider binding and any resumable cut."""

    return dict(
        _runtime().run_storage_service_operation(
            "backend_status",
            str(runtime_dir),
            {"provider": provider} if provider else {},
        )
    )


write_jsonl = StorageTransfer.write_jsonl


def export_records(
    runtime_dir: str | Path,
    *,
    source_id: str,
    range_filter: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in _runtime().export_storage_records(
            str(runtime_dir), source_id, range_filter or {}
        )
    ]


def episode_admission(
    destination_runtime_dir: str | Path,
    *,
    action: str = "plan",
    source_runtime_dir: str | Path | None = None,
    episode_ids: list[int] | None = None,
    transport: str = "local-direct",
    initiator: str = "destination-pull",
    plan: dict[str, Any] | None = None,
    plan_root: str = "",
    episode_bundles: list[dict[str, Any]] | None = None,
    source_identity: dict[str, Any] | None = None,
    destination_identity: dict[str, Any] | None = None,
    project_cut_roots: list[str] | None = None,
) -> dict[str, Any]:
    """Run the destination-owned Episode Admission protocol in libkungfu."""

    options: dict[str, Any] = {
        "action": action,
        "transport": transport,
        "initiator": initiator,
        "episode_ids": [_u64(value) for value in (episode_ids or [])],
        "project_cut_roots": project_cut_roots or [],
    }
    if source_runtime_dir is not None:
        options["source_runtime_dir"] = str(source_runtime_dir)
    if plan is not None:
        options["plan"] = _binding_json(plan)
    if plan_root:
        options["plan_root"] = plan_root
    if episode_bundles is not None:
        options["episode_bundles"] = _binding_json(episode_bundles)
    if source_identity is not None:
        options["source_identity"] = _binding_json(source_identity)
    if destination_identity is not None:
        options["destination_identity"] = _binding_json(destination_identity)
    return dict(
        _runtime().run_storage_service_operation(
            "episode_admission", str(destination_runtime_dir), options
        )
    )


export_jsonl = StorageTransfer.export_jsonl
export_bundle_json = StorageTransfer.export_bundle_json
build_export_bundle = StorageTransfer.build_export_bundle
import_bundle = StorageTransfer.import_bundle


def write_synthetic_source(
    runtime_dir: str | Path,
    *,
    source_id: str,
    records: list[dict[str, Any]],
    manifest_id: str = "synthetic-import",
    source_head: str = "synthetic-head",
    range_filter: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write a qualification-only synthetic adapter fixture.

    The canonical payload protocol and exact manifest projection are pinned by
    ``tests/fixtures/storage-synthetic-source/vectors.json``. Production source
    adapters must provide their own manifest rather than call this helper.
    """

    entries = []
    for index, record in enumerate(records):
        state = str(record.get("payload_state") or PAYLOAD_STATE_PRESENT)
        if state not in PAYLOAD_STATES:
            raise ValueError(f"unsupported synthetic payload state: {state}")
        if state == PAYLOAD_STATE_PRESENT:
            payload = record.get("payload", record)
            raw = canonical_json_bytes(payload)
            digest = payload_hash(raw)
            write_payload_bytes(runtime_dir, digest, raw)
            byte_len = len(raw)
        else:
            # Honest non-present states never serialize a body. A redacted
            # entry may carry the hash/length computed before withholding;
            # an absent entry carries neither; a recorded-missing entry keeps
            # whatever identity is known for the lost body.
            digest = str(record.get("payload_hash") or "")
            byte_len = int(record.get("byte_len") or 0)
        entries.append(
            {
                "kind": str(record.get("kind") or "record"),
                "source_id": str(record.get("source_id") or f"record-{index}"),
                "source_path": str(
                    record.get("source_path") or f"synthetic/{index}.json"
                ),
                "source_time": str(record.get("source_time") or ""),
                "schema_version": int(record.get("schema_version") or 1),
                "content_type": CONTENT_TYPE_JSON,
                "payload_hash": digest,
                "byte_len": byte_len,
                "payload_state": state,
            }
        )
    return accept_manifest(
        runtime_dir,
        {
            "manifest_id": manifest_id,
            "storage_source_id": source_id,
            "source_type": "synthetic",
            "source_coordinate": f"synthetic:{source_id}",
            "source_head": source_head,
            "scope": "source",
            "range": range_filter or {},
            "entries": entries,
        },
    )
