#  SPDX-License-Identifier: Apache-2.0
#
# Source registry and mirror boundary for remote Kungfu facts. A synced source
# is copied into a source-scoped read-only projection area; it is not merged into
# the local authoritative runtime.

from __future__ import annotations

import datetime as dt
import io
import json
import os
import shlex
import shutil
import subprocess
import tarfile
from pathlib import Path
from typing import Any

SYNC_DIRS = ("journal", "rewind", "work", "storage")
LOCAL_HOSTS = {"", "local", "localhost", "127.0.0.1", "::1"}


def _registry_dir(runtime_dir: str) -> Path:
    path = Path(runtime_dir) / "remotes"
    path.mkdir(parents=True, exist_ok=True)
    return path


def registry_path(runtime_dir: str) -> Path:
    return _registry_dir(runtime_dir) / "sources.json"


def load_sources(runtime_dir: str) -> dict[str, Any]:
    path = registry_path(runtime_dir)
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return dict(data.get("sources", {}))


def save_sources(runtime_dir: str, sources: dict[str, Any]) -> Path:
    path = registry_path(runtime_dir)
    with path.open("w", encoding="utf-8") as f:
        json.dump(
            {"schema": "kungfu.remote-sources/v1", "sources": sources},
            f,
            indent=2,
            sort_keys=True,
        )
        f.write("\n")
    return path


def add_source(
    runtime_dir: str, source_id: str, host: str, home: str
) -> dict[str, Any]:
    sources = load_sources(runtime_dir)
    row = {
        "id": source_id,
        "host": host,
        "home": home,
        "transport": "local" if host in LOCAL_HOSTS else "ssh",
    }
    sources[source_id] = row
    save_sources(runtime_dir, sources)
    return row


def mirror_runtime_dir(runtime_dir: str, source_id: str) -> Path:
    path = _registry_dir(runtime_dir) / source_id / "runtime"
    path.mkdir(parents=True, exist_ok=True)
    return path


def manifest_path(runtime_dir: str, source_id: str) -> Path:
    return _registry_dir(runtime_dir) / source_id / "sync-manifest.json"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def _source_runtime_root(source_home: Path) -> Path:
    runtime = source_home / "runtime"
    if runtime.exists():
        return runtime
    return source_home


def _copy_local(source_home: Path, target: Path) -> list[str]:
    source_home = _source_runtime_root(source_home)
    copied: list[str] = []
    for name in SYNC_DIRS:
        src = source_home / name
        if not src.exists():
            continue
        dst = target / name
        if dst.exists():
            if dst.is_dir():
                shutil.rmtree(dst)
            else:
                dst.unlink()
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        copied.append(name)
    return copied


def _safe_extract(tf: tarfile.TarFile, target: Path) -> list[str]:
    copied: list[str] = []
    safe_members: list[tarfile.TarInfo] = []
    target_resolved = target.resolve()
    for member in tf.getmembers():
        name = member.name.strip("/")
        if not name or name.startswith("../") or "/../" in name:
            continue
        root = name.split("/", 1)[0]
        if root not in SYNC_DIRS:
            continue
        dest = (target / name).resolve()
        try:
            dest.relative_to(target_resolved)
        except ValueError:
            continue
        member.name = name
        safe_members.append(member)
        if root not in copied:
            copied.append(root)
    for root in copied:
        dst = target / root
        if dst.exists():
            if dst.is_dir():
                shutil.rmtree(dst)
            else:
                dst.unlink()
    tf.extractall(target, members=safe_members)
    return copied


def _copy_ssh(host: str, home: str, target: Path) -> list[str]:
    quoted_home = shlex.quote(home)
    quoted_dirs = " ".join(shlex.quote(name) for name in SYNC_DIRS)
    remote_script = (
        f"root={quoted_home}; "
        'if [ -d "$root/runtime" ]; then root="$root/runtime"; fi; '
        "set --; "
        f'for d in {quoted_dirs}; do [ -e "$root/$d" ] && set -- "$@" "$d"; done; '
        '[ "$#" -gt 0 ] || exit 0; '
        'tar -C "$root" -cf - "$@"'
    )
    command = ["ssh", host, "sh", "-lc", remote_script]
    result = subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(detail or f"ssh tar failed with exit {result.returncode}")
    if not result.stdout:
        return []
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as tf:
        return _safe_extract(tf, target)


def _load_manifest(runtime_dir: str, source_id: str) -> dict[str, Any] | None:
    path = manifest_path(runtime_dir, source_id)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        return dict(json.load(f))


