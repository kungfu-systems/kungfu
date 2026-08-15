# SPDX-License-Identifier: Apache-2.0

import time
from pathlib import Path
from typing import Any

import kungfu

from kungfu.action_envelope import canonical_json_bytes, payload_hash
from kungfu.storage.transfer import StorageTransfer, _binding_json, _u64

PAYLOAD_STATE_PRESENT = "present"
PAYLOAD_STATES = ("present", "redacted", "absent", "missing")
CONTENT_TYPE_JSON = "application/json"
SOURCE_REGISTRY_SCHEMA = "kungfu.storage.source-registry/v1"
MANIFEST_CATALOG_SCHEMA = "kungfu.storage.manifest-catalog/v1"
PROJECTION_SOURCE_REGISTRY = "source-registry-sqlite"
PROJECTION_MANIFEST_CATALOG = "manifest-catalog-sqlite"
PROJECTION_ATLAS_JOURNAL_FOLD = "atlas-journal-fold"
RUNTIME_STORAGE_SERVICE_SCHEMA = "kungfu.runtime.storage-service/v1"


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


def root_dir(runtime_dir: str | Path) -> Path:
    return Path(runtime_dir) / "storage"


def payload_path(runtime_dir: str | Path, digest: str) -> Path:
    # KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5: payload bodies are opaque content-addressed bytes named by the
    # content hash alone (no format-implying extension). Must match the C++
    # runtime storage service payload_path.
    return root_dir(runtime_dir) / "payloads" / digest[:2] / digest


def write_payload_bytes(runtime_dir: str | Path, digest: str, raw: bytes) -> str:
    return str(_runtime().write_storage_payload_bytes(str(runtime_dir), digest, raw))


def verify_import_manifest(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        dict(issue) for issue in _runtime().verify_storage_import_manifest(manifest)
    ]


def accept_manifest(
    runtime_dir: str | Path, manifest: dict[str, Any]
) -> dict[str, Any]:
    """Accept one import manifest into the kernel journals (KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5).

    ``manifest`` is the adapter-edge input document; the accepted facts are
    Hana-core journal records and the return value is their JSON edge
    projection.
    """

    return dict(_runtime().accept_storage_manifest(str(runtime_dir), manifest))


def load_latest_manifest(
    runtime_dir: str | Path, source_id: str
) -> dict[str, Any] | None:
    data = _runtime().load_storage_latest_manifest(str(runtime_dir), source_id)
    if data is None:
        return None
    return data if isinstance(data, dict) else None


def list_sources(runtime_dir: str | Path) -> list[dict[str, Any]]:
    return list(status(runtime_dir).get("sources", []))


def status(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
) -> dict[str, Any]:
    return dict(_runtime().storage_status_typed(str(runtime_dir), source_id))


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


def backend_switch(
    runtime_dir: str | Path,
    *,
    target_provider: str,
    expected_generation: int | None = None,
    qualification_fail_after_copied_objects: int | None = None,
) -> dict[str, Any]:
    """Copy, verify, and atomically bind a different embedded provider."""

    options: dict[str, Any] = {"target_provider": target_provider}
    if expected_generation is not None:
        options["expected_generation"] = _u64(expected_generation)
    if qualification_fail_after_copied_objects is not None:
        options["qualification_fail_after_copied_objects"] = _u64(
            qualification_fail_after_copied_objects
        )
    return dict(
        _runtime().run_storage_service_operation(
            "backend_switch", str(runtime_dir), options
        )
    )


def backend_rollback(
    runtime_dir: str | Path, *, expected_generation: int | None = None
) -> dict[str, Any]:
    """Reverse-sync to the retained provider and publish a new generation."""

    options: dict[str, Any] = {}
    if expected_generation is not None:
        options["expected_generation"] = _u64(expected_generation)
    return dict(
        _runtime().run_storage_service_operation(
            "backend_rollback", str(runtime_dir), options
        )
    )


def layout(
    runtime_dir: str | Path,
    *,
    runtime_home: str | Path | None = None,
    config_home: str | Path | None = None,
    provider: str | None = None,
) -> dict[str, Any]:
    return dict(
        _runtime().storage_layout_typed(
            str(runtime_dir),
            runtime_home=str(runtime_home) if runtime_home is not None else "",
            config_home=str(config_home) if config_home is not None else "",
            provider=provider or "",
        )
    )


