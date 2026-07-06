# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
from typing import Any

from .parser import SkillError, parse_skill


def skill_roots(home: str, extra_paths: list[str] | None = None) -> list[str]:
    roots: list[str] = []
    env_path = os.environ.get("KF_SKILL_PATH")
    if env_path:
        roots.extend(path for path in env_path.split(os.pathsep) if path)
    if extra_paths:
        roots.extend(extra_paths)
    roots.append(os.path.join(home, "skills"))
    return roots


def discover_skills(
    home: str, extra_paths: list[str] | None = None
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for root in skill_roots(home, extra_paths):
        for skill_dir in _candidate_skill_dirs(root):
            try:
                skill = parse_skill(skill_dir)
            except SkillError:
                continue
            if skill["key"] in seen:
                continue
            seen.add(skill["key"])
            rows.append(skill)
    return rows


def find_skill(
    home: str, key_or_path: str, extra_paths: list[str] | None = None
) -> dict[str, Any]:
    if os.path.exists(key_or_path):
        return parse_skill(key_or_path)
    for skill in discover_skills(home, extra_paths):
        if skill["key"] == key_or_path:
            return skill
    raise SkillError(f"skill not found: {key_or_path}")


def read_skill_markdown(
    home: str, key_or_path: str, extra_paths: list[str] | None = None
) -> tuple[dict[str, Any], str]:
    skill = find_skill(home, key_or_path, extra_paths)
    with open(skill["source"]["path"], encoding="utf-8") as f:
        return skill, f.read()


def _candidate_skill_dirs(root: str) -> list[str]:
    if not root or not os.path.exists(root):
        return []
    root = os.path.abspath(root)
    if os.path.isfile(os.path.join(root, "SKILL.md")):
        return [root]
    if not os.path.isdir(root):
        return []
    rows: list[str] = []
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if os.path.isdir(path) and os.path.isfile(os.path.join(path, "SKILL.md")):
            rows.append(path)
    return rows
