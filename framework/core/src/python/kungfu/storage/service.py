# SPDX-License-Identifier: Apache-2.0

import json
import tempfile
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


def _runtime():
    return kungfu.__binding__.runtime


def root_dir(runtime_dir: str | Path) -> Path:
    return Path(runtime_dir) / "storage"


def registry_path(runtime_dir: str | Path) -> Path:
    return root_dir(runtime_dir) / "sources.json"


def payload_path(runtime_dir: str | Path, digest: str) -> Path:
    return root_dir(runtime_dir) / "payloads" / digest[:2] / f"{digest}.json"


def _payload_root(runtime_dir: str | Path) -> Path:
    return root_dir(runtime_dir) / "payloads"


def write_payload_bytes(runtime_dir: str | Path, digest: str, raw: bytes) -> Path:
    path = payload_path(runtime_dir, digest)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return path


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
    generic = build_import_manifest(manifest)
    issues = verify_import_manifest(generic)
    if any(issue.get("severity") == "error" for issue in issues):
        raise ValueError(f"storage_manifest_invalid: {issues}")
    source_id = str(generic["source_id"])
    manifest_id = str(generic["manifest_id"])
    _write_json(manifest_path(runtime_dir, source_id, manifest_id), generic)
    _write_json(latest_manifest_path(runtime_dir, source_id), generic)

    registry = load_registry(runtime_dir)
    registry["sources"][source_id] = generic["source"]
    save_registry(runtime_dir, registry)
    return generic


def load_latest_manifest(
    runtime_dir: str | Path, source_id: str
) -> dict[str, Any] | None:
    path = latest_manifest_path(runtime_dir, source_id)
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
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
    registry = load_registry(runtime_dir)
    return sorted(
        registry["sources"].values(),
        key=lambda source: str(source.get("source_id") or ""),
    )


