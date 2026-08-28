# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import functools
import json
import os
import sys
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable


def _upgrade_facade_value(name: str, fallback: Any) -> Any:
    facade = sys.modules.get("kungfu.runtime_upgrade")
    return getattr(facade, name, fallback) if facade is not None else fallback


def _upgrade_facade_seam(
    name: str,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Keep a moved function injectable through its historical facade name."""

    def decorate(fallback: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fallback)
        def dispatch(*args: Any, **kwargs: Any) -> Any:
            candidate = _upgrade_facade_value(name, dispatch)
            target = fallback if candidate is dispatch else candidate
            return target(*args, **kwargs)

        return dispatch

    return decorate


MANIFEST_SCHEMA = "kungfu.product-upgrade.manifest/v1"
IMAGE_SCHEMA = "kungfu.runtime-image/v1"
REFERENCE_SCHEMA = "kungfu.runtime-image-reference/v1"
PLAN_SCHEMA = "kungfu.runtime-upgrade-plan/v1"
RECEIPT_SCHEMA = "kungfu.runtime-upgrade-receipt/v1"
GC_PLAN_SCHEMA = "kungfu.runtime-image-gc-plan/v1"
MESSAGE_SCHEMA = "kungfu.product-upgrade-message/v1"
LEGACY_BOOTSTRAP_MODE = "legacy-bootstrap"


class UpgradeError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _contract(contract: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
    from kungfu import contract as contract_runtime

    return contract_runtime.load_contract("upgrade") if contract is None else contract


def _validate(
    target: str,
    value: Mapping[str, Any],
    contract: Mapping[str, Any] | None = None,
) -> None:
    from kungfu import contract as contract_runtime

    bundle = _contract(contract)["valueSchemaBundle"]
    schema = {
        "$schema": bundle["$schema"],
        "$defs": bundle["$defs"],
        "$ref": f"#/$defs/{target}",
    }
    contract_runtime.validate_json_schema(value, schema, f"upgrade {target}")


def _canonical(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def _stable_id(prefix: str, value: Mapping[str, Any]) -> str:
    return f"{prefix}-{hashlib.sha256(_canonical(value)).hexdigest()[:24]}"


def manifest_digest(manifest: Mapping[str, Any]) -> str:
    _validate("releaseManifest", manifest)
    return f"sha256:{hashlib.sha256(_canonical(manifest)).hexdigest()}"


def tree_digest(root: str | Path) -> str:
    resolved = Path(root).expanduser().resolve()
    if not resolved.is_dir():
        raise UpgradeError(
            "artifact-missing", f"runtime image is not a directory: {resolved}"
        )
    rows: list[str] = []
    for path in resolved.rglob("*"):
        if path.is_symlink():
            target = os.readlink(path)
            try:
                target_real = path.resolve(strict=True)
                target_real.relative_to(resolved)
            except (OSError, ValueError) as error:
                raise UpgradeError(
                    "artifact-symlink-unsupported",
                    f"runtime image contains an unsupported symlink: {path}",
                ) from error
            if os.path.isabs(target):
                raise UpgradeError(
                    "artifact-symlink-unsupported",
                    f"runtime image contains an unsupported symlink: {path}",
                )
            rows.append(f"{path.relative_to(resolved).as_posix()}\0symlink:{target}")
            continue
        if not path.is_file():
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append(f"{path.relative_to(resolved).as_posix()}\0{digest}")
    rows.sort(key=lambda row: row.encode("utf-8"))
    return (
        f"sha256:{hashlib.sha256((chr(10).join(rows) + chr(10)).encode()).hexdigest()}"
    )


def inventory_root(config_home: str | Path) -> Path:
    return Path(config_home).expanduser().resolve() / "runtime" / "images"


def _state_root(config_home: str | Path) -> Path:
    return Path(config_home).expanduser().resolve() / "runtime" / "upgrade"


def _image_root(config_home: str | Path, build_id: str) -> Path:
    if not build_id or any(
        ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
        for ch in build_id
    ):
        raise UpgradeError("invalid-build-id", "runtime build id is not path safe")
    return inventory_root(config_home) / build_id


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as output:
            json.dump(value, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise UpgradeError(
            "state-unreadable", f"upgrade state is unreadable: {path}"
        ) from error
    if not isinstance(value, dict):
        raise UpgradeError("state-invalid", f"upgrade state is not an object: {path}")
    return value


for _upgrade_name in (
    "_contract",
    "_validate",
    "_canonical",
    "_stable_id",
    "manifest_digest",
    "tree_digest",
    "inventory_root",
    "_state_root",
    "_image_root",
    "_write_json",
    "_read_json",
):
    globals()[_upgrade_name] = _upgrade_facade_seam(_upgrade_name)(
        globals()[_upgrade_name]
    )
del _upgrade_name