def _entries_for_manifest(
    manifest: dict[str, Any], range_filter: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    entries = manifest.get("entries", [])
    if range_filter:
        entries = _runtime().filter_storage_manifest_entries(entries, range_filter)
    return [dict(entry) for entry in entries if isinstance(entry, dict)]


def fsck(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    episode_id: int | None = None,
    verify_frames: bool = False,
) -> dict[str, Any]:
    # verify_frames re-opens the event journals the Episode manifest claims
    # frames from and verifies each attached receipt (presence, header fields,
    # recomputed checksums). Episode-scope only; it reads every referenced
    # journal, so it stays opt-in.
    return dict(
        _runtime().storage_fsck_typed(
            str(runtime_dir),
            source_id=source_id,
            episode_id=episode_id or 0,
            verify_frames=verify_frames,
        )
    )


def repair_plan(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    episode_id: int | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    return dict(
        _runtime().storage_repair_plan_typed(
            str(runtime_dir),
            source_id=source_id,
            episode_id=episode_id or 0,
            dry_run=dry_run,
        )
    )


def repair_fetch(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    episode_id: int | None = None,
    out_path: str | Path | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    scope = "episode" if episode_id else ("source" if source_id else "all")
    return dict(
        _runtime().run_storage_service_operation(
            "repair_fetch",
            str(runtime_dir),
            {
                "scope": scope,
                "source_id": source_id,
                "episode_id": _u64(episode_id),
                "dry_run": dry_run,
                "artifact_uri": str(out_path) if out_path else "",
            },
        )
    )


def repair_apply(
    runtime_dir: str | Path,
    repair_input: dict[str, Any],
    *,
    source_id: str | None = None,
    episode_id: int | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    scope = "episode" if episode_id else ("source" if source_id else "all")
    return dict(
        _runtime().run_storage_service_operation(
            "repair_apply",
            str(runtime_dir),
            {
                "scope": scope,
                "source_id": source_id,
                "episode_id": _u64(episode_id),
                "dry_run": dry_run,
                "bundle": _binding_json(repair_input),
            },
        )
    )


def source_register(
    runtime_dir: str | Path,
    *,
    source_id: str,
    kind: str = "local",
    coordinate: str = "",
    head: str = "",
) -> dict[str, Any]:
    """Register a source in the source-registry kernel journal (KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5)."""

    return dict(
        _runtime().storage_source_register_typed(
            str(runtime_dir),
            source_id=source_id,
            kind=kind,
            coordinate=coordinate,
            head=head,
        )
    )


def source_inspect(runtime_dir: str | Path, *, source_id: str) -> dict[str, Any]:
    """Fold the source-registry journal into one source's edge view."""

    return dict(
        _runtime().storage_source_inspect_typed(str(runtime_dir), source_id=source_id)
    )


def rebuild_index(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Rebuild the source registry projection from accepted manifests."""

    return dict(
        _runtime().storage_rebuild_index_typed(
            str(runtime_dir),
            source_id=source_id,
            dry_run=dry_run,
        )
    )


def gc_plan(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    return dict(
        _runtime().storage_gc_plan_typed(
            str(runtime_dir),
            source_id=source_id,
            dry_run=dry_run,
        )
    )


def compact_plan(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    return dict(
        _runtime().storage_compact_plan_typed(
            str(runtime_dir),
            source_id=source_id,
            dry_run=dry_run,
        )
    )


def verify_local_sync(
    runtime_dir: str | Path,
    *,
    source_id: str,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "verify_sync",
            str(runtime_dir),
            {
                "scope": "source",
                "source_id": source_id,
            },
        )
    )


def _typed_query_edge_projection(result: dict[str, Any]) -> dict[str, Any]:
    query_names = {
        0: "sources",
        1: "manifests",
        2: "entries",
    }
    query = query_names[int(result["query"])]
    rows = list(result.get("rows", []))
    rendered = {
        "ok": bool(result["ok"]),
        "scope": result["scope"],
        "projection": {
            "name": result["projection_name"],
            "schema": result["projection_schema"],
            "authority": result["authority"],
            "rebuildable": bool(result["rebuildable"]),
        },
        "query": query,
        "limit": int(result["limit"]),
        "rows": rows,
        "row_count": len(rows),
        "source_id": result.get("source_id"),
        "kind": result.get("entry_kind"),
        "range": {
            key: value for key, value in dict(result.get("range", {})).items() if value
        },
    }
    errors = [
        {key: value for key, value in dict(error).items() if value is not None}
        for error in result.get("errors", [])
    ]
    if errors:
        rendered["errors"] = errors
    return rendered


def query_projection(
    runtime_dir: str | Path,
    *,
    query: str = "entries",
    source_id: str | None = None,
    episode_id: int | None = None,
    kind: str | None = None,
    range_filter: dict[str, Any] | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    scope = "episode" if episode_id else ("source" if source_id else "all")
    if query in {"sources", "manifests", "entries"}:
        range_filter = range_filter or {}
        return _typed_query_edge_projection(
            dict(
                _runtime().storage_query_typed(
                    str(runtime_dir),
                    query,
                    source_id=source_id,
                    entry_kind=kind,
                    limit=limit,
                    since=str(range_filter.get("since") or ""),
                    until=str(range_filter.get("until") or ""),
                )
            )
        )
    return dict(
        _runtime().run_storage_service_operation(
            "query",
            str(runtime_dir),
            {
                "scope": scope,
                "source_id": source_id,
                "episode_id": _u64(episode_id),
                "query": query,
                "kind": kind,
                "range": range_filter or {},
                "limit": limit,
            },
        )
    )


def _episode_write_options(
    operation_options: dict[str, Any], write_retry: dict[str, Any] | None
) -> dict[str, Any]:
    options = _binding_json(operation_options)
    if write_retry is not None:
        options["write_retry"] = _binding_json(write_retry)
    return options


def _episode_write_edge(value: dict[str, Any]) -> dict[str, Any]:
    """Preserve the established typed Python shape over the native JSON edge."""

    result = dict(value)
    status = result.get("status")
    if isinstance(status, str):
        result["status"] = {
            "open": 1,
            "ended": 2,
            "aborted": 3,
            "tombstoned": 4,
        }.get(status, 0)
    ref_kind = result.get("ref_kind")
    if isinstance(ref_kind, str):
        result["ref_kind"] = {
            "input_frame": 1,
            "payload": 2,
            "schema": 3,
            "episode": 4,
        }.get(ref_kind, 0)
    return result


def _episode_close_edge(value: dict[str, Any]) -> dict[str, Any]:
    result = _episode_write_edge(value)
    write_retry = result.pop("write_retry", None)
    content_root = result.pop("content_root", None)
    edge: dict[str, Any] = {"close": result}
    if content_root is not None:
        edge["content_root"] = content_root
    if write_retry is not None:
        edge["write_retry"] = write_retry
    return edge


def episode_begin(
    runtime_dir: str | Path,
    *,
    title: str = "",
    actor: str = "",
    source: str = "",
    episode_id: int = 0,
    parent_episode_id: int = 0,
    root_trigger_frame_uid: int = 0,
    location_uid: int = 0,
    begin_time: int = 0,
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_write_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_begin",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "parent_episode_id": parent_episode_id,
                        "root_trigger_frame_uid": root_trigger_frame_uid,
                        "location_uid": location_uid,
                        "begin_time": begin_time,
                        "title": title,
                        "actor": actor,
                        "source": source,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_heartbeat(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    update_time: int = 0,
    last_frame_uid: int = 0,
    frame_count: int = 0,
    note: str = "",
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_write_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_heartbeat",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "location_uid": location_uid,
                        "update_time": update_time,
                        "last_frame_uid": last_frame_uid,
                        "frame_count": frame_count,
                        "note": note,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_attach_frame(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    frame_uid: int,
    location_uid: int = 0,
    trigger_frame_uid: int = 0,
    stream_id: int = 0,
    gen_time: int = 0,
    trigger_time: int = 0,
    carrier_type: int = 0,
    source: int = 0,
    dest: int = 0,
    data_length: int = 0,
    integrity_version: int = 0,
    payload_checksum: int = 0,
    frame_checksum: int = 0,
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_write_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_attach_frame",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "frame_uid": frame_uid,
                        "location_uid": location_uid,
                        "trigger_frame_uid": trigger_frame_uid,
                        "stream_id": stream_id,
                        "gen_time": gen_time,
                        "trigger_time": trigger_time,
                        "carrier_type": carrier_type,
                        "source": source,
                        "dest": dest,
                        "data_length": data_length,
                        "integrity_version": integrity_version,
                        "payload_checksum": payload_checksum,
                        "frame_checksum": frame_checksum,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_attach_ref(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    ref_kind: str = "input_frame",
    ref_uid: int = 0,
    ref_id: str = "",
    ref_hash: str = "",
    location_uid: int = 0,
    update_time: int = 0,
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_write_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_attach_ref",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "ref_kind": ref_kind,
                        "ref_uid": ref_uid,
                        "ref_id": ref_id,
                        "ref_hash": ref_hash,
                        "location_uid": location_uid,
                        "update_time": update_time,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_end(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    end_time: int = 0,
    last_frame_uid: int = 0,
    frame_count: int = 0,
    reason: str = "",
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_close_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_end",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "location_uid": location_uid,
                        "end_time": end_time,
                        "last_frame_uid": last_frame_uid,
                        "frame_count": frame_count,
                        "reason": reason,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_abort(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    end_time: int = 0,
    last_frame_uid: int = 0,
    frame_count: int = 0,
    reason: str = "",
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_close_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_abort",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "location_uid": location_uid,
                        "end_time": end_time,
                        "last_frame_uid": last_frame_uid,
                        "frame_count": frame_count,
                        "reason": reason,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_list(
    runtime_dir: str | Path,
    *,
    location_uid: int = 0,
    limit: int = 100,
) -> dict[str, Any]:
    return dict(
        _runtime().storage_episode_list_typed(
            str(runtime_dir), location_uid=location_uid, limit=limit
        )
    )


def episode_inspect(runtime_dir: str | Path, *, episode_id: int) -> dict[str, Any]:
    return dict(
        _runtime().storage_episode_inspect_typed(
            str(runtime_dir), episode_id=episode_id
        )
    )


def build_fact_query_definition(
    *, episode_id: int = 0, cut: dict[str, Any] | None = None, limit: int = 100
) -> dict[str, Any]:
    """Build the canonical edge form consumed by the C++ query planner."""

    examples = _runtime().run_storage_service_operation(
        "query_plan", "", {"action": "examples"}
    )
    definition = dict(examples["examples"][0]["definition"])
    definition["basis"] = dict(definition["basis"])
    definition["basis"]["episode_id"] = _u64(episode_id)
    definition["basis"]["cut"] = cut or {"kind": "head"}
    definition["limit"] = limit
    return definition


def query_plan(
    runtime_dir: str | Path,
    *,
    action: str,
    definition: dict[str, Any] | None = None,
    object_name: str = "episodes",
    sql: str | None = None,
    engine: str = "authority",
) -> dict[str, Any]:
    """Use the C++-owned KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104 planner and discovery contract."""

    options: dict[str, Any] = {
        "action": action,
        "object": object_name,
        "engine": engine,
    }
    if definition is not None:
        options["definition"] = definition
    if sql is not None:
        options["query"] = sql
    return dict(
        _runtime().run_storage_service_operation(
            "query_plan", str(runtime_dir), options
        )
    )


def fact_query_definition(
    runtime_dir: str | Path,
    definition: dict[str, Any],
    *,
    engine: str = "authority",
) -> dict[str, Any]:
    """Plan once and execute through the selected physical engine."""

    return dict(
        _runtime().run_storage_service_operation(
            "fact_query",
            str(runtime_dir),
            {"definition": definition, "engine": engine},
        )
    )


def fact_query(
    runtime_dir: str | Path,
    *,
    episode_id: int = 0,
    cut: dict[str, Any] | None = None,
    limit: int = 100,
    engine: str = "authority",
) -> dict[str, Any]:
    """Run the KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104 Episode query through one declared engine."""

    return fact_query_definition(
        runtime_dir,
        build_fact_query_definition(episode_id=episode_id, cut=cut, limit=limit),
        engine=engine,
    )


def fact_changelog(
    runtime_dir: str | Path,
    definition: dict[str, Any],
    *,
    resume_token: dict[str, Any] | None = None,
    max_messages: int = 100,
) -> dict[str, Any]:
    """Read one deterministic page of the KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104 proof changelog."""

    options: dict[str, Any] = {
        "definition": definition,
        "max_messages": max_messages,
    }
    if resume_token is not None:
        options["resume_token"] = resume_token
    return dict(
        _runtime().run_storage_service_operation(
            "fact_changelog", str(runtime_dir), options
        )
    )


def saved_query_catalog(
    runtime_dir: str | Path, action: str = "list", **kwargs: Any
) -> dict[str, Any]:
    """Operate the workspace-local journal-backed saved-query catalog."""
    return dict(
        _runtime().run_storage_service_operation(
            "saved_query_catalog", str(runtime_dir), {"action": action, **kwargs}
        )
    )


def profile_lifecycle(
    runtime_dir: str | Path, action: str = "list", **kwargs: Any
) -> dict[str, Any]:
    """Operate the Core-owned journal-backed Profile Suite lifecycle."""
    return dict(
        _runtime().run_storage_service_operation(
            "profile_lifecycle", str(runtime_dir), {"action": action, **kwargs}
        )
    )


def kfx_runtime_contract(runtime_dir: str | Path = "") -> dict[str, Any]:
    """Return the versioned Core-owned native KFX contract."""

    return dict(
        _runtime().run_storage_service_operation(
            "kfx_runtime", str(runtime_dir), {"action": "contract"}
        )
    )


def validate_kfx_runtime_document(
    kind: str, document: dict[str, Any], runtime_dir: str | Path = ""
) -> dict[str, Any]:
    """Validate a KFX edge document without reproducing Core policy."""

    return dict(
        _runtime().run_storage_service_operation(
            "kfx_runtime",
            str(runtime_dir),
            {"action": "validate", "kind": kind, "document": document},
        )
    )


def kfx_registry(
    action: str,
    request: dict[str, Any],
    runtime_dir: str | Path = "",
) -> dict[str, Any]:
    """Project one Core-native KFX registry or lifecycle operation."""

    if action not in {
        "list",
        "inspect",
        "resolve",
        "plan",
        "status",
        "assess",
        "apply",
        "history",
        "authorize-host",
        "runtime-warrant-issue",
        "runtime-warrant-heartbeat",
        "runtime-warrant-revoke",
        "runtime-warrant-settle",
        "runtime-warrant-recover",
        "kfd-10-witness",
    }:
        raise ValueError(f"unsupported KFX registry action: {action}")
    return dict(
        _runtime().run_storage_service_operation(
            "kfx_runtime",
            str(runtime_dir),
            {"action": action, "request": request},
        )
    )


def fact_contract(runtime_dir: str | Path = "") -> dict[str, Any]:
    """Return the C++-owned KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03 declaration/admission contract."""

    return dict(
        _runtime().run_storage_service_operation("fact_contract", str(runtime_dir), {})
    )


def fact_kernel(
    runtime_dir: str | Path,
    action: str,
    request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Forward one generic Fact operation to the Core-owned native kernel."""

    return dict(
        _runtime().run_storage_service_operation(
            "fact_kernel", str(runtime_dir), {"action": action, **(request or {})}
        )
    )


def action_runtime(
    runtime_dir: str | Path,
    action: str,
    request: dict[str, Any] | None = None,
) -> Any:
    """Forward one Action Geometry / Domain Profile / Profile action to native.

    Most actions return a JSON object; ``session_valid_actions`` returns a JSON
    array, so the wrapper preserves non-object results instead of forcing dict().
    """

    operation_request = {"action": action, **(request or {})}
    if "search_base" not in operation_request:
        from kungfu import host

        product_root = host.product_root()
        if product_root is not None:
            operation_request["search_base"] = str(product_root)

    result = _runtime().run_storage_service_operation(
        "action_runtime", str(runtime_dir), operation_request
    )
    return dict(result) if isinstance(result, dict) else result


def fact_profile_shadow_project(
    runtime_dir: str | Path, document: dict[str, Any]
) -> dict[str, Any]:
    """Project Profile source material through the native Fact kernel."""

    from kungfu.storage import fact_profile_shadow

    return fact_profile_shadow.project(runtime_dir, document)


def fact_profile_shadow_inspect(
    runtime_dir: str | Path, *, cut_root: str = "", ref_name: str = ""
) -> dict[str, Any]:
    """Inspect one shadow Cut without selecting it as authority."""

    from kungfu.storage import fact_profile_shadow

    return fact_profile_shadow.inspect(
        runtime_dir, cut_root=cut_root, ref_name=ref_name
    )


def fact_profile_shadow_compare(
    expected: dict[str, Any], actual: dict[str, Any]
) -> dict[str, Any]:
    """Compare an authoritative source view with a shadow projection."""

    from kungfu.storage import fact_profile_shadow

    return fact_profile_shadow.compare(expected, actual)


def fact_kernel_fsck(runtime_dir: str | Path, *, cut_root: str = "") -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.fsck(runtime_dir, cut_root=cut_root)


def fact_kernel_export(
    runtime_dir: str | Path, *, cut_root: str = "", ref_name: str = ""
) -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.export_bundle(
        runtime_dir, cut_root=cut_root, ref_name=ref_name
    )


def fact_kernel_import(
    runtime_dir: str | Path, bundle: dict[str, Any], *, dry_run: bool = True
) -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.import_bundle(runtime_dir, bundle, dry_run=dry_run)


def fact_kernel_retention_plan(
    runtime_dir: str | Path, *, cut_roots: list[str] | None = None
) -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.retention_plan(runtime_dir, cut_roots=cut_roots)


def fact_kernel_rebuild_projections(runtime_dir: str | Path) -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.rebuild_projections(runtime_dir)


def fact_kernel_backend_parity(
    runtime_dir: str | Path, *, target_provider: str
) -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.qualify_backend_parity(
        runtime_dir, target_provider=target_provider
    )


def fact_declare_contract_world(
    runtime_dir: str | Path,
    declaration: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_declare_world",
            str(runtime_dir),
            {"declaration": declaration, "system_time": system_time},
        )
    )


def fact_declare_surface(
    runtime_dir: str | Path,
    declaration: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_declare_surface",
            str(runtime_dir),
            {"declaration": declaration, "system_time": system_time},
        )
    )


def fact_observe(
    runtime_dir: str | Path,
    observation: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_observe",
            str(runtime_dir),
            {"observation": observation, "system_time": system_time},
        )
    )


def fact_state(
    runtime_dir: str | Path,
    *,
    cut_system_time: int = 0,
    subject_key: str = "",
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_state",
            str(runtime_dir),
            {"cut_system_time": cut_system_time, "subject_key": subject_key},
        )
    )


def fact_library_contract(runtime_dir: str | Path = "") -> dict[str, Any]:
    """Return the supported end-user Fact Library contract."""

    return dict(
        _runtime().run_storage_service_operation(
            "fact_library_contract", str(runtime_dir), {}
        )
    )


def fact_type_create(
    runtime_dir: str | Path,
    definition: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    """Create or idempotently recover one versioned managed fact type."""

    return dict(
        _runtime().run_storage_service_operation(
            "fact_type_create",
            str(runtime_dir),
            {"definition": definition, "system_time": system_time},
        )
    )


def fact_type_list(
    runtime_dir: str | Path,
    *,
    cut_system_time: int = 0,
    scope: str = "selected-data-root",
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_type_list",
            str(runtime_dir),
            {"cut_system_time": cut_system_time, "scope": scope},
        )
    )


def fact_material_put(
    runtime_dir: str | Path,
    material: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    """Store JSON material and record its admitted observation in one intent."""

    return dict(
        _runtime().run_storage_service_operation(
            "fact_material_put",
            str(runtime_dir),
            {"material": material, "system_time": system_time},
        )
    )


def fact_material_list(
    runtime_dir: str | Path,
    *,
    type_id: str = "",
    subject_key: str = "",
    cut_system_time: int = 0,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_material_list",
            str(runtime_dir),
            {
                "type_id": type_id,
                "subject_key": subject_key,
                "cut_system_time": cut_system_time,
            },
        )
    )


def fact_library_export(
    runtime_dir: str | Path,
    *,
    thin: bool = False,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_library_export", str(runtime_dir), {"thin": thin}
        )
    )


