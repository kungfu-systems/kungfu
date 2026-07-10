# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path
from typing import Any

import kungfu

from kungfu.action_envelope import canonical_json_bytes, payload_hash
from kungfu.content_hash import CONTENT_HASH_ALGORITHM_SHA256

PAYLOAD_STATE_PRESENT = "present"
CONTENT_TYPE_JSON = "application/json"
SOURCE_REGISTRY_SCHEMA = "kungfu.storage.source-registry/v1"
PROJECTION_SOURCE_REGISTRY = "source-registry"
PROJECTION_SQLITE = "sqlite"
PROJECTION_ATLAS_JOURNAL_FOLD = "atlas-journal-fold"
RUNTIME_STORAGE_SERVICE_SCHEMA = "kungfu.runtime.storage-service/v1"


def _runtime():
    return kungfu.__binding__.runtime


def _u64(value: int | None) -> str:
    return str(value or 0)


def _binding_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _binding_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_binding_json(item) for item in value]
    if isinstance(value, int) and not isinstance(value, bool) and value > 2**63 - 1:
        return str(value)
    return value


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


def registry_path(runtime_dir: str | Path) -> Path:
    return root_dir(runtime_dir) / "sources.json"


def payload_path(runtime_dir: str | Path, digest: str) -> Path:
    # ADR-0037: payload bodies are opaque content-addressed bytes named by the
    # content hash alone (no format-implying extension). Must match the C++
    # runtime storage service payload_path.
    return root_dir(runtime_dir) / "payloads" / digest[:2] / digest


def _payload_root(runtime_dir: str | Path) -> Path:
    return root_dir(runtime_dir) / "payloads"


def write_payload_bytes(runtime_dir: str | Path, digest: str, raw: bytes) -> str:
    return str(_runtime().write_storage_payload_bytes(str(runtime_dir), digest, raw))


def source_manifest_dir(runtime_dir: str | Path, source_id: str) -> Path:
    return root_dir(runtime_dir) / "sources" / source_id / "manifests"


def latest_manifest_path(runtime_dir: str | Path, source_id: str) -> Path:
    return source_manifest_dir(runtime_dir, source_id) / "latest.json"


def manifest_path(runtime_dir: str | Path, source_id: str, manifest_id: str) -> Path:
    return source_manifest_dir(runtime_dir, source_id) / f"{manifest_id}.json"


def _read_json(path: Path) -> dict[str, Any] | None:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else None


def _manifest_paths(
    runtime_dir: str | Path, source_id: str | None = None
) -> list[Path]:
    base = root_dir(runtime_dir) / "sources"
    if source_id:
        roots = [base / source_id / "manifests"]
    else:
        roots = (
            sorted(path / "manifests" for path in base.iterdir())
            if base.exists()
            else []
        )
    paths: list[Path] = []
    for manifest_dir in roots:
        if manifest_dir.exists():
            paths.extend(sorted(manifest_dir.glob("*.json")))
    return paths


def _latest_manifest_paths(
    runtime_dir: str | Path, source_id: str | None = None
) -> list[Path]:
    base = root_dir(runtime_dir) / "sources"
    if source_id:
        paths = [base / source_id / "manifests" / "latest.json"]
    else:
        paths = sorted(base.glob("*/manifests/latest.json")) if base.exists() else []
    return [path for path in paths if path.exists()]


def _all_payload_paths(runtime_dir: str | Path) -> list[Path]:
    payload_root = _payload_root(runtime_dir)
    if not payload_root.exists():
        return []
    return sorted(path for path in payload_root.glob("*/*.json") if path.is_file())


def _payload_digest_from_path(path: Path) -> str:
    return path.stem


def load_registry(runtime_dir: str | Path) -> dict[str, Any]:
    path = registry_path(runtime_dir)
    if not path.exists():
        return {"schema": SOURCE_REGISTRY_SCHEMA, "sources": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("sources"), dict):
        raise ValueError(f"invalid storage source registry: {path}")
    data.setdefault("schema", SOURCE_REGISTRY_SCHEMA)
    return data


