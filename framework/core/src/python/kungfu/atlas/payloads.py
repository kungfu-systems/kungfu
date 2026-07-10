# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path
from typing import Any, cast

import kungfu

from kungfu.action_envelope import (
    ACTION_ENVELOPE_SCHEMA,
    build_action_envelope as build_common_action_envelope,
    canonical_json_bytes,
    payload_hash,
)
from kungfu.content_hash import CONTENT_HASH_ALGORITHM_SHA256
from kungfu.atlas import (
    ACTION_GOAL_SNAPSHOT,
    ACTION_MARKER_SNAPSHOT,
    ACTION_MISSION_SNAPSHOT,
)

CONTENT_TYPE_JSON = "application/json"
FRAME_INTEGRITY_VERSION_V1 = 1
FRAME_INTEGRITY_VERSION_V2 = 2
DEFAULT_FRAME_INTEGRITY_VERSION = FRAME_INTEGRITY_VERSION_V2
FRAME_CHECKSUM_ALGORITHM_FNV1A64 = "fnv1a64"
FRAME_CHECKSUM_ALGORITHM_CRC32C = "crc32c"
DEFAULT_FRAME_CHECKSUM_ALGORITHM = FRAME_CHECKSUM_ALGORITHM_CRC32C
FRAME_CHECKSUM_ALGORITHMS_BY_VERSION = {
    FRAME_INTEGRITY_VERSION_V1: FRAME_CHECKSUM_ALGORITHM_FNV1A64,
    FRAME_INTEGRITY_VERSION_V2: FRAME_CHECKSUM_ALGORITHM_CRC32C,
}
SUPPORTED_FRAME_CHECKSUM_ALGORITHMS = set(FRAME_CHECKSUM_ALGORITHMS_BY_VERSION.values())
PAYLOAD_STATE_PRESENT = "present"
SYNC_ROOT_SCHEMA = "kungfu.sync-root/v1"
SYNC_ROOT_SCOPE_ATLAS_IMPORT_MANIFEST = "atlas.import.manifest"
SYNC_ROOT_CHAIN_LINK_SCHEMA = "kungfu.sync-chain-link/v1"
SYNC_ROOT_PROOF_LINEAR_CHAIN_V1 = "linear-chain-v1"
SYNC_ROOT_ORDERING_POLICY_MANIFEST_ENTRY_SORT_V1 = "manifest-entry-sort-v1"
SYNC_ROOT_INITIAL = f"{CONTENT_HASH_ALGORITHM_SHA256}:{'0' * 64}"
SYNC_ROOT_ENTRY_ORDER_FIELDS = ["kind", "source_id", "source_path"]

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


def _runtime():
    return kungfu.__binding__.runtime


def payload_path(store_dir: str | Path, digest: str) -> Path:
    # ADR-0037: payload bodies are opaque content-addressed bytes named by the
    # content hash alone, with no format-implying extension. The body format is
    # orthogonal to the record schema; content_type / length / hash live on the
    # manifest entry, not in the file name.
    root = Path(store_dir) / "payloads" / digest[:2]
    return root / digest


def latest_manifest_path(store_dir: str | Path) -> Path:
    return Path(store_dir) / "imports" / "latest.json"


def import_manifest_path(store_dir: str | Path, import_id: str) -> Path:
    return Path(store_dir) / "imports" / f"{import_id}.json"


def _source_payload(record: dict[str, Any]) -> dict[str, Any]:
    payload = record.get("payload")
    return payload if isinstance(payload, dict) else {}


def _source_refs(record: dict[str, Any]) -> list[dict[str, str]]:
    payload = _source_payload(record)
    refs: list[dict[str, str]] = []
    if record.get("kind") == "goal":
        mission_id = str(payload.get("mission_id") or "").strip()
        if mission_id:
            refs.append(
                {
                    "kind": "mission",
                    "source_id": mission_id,
                    "role": "context",
                }
            )
    return refs


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
        refs = _source_refs(record)
        if refs:
            row["source_refs"] = refs
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
            "hash_algorithm": CONTENT_HASH_ALGORITHM_SHA256,
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
    return bool(_runtime().filter_storage_manifest_entries([entry], range_filter))