def status(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
) -> dict[str, Any]:
    sources = [
        source
        for source in list_sources(runtime_dir)
        if source_id is None or source.get("source_id") == source_id
    ]
    source_status = [_source_manifest_status(runtime_dir, source) for source in sources]
    return {
        "ok": bool(sources) if source_id else True,
        "scope": "source" if source_id else "all",
        "source_id": source_id,
        "sources": sources,
        "source_count": len(sources),
        "projection": {
            "name": PROJECTION_SOURCE_REGISTRY,
            "path": str(registry_path(runtime_dir)),
            "rebuildable": True,
        },
        "source_status": source_status,
    }


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
) -> dict[str, Any]:
    try:
        registry = load_registry(runtime_dir)
    except (OSError, json.JSONDecodeError, ValueError) as e:
        return {
            "ok": False,
            "scope": "source" if source_id else "all",
            "source_id": source_id,
            "errors": [{"code": "source_registry_invalid", "error": str(e)}],
            "warnings": [],
            "checked": {
                "sources": 0,
                "manifests": 0,
                "payloads": 0,
                "schemas": 0,
                "accepted_ranges": 0,
                "source_records": 0,
                "projection_indexes": 0,
                "orphan_payloads": 0,
            },
        }
    sources = sorted(
        registry["sources"].values(),
        key=lambda source: str(source.get("source_id") or ""),
    )
    if source_id:
        sources = [source for source in sources if source.get("source_id") == source_id]
    report: dict[str, Any] = {
        "ok": True,
        "scope": "source" if source_id else "all",
        "source_id": source_id,
        "errors": [],
        "warnings": [],
        "checked": {
            "sources": len(sources),
            "manifests": 0,
            "payloads": 0,
            "schemas": 0,
            "accepted_ranges": 0,
            "source_records": 0,
            "projection_indexes": 1,
            "orphan_payloads": 0,
        },
    }
    if source_id and not sources:
        report["ok"] = False
        report["errors"].append({"code": "source_missing", "source_id": source_id})
        return report
    for source in sources:
        current_source_id = str(source.get("source_id") or "")
        manifest = load_latest_manifest(runtime_dir, current_source_id)
        if manifest is None:
            report["ok"] = False
            report["errors"].append(
                {"code": "manifest_missing", "source_id": current_source_id}
            )
            continue
        report["checked"]["manifests"] += 1
        report["checked"]["source_records"] += 1
        projected_source = _source_projection_from_manifest(manifest)
        if projected_source != source:
            report["ok"] = False
            report["errors"].append(
                {
                    "code": "source_registry_drift",
                    "source_id": current_source_id,
                    "expected": projected_source,
                    "actual": source,
                }
            )
        for issue in verify_import_manifest(manifest):
            row = dict(issue)
            row["source_id"] = current_source_id
            if row.get("severity") == "warning":
                report["warnings"].append(row)
            else:
                report["ok"] = False
                report["errors"].append(row)
        report["checked"]["accepted_ranges"] += len(manifest.get("accepted_ranges", []))
        report["checked"]["schemas"] += len(
            manifest.get("schema_inventory", {}).get("entries", [])
        )
        payload_inventory = manifest.get("payload_inventory", {})
        if isinstance(payload_inventory, dict):
            inventory_count = len(payload_inventory.get("entries", []))
            entry_count = len(_entries_for_manifest(manifest))
            if inventory_count != entry_count:
                report["ok"] = False
                report["errors"].append(
                    {
                        "code": "payload_inventory_mismatch",
                        "source_id": current_source_id,
                        "expected": entry_count,
                        "actual": inventory_count,
                    }
                )
        for entry in _entries_for_manifest(manifest):
            report["checked"]["payloads"] += 1
            if entry.get("payload_state") != PAYLOAD_STATE_PRESENT:
                report["warnings"].append(
                    {
                        "code": "payload_not_present",
                        "source_id": current_source_id,
                        "subject": f"{entry.get('kind')}:{entry.get('source_id')}",
                        "state": entry.get("payload_state"),
                    }
                )
                continue
            _, error = _load_payload(runtime_dir, entry)
            if error:
                report["ok"] = False
                report["errors"].append(
                    {
                        "code": error,
                        "source_id": current_source_id,
                        "kind": entry.get("kind"),
                        "entry_source_id": entry.get("source_id"),
                        "payload_hash": entry.get("payload_hash"),
                    }
                )
    if source_id is None:
        referenced = _referenced_payload_hashes(runtime_dir)
        for path in _all_payload_paths(runtime_dir):
            if _payload_digest_from_path(path) not in referenced:
                report["checked"]["orphan_payloads"] += 1
                report["warnings"].append(
                    {
                        "code": "orphan_payload",
                        "path": str(path),
                        "payload_hash": _payload_digest_from_path(path),
                    }
                )
    return report