def save_registry(runtime_dir: str | Path, registry: dict[str, Any]) -> None:
    path = registry_path(runtime_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(registry, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def build_source_record(input_record: dict[str, Any]) -> dict[str, Any]:
    return dict(_runtime().build_storage_source_record(input_record))


def build_import_manifest(input_manifest: dict[str, Any]) -> dict[str, Any]:
    return dict(_runtime().build_storage_import_manifest(input_manifest))


def verify_import_manifest(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        dict(issue) for issue in _runtime().verify_storage_import_manifest(manifest)
    ]


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def accept_manifest(
    runtime_dir: str | Path, manifest: dict[str, Any]
) -> dict[str, Any]:
    return dict(_runtime().accept_storage_manifest(str(runtime_dir), manifest))


def load_latest_manifest(
    runtime_dir: str | Path, source_id: str
) -> dict[str, Any] | None:
    data = _runtime().load_storage_latest_manifest(str(runtime_dir), source_id)
    if data is None:
        return None
    return data if isinstance(data, dict) else None


def _referenced_payload_hashes(
    runtime_dir: str | Path, source_id: str | None = None
) -> set[str]:
    hashes: set[str] = set()
    seen_manifests: set[tuple[str, str]] = set()
    for path in _manifest_paths(runtime_dir, source_id):
        try:
            manifest = _read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if not manifest:
            continue
        key = (
            str(manifest.get("source_id") or ""),
            str(manifest.get("manifest_id") or path.name),
        )
        if key in seen_manifests:
            continue
        seen_manifests.add(key)
        for entry in _entries_for_manifest(manifest):
            digest = str(entry.get("payload_hash") or "")
            if digest:
                hashes.add(digest)
    return hashes


def _source_projection_from_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    source = manifest.get("source")
    if isinstance(source, dict):
        return source
    return build_source_record(
        {
            "source_id": manifest.get("source_id"),
            "source_type": manifest.get("source_type"),
            "source_head": manifest.get("source_head"),
            "range": manifest.get("range"),
            "manifest_id": manifest.get("manifest_id"),
            "sync_root": manifest.get("sync_root"),
            "accepted_ranges": manifest.get("accepted_ranges", []),
        }
    )


def _accepted_cursor(manifest: dict[str, Any]) -> dict[str, Any]:
    accepted_ranges = manifest.get("accepted_ranges", [])
    last_range = accepted_ranges[-1] if accepted_ranges else {}
    last_range = last_range if isinstance(last_range, dict) else {}
    return {
        "schema": "kungfu.storage.channel-cursor/v1",
        "source_id": manifest.get("source_id"),
        "manifest_id": manifest.get("manifest_id"),
        "source_head": manifest.get("source_head") or last_range.get("source_head"),
        "range": manifest.get("range") or last_range.get("range") or {},
        "sync_root": manifest.get("sync_root") or last_range.get("sync_root"),
        "entry_count": len(_entries_for_manifest(manifest)),
    }


def _source_manifest_status(
    runtime_dir: str | Path, source: dict[str, Any]
) -> dict[str, Any]:
    source_id = str(source.get("source_id") or "")
    manifest = load_latest_manifest(runtime_dir, source_id)
    if manifest is None:
        return {
            "source_id": source_id,
            "ok": False,
            "projection": PROJECTION_SOURCE_REGISTRY,
            "reason": "manifest_missing",
            "source": source,
        }
    entries = _entries_for_manifest(manifest)
    payload_inventory = manifest.get("payload_inventory", {})
    schema_inventory = manifest.get("schema_inventory", {})
    return {
        "source_id": source_id,
        "ok": True,
        "projection": PROJECTION_SOURCE_REGISTRY,
        "manifest_id": manifest.get("manifest_id"),
        "source_type": manifest.get("source_type"),
        "source_head": manifest.get("source_head"),
        "accepted_ranges": manifest.get("accepted_ranges", []),
        "accepted_cursor": _accepted_cursor(manifest),
        "sync_root": manifest.get("sync_root"),
        "entries": len(entries),
        "payload_inventory": len(payload_inventory.get("entries", []))
        if isinstance(payload_inventory, dict)
        else 0,
        "schema_inventory": len(schema_inventory.get("entries", []))
        if isinstance(schema_inventory, dict)
        else 0,
        "source_record": source,
    }


def list_sources(runtime_dir: str | Path) -> list[dict[str, Any]]:
    return list(status(runtime_dir).get("sources", []))


def status(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "status",
            str(runtime_dir),
            {
                "scope": "source" if source_id else "all",
                "source_id": source_id,
            },
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
        _runtime().run_storage_service_operation(
            "layout",
            str(runtime_dir),
            {
                "scope": "all",
                "runtime_home": str(runtime_home) if runtime_home is not None else None,
                "config_home": str(config_home) if config_home is not None else None,
                "provider": provider,
            },
        )
    )


def _entries_for_manifest(
    manifest: dict[str, Any], range_filter: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    entries = manifest.get("entries", [])
    if range_filter:
        entries = _runtime().filter_storage_manifest_entries(entries, range_filter)
    return [dict(entry) for entry in entries if isinstance(entry, dict)]


def _load_payload(
    runtime_dir: str | Path, entry: dict[str, Any]
) -> tuple[Any, str | None]:
    digest = str(entry.get("payload_hash") or "")
    path = payload_path(runtime_dir, digest)
    if not path.exists():
        return None, "payload_missing"
    raw = path.read_bytes()
    expected_len = entry.get("byte_len")
    if not isinstance(expected_len, int) or expected_len < 0:
        return None, "byte_len_mismatch"
    try:
        error = _runtime().verify_storage_payload(
            raw,
            digest,
            expected_len,
            CONTENT_HASH_ALGORITHM_SHA256,
        )
    except ValueError:
        return None, "hash_mismatch"
    if error:
        return None, str(error)
    try:
        return json.loads(raw.decode("utf-8")), None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "payload_decode_error"


def fsck(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    episode_id: int | None = None,
) -> dict[str, Any]:
    scope = "episode" if episode_id else ("source" if source_id else "all")
    return dict(
        _runtime().run_storage_service_operation(
            "fsck",
            str(runtime_dir),
            {
                "scope": scope,
                "source_id": source_id,
                "episode_id": _u64(episode_id),
            },
        )
    )


def repair_plan(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    episode_id: int | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    scope = "episode" if episode_id else ("source" if source_id else "all")
    return dict(
        _runtime().run_storage_service_operation(
            "repair_plan",
            str(runtime_dir),
            {
                "scope": scope,
                "source_id": source_id,
                "episode_id": _u64(episode_id),
                "dry_run": dry_run,
            },
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


def rebuild_index(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Rebuild the source registry projection from accepted manifests."""

    return dict(
        _runtime().run_storage_service_operation(
            "rebuild_index",
            str(runtime_dir),
            {
                "scope": "source" if source_id else "all",
                "source_id": source_id,
                "dry_run": dry_run,
            },
        )
    )


def gc_plan(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "gc_plan",
            str(runtime_dir),
            {
                "scope": "source" if source_id else "all",
                "source_id": source_id,
                "dry_run": dry_run,
            },
        )
    )


def compact_plan(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "compact_plan",
            str(runtime_dir),
            {
                "scope": "source" if source_id else "all",
                "source_id": source_id,
                "dry_run": dry_run,
            },
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
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "episode_begin",
            str(runtime_dir),
            {
                "episode_id": _u64(episode_id),
                "parent_episode_id": _u64(parent_episode_id),
                "root_trigger_frame_uid": _u64(root_trigger_frame_uid),
                "location_uid": location_uid,
                "begin_time": begin_time,
                "title": title,
                "actor": actor,
                "source": source,
            },
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
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "episode_heartbeat",
            str(runtime_dir),
            {
                "episode_id": _u64(episode_id),
                "location_uid": location_uid,
                "update_time": update_time,
                "last_frame_uid": _u64(last_frame_uid),
                "frame_count": _u64(frame_count),
                "note": note,
            },
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
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "episode_attach_frame",
            str(runtime_dir),
            {
                "episode_id": _u64(episode_id),
                "location_uid": location_uid,
                "frame_uid": _u64(frame_uid),
                "trigger_frame_uid": _u64(trigger_frame_uid),
                "stream_id": _u64(stream_id),
                "gen_time": gen_time,
                "trigger_time": trigger_time,
                "carrier_type": carrier_type,
                "source": source,
                "dest": dest,
                "data_length": data_length,
                "integrity_version": integrity_version,
                "payload_checksum": _u64(payload_checksum),
                "frame_checksum": _u64(frame_checksum),
            },
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
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "episode_attach_ref",
            str(runtime_dir),
            {
                "episode_id": _u64(episode_id),
                "location_uid": location_uid,
                "ref_kind": ref_kind,
                "ref_uid": _u64(ref_uid),
                "ref_id": ref_id,
                "ref_hash": ref_hash,
                "update_time": update_time,
            },
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
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "episode_end",
            str(runtime_dir),
            {
                "episode_id": _u64(episode_id),
                "location_uid": location_uid,
                "end_time": end_time,
                "last_frame_uid": _u64(last_frame_uid),
                "frame_count": _u64(frame_count),
                "reason": reason,
            },
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
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "episode_abort",
            str(runtime_dir),
            {
                "episode_id": _u64(episode_id),
                "location_uid": location_uid,
                "end_time": end_time,
                "last_frame_uid": _u64(last_frame_uid),
                "frame_count": _u64(frame_count),
                "reason": reason,
            },
        )
    )


def episode_list(
    runtime_dir: str | Path,
    *,
    location_uid: int = 0,
    limit: int = 100,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "episode_list",
            str(runtime_dir),
            {"location_uid": location_uid, "limit": limit},
        )
    )


def episode_inspect(runtime_dir: str | Path, *, episode_id: int) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "episode_inspect",
            str(runtime_dir),
            {"episode_id": _u64(episode_id)},
        )
    )


def episode_recover(
    runtime_dir: str | Path,
    *,
    episode_id: int = 0,
    location_uid: int = 0,
    end_time: int = 0,
    reason: str = "",
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "episode_recover",
            str(runtime_dir),
            {
                "episode_id": _u64(episode_id),
                "location_uid": location_uid,
                "end_time": end_time,
                "reason": reason,
            },
        )
    )


def write_jsonl(records: list[dict[str, Any]], out_path: str | Path) -> None:
    with open(out_path, "w", encoding="utf-8") as f:
        for record in records:
            f.write(
                json.dumps(
                    record, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                )
                + "\n"
            )


def export_records(
    runtime_dir: str | Path,
    *,
    source_id: str,
    range_filter: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in _runtime().export_storage_records(
            str(runtime_dir),
            source_id,
            range_filter or {},
        )
    ]


def export_jsonl(
    runtime_dir: str | Path,
    out_path: str | Path,
    *,
    source_id: str,
    range_filter: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifest = load_latest_manifest(runtime_dir, source_id)
    if manifest is None:
        raise FileNotFoundError(str(latest_manifest_path(runtime_dir, source_id)))
    records = export_records(
        runtime_dir, source_id=source_id, range_filter=range_filter
    )
    write_jsonl(records, out_path)
    return {
        "ok": True,
        "scope": "source",
        "source_id": source_id,
        "range": range_filter,
        "sync_root": manifest.get("sync_root"),
        "format": "jsonl",
        "out": str(Path(out_path).resolve()),
        "records": len(records),
    }


def export_bundle_json(
    runtime_dir: str | Path,
    out_path: str | Path,
    *,
    source_id: str | None = None,
    episode_id: int | None = None,
    range_filter: dict[str, Any] | None = None,
) -> dict[str, Any]:
    bundle = build_export_bundle(
        runtime_dir,
        source_id=source_id,
        episode_id=episode_id,
        range_filter=range_filter,
    )
    _write_json(Path(out_path), bundle)
    scope = "episode" if episode_id else "source"
    return {
        "ok": True,
        "scope": scope,
        "source_id": source_id,
        "episode_id": episode_id,
        "range": range_filter,
        "sync_root": bundle.get("manifest", {}).get("sync_root"),
        "format": "bundle-json",
        "out": str(Path(out_path).resolve()),
        "records": len(bundle.get("records", [])),
    }


def build_export_bundle(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    episode_id: int | None = None,
    range_filter: dict[str, Any] | None = None,
) -> dict[str, Any]:
    scope = "episode" if episode_id else "source"
    return dict(
        _runtime().run_storage_service_operation(
            "export_bundle",
            str(runtime_dir),
            {
                "scope": scope,
                "source_id": source_id,
                "episode_id": _u64(episode_id),
                "range": range_filter or {},
            },
        )
    )


def import_bundle(
    runtime_dir: str | Path,
    bundle: dict[str, Any],
    *,
    verify: bool = True,
) -> dict[str, Any]:
    source_id = str(bundle.get("source_id") or "")
    scope = (
        "episode"
        if bundle.get("schema") == "kungfu.storage.episode-bundle/v1"
        else "source"
    )
    return dict(
        _runtime().run_storage_service_operation(
            "import_bundle",
            str(runtime_dir),
            {
                "scope": scope if source_id or scope == "episode" else "all",
                "source_id": source_id or None,
                "episode_id": _u64(bundle.get("episode_id")),
                "verify": verify,
                "bundle": _binding_json(bundle),
            },
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
    entries = []
    for index, record in enumerate(records):
        payload = record.get("payload", record)
        raw = canonical_json_bytes(payload)
        digest = payload_hash(raw)
        write_payload_bytes(runtime_dir, digest, raw)
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
                "byte_len": len(raw),
                "payload_state": str(
                    record.get("payload_state") or PAYLOAD_STATE_PRESENT
                ),
            }
        )
    manifest = build_import_manifest(
        {
            "manifest_id": manifest_id,
            "storage_source_id": source_id,
            "source_type": "synthetic",
            "source_coordinate": f"synthetic:{source_id}",
            "source_head": source_head,
            "scope": "source",
            "range": range_filter,
            "counts": {"records": len(entries)},
            "entries": entries,
        }
    )
    return accept_manifest(runtime_dir, manifest)
