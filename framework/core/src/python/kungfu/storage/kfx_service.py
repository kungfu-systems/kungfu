# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
from typing import Any

import kungfu


def _runtime():
    return kungfu.__binding__.runtime


def kfx_runtime_contract(runtime_dir: str | Path = "") -> dict[str, Any]:
    """Return the versioned Core-owned native KFX contract."""

    return dict(
        _runtime().run_storage_service_operation(
            "kfx_runtime", str(runtime_dir), {"action": "contract"}
        )
    )


def validate_kfx_runtime_document(
    kind: str, document: dict[str, Any], runtime_dir: str | Path = ""
) -> dict[str, Any]:
    """Validate a KFX edge document without reproducing Core policy."""

    return dict(
        _runtime().run_storage_service_operation(
            "kfx_runtime",
            str(runtime_dir),
            {"action": "validate", "kind": kind, "document": document},
        )
    )


def kfx_registry(
    action: str,
    request: dict[str, Any],
    runtime_dir: str | Path = "",
    *,
    runtime: Any | None = None,
) -> dict[str, Any]:
    """Project one Core-native KFX registry or lifecycle operation."""

    if action not in {
        "list",
        "inspect",
        "resolve",
        "plan",
        "status",
        "assess",
        "apply",
        "history",
        "authorize-host",
        "runtime-warrant-issue",
        "runtime-warrant-heartbeat",
        "runtime-warrant-revoke",
        "runtime-warrant-settle",
        "runtime-warrant-recover",
        "kfd-10-witness",
    }:
        raise ValueError(f"unsupported KFX registry action: {action}")
    return dict(
        (runtime or _runtime()).run_storage_service_operation(
            "kfx_runtime",
            str(runtime_dir),
            {"action": action, "request": request},
        )
    )