def fact_library_import(
    runtime_dir: str | Path,
    library_bundle: dict[str, Any],
    *,
    dry_run: bool = True,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_library_import",
            str(runtime_dir),
            {"library_bundle": _binding_json(library_bundle), "dry_run": dry_run},
        )
    )


def assessment_contract(runtime_dir: str | Path = "") -> dict[str, Any]:
    """Return the C++-owned KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302 assessment contract."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_contract", str(runtime_dir), {}
        )
    )


def assessment_request(
    runtime_dir: str | Path,
    request: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    """Persist an assessment intent without blocking the work Episode seal."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_request",
            str(runtime_dir),
            {"request": request, "system_time": system_time},
        )
    )


def assessment_execute(
    runtime_dir: str | Path,
    assessment_key: str,
    *,
    executor_profile: str = "process",
    system_time: int = 0,
) -> dict[str, Any]:
    """Execute or deduplicate a durable assessment job."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_execute",
            str(runtime_dir),
            {
                "assessment_key": assessment_key,
                "executor_profile": executor_profile,
                "system_time": system_time,
            },
        )
    )


def assessment_status(runtime_dir: str | Path, assessment_key: str) -> dict[str, Any]:
    """Fold the durable lifecycle of one assessment key."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_status",
            str(runtime_dir),
            {"assessment_key": assessment_key},
        )
    )


