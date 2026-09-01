# SPDX-License-Identifier: Apache-2.0

"""Backend, integrity, and projection operations for the storage facade."""

from pathlib import Path
from typing import Any

from kungfu.storage.transfer import _binding_json, _u64


PAYLOAD_STATE_PRESENT = "present"
PAYLOAD_STATES = ("present", "redacted", "absent", "missing")
CONTENT_TYPE_JSON = "application/json"
SOURCE_REGISTRY_SCHEMA = "kungfu.storage.source-registry/v1"
MANIFEST_CATALOG_SCHEMA = "kungfu.storage.manifest-catalog/v1"
PROJECTION_SOURCE_REGISTRY = "source-registry-sqlite"
PROJECTION_MANIFEST_CATALOG = "manifest-catalog-sqlite"
PROJECTION_ATLAS_JOURNAL_FOLD = "atlas-journal-fold"
RUNTIME_STORAGE_SERVICE_SCHEMA = "kungfu.runtime.storage-service/v1"


def _runtime_adapter() -> Any:
    """Resolve the public runtime seam at call time, avoiding import cycles."""

    from kungfu.storage import service

    return service._runtime()


_runtime = _runtime_adapter


def root_dir(runtime_dir: str | Path) -> Path:
    return Path(runtime_dir) / "storage"


def payload_path(runtime_dir: str | Path, digest: str) -> Path:
    # KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5: payload bodies are opaque content-addressed bytes named by the
    # content hash alone (no format-implying extension). Must match the C++
    # runtime storage service payload_path.
    return root_dir(runtime_dir) / "payloads" / digest[:2] / digest


def verify_import_manifest(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        dict(issue) for issue in _runtime().verify_storage_import_manifest(manifest)
    ]


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
