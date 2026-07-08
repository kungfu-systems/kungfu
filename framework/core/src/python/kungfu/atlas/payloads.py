# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path
from typing import Any, cast

from kungfu.action_envelope import (
    ACTION_ENVELOPE_SCHEMA,
    build_action_envelope as build_common_action_envelope,
    canonical_json_bytes,
    payload_hash,
)
from kungfu.atlas import (
    ACTION_GOAL_SNAPSHOT,
    ACTION_MARKER_SNAPSHOT,
    ACTION_MISSION_SNAPSHOT,
)

CONTENT_TYPE_JSON = "application/json"
PAYLOAD_STATE_PRESENT = "present"

ACTION_SCHEMA_REFS = {
    "atlas.import.begin": {"id": "kungfu.atlas.ImportBegin", "version": 1},
    ACTION_MISSION_SNAPSHOT: {"id": "kungfu.atlas.MissionSnapshot", "version": 1},
    ACTION_GOAL_SNAPSHOT: {"id": "kungfu.atlas.GoalSnapshot", "version": 1},
    ACTION_MARKER_SNAPSHOT: {"id": "kungfu.atlas.MarkerSnapshot", "version": 1},
    "atlas.import.end": {"id": "kungfu.atlas.ImportEnd", "version": 1},
}

KIND_ACTION_TYPES = {
    "mission": ACTION_MISSION_SNAPSHOT,
    "goal": ACTION_GOAL_SNAPSHOT,
    "marker": ACTION_MARKER_SNAPSHOT,
}


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


def action_type_for_kind(kind: str) -> str:
    return KIND_ACTION_TYPES.get(kind, f"atlas.{kind}.snapshot")


def _schema_ref(action_type: str) -> dict[str, Any]:
    return dict(
        ACTION_SCHEMA_REFS.get(
            action_type,
            {"id": action_type, "version": 1},
        )
    )


