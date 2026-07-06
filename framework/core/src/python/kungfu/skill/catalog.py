# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def catalog_entry(skill: dict[str, Any]) -> dict[str, Any]:
    return {
        "key": skill["key"],
        "title": skill["title"],
        "description": skill["description"],
        "kind": skill["kind"],
        "triggers": list(skill.get("triggers", [])),
        "capabilities": list(skill.get("capabilities", [])),
        "kfx": list(skill.get("kfx", [])),
        "loadPolicy": "on-demand",
        "sourceHash": skill["source"]["hash"],
    }


def build_catalog(skills: Iterable[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema": "kungfu.skill-catalog/v1",
        "skills": [catalog_entry(skill) for skill in skills],
    }
