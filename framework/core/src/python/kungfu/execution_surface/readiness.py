# SPDX-License-Identifier: Apache-2.0

"""Coordinator readiness and running-state projection."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any


def coordinator_ready(status: Mapping[str, Any]) -> bool:
    """Require verified process identities and the matching native-ready state."""

    lifecycle = status.get("lifecycle") or {}
    supervisor = status.get("supervisor") or {}
    coordinator = status.get("coordinator") or {}
    last_state = status.get("lastState") or {}
    return all(
        (
            lifecycle.get("healthy") is True,
            supervisor.get("identityVerified") is True,
            coordinator.get("identityVerified") is True,
            last_state.get("status") == "coordinator-running",
            last_state.get("coordinatorPid") == coordinator.get("pid"),
        )
    )


def coordinator_running_state(
    *,
    schema: str,
    home: str,
    runtime_dir: str,
    authority: Mapping[str, Any],
    pid: int,
    start_identity: Any,
    runtime_image: Mapping[str, Any] | None,
    updated_at: str,
) -> dict[str, Any]:
    """Project ready state only after the native coordinator is constructed."""

    return {
        "schema": schema,
        "status": "coordinator-running",
        "home": home,
        "runtimeDir": runtime_dir,
        **authority,
        "coordinatorPid": pid,
        "coordinatorStartIdentity": start_identity,
        "runtimeImage": copy.deepcopy(dict(runtime_image))
        if runtime_image is not None
        else None,
        "updatedAt": updated_at,
    }