def assessment_list(runtime_dir: str | Path) -> dict[str, Any]:
    """List durable assessment lifecycle folds for workspace scheduling."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_list", str(runtime_dir), {}
        )
    )


def assessment_invalidate(
    runtime_dir: str | Path,
    assessment_key: str,
    *,
    changed_root: str,
    reason: str = "",
    system_time: int = 0,
) -> dict[str, Any]:
    """Mark a report stale only when the changed root is one of its inputs."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_invalidate",
            str(runtime_dir),
            {
                "assessment_key": assessment_key,
                "changed_root": changed_root,
                "reason": reason,
                "system_time": system_time,
            },
        )
    )


def trust_require(
    runtime_dir: str | Path, assessment_key: str, *, purpose: str
) -> dict[str, Any]:
    """Fail closed unless a fresh report is bound to the requested purpose."""

    return dict(
        _runtime().run_storage_service_operation(
            "trust_require",
            str(runtime_dir),
            {"assessment_key": assessment_key, "purpose": purpose},
        )
    )


def trust_await(
    runtime_dir: str | Path,
    assessment_key: str,
    *,
    purpose: str,
    timeout_seconds: float,
    poll_interval_seconds: float = 0.05,
) -> dict[str, Any]:
    """Wait a bounded time, then fail closed without changing Episode seal state."""

    deadline = time.monotonic() + max(timeout_seconds, 0.0)
    while True:
        result = trust_require(runtime_dir, assessment_key, purpose=purpose)
        if result["allowed"] or result["reason"] not in {
            "assessment-not-found",
            "assessment-not-fresh",
        }:
            return result
        status = assessment_status(runtime_dir, assessment_key)
        if status.get("state") not in {None, "pending", "running"}:
            return result
        if time.monotonic() >= deadline:
            return {
                "schema": "kungfu.trust.assessment/v1",
                "allowed": False,
                "reason": "trust-timeout",
                "assessment_key": assessment_key,
                "purpose": purpose,
                "state": status.get("state", "missing"),
            }
        time.sleep(max(poll_interval_seconds, 0.001))


