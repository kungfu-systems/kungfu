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
import shutil
import subprocess
import tarfile
from pathlib import Path
from typing import Any

SYNC_DIRS = ("rewind", "work")
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


def _copy_local(source_home: Path, target: Path) -> list[str]:
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
    command = ["ssh", host, "tar", "-C", home, "-cf", "-", *SYNC_DIRS]
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
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as tf:
        return _safe_extract(tf, target)


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
            "they are not merged into the local authoritative runtime"
        ),
    }
    if error:
        manifest["error"] = error
    path = manifest_path(runtime_dir, source_id)
    with path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")
    return manifest