def build_action_envelope(
    *,
    import_id: str,
    storage_source_id: str,
    source_type: str,
    action_type: str,
    source: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
    batch: dict[str, Any] | None = None,
    journal: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return build_common_action_envelope(
        action_type=action_type,
        schema_ref=_schema_ref(action_type),
        session={"import_id": import_id},
        actor={
            "storage_source_id": storage_source_id,
            "source_type": source_type,
        },
        source=source,
        payload=payload,
        batch=batch,
        journal=journal,
    )


def _action_envelope(
    *,
    import_id: str,
    storage_source_id: str,
    source_type: str,
    entry: dict[str, Any],
    receipt: dict[str, Any],
) -> dict[str, Any]:
    kind = str(entry.get("kind") or "")
    return build_action_envelope(
        import_id=import_id,
        storage_source_id=storage_source_id,
        source_type=source_type,
        action_type=action_type_for_kind(kind),
        source={
            "kind": kind,
            "source_id": entry.get("source_id"),
            "source_path": entry.get("source_path"),
            "source_time": entry.get("source_time"),
            "schema_version": entry.get("schema_version"),
        },
        payload={
            "content_type": entry.get("content_type", CONTENT_TYPE_JSON),
            "hash_algorithm": "sha256",
            "hash": entry.get("payload_hash"),
            "byte_len": entry.get("byte_len"),
            "state": entry.get("payload_state", PAYLOAD_STATE_PRESENT),
        },
        journal=receipt,
    )


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
    action_receipts: dict[tuple[str, str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    store_dir = Path(store_dir)
    entries = []
    records = (
        source_records
        if all("payload_hash" in record for record in source_records)
        else enrich_source_records(source_records)
    )
    for record in records:
        raw = canonical_json_bytes(record["payload"])
        path = payload_path(store_dir, record["payload_hash"])
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(raw)
        entry = {k: v for k, v in record.items() if k != "payload"}
        receipt = (action_receipts or {}).get(_entry_key(entry))
        if receipt is not None:
            entry["action"] = _action_envelope(
                import_id=import_id,
                storage_source_id=storage_source_id,
                source_type=source_type,
                entry=entry,
                receipt=receipt,
            )
        entries.append(entry)

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


def load_payload_descriptor(
    store_dir: str | Path,
    descriptor: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    entry = {
        "payload_hash": descriptor.get("hash"),
        "byte_len": descriptor.get("byte_len"),
    }
    return _load_payload(store_dir, entry)


def _append_action_error(
    report: dict[str, Any],
    code: str,
    entry: dict[str, Any],
    **extra: Any,
) -> None:
    report["ok"] = False
    error = {
        "code": code,
        "kind": entry.get("kind"),
        "source_id": entry.get("source_id"),
    }
    error.update(extra)
    report["errors"].append(error)


def _check_action_payload(
    report: dict[str, Any],
    entry: dict[str, Any],
    action: dict[str, Any],
) -> None:
    payload = action.get("payload")
    if not isinstance(payload, dict):
        _append_action_error(report, "action_payload_invalid", entry)
        return
    expectations = {
        "hash": entry.get("payload_hash"),
        "byte_len": entry.get("byte_len"),
        "state": entry.get("payload_state"),
    }
    for field, expected in expectations.items():
        if payload.get(field) != expected:
            _append_action_error(
                report,
                "action_payload_mismatch",
                entry,
                field=field,
                expected=expected,
                actual=payload.get(field),
            )


def _check_action_frame(
    report: dict[str, Any],
    entry: dict[str, Any],
    action: dict[str, Any],
    action_frames: dict[Any, dict[str, Any]] | None,
) -> None:
    journal = action.get("journal")
    if not isinstance(journal, dict):
        _append_action_error(report, "action_journal_invalid", entry)
        return
    if action_frames is None:
        return
    frame_uid = journal.get("frame_uid")
    frame = action_frames.get((frame_uid, journal.get("gen_time")))
    if frame is None:
        frame = action_frames.get(
            (frame_uid, journal.get("carrier_type"), journal.get("gen_time"))
        )
    if frame is None:
        _append_action_error(report, "action_frame_missing", entry, frame_uid=frame_uid)
        return
    for field in (
        "trigger_frame_uid",
        "stream_id",
        "gen_time",
        "trigger_time",
        "carrier_type",
        "source",
        "initial_source",
        "dest",
        "data_type",
    ):
        if frame.get(field) != journal.get(field):
            _append_action_error(
                report,
                "action_frame_mismatch",
                entry,
                field=field,
                frame_uid=frame_uid,
                expected=journal.get(field),
                actual=frame.get(field),
            )
    payload = frame.get("_payload")
    expected_length = journal.get("data_length")
    if isinstance(payload, bytes) and isinstance(expected_length, int):
        if len(payload) < expected_length:
            _append_action_error(
                report,
                "action_frame_mismatch",
                entry,
                field="data_length",
                frame_uid=frame_uid,
                expected=expected_length,
                actual=len(payload),
            )
        elif any(payload[expected_length:]):
            _append_action_error(
                report,
                "action_frame_nonzero_padding",
                entry,
                frame_uid=frame_uid,
                expected=expected_length,
                actual=len(payload),
            )
        actual_hash = payload_hash(payload[:expected_length])
        if actual_hash != journal.get("journal_payload_hash"):
            _append_action_error(
                report,
                "action_frame_mismatch",
                entry,
                field="journal_payload_hash",
                frame_uid=frame_uid,
                expected=journal.get("journal_payload_hash"),
                actual=actual_hash,
            )
        payload_checksum = journal.get("payload_checksum")
        if isinstance(payload_checksum, int) and payload_checksum:
            checksum_for = frame.get("_payload_checksum_for")
            actual_checksum = (
                checksum_for(expected_length) if callable(checksum_for) else None
            )
            if actual_checksum != payload_checksum:
                _append_action_error(
                    report,
                    "action_frame_mismatch",
                    entry,
                    field="payload_checksum",
                    frame_uid=frame_uid,
                    expected=payload_checksum,
                    actual=actual_checksum,
                )
        frame_checksum = journal.get("frame_checksum")
        if isinstance(frame_checksum, int) and frame_checksum:
            checksum_for = frame.get("_frame_checksum_for")
            actual_checksum = (
                checksum_for(expected_length) if callable(checksum_for) else None
            )
            if actual_checksum != frame_checksum:
                _append_action_error(
                    report,
                    "action_frame_mismatch",
                    entry,
                    field="frame_checksum",
                    frame_uid=frame_uid,
                    expected=frame_checksum,
                    actual=actual_checksum,
                )


def _check_action(
    report: dict[str, Any],
    entry: dict[str, Any],
    action_frames: dict[Any, dict[str, Any]] | None,
) -> None:
    action = entry.get("action")
    if action is None:
        return
    report["checked"]["actions"] += 1
    if not isinstance(action, dict):
        _append_action_error(report, "action_invalid", entry)
        return
    if action.get("schema") != ACTION_ENVELOPE_SCHEMA:
        _append_action_error(
            report,
            "action_schema_mismatch",
            entry,
            expected=ACTION_ENVELOPE_SCHEMA,
            actual=action.get("schema"),
        )
    kind = str(entry.get("kind") or "")
    if action.get("action_type") != action_type_for_kind(kind):
        _append_action_error(
            report,
            "action_type_mismatch",
            entry,
            expected=action_type_for_kind(kind),
            actual=action.get("action_type"),
        )
    _check_action_payload(report, entry, action)
    _check_action_frame(report, entry, action, action_frames)


def fsck_import(
    store_dir: str | Path,
    projection: dict[str, Any] | None = None,
    action_frames: dict[Any, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    manifest = load_latest_manifest(store_dir)
    report: dict[str, Any] = {
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
            "actions": 0,
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
        entry_key = _entry_key(entry)
        if entry_key in seen:
            report["ok"] = False
            report["errors"].append(
                {
                    "code": "duplicate_source",
                    "kind": entry_key[0],
                    "source_id": entry_key[1],
                }
            )
        seen.add(entry_key)

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
        _check_action(report, entry, action_frames)

    raw_counts = manifest.get("counts")
    counts = cast(dict[str, Any], raw_counts) if isinstance(raw_counts, dict) else {}
    for section in ("missions", "goals", "markers"):
        expected = counts.get(section)
        if expected is not None and expected != report["checked"][section]:
            report["ok"] = False
            report["errors"].append(
                {
                    "code": "manifest_count_mismatch",
                    "kind": section,
                    "expected": expected,
                    "actual": report["checked"][section],
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
        for section in ("missions", "goals", "markers"):
            actual = len(projection_keys[section])
            expected = len(manifest_keys[section])
            if actual != expected:
                report["ok"] = False
                report["errors"].append(
                    {
                        "code": "projection_count_mismatch",
                        "kind": section,
                        "expected": expected,
                        "actual": actual,
                    }
                )
            if projection_keys[section] != manifest_keys[section]:
                report["ok"] = False
                report["errors"].append(
                    {
                        "code": "projection_id_mismatch",
                        "kind": section,
                        "missing_in_projection": [
                            {"kind": kind, "source_id": source_id}
                            for kind, source_id in sorted(
                                manifest_keys[section] - projection_keys[section]
                            )
                        ],
                        "extra_in_projection": [
                            {"kind": kind, "source_id": source_id}
                            for kind, source_id in sorted(
                                projection_keys[section] - manifest_keys[section]
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
