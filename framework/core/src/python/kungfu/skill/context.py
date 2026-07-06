# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any


def build_context_envelope(
    catalog: dict[str, Any], session: Mapping[str, Any]
) -> dict[str, Any]:
    advertised = json.dumps(
        catalog.get("skills", []),
        sort_keys=True,
        separators=(",", ":"),
    )
    return {
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
