# SPDX-License-Identifier: Apache-2.0

import hashlib
import json
from pathlib import Path
from typing import Any

CONTENT_TYPE_JSON = "application/json"
PAYLOAD_STATE_PRESENT = "present"


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def payload_hash(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def payload_path(store_dir: str | Path, digest: str) -> Path:
    root = Path(store_dir) / "payloads" / digest[:2]
    return root / f"{digest}.json"


def latest_manifest_path(store_dir: str | Path) -> Path:
    return Path(store_dir) / "imports" / "latest.json"


def import_manifest_path(store_dir: str | Path, import_id: str) -> Path:
    return Path(store_dir) / "imports" / f"{import_id}.json"


def _source_payload(record: dict[str, Any]) -> dict[str, Any]:
    payload = record.get("payload")
    return payload if isinstance(payload, dict) else {}


def enrich_source_records(source_records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    enriched = []
    for record in source_records:
        raw = canonical_json_bytes(_source_payload(record))
        digest = payload_hash(raw)
        row = {
            "kind": record.get("kind"),
            "source_id": record.get("source_id"),
            "source_path": record.get("source_path"),
            "source_time": record.get("source_time"),
            "schema_version": record.get("schema_version"),
            "content_type": CONTENT_TYPE_JSON,
            "payload_hash": digest,
            "byte_len": len(raw),
            "payload_state": PAYLOAD_STATE_PRESENT,
            "payload": _source_payload(record),
        }
        enriched.append(row)
    return enriched


def _serialize_range(range_filter: dict[str, Any] | None) -> dict[str, Any] | None:
    if not range_filter:
        return None
    result = {}
    for key in ("since", "until", "cursor"):
        value = range_filter.get(key)
        if value not in (None, ""):
            result[key] = str(value)
    return result or None


def _matches_range(entry: dict[str, Any], range_filter: dict[str, Any] | None) -> bool:
    if not range_filter:
        return True
    from kungfu.atlas.importer import parse_timestamp

    since = parse_timestamp(range_filter.get("since"))
    until = parse_timestamp(range_filter.get("until"))
    if since is None and until is None:
        return True
    stamp = parse_timestamp(entry.get("source_time"))
    if stamp is None:
        return False
    if since is not None and stamp < since:
        return False
    if until is not None and stamp > until:
        return False
    return True


def write_import_payloads(
    store_dir: str | Path,
    *,
    import_id: str,
    repo_root: str,
    repo_head: str | None,
    source_records: list[dict[str, Any]],
    counts: dict[str, int],
    storage_source_id: str = "atlas",
    source_type: str = "atlas",
    range_filter: dict[str, Any] | None = None,
) -> dict[str, Any]:
    store_dir = Path(store_dir)
    entries = []
    for record in enrich_source_records(source_records):
        raw = canonical_json_bytes(record["payload"])
        path = payload_path(store_dir, record["payload_hash"])
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(raw)
        entries.append({k: v for k, v in record.items() if k != "payload"})

    manifest = {
        "schema": "kungfu.atlas-import/v1",
        "import_id": import_id,
        "storage_source_id": storage_source_id,
        "source_type": source_type,
        "repo_root": repo_root,
        "repo_head": repo_head,
        "source_head": repo_head,
        "range": _serialize_range(range_filter),
        "hash_algorithm": "sha256",
        "counts": counts,
        "entries": sorted(
            entries,
            key=lambda row: (
                str(row.get("kind") or ""),
                str(row.get("source_id") or ""),
                str(row.get("source_path") or ""),
            ),
        ),
    }

    manifest_path = import_manifest_path(store_dir, import_id)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    latest_manifest_path(store_dir).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def load_latest_manifest(store_dir: str | Path) -> dict[str, Any] | None:
    path = latest_manifest_path(store_dir)
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else None


def _entry_key(entry: dict[str, Any]) -> tuple[str, str]:
    return str(entry.get("kind") or ""), str(entry.get("source_id") or "")


def _load_payload(
    store_dir: str | Path, entry: dict[str, Any]
) -> tuple[dict[str, Any] | None, str | None]:
    digest = str(entry.get("payload_hash") or "")
    path = payload_path(store_dir, digest)
    if not path.exists():
        return None, "payload_missing"
    raw = path.read_bytes()
    if len(raw) != entry.get("byte_len"):
        return None, "byte_len_mismatch"
    if payload_hash(raw) != digest:
        return None, "hash_mismatch"
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "payload_decode_error"
    if not isinstance(data, dict):
        return None, "payload_not_object"
    return data, None


def fsck_import(
    store_dir: str | Path,
    projection: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifest = load_latest_manifest(store_dir)
    report = {
        "ok": True,
        "scope": "atlas",
        "import_id": None,
        "errors": [],
        "warnings": [],
        "checked": {
            "payloads": 0,
            "missions": 0,
            "goals": 0,
            "markers": 0,
        },
    }
    if manifest is None:
        report["ok"] = False
        report["errors"].append({"code": "manifest_missing"})
        return report

    report["import_id"] = manifest.get("import_id")
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        report["ok"] = False
        report["errors"].append({"code": "manifest_entries_invalid"})
        return report

    seen: set[tuple[str, str]] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            report["ok"] = False
            report["errors"].append({"code": "manifest_entry_invalid"})
            continue
        key = _entry_key(entry)
        if key in seen:
            report["ok"] = False
            report["errors"].append(
                {"code": "duplicate_source", "kind": key[0], "source_id": key[1]}
            )
        seen.add(key)

        kind = str(entry.get("kind") or "")
        if kind in ("mission", "goal", "marker"):
            report["checked"][f"{kind}s"] += 1
        report["checked"]["payloads"] += 1

        if entry.get("payload_state") != PAYLOAD_STATE_PRESENT:
            report["warnings"].append(
                {
                    "code": "payload_not_present",
                    "kind": kind,
                    "source_id": entry.get("source_id"),
                    "state": entry.get("payload_state"),
                }
            )
            continue
        _, error = _load_payload(store_dir, entry)
        if error:
            report["ok"] = False
            report["errors"].append(
                {
                    "code": error,
                    "kind": kind,
                    "source_id": entry.get("source_id"),
                    "payload_hash": entry.get("payload_hash"),
                }
            )

    counts = manifest.get("counts") if isinstance(manifest.get("counts"), dict) else {}
    for key in ("missions", "goals", "markers"):
        expected = counts.get(key)
        if expected is not None and expected != report["checked"][key]:
            report["ok"] = False
            report["errors"].append(
                {
                    "code": "manifest_count_mismatch",
                    "kind": key,
                    "expected": expected,
                    "actual": report["checked"][key],
                }
            )

    if projection is not None:
        projection_keys = {
            "missions": {
                ("mission", str(key)) for key in projection.get("missions", {})
            },
            "goals": {("goal", str(key)) for key in projection.get("goals", {})},
            "markers": {("marker", str(key)) for key in projection.get("markers", {})},
        }
        manifest_keys = {
            "missions": {key for key in seen if key[0] == "mission"},
            "goals": {key for key in seen if key[0] == "goal"},
            "markers": {key for key in seen if key[0] == "marker"},
        }
        for key in ("missions", "goals", "markers"):
            actual = len(projection_keys[key])
            expected = len(manifest_keys[key])
            if actual != expected:
                report["ok"] = False
                report["errors"].append(
                    {
                        "code": "projection_count_mismatch",
                        "kind": key,
                        "expected": expected,
                        "actual": actual,
                    }
                )
            if projection_keys[key] != manifest_keys[key]:
                report["ok"] = False
                report["errors"].append(
                    {
                        "code": "projection_id_mismatch",
                        "kind": key,
                        "missing_in_projection": [
                            {"kind": kind, "source_id": source_id}
                            for kind, source_id in sorted(
                                manifest_keys[key] - projection_keys[key]
                            )
                        ],
                        "extra_in_projection": [
                            {"kind": kind, "source_id": source_id}
                            for kind, source_id in sorted(
                                projection_keys[key] - manifest_keys[key]
                            )
                        ],
                    }
                )
        if projection.get("import_id") != manifest.get("import_id"):
            report["ok"] = False
            report["errors"].append(
                {
                    "code": "projection_import_mismatch",
                    "manifest_import_id": manifest.get("import_id"),
                    "projection_import_id": projection.get("import_id"),
                }
            )

    return report


def export_records(
    store_dir: str | Path,
    range_filter: dict[str, Any] | None = None,
    storage_source_id: str | None = None,
) -> list[dict[str, Any]]:
    manifest = load_latest_manifest(store_dir)
    if manifest is None:
        raise FileNotFoundError(str(latest_manifest_path(store_dir)))
    if storage_source_id and manifest.get("storage_source_id") != storage_source_id:
        raise ValueError(f"source_not_imported: {storage_source_id}")
    records = []
    for entry in manifest.get("entries", []):
        if not _matches_range(entry, range_filter):
            continue
        payload, error = _load_payload(store_dir, entry)
        if error:
            raise ValueError(f"{error}: {entry.get('kind')}:{entry.get('source_id')}")
        row = dict(entry)
        row["scope"] = "atlas"
        row["import_id"] = manifest.get("import_id")
        row["storage_source_id"] = manifest.get("storage_source_id", "atlas")
        row["source_type"] = manifest.get("source_type", "atlas")
        row["repo_head"] = manifest.get("repo_head")
        row["source_head"] = manifest.get("repo_head")
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


def write_jsonl(records: list[dict[str, Any]], out_path: str | Path) -> None:
    with open(out_path, "w", encoding="utf-8") as f:
        for record in records:
            f.write(
                json.dumps(
                    record, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                )
                + "\n"
            )


def verify_against_source(
    store_dir: str | Path,
    source_records: list[dict[str, Any]],
    storage_source_id: str | None = None,
) -> dict[str, Any]:
    exported = {
        _entry_key(record): record
        for record in export_records(store_dir, storage_source_id=storage_source_id)
    }
    source = {
        _entry_key(record): record for record in enrich_source_records(source_records)
    }
    missing = []
    extra = []
    mismatched = []
    for key, row in source.items():
        current = exported.get(key)
        if current is None:
            missing.append({"kind": key[0], "source_id": key[1]})
            continue
        if current.get("payload_hash") != row.get("payload_hash"):
            mismatched.append(
                {
                    "kind": key[0],
                    "source_id": key[1],
                    "expected": row.get("payload_hash"),
                    "actual": current.get("payload_hash"),
                }
            )
    for key in exported:
        if key not in source:
            extra.append({"kind": key[0], "source_id": key[1]})

    return {
        "ok": not missing and not extra and not mismatched,
        "scope": "atlas",
        "checked": len(source),
        "missing": missing,
        "extra": extra,
        "hash_mismatch": mismatched,
    }
