# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path
from typing import Any

import kungfu

from kungfu.action_envelope import canonical_json_bytes, payload_hash
from kungfu.content_hash import CONTENT_HASH_ALGORITHM_SHA256

PAYLOAD_STATE_PRESENT = "present"
CONTENT_TYPE_JSON = "application/json"


def _runtime():
    return kungfu.__binding__.runtime


def root_dir(runtime_dir: str | Path) -> Path:
    return Path(runtime_dir) / "storage"


def registry_path(runtime_dir: str | Path) -> Path:
    return root_dir(runtime_dir) / "sources.json"


def payload_path(runtime_dir: str | Path, digest: str) -> Path:
    return root_dir(runtime_dir) / "payloads" / digest[:2] / f"{digest}.json"


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


def load_registry(runtime_dir: str | Path) -> dict[str, Any]:
    path = registry_path(runtime_dir)
    if not path.exists():
        return {"schema": "kungfu.storage.source-registry/v1", "sources": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("sources"), dict):
        raise ValueError(f"invalid storage source registry: {path}")
    data.setdefault("schema", "kungfu.storage.source-registry/v1")
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
    return {
        "ok": bool(sources) if source_id else True,
        "scope": "source" if source_id else "all",
        "source_id": source_id,
        "sources": sources,
        "source_count": len(sources),
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
    sources = list_sources(runtime_dir)
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
    return report


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