def rebuild_index(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Rebuild the source registry projection from accepted manifests."""

    try:
        old_registry = load_registry(runtime_dir)
    except (OSError, json.JSONDecodeError, ValueError):
        old_registry = {"schema": SOURCE_REGISTRY_SCHEMA, "sources": {}}

    old_sources = old_registry.get("sources", {})
    old_sources = old_sources if isinstance(old_sources, dict) else {}
    if source_id:
        new_sources = dict(old_sources)
    else:
        new_sources = {}

    changes = []
    errors = []
    rebuilt = 0
    for path in _latest_manifest_paths(runtime_dir, source_id):
        try:
            manifest = _read_json(path)
        except (OSError, json.JSONDecodeError) as e:
            errors.append(
                {"code": "manifest_read_error", "path": str(path), "error": str(e)}
            )
            continue
        if not manifest:
            errors.append({"code": "manifest_invalid", "path": str(path)})
            continue
        current_source_id = str(manifest.get("source_id") or "")
        if not current_source_id:
            errors.append({"code": "source_id_missing", "path": str(path)})
            continue
        projected = _source_projection_from_manifest(manifest)
        previous = old_sources.get(current_source_id)
        if previous != projected:
            changes.append(
                {
                    "source_id": current_source_id,
                    "action": "update" if previous is not None else "add",
                    "manifest_id": manifest.get("manifest_id"),
                }
            )
        new_sources[current_source_id] = projected
        rebuilt += 1

    if source_id and rebuilt == 0:
        errors.append({"code": "source_manifest_missing", "source_id": source_id})

    new_registry = {"schema": SOURCE_REGISTRY_SCHEMA, "sources": new_sources}
    would_write = old_registry != new_registry
    if would_write and not dry_run:
        save_registry(runtime_dir, new_registry)

    return {
        "ok": not errors,
        "scope": "source" if source_id else "all",
        "source_id": source_id,
        "projection": {
            "name": PROJECTION_SOURCE_REGISTRY,
            "path": str(registry_path(runtime_dir)),
            "rebuilt_from": "accepted latest manifests",
        },
        "dry_run": dry_run,
        "would_write": would_write,
        "written": would_write and not dry_run,
        "sources_rebuilt": rebuilt,
        "changes": changes,
        "errors": errors,
        "unsupported": [
            {
                "name": PROJECTION_SQLITE,
                "reason": "no generic SQLite projection exists in this storage slice",
            }
        ],
    }


def gc_plan(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    if not dry_run:
        raise ValueError("storage_gc_requires_dry_run")
    referenced = _referenced_payload_hashes(runtime_dir, source_id)
    payloads = _all_payload_paths(runtime_dir)
    candidates = []
    for path in payloads:
        digest = _payload_digest_from_path(path)
        if digest in referenced:
            continue
        candidates.append(
            {
                "payload_hash": digest,
                "path": str(path),
                "bytes": path.stat().st_size,
                "safe_to_delete": source_id is None,
            }
        )
    return {
        "ok": True,
        "scope": "source" if source_id else "all",
        "source_id": source_id,
        "dry_run": True,
        "payloads_scanned": len(payloads),
        "referenced_payloads": len(referenced),
        "candidate_count": len(candidates),
        "candidate_bytes": sum(row["bytes"] for row in candidates),
        "candidates": candidates,
        "notes": [
            "No payloads were deleted.",
            (
                "Source scope candidates are not globally safe to delete because "
                "the interim payload store is shared."
            )
            if source_id
            else "All-scope candidates are unreferenced by retained storage manifests.",
        ],
    }


def compact_plan(
    runtime_dir: str | Path,
    *,
    source_id: str | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    if not dry_run:
        raise ValueError("storage_compact_requires_dry_run")
    rebuild = rebuild_index(runtime_dir, source_id=source_id, dry_run=True)
    garbage = gc_plan(runtime_dir, source_id=source_id, dry_run=True)
    manifests = []
    for path in _manifest_paths(runtime_dir, source_id):
        try:
            manifest = _read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if manifest:
            manifests.append(
                {
                    "source_id": manifest.get("source_id"),
                    "manifest_id": manifest.get("manifest_id"),
                    "path": str(path),
                    "entries": len(_entries_for_manifest(manifest)),
                    "sync_root": manifest.get("sync_root"),
                }
            )
    return {
        "ok": rebuild["ok"] and garbage["ok"],
        "scope": "source" if source_id else "all",
        "source_id": source_id,
        "dry_run": True,
        "retained_manifests": manifests,
        "rebuild_index": rebuild,
        "gc": garbage,
        "unsupported": [
            {
                "name": "history-archive",
                "reason": "archive bundles are not implemented in this slice",
            },
            {
                "name": PROJECTION_SQLITE,
                "reason": "no generic SQLite projection exists in this storage slice",
            },
            {
                "name": "backend-compact",
                "reason": "the interim backend is content-addressed files",
            },
        ],
        "notes": [
            "No manifests, payloads, journal frames, or projections were rewritten.",
            "This is a reviewable compaction plan, not destructive compaction.",
        ],
    }


def verify_local_sync(
    runtime_dir: str | Path,
    *,
    source_id: str,
) -> dict[str, Any]:
    source_report = fsck(runtime_dir, source_id=source_id)
    if not source_report["ok"]:
        return {
            "ok": False,
            "scope": "source",
            "source_id": source_id,
            "errors": [{"code": "source_fsck_failed", "fsck": source_report}],
        }
    bundle = build_export_bundle(runtime_dir, source_id=source_id)
    with tempfile.TemporaryDirectory(prefix="kungfu-storage-sync-") as temp_dir:
        import_result = import_bundle(temp_dir, bundle)
        imported_report = fsck(temp_dir, source_id=source_id)
        imported_manifest = load_latest_manifest(temp_dir, source_id)
    local_manifest = load_latest_manifest(runtime_dir, source_id)
    local_root = local_manifest.get("sync_root") if local_manifest else None
    imported_root = imported_manifest.get("sync_root") if imported_manifest else None
    roots_match = local_root == imported_root
    return {
        "ok": imported_report["ok"] and roots_match,
        "scope": "source",
        "source_id": source_id,
        "exported_records": len(bundle.get("records", [])),
        "import": import_result,
        "local_sync_root": local_root,
        "imported_sync_root": imported_root,
        "sync_roots_match": roots_match,
        "source_fsck": source_report,
        "imported_fsck": imported_report,
    }


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
    manifest = load_latest_manifest(runtime_dir, source_id)
    if manifest is None:
        raise FileNotFoundError(str(latest_manifest_path(runtime_dir, source_id)))
    records = []
    for entry in _entries_for_manifest(manifest, range_filter):
        payload, error = _load_payload(runtime_dir, entry)
        if error:
            raise ValueError(f"{error}: {entry.get('kind')}:{entry.get('source_id')}")
        row = dict(entry)
        row["scope"] = manifest.get("scope")
        row["manifest_id"] = manifest.get("manifest_id")
        row["storage_source_id"] = source_id
        row["source_type"] = manifest.get("source_type")
        row["source_head"] = manifest.get("source_head")
        row["payload"] = payload
        records.append(row)
    records.sort(
        key=lambda row: (
            str(row.get("kind") or ""),
            str(row.get("source_id") or ""),
            str(row.get("source_path") or ""),
        )
    )
    return records


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
    source_id: str,
    range_filter: dict[str, Any] | None = None,
) -> dict[str, Any]:
    bundle = build_export_bundle(
        runtime_dir, source_id=source_id, range_filter=range_filter
    )
    _write_json(Path(out_path), bundle)
    return {
        "ok": True,
        "scope": "source",
        "source_id": source_id,
        "range": range_filter,
        "sync_root": bundle.get("manifest", {}).get("sync_root"),
        "format": "bundle-json",
        "out": str(Path(out_path).resolve()),
        "records": len(bundle.get("records", [])),
    }


def build_export_bundle(
    runtime_dir: str | Path,
    *,
    source_id: str,
    range_filter: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifest = load_latest_manifest(runtime_dir, source_id)
    if manifest is None:
        raise FileNotFoundError(str(latest_manifest_path(runtime_dir, source_id)))
    export_manifest = manifest
    if range_filter:
        export_manifest = build_import_manifest(
            {
                "manifest_id": manifest.get("manifest_id"),
                "storage_source_id": manifest.get("source_id"),
                "source_type": manifest.get("source_type"),
                "source_coordinate": manifest.get("source", {}).get("coordinate"),
                "source_head": manifest.get("source_head"),
                "scope": manifest.get("scope"),
                "range": range_filter,
                "counts": {
                    "records": len(_entries_for_manifest(manifest, range_filter))
                },
                "entries": _entries_for_manifest(manifest, range_filter),
            }
        )
    records = export_records(
        runtime_dir, source_id=source_id, range_filter=range_filter
    )
    return dict(_runtime().build_storage_export_bundle(export_manifest, records))


def import_bundle(
    runtime_dir: str | Path,
    bundle: dict[str, Any],
    *,
    verify: bool = True,
) -> dict[str, Any]:
    manifest = bundle.get("manifest")
    if not isinstance(manifest, dict):
        raise ValueError("bundle_manifest_missing")
    records = bundle.get("records", [])
    if not isinstance(records, list):
        raise ValueError("bundle_records_invalid")
    if verify:
        issues = verify_import_manifest(manifest)
        if any(issue.get("severity") == "error" for issue in issues):
            raise ValueError(f"bundle_manifest_invalid: {issues}")
    for record in records:
        if not isinstance(record, dict) or "payload" not in record:
            continue
        raw = canonical_json_bytes(record["payload"])
        digest = str(record.get("payload_hash") or payload_hash(raw))
        write_payload_bytes(runtime_dir, digest, raw)
    accepted = accept_manifest(runtime_dir, manifest)
    return {
        "ok": True,
        "scope": "source",
        "source_id": accepted.get("source_id"),
        "manifest_id": accepted.get("manifest_id"),
        "records": len(records),
    }


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
        path = payload_path(runtime_dir, digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
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
                "payload_state": PAYLOAD_STATE_PRESENT,
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