def source_projection(runtime_dir: str, source_id: str) -> dict[str, Any]:
    sources = load_sources(runtime_dir)
    if source_id not in sources:
        raise KeyError(source_id)
    manifest = _load_manifest(runtime_dir, source_id)
    mirror = Path(runtime_dir) / "remotes" / source_id / "runtime"
    sync_state = "never"
    last_synced_at = None
    if manifest:
        sync_state = str(manifest.get("sync_state") or "stale")
        last_synced_at = manifest.get("last_synced_at")
        if sync_state == "fresh" and not mirror.exists():
            sync_state = "stale"
    return {
        "source_id": source_id,
        "source": sources[source_id],
        "source_label": f"remote:{source_id}",
        "sync_state": sync_state,
        "last_synced_at": last_synced_at,
        "mirror_runtime": str(mirror),
        "manifest": manifest,
        "capture_mode": "imported",
    }


def list_work(runtime_dir: str, source_id: str | None = None) -> list[dict[str, Any]]:
    from kungfu.work import store as work_store

    source_ids = [source_id] if source_id else sorted(load_sources(runtime_dir))
    rows: list[dict[str, Any]] = []
    for current in source_ids:
        projection = source_projection(runtime_dir, current)
        if projection["sync_state"] == "never":
            continue
        for item in work_store.load(projection["mirror_runtime"]).values():
            row = dict(item)
            row.update(
                {
                    "source": projection["source_label"],
                    "source_id": current,
                    "sync_state": projection["sync_state"],
                    "last_synced_at": projection["last_synced_at"],
                    "mirror_runtime": projection["mirror_runtime"],
                    "capture_mode": projection["capture_mode"],
                }
            )
            rows.append(row)
    rows.sort(
        key=lambda row: (
            row.get("updated_time") or 0,
            row.get("source_id") or "",
            row.get("work_id") or "",
        ),
        reverse=True,
    )
    return rows


def list_runs(runtime_dir: str, source_id: str | None = None) -> list[dict[str, Any]]:
    source_ids = [source_id] if source_id else sorted(load_sources(runtime_dir))
    rows: list[dict[str, Any]] = []
    for current in source_ids:
        projection = source_projection(runtime_dir, current)
        if projection["sync_state"] == "never":
            continue
        rewind_dir = Path(projection["mirror_runtime"]) / "rewind"
        if not rewind_dir.exists():
            continue
        for entry in rewind_dir.iterdir():
            if not entry.is_dir():
                continue
            manifest = entry / "bundle" / "manifest.json"
            row: dict[str, Any] = {
                "run_id": entry.name,
                "source": projection["source_label"],
                "source_id": current,
                "sync_state": projection["sync_state"],
                "last_synced_at": projection["last_synced_at"],
                "mirror_runtime": projection["mirror_runtime"],
                "capture_mode": projection["capture_mode"],
                "manifest": str(manifest) if manifest.exists() else None,
            }
            if manifest.exists():
                try:
                    with manifest.open("r", encoding="utf-8") as f:
                        data = json.load(f)
                    row["manifest_schema"] = data.get("schema") or data.get(
                        "spec_version"
                    )
                except json.JSONDecodeError:
                    row["sync_state"] = "stale"
                    row["manifest_error"] = "invalid json"
            rows.append(row)
    rows.sort(key=lambda row: (row["source_id"], row["run_id"]))
    return rows


def sync_source(runtime_dir: str, source_id: str) -> dict[str, Any]:
    sources = load_sources(runtime_dir)
    if source_id not in sources:
        raise KeyError(source_id)
    source = sources[source_id]
    target = mirror_runtime_dir(runtime_dir, source_id)
    try:
        if source.get("transport") == "local":
            copied = _copy_local(Path(os.path.expanduser(source["home"])), target)
        else:
            copied = _copy_ssh(str(source["host"]), str(source["home"]), target)
        state = "fresh"
        error = None
    except Exception as exc:  # noqa: BLE001 - error is persisted in the manifest
        copied = []
        state = "failed"
        error = str(exc)
    manifest = {
        "schema": "kungfu.remote-sync-manifest/v1",
        "source_id": source_id,
        "source": source,
        "mirror_runtime": str(target),
        "sync_state": state,
        "last_synced_at": _now(),
        "copied": copied,
        "capture_boundary": (
            "remote facts stay source-scoped under remotes/<source-id>/runtime; "
            "journal/rewind/work/storage are mirrored but not merged into the local "
            "authoritative runtime"
        ),
    }
    if error:
        manifest["error"] = error
    path = manifest_path(runtime_dir, source_id)
    with path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")
    return manifest
