# SPDX-License-Identifier: Apache-2.0

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from kungfu.storage import service as storage_service


def now_iso() -> str:
    return _iso(datetime.now(timezone.utc))


def registry_path(runtime_dir: str | os.PathLike[str]) -> Path:
    return Path(runtime_dir) / "sources" / "sources.json"


def load_registry(runtime_dir: str | os.PathLike[str]) -> dict[str, Any]:
    path = registry_path(runtime_dir)
    if not path.exists():
        return {"schema": "kungfu.sources/v1", "sources": {}}
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not isinstance(data.get("sources"), dict):
        raise ValueError(f"invalid source registry: {path}")
    data.setdefault("schema", "kungfu.sources/v1")
    return data


def save_registry(
    runtime_dir: str | os.PathLike[str], registry: dict[str, Any]
) -> None:
    path = registry_path(runtime_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(registry, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def list_sources(runtime_dir: str | os.PathLike[str]) -> list[dict[str, Any]]:
    registry = load_registry(runtime_dir)
    return sorted(
        registry["sources"].values(),
        key=lambda source: str(source.get("source_id") or ""),
    )


def get_source(runtime_dir: str | os.PathLike[str], source_id: str) -> dict[str, Any]:
    registry = load_registry(runtime_dir)
    source = registry["sources"].get(source_id)
    if source is None:
        raise KeyError(source_id)
    return source


def add_source(
    runtime_dir: str | os.PathLike[str],
    *,
    source_id: str,
    source_type: str,
    repo: str,
) -> dict[str, Any]:
    if source_type != "atlas":
        raise ValueError(f"unsupported source type: {source_type}")
    registry = load_registry(runtime_dir)
    sources = registry["sources"]
    stamp = now_iso()
    previous = sources.get(source_id, {})
    source = {
        "source_id": source_id,
        "type": source_type,
        "repo": os.path.abspath(repo),
        "created_at": previous.get("created_at", stamp),
        "updated_at": stamp,
        "last_synced_at": previous.get("last_synced_at"),
        "last_import_id": previous.get("last_import_id"),
        "last_source_head": previous.get("last_source_head"),
        "last_range": previous.get("last_range"),
    }
    source["storage_record"] = storage_service.build_source_record(
        {
            "source_id": source_id,
            "source_type": source_type,
            "source_coordinate": source["repo"],
            "updated_at": stamp,
        }
    )
    sources[source_id] = source
    save_registry(runtime_dir, registry)
    generic_registry = storage_service.load_registry(Path(runtime_dir))
    generic_registry["sources"][source_id] = source["storage_record"]
    storage_service.save_registry(Path(runtime_dir), generic_registry)
    return source


def _iso(stamp: datetime) -> str:
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_relative(value: str, *, now: datetime) -> datetime | None:
    text = value.strip().lower()
    if len(text) < 2:
        return None
    unit = text[-1]
    amount_text = text[:-1]
    if not amount_text.isdigit():
        return None
    amount = int(amount_text)
    if unit == "d":
        delta = timedelta(days=amount)
    elif unit == "h":
        delta = timedelta(hours=amount)
    elif unit == "m":
        delta = timedelta(minutes=amount)
    elif unit == "s":
        delta = timedelta(seconds=amount)
    else:
        return None
    return now - delta


def build_range_filter(
    *,
    since: str | None = None,
    from_time: str | None = None,
    until: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    if since and from_time:
        raise ValueError("use either --since or --from, not both")
    now = now or datetime.now(timezone.utc)
    result: dict[str, Any] = {}
    if since:
        relative = _parse_relative(since, now=now)
        result["since"] = _iso(relative) if relative is not None else since
    if from_time:
        result["since"] = from_time
    if until:
        result["until"] = until
    return result or None


def sync_source(
    runtime_dir: str | os.PathLike[str],
    source_id: str,
    *,
    range_filter: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from kungfu.atlas.store import ImportStore

    registry = load_registry(runtime_dir)
    source = registry["sources"].get(source_id)
    if source is None:
        raise KeyError(source_id)
    if source.get("type") != "atlas":
        raise ValueError(f"unsupported source type: {source.get('type')}")

    result = ImportStore(runtime_dir).run_import(
        source["repo"],
        storage_source_id=source_id,
        range_filter=range_filter,
    )
    stamp = now_iso()
    source.update(
        {
            "updated_at": stamp,
            "last_synced_at": stamp,
            "last_import_id": result.get("import_id"),
            "last_source_head": result.get("source_head"),
            "last_range": result.get("range"),
        }
    )
    generic_registry = storage_service.load_registry(Path(runtime_dir))
    source["storage_record"] = generic_registry["sources"].get(source_id)
    save_registry(runtime_dir, registry)
    return {"ok": True, "source": source, "sync": result}


def fsck_source(
    runtime_dir: str | os.PathLike[str],
    source_id: str,
) -> dict[str, Any]:
    from kungfu.atlas import payloads
    from kungfu.atlas import store as atlas_store

    source = get_source(runtime_dir, source_id)
    manifest = payloads.load_latest_manifest(atlas_store.store_dir(runtime_dir))
    if manifest is None:
        return {
            "ok": False,
            "source": source,
            "errors": [{"code": "manifest_missing"}],
            "warnings": [],
        }
    if manifest.get("storage_source_id") != source_id:
        return {
            "ok": False,
            "source": source,
            "errors": [
                {
                    "code": "source_not_latest_import",
                    "expected": source_id,
                    "actual": manifest.get("storage_source_id"),
                }
            ],
            "warnings": [],
        }
    report = atlas_store.verify_against_repo(
        runtime_dir,
        source["repo"],
        range_filter=manifest.get("range"),
        storage_source_id=source_id,
    )
    report["storage"] = storage_service.fsck(Path(runtime_dir), source_id=source_id)
    if not report["storage"]["ok"]:
        report["ok"] = False
    report["source"] = source
    return report