def compile_fact_query_sql(
    runtime_dir: str | Path, *, sql: str, definition: dict[str, Any]
) -> dict[str, Any]:
    """Compile the bounded SQL subset into the canonical LogicalPlan."""

    return query_plan(
        runtime_dir,
        action="compile-sql",
        definition=definition,
        sql=sql,
    )


def fact_query_conformance(
    runtime_dir: str | Path, definition: dict[str, Any]
) -> dict[str, Any]:
    """Compare authority and SQLite execution at the public semantic seam."""

    authority = fact_query_definition(runtime_dir, definition, engine="authority")
    sqlite = fact_query_definition(runtime_dir, definition, engine="sqlite")
    authority_lineage = dict(authority["lineage"])
    sqlite_lineage = dict(sqlite["lineage"])
    authority_lineage.pop("execution", None)
    sqlite_lineage.pop("execution", None)
    checks = {
        "definition": authority["definition"] == sqlite["definition"],
        "logical_plan": authority["logical_plan"] == sqlite["logical_plan"],
        "result_schema": authority["result_schema"] == sqlite["result_schema"],
        "rows": authority["rows"] == sqlite["rows"],
        "result_hash": authority["result_hash"] == sqlite["result_hash"],
        "lineage_semantics": authority_lineage == sqlite_lineage,
        "lineage_authority": (
            authority["lineage"]["authority"] == sqlite["lineage"]["authority"]
        ),
        "lineage_cut": authority["lineage"]["cut"] == sqlite["lineage"]["cut"],
        "lineage_admission": (
            authority["lineage"]["admission_outcomes"]
            == sqlite["lineage"]["admission_outcomes"]
        ),
        "canonical_state": (
            authority["lineage"]["canonical_state"]
            == sqlite["lineage"]["canonical_state"]
        ),
    }
    return {
        "schema": "kungfu.query.conformance/v1",
        "ok": all(checks.values()),
        "checks": checks,
        "authority": authority,
        "sqlite": sqlite,
    }


