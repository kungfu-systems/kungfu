# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from kungfu.config import resolve_config


def build_context_envelope(
    catalog: dict[str, Any],
    session: Mapping[str, Any],
    kungfu: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    advertised = json.dumps(
        catalog.get("skills", []),
        sort_keys=True,
        separators=(",", ":"),
    )
    envelope = {
        "schema": "kungfu.skill-context/v1",
        "session": dict(session),
        "catalog": list(catalog.get("skills", [])),
        "tools": [
            {
                "name": "kungfu.skill.read",
                "description": "Load the full SKILL.md for a selected skill key.",
            }
        ],
        "audit": {
            "advertisedSkillsHash": "sha256:"
            + hashlib.sha256(advertised.encode()).hexdigest(),
        },
    }
    if kungfu:
        envelope["kungfu"] = kungfu
    return envelope


def build_kungfu_environment(
    home: str,
    *,
    source: str | None = None,
    extra_paths: list[str] | None = None,
    runtime_dir: str | None = None,
    env: Mapping[str, str] | None = None,
    cwd: str | None = None,
) -> dict[str, str]:
    del extra_paths, runtime_dir, cwd
    config = resolve_config(runtime_home=home, env=env)
    return {
        "schema": "kungfu.environment/v1",
        "environment": "test" if source == "test" else "managed-run",
        "agentEntrypoint": config["config"]["agent"]["entrypoint"],
    }
