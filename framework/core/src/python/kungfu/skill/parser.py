# SPDX-License-Identifier: Apache-2.0

import hashlib
import os
import re
from typing import Any


class SkillError(ValueError):
    pass


def parse_skill(skill_dir):
    root = os.path.abspath(skill_dir)
    if not os.path.isdir(root):
        raise SkillError(f"skill path is not a directory: {skill_dir}")
    skill_path = os.path.join(root, "SKILL.md")
    if not os.path.isfile(skill_path):
        raise SkillError(f"missing SKILL.md: {skill_path}")
    with open(skill_path, encoding="utf-8") as f:
        markdown = f.read()
    frontmatter, body = _split_frontmatter(markdown)
    title = _string(frontmatter.get("title")) or _first_heading(body)
    title = title or os.path.basename(root)
    description = _string(frontmatter.get("description")) or _first_paragraph(body)
    capabilities = _string_list(frontmatter.get("capabilities"))
    kfx = _kfx_dependencies(frontmatter.get("kfx"))
    return {
        "schema": "kungfu.skill/v1",
        "key": _string(frontmatter.get("key"))
        or _normalize_key(os.path.basename(root)),
        "title": title,
        "description": description or "",
        "kind": "kfx-backed" if capabilities or kfx else "instruction-only",
        "triggers": _string_list(frontmatter.get("triggers")),
        "capabilities": capabilities,
        "kfx": kfx,
        "source": {
            "path": skill_path,
            "hash": "sha256:" + hashlib.sha256(markdown.encode()).hexdigest(),
        },
    }


def _split_frontmatter(markdown):
    if not markdown.startswith("---\n"):
        return {}, markdown
    end = markdown.find("\n---\n", 4)
    if end < 0:
        return {}, markdown
    return _parse_simple_yaml(markdown[4:end]), markdown[end + 5 :]


def _parse_simple_yaml(src):
    root = {}
    current_key = None
    current_array: list[Any] | None = None
    current_object = None
    for raw in src.splitlines():
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        list_match = re.match(r"^  -\s+(.*)$", raw)
        if list_match and current_key and current_array is not None:
            value = list_match.group(1)
            kv = re.match(r"^([A-Za-z0-9_.-]+):\s*(.*)$", value)
            if kv:
                current_object = {kv.group(1): _strip_quotes(kv.group(2))}
                current_array.append(current_object)
            else:
                current_object = None
                current_array.append(_strip_quotes(value))
            continue
        nested_match = re.match(r"^    ([A-Za-z0-9_.-]+):\s*(.*)$", raw)
        if nested_match and current_object is not None:
            current_object[nested_match.group(1)] = _strip_quotes(nested_match.group(2))
            continue
        scalar_match = re.match(r"^([A-Za-z0-9_.-]+):\s*(.*)$", raw)
        if not scalar_match:
            continue
        current_key = scalar_match.group(1)
        current_object = None
        value = scalar_match.group(2)
        if value == "":
            current_array = []
            root[current_key] = current_array
        else:
            current_array = None
            root[current_key] = _strip_quotes(value)
    return root


def _first_heading(body):
    for line in body.splitlines():
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            return match.group(1)
    return None


def _first_paragraph(body):
    without_title = re.sub(r"^#\s+.+$", "", body, count=1, flags=re.MULTILINE)
    for chunk in re.split(r"\n\s*\n", without_title):
        paragraph = re.sub(r"\s+", " ", chunk).strip()
        if paragraph:
            return paragraph
    return None


def _normalize_key(value):
    key = re.sub(r"[^a-z0-9_.-]+", "-", value.strip().lower())
    key = key.strip("-")
    return key or "skill"


def _strip_quotes(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def _string(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def _string_list(value):
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _kfx_dependencies(value):
    if not isinstance(value, list):
        return []
    rows = []
    for item in value:
        if not isinstance(item, dict) or not _string(item.get("key")):
            continue
        row = dict(item)
        row["key"] = str(row["key"])
        rows.append(row)
    return rows
