# SPDX-License-Identifier: Apache-2.0

"""Persistence and bundle-transfer owner for the Python storage facade.

This module owns only Python edge serialization and the typed options passed to
the native storage service.  It does not own storage authority: bundle
validation, materialization, provider selection, and receipt construction stay
inside libkungfu.
"""

import json
from pathlib import Path
from typing import Any

import kungfu


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


class StorageTransfer:
    """Cohesive owner for JSONL and bundle import/export edge behavior."""

    @staticmethod
    def write_jsonl(records: list[dict[str, Any]], out_path: str | Path) -> None:
        with open(out_path, "w", encoding="utf-8") as output:
            for record in records:
                output.write(
                    json.dumps(
                        record,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    + "\n"
                )

    @staticmethod
    def export_jsonl(
        runtime_dir: str | Path,
        out_path: str | Path,
        *,
        source_id: str,
        range_filter: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        runtime = kungfu.__binding__.runtime
        data = runtime.load_storage_latest_manifest(str(runtime_dir), source_id)
        manifest = data if isinstance(data, dict) else None
        if manifest is None:
            raise FileNotFoundError(f"no accepted manifest for source: {source_id}")
        records = [
            dict(row)
            for row in runtime.export_storage_records(
                str(runtime_dir), source_id, range_filter or {}
            )
        ]
        StorageTransfer.write_jsonl(records, out_path)
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

    @staticmethod
    def export_bundle_json(
        runtime_dir: str | Path,
        out_path: str | Path,
        *,
        source_id: str | None = None,
        episode_id: int | None = None,
        range_filter: dict[str, Any] | None = None,
        thin: bool = False,
    ) -> dict[str, Any]:
        bundle = StorageTransfer.build_export_bundle(
            runtime_dir,
            source_id=source_id,
            episode_id=episode_id,
            range_filter=range_filter,
            thin=thin,
        )
        output = Path(out_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps(bundle, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
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

    @staticmethod
    def build_export_bundle(
        runtime_dir: str | Path,
        *,
        source_id: str | None = None,
        episode_id: int | None = None,
        range_filter: dict[str, Any] | None = None,
        thin: bool = False,
    ) -> dict[str, Any]:
        scope = "episode" if episode_id else "source"
        return dict(
            kungfu.__binding__.runtime.run_storage_service_operation(
                "export_bundle",
                str(runtime_dir),
                {
                    "scope": scope,
                    "source_id": source_id,
                    "episode_id": _u64(episode_id),
                    "range": range_filter or {},
                    "thin": thin,
                },
            )
        )

    @staticmethod
    def import_bundle(
        runtime_dir: str | Path,
        bundle: dict[str, Any],
        *,
        verify: bool = True,
        execute: bool = False,
    ) -> dict[str, Any]:
        source_id = str(bundle.get("source_id") or "")
        scope = (
            "episode"
            if bundle.get("schema") == "kungfu.storage.episode-bundle/v1"
            else "source"
        )
        return dict(
            kungfu.__binding__.runtime.run_storage_service_operation(
                "import_bundle",
                str(runtime_dir),
                {
                    "scope": scope if source_id or scope == "episode" else "all",
                    "source_id": source_id or None,
                    "episode_id": _u64(bundle.get("episode_id")),
                    "verify": verify,
                    "dry_run": not execute,
                    "bundle": _binding_json(bundle),
                },
            )
        )