def _context_keys_from_entry(
    store_dir: str | Path,
    entry: dict[str, Any],
) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    refs = entry.get("source_refs")
    if isinstance(refs, list):
        for ref in refs:
            if not isinstance(ref, dict):
                continue
            kind = str(ref.get("kind") or "").strip()
            source_id = str(ref.get("source_id") or "").strip()
            if kind and source_id:
                keys.add((kind, source_id))
    if keys or entry.get("kind") != "goal":
        return keys

    payload, error = _load_payload(store_dir, entry)
    if error or payload is None:
        return keys
    mission_id = str(payload.get("mission_id") or "").strip()
    if mission_id:
        keys.add(("mission", mission_id))
    return keys


def _entries_for_range(
    store_dir: str | Path,
    entries: list[Any],
    range_filter: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    manifest_entries = [entry for entry in entries if isinstance(entry, dict)]
    if not range_filter:
        return manifest_entries

    selected = [
        entry for entry in manifest_entries if _matches_range(entry, range_filter)
    ]
    selected_keys = {_entry_key(entry) for entry in selected}
    context_keys: set[tuple[str, str]] = set()
    for entry in selected:
        context_keys.update(_context_keys_from_entry(store_dir, entry))

    expanded = list(selected)
    for entry in manifest_entries:
        key = _entry_key(entry)
        if key in selected_keys:
            continue
        if key in context_keys:
            expanded.append(entry)
            selected_keys.add(key)
    return sorted(expanded, key=_manifest_entry_sort_key)


def _manifest_entry_sort_key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(row.get("kind") or ""),
        str(row.get("source_id") or ""),
        str(row.get("source_path") or ""),
    )


def _sync_root_entry_commitment(entry: dict[str, Any]) -> dict[str, Any]:
    return dict(_runtime().storage_sync_root_entry_commitment(entry))


def compute_sync_root(entries: list[dict[str, Any]]) -> dict[str, Any]:
    return dict(_runtime().compute_storage_sync_root(entries))


def _append_sync_root_error(
    report: dict[str, Any],
    code: str,
    *,
    field: str | None = None,
    expected: Any = None,
    actual: Any = None,
) -> None:
    report["ok"] = False
    error = {"code": code}
    if field is not None:
        error["field"] = field
    if expected is not None:
        error["expected"] = expected
    if actual is not None:
        error["actual"] = actual
    report["errors"].append(error)


def _check_sync_root(
    report: dict[str, Any], manifest: dict[str, Any], entries: list[dict[str, Any]]
) -> None:
    report["checked"]["sync_roots"] += 1
    actual = manifest.get("sync_root")
    if actual is None:
        _append_sync_root_error(report, "sync_root_missing")
        return
    if not isinstance(actual, dict):
        _append_sync_root_error(report, "sync_root_invalid", actual=actual)
        return
    for issue in _runtime().verify_storage_sync_root(actual, entries):
        issue = dict(issue)
        _append_sync_root_error(
            report,
            str(issue.get("code") or "sync_root_mismatch"),
            field=issue.get("field"),
            expected=issue.get("expected"),
            actual=issue.get("actual"),
        )


