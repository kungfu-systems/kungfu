"""Thin CLI/Agent adapter over the Core-owned KFX Control Suite protocol."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from kungfu.storage import service as storage_service


CONTROLLER_ID = "kungfu-kfx-control-suite"
PACKAGE_KEY = "kfx-manager"


def _request(candidate: str | Path, operation: str) -> dict[str, Any]:
    if operation not in {"install", "update"}:
        raise ValueError(f"unsupported KFX Control operation: {operation}")
    return {
        "controller": CONTROLLER_ID,
        "packageKey": PACKAGE_KEY,
        "operation": operation,
        "roots": [{"kind": "product", "path": str(Path(candidate).resolve())}],
        "runtimeTiers": {PACKAGE_KEY: "first-party-pinned"},
    }


def status(runtime_dir: str | Path) -> dict[str, Any]:
    return storage_service.kfx_registry(
        "status", {"controller": CONTROLLER_ID}, runtime_dir
    )


def plan(
    runtime_dir: str | Path, candidate: str | Path, operation: str
) -> dict[str, Any]:
    return storage_service.kfx_registry(
        "plan", _request(candidate, operation), runtime_dir
    )


def apply(
    runtime_dir: str | Path,
    candidate: str | Path,
    control_plan: dict[str, Any],
    authorized_by: str,
) -> dict[str, Any]:
    if not authorized_by.strip():
        raise ValueError("KFX Control authorization identity is required")
    load_plan = control_plan["loadPlan"]
    package = next(
        row for row in load_plan["packages"] if row.get("key") == PACKAGE_KEY
    )
    request = {
        **_request(candidate, str(control_plan["operation"])),
        "expectedCutRoot": load_plan["cutRoot"],
        "expectedRevision": load_plan["revision"],
        "expectedRegistryRoot": load_plan["registryRoot"],
        "expectedGraphRoot": load_plan["graphRoot"],
        "expectedPlanRoot": load_plan["planRoot"],
        "expectedTrustRoot": package["trustRoot"],
        "expectedPackageRoot": package["packageRoot"],
        "expectedControlPlanRoot": control_plan["controlPlanRoot"],
        "expectedBootstrapPolicyRoot": control_plan["bootstrapPolicyRoot"],
        "authorizationId": authorized_by.strip(),
        "actor": authorized_by.strip(),
    }
    return storage_service.kfx_registry("apply", request, runtime_dir)
