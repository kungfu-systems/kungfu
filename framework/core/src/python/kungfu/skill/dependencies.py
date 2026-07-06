# SPDX-License-Identifier: Apache-2.0

import json
import os

from kungfu import kfx_contract


DEPENDENCY_SCHEMA = "kungfu.skill-dependencies/v1"


def skill_binding_root(home):
    return os.path.join(home, "skill-bindings")


def skill_binding_path(home, skill_key):
    return os.path.join(skill_binding_root(home), f"{skill_key}.json")


def build_skill_dependency_binding(home, skill):
    rows = [_dependency_row(home, skill, dep) for dep in skill.get("kfx", [])]
    resolved = sum(1 for row in rows if row["status"] == "resolved")
    return {
        "schema": DEPENDENCY_SCHEMA,
        "skill": {
            "key": skill["key"],
            "title": skill["title"],
            "kind": skill["kind"],
            "sourceHash": skill["source"]["hash"],
            "sourcePath": skill["source"]["path"],
        },
        "registry": {
            "type": "kfx",
            "root": _kfx_registry_root(home),
        },
        "dependencies": rows,
        "summary": {
            "total": len(rows),
            "resolved": resolved,
            "unresolved": len(rows) - resolved,
        },
    }


def write_skill_dependency_binding(home, skill):
    document = build_skill_dependency_binding(home, skill)
    path = skill_binding_path(home, skill["key"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(document, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    return path, document


def read_skill_dependency_binding(home, skill_key):
    path = skill_binding_path(home, skill_key)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _dependency_row(home, skill, dep):
    key = str(dep["key"])
    package_dir = os.path.join(_kfx_registry_root(home), key)
    resolved = _resolve_kfx_package(package_dir, key)
    version = dep.get("version")
    if version is not None:
        version = str(version)
    status = "resolved" if resolved else "unresolved"
    reason = None
    if resolved and version and resolved.get("version") != version:
        status = "unresolved"
        reason = f"installed version {resolved.get('version')} does not match {version}"
    elif not resolved:
        reason = "not installed in kfx registry"
    row = {
        "skillKey": skill["key"],
        "kfxKey": key,
        "role": dep.get("role"),
        "version": version,
        "required": _bool(dep.get("required"), True),
        "status": status,
        "registryKey": key,
        "registryPath": package_dir,
    }
    for extra_key, extra_value in sorted(dep.items()):
        if extra_key not in {"key", "role", "version", "required"}:
            row[extra_key] = extra_value
    if resolved:
        row["package"] = resolved
    if reason:
        row["reason"] = reason
    return row


def _resolve_kfx_package(package_dir, expected_key):
    return kfx_contract.resolve_kfx_package(package_dir, expected_key)


def _kfx_registry_root(home):
    return os.path.join(home, "extensions")


def _bool(value, default):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "yes", "1"}:
            return True
        if normalized in {"false", "no", "0"}:
            return False
    return default