def episode_recover(
    runtime_dir: str | Path,
    *,
    episode_id: int = 0,
    location_uid: int = 0,
    end_time: int = 0,
    reason: str = "",
    expected_manifest_frame_uid: int = 0,
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = dict(
        _runtime().run_storage_service_operation(
            "episode_recover",
            str(runtime_dir),
            _episode_write_options(
                {
                    "episode_id": episode_id,
                    "location_uid": location_uid,
                    "end_time": end_time,
                    "reason": reason,
                    "expected_manifest_frame_uid": expected_manifest_frame_uid,
                },
                write_retry,
            ),
        )
    )
    result["recovered"] = [
        _episode_close_edge(dict(item)) for item in result.get("recovered", [])
    ]
    return result


def episode_recovery_plan(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    stale_after_seconds: float = 300.0,
    now_ns: int | None = None,
) -> dict[str, Any]:
    options: dict[str, Any] = {
        "episode_id": episode_id,
        "location_uid": location_uid,
        "stale_after_seconds": stale_after_seconds,
    }
    if now_ns is not None:
        options["now_ns"] = now_ns
    return dict(
        _runtime().run_storage_service_operation(
            "episode_recovery_plan", str(runtime_dir), _binding_json(options)
        )
    )


def episode_recovery_execute(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    stale_after_seconds: float = 300.0,
    reason: str = "operator recovery",
    now_ns: int | None = None,
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    options: dict[str, Any] = {
        "episode_id": episode_id,
        "location_uid": location_uid,
        "stale_after_seconds": stale_after_seconds,
        "reason": reason,
    }
    if now_ns is not None:
        options["now_ns"] = now_ns
    result = dict(
        _runtime().run_storage_service_operation(
            "episode_recovery_execute",
            str(runtime_dir),
            _episode_write_options(options, write_retry),
        )
    )
    if result.get("ok") and isinstance(result.get("recovery"), dict):
        recovery = dict(result["recovery"])
        recovery["recovered"] = [
            _episode_close_edge(dict(item)) for item in recovery.get("recovered", [])
        ]
        result["recovery"] = recovery
    return result


def episode_projection_rebuild(runtime_dir: str | Path) -> dict[str, Any]:
    """Rebuild the Episode manifest SQLite projection from the journal."""

    return dict(_runtime().storage_episode_projection_rebuild_typed(str(runtime_dir)))


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


export_jsonl = StorageTransfer.export_jsonl
export_bundle_json = StorageTransfer.export_bundle_json
build_export_bundle = StorageTransfer.build_export_bundle
import_bundle = StorageTransfer.import_bundle


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