def export_sync_root(
    store_dir: str | Path,
    range_filter: dict[str, Any] | None = None,
    storage_source_id: str | None = None,
) -> dict[str, Any]:
    manifest = load_latest_manifest(store_dir)
    if manifest is None:
        raise FileNotFoundError(str(latest_manifest_path(store_dir)))
    if storage_source_id and manifest.get("storage_source_id") != storage_source_id:
        raise ValueError(f"source_not_imported: {storage_source_id}")
    entries = _entries_for_range(store_dir, manifest.get("entries", []), range_filter)
    return compute_sync_root(entries)


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

    sorted_entries = sorted(entries, key=_manifest_entry_sort_key)
    manifest = {
        "schema": "kungfu.atlas-import/v1",
        "import_id": import_id,
        "storage_source_id": storage_source_id,
        "source_type": source_type,
        "repo_root": repo_root,
        "repo_head": repo_head,
        "source_head": repo_head,
        "range": _serialize_range(range_filter),
        "hash_algorithm": CONTENT_HASH_ALGORITHM_SHA256,
        "counts": counts,
        "entries": sorted_entries,
        "sync_root": compute_sync_root(sorted_entries),
    }
    # The storage-service acceptance input (ADR-0037): an adapter-edge
    # document. Acceptance turns it into Hana-core journal records; the
    # adapter keeps a copy of what it submitted.
    manifest["storage_manifest"] = {
        "manifest_id": import_id,
        "storage_source_id": storage_source_id,
        "source_type": source_type,
        "source_coordinate": repo_root,
        "source_head": repo_head,
        "scope": "atlas",
        "range": manifest["range"] or {},
        "entries": sorted_entries,
        "sync_root": manifest["sync_root"],
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


def _frame_checksum_algorithm_for_journal(
    report: dict[str, Any],
    entry: dict[str, Any],
    journal: dict[str, Any],
) -> str | None:
    integrity_version = journal.get("integrity_version")
    checksum_algorithm = journal.get("checksum_algorithm")
    if not integrity_version and not checksum_algorithm:
        return None
    if not isinstance(integrity_version, int) or integrity_version <= 0:
        _append_action_error(
            report,
            "action_frame_mismatch",
            entry,
            field="integrity_version",
            expected=sorted(FRAME_CHECKSUM_ALGORITHMS_BY_VERSION),
            actual=integrity_version,
        )
        return None
    expected_algorithm = FRAME_CHECKSUM_ALGORITHMS_BY_VERSION.get(integrity_version)
    if expected_algorithm is None:
        _append_action_error(
            report,
            "action_frame_mismatch",
            entry,
            field="integrity_version",
            expected=sorted(FRAME_CHECKSUM_ALGORITHMS_BY_VERSION),
            actual=integrity_version,
        )
        return None
    if not checksum_algorithm:
        if integrity_version == FRAME_INTEGRITY_VERSION_V1:
            return expected_algorithm
        _append_action_error(
            report,
            "action_frame_mismatch",
            entry,
            field="checksum_algorithm",
            expected=expected_algorithm,
            actual=checksum_algorithm,
        )
        return None
    if checksum_algorithm not in SUPPORTED_FRAME_CHECKSUM_ALGORITHMS:
        _append_action_error(
            report,
            "action_frame_mismatch",
            entry,
            field="checksum_algorithm",
            expected=sorted(SUPPORTED_FRAME_CHECKSUM_ALGORITHMS),
            actual=checksum_algorithm,
        )
        return None
    if checksum_algorithm != expected_algorithm:
        _append_action_error(
            report,
            "action_frame_mismatch",
            entry,
            field="checksum_algorithm",
            expected=expected_algorithm,
            actual=checksum_algorithm,
        )
        return None
    return checksum_algorithm


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
        checksum_algorithm = _frame_checksum_algorithm_for_journal(
            report, entry, journal
        )
        payload_checksum = journal.get("payload_checksum")
        if (
            checksum_algorithm
            and isinstance(payload_checksum, int)
            and payload_checksum
        ):
            checksum_for = frame.get("_payload_checksum_for")
            actual_checksum = (
                checksum_for(expected_length, checksum_algorithm)
                if callable(checksum_for)
                else None
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
        if checksum_algorithm and isinstance(frame_checksum, int) and frame_checksum:
            checksum_for = frame.get("_frame_checksum_for")
            actual_checksum = (
                checksum_for(expected_length, checksum_algorithm)
                if callable(checksum_for)
                else None
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
            "sync_roots": 0,
            "storage_manifests": 0,
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
    manifest_entries = [entry for entry in entries if isinstance(entry, dict)]
    _check_sync_root(report, manifest, manifest_entries)
    storage_manifest = manifest.get("storage_manifest")
    if isinstance(storage_manifest, dict):
        # The storage_manifest is the acceptance input document (ADR-0037):
        # check it structurally and against this manifest before it is (re-)
        # submitted to the storage service.
        report["checked"]["storage_manifests"] += 1
        for field in ("manifest_id", "storage_source_id"):
            if not str(storage_manifest.get(field) or ""):
                report["ok"] = False
                report["errors"].append(
                    {"code": "missing_field", "path": f"$.storage_manifest.{field}"}
                )
        if storage_manifest.get("entries") != manifest.get("entries"):
            report["ok"] = False
            report["errors"].append({"code": "storage_manifest_entries_drift"})
        if storage_manifest.get("sync_root") != manifest.get("sync_root"):
            report["ok"] = False
            report["errors"].append({"code": "storage_manifest_sync_root_drift"})
    else:
        report["ok"] = False
        report["errors"].append({"code": "storage_manifest_missing"})

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
    for entry in _entries_for_range(
        store_dir, manifest.get("entries", []), range_filter
    ):
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
    records.sort(key=_manifest_entry_sort_key)
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
