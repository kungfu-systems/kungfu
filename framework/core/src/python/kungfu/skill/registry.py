# SPDX-License-Identifier: Apache-2.0

"""Content-addressed Kungfu Skill registry lifecycle facade.

The facade owns lifecycle planning, the fenced writer, state transitions, and
read APIs. Content verification and durable persistence primitives live in the
private registry support owner.
"""

from __future__ import annotations

import copy
import hashlib as hashlib
import json as json
import os
import shutil
import tempfile as tempfile
import unicodedata
from pathlib import Path, PurePosixPath as PurePosixPath
from typing import Any, Mapping, cast

from kungfu.canonical_json import canonical_json_bytes as canonical_json_bytes
from kungfu.coordination import locks
from kungfu.skill import contract as skill_contract
from kungfu.skill.parser import SkillError, parse_skill
from kungfu.skill._registry.support import (
    STATE_SCHEMA as STATE_SCHEMA,
    PLAN_SCHEMA as PLAN_SCHEMA,
    RECEIPT_SCHEMA as RECEIPT_SCHEMA,
    REPORT_SCHEMA as REPORT_SCHEMA,
    HISTORY_SCHEMA as HISTORY_SCHEMA,
    DIAGNOSIS_SCHEMA as DIAGNOSIS_SCHEMA,
    DIFF_SCHEMA as DIFF_SCHEMA,
    DEPENDENCY_COORDINATES_SCHEMA as DEPENDENCY_COORDINATES_SCHEMA,
    DEFINITION_NAMES as DEFINITION_NAMES,
    MUTATIONS as MUTATIONS,
    SkillRegistryError as SkillRegistryError,
    _blank_state as _blank_state,
    _load_state as _load_state,
    _state_with_root as _state_with_root,
    _semantic_failure as _semantic_failure,
    _stage_package as _stage_package,
    _publish_package as _publish_package,
    _build_receipt as _build_receipt,
    _publish_receipt_and_history as _publish_receipt_and_history,
    _receipt_path as _receipt_path,
    _write_immutable_json as _write_immutable_json,
    _write_json_atomic as _write_json_atomic,
    _read_json as _read_json,
    _read_json_required as _read_json_required,
    _verify_receipt as _verify_receipt,
    _verify_published_payload as _verify_published_payload,
    _fsync_directory as _fsync_directory,
    _root as _root,
    _bytes_root as _bytes_root,
    _require_root as _require_root,
    _closure_root as _closure_root,
    _validate_member_path as _validate_member_path,
    _active_content_root as _active_content_root,
    _affected as _affected,
    _rollback_guidance as _rollback_guidance,
    _diff_values as _diff_values,
)


_COMPATIBILITY_EXPORTS = (
    hashlib,
    json,
    tempfile,
    PurePosixPath,
    canonical_json_bytes,
    _write_immutable_json,
    _write_json_atomic,
    _verify_published_payload,
    _fsync_directory,
)


_MOVED_CALLABLE_SYMBOLS = (
    "SkillRegistryError _blank_state _load_state _state_with_root _semantic_failure "
    "_stage_package _publish_package _build_receipt _publish_receipt_and_history "
    "_receipt_path _write_immutable_json _write_json_atomic _read_json "
    "_read_json_required _verify_receipt _verify_published_payload _fsync_directory "
    "_root _bytes_root _require_root _closure_root _validate_member_path "
    "_active_content_root _affected _rollback_guidance _diff_values"
).split()
for _symbol in _MOVED_CALLABLE_SYMBOLS:
    globals()[_symbol].__module__ = __name__
    globals()[_symbol].__qualname__ = _symbol


def registry_root(home: str | os.PathLike[str]) -> Path:
    return Path(home).resolve() / "skill-registry" / "v2"


def plan_operation(
    home: str | os.PathLike[str],
    operation: str,
    *,
    key: str | None = None,
    source: str | os.PathLike[str] | None = None,
    work_ref: str | None = None,
    work_root: str | None = None,
    target_revision: int | None = None,
) -> dict[str, Any]:
    """Build a read-only, exact-basis lifecycle mutation plan."""

    if operation not in MUTATIONS:
        raise SkillRegistryError("unsupported-operation", operation)
    state = _load_state(registry_root(home))
    package = normalize_package(source) if source is not None else None
    if package is not None:
        package_key = package["definition"]["identity"]["key"]
        if key is not None and key != package_key:
            raise SkillRegistryError(
                "identity-mismatch", f"requested {key!r}, package is {package_key!r}"
            )
        key = package_key
    if not key:
        raise SkillRegistryError("skill-key-required", "the operation requires a key")

    request: dict[str, Any] = {"key": key}
    if package is not None:
        request["sourcePath"] = package["sourcePath"]
        request["definition"] = package["definition"]
        request["definitionRoot"] = package["definitionRoot"]
        request["contentRoot"] = package["contentRoot"]
    if work_ref is not None:
        if not work_ref.strip():
            raise SkillRegistryError("work-ref-required", "Work ref cannot be empty")
        request["workRef"] = work_ref
    if work_root is not None:
        _require_root(work_root, "work-root-invalid")
        request["workRoot"] = work_root
    if target_revision is not None:
        request["targetRevision"] = int(target_revision)

    basis = {"generation": state["generation"], "stateRoot": state["stateRoot"]}
    operation_root = _root(
        {
            "schema": "kungfu.skill-lifecycle-operation/v2",
            "operation": operation,
            "basis": basis,
            "request": request,
        }
    )
    next_state, changed = _fold(state, operation, request, operation_root)
    plan: dict[str, Any] = {
        "schema": PLAN_SCHEMA,
        "operation": operation,
        "execute": False,
        "basis": basis,
        "request": request,
        "operationRoot": operation_root,
        "affected": _affected(operation, request, state, next_state),
        "changed": changed,
        "next": {
            "generation": next_state["generation"],
            "stateRoot": next_state["stateRoot"],
        },
        "rollback": _rollback_guidance(operation, request, state),
        "recovery": {
            "policy": "rerun-the-exact-plan-root",
            "history": "retain-roots-receipts-work-bindings-and-kfx-coordinates",
        },
    }
    plan["planRoot"] = _root(plan)
    skill_contract.validate_lifecycle_plan_v2(plan)
    return plan


def apply_plan(
    home: str | os.PathLike[str],
    plan: Mapping[str, Any],
    *,
    expected_plan_root: str,
    fault: str | None = None,
) -> dict[str, Any]:
    """Apply one exact plan through the fenced writer and atomic publish cut."""

    plan_dict: dict[str, Any] = copy.deepcopy(dict(plan))
    supplied_root = str(plan_dict.pop("planRoot", ""))
    actual_root = _root(plan_dict)
    plan_dict["planRoot"] = supplied_root
    if supplied_root != actual_root or expected_plan_root != actual_root:
        raise SkillRegistryError(
            "plan-root-mismatch",
            f"expected {expected_plan_root!r}, supplied {supplied_root!r}, actual {actual_root!r}",
        )
    if (
        plan_dict.get("schema") != PLAN_SCHEMA
        or plan_dict.get("operation") not in MUTATIONS
    ):
        raise SkillRegistryError("invalid-plan", "not a Skill lifecycle v2 plan")
    skill_contract.validate_lifecycle_plan_v2(plan_dict)
    plan = plan_dict

    root = registry_root(home)
    receipt_path = _receipt_path(root, actual_root)
    retained = _read_json(receipt_path)
    if retained is not None:
        _verify_receipt(retained)
        return retained

    package = None
    if "sourcePath" in plan["request"]:
        package = normalize_package(plan["request"]["sourcePath"])
        for field in ("definition", "definitionRoot", "contentRoot"):
            if package[field] != plan["request"][field]:
                raise SkillRegistryError(
                    "source-drift", f"package {field} changed after planning"
                )

    root.mkdir(parents=True, exist_ok=True)
    if not locks.try_acquire(root / "locks", "skill-registry-writer"):
        raise SkillRegistryError(
            "writer-busy", "another Skill lifecycle writer holds the fence"
        )
    try:
        retained = _read_json(receipt_path)
        if retained is not None:
            _verify_receipt(retained)
            return retained
        current = _load_state(root)
        if current["stateRoot"] == plan["next"]["stateRoot"] and any(
            row.get("operationRoot") == plan["operationRoot"]
            for row in current.get("events", [])
        ):
            receipt = _build_receipt(plan, current, recovered=True)
            _publish_receipt_and_history(root, receipt, current)
            return receipt
        if (
            current["stateRoot"] != plan["basis"]["stateRoot"]
            or current["generation"] != plan["basis"]["generation"]
        ):
            raise SkillRegistryError(
                "stale-plan",
                "registry root or generation changed after this plan was built",
            )

        replay = plan_operation(
            home,
            str(plan["operation"]),
            key=str(plan["request"]["key"]),
            source=plan["request"].get("sourcePath"),
            work_ref=plan["request"].get("workRef"),
            work_root=plan["request"].get("workRoot"),
            target_revision=plan["request"].get("targetRevision"),
        )
        if replay["planRoot"] != actual_root:
            raise SkillRegistryError(
                "plan-replay-mismatch", "the exact plan no longer replays"
            )
        next_state, _ = _fold(
            current,
            str(plan["operation"]),
            dict(plan["request"]),
            str(plan["operationRoot"]),
        )

        staging: Path | None = None
        try:
            if package is not None:
                staging = _stage_package(root, package)
                if fault == "after-staging":
                    raise RuntimeError("injected crash after staging")
                _publish_package(root, package, staging)
                staging = None
                if fault == "after-payload":
                    raise RuntimeError("injected crash after payload publish")
            _write_json_atomic(root / "state.json", next_state)
            if fault == "after-state":
                raise RuntimeError("injected crash after state publish")
        finally:
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)

        receipt = _build_receipt(plan, next_state, recovered=False)
        _publish_receipt_and_history(root, receipt, next_state)
        return receipt
    finally:
        locks.release(root / "locks", "skill-registry-writer")


def normalize_package(source: str | os.PathLike[str] | None) -> dict[str, Any]:
    """Validate and normalize one complete, manifest-declared Skill package."""

    if source is None:
        raise SkillRegistryError("source-required", "install or update needs a package")
    source_path = Path(source).resolve()
    if not source_path.is_dir():
        raise SkillRegistryError("source-not-directory", str(source_path))
    manifests = [
        source_path / name
        for name in DEFINITION_NAMES
        if (source_path / name).is_file()
    ]
    if len(manifests) != 1:
        raise SkillRegistryError(
            "definition-count",
            f"expected exactly one of {', '.join(DEFINITION_NAMES)}",
        )
    manifest = manifests[0]
    definition = _read_json_required(manifest)
    try:
        skill_contract.validate_definition_v2(definition)
    except (ValueError, KeyError) as error:
        raise SkillRegistryError("definition-schema-invalid", str(error)) from error
    semantic = _semantic_failure(definition)
    if semantic:
        raise SkillRegistryError(semantic, "Skill v2 semantic contract rejected")

    declared = {row["path"]: row for row in definition["content"]["members"]}
    observed: dict[str, dict[str, Any]] = {}
    collision_keys: dict[str, str] = {}
    for parent, dirs, files in os.walk(source_path, followlinks=False):
        parent_path = Path(parent)
        for name in list(dirs):
            path = parent_path / name
            if path.is_symlink():
                raise SkillRegistryError("path-escape", f"symlink directory: {path}")
        for name in files:
            path = parent_path / name
            if path == manifest:
                continue
            if path.is_symlink() or not path.is_file():
                raise SkillRegistryError("path-escape", f"non-regular member: {path}")
            rel = path.relative_to(source_path).as_posix()
            _validate_member_path(rel)
            if rel == "kfx" or rel.startswith("kfx/"):
                raise SkillRegistryError(
                    "kfx-payload-forbidden",
                    "Skill packages bind exact KFX coordinates; they never contain KFX bodies",
                )
            folded = unicodedata.normalize("NFC", rel).casefold()
            if folded in collision_keys:
                raise SkillRegistryError(
                    "path-collision",
                    f"{collision_keys[folded]!r} collides with {rel!r}",
                )
            collision_keys[folded] = rel
            raw = path.read_bytes()
            row = declared.get(rel)
            if row is None:
                raise SkillRegistryError("undeclared-payload", rel)
            observed[rel] = {
                "path": rel,
                "root": _bytes_root(raw),
                "bytes": len(raw),
                "mediaType": row["mediaType"],
            }
    missing = sorted(set(declared) - set(observed))
    if missing:
        raise SkillRegistryError("incomplete-closure", ", ".join(missing))
    members = [observed[path] for path in sorted(observed)]
    if members != definition["content"]["members"]:
        raise SkillRegistryError(
            "member-metadata-mismatch",
            "declared member roots, bytes, paths, or order do not match package bytes",
        )
    content_root = _closure_root(definition["content"]["entrypoint"], members)
    if content_root != definition["content"]["root"]:
        raise SkillRegistryError("content-root-mismatch", content_root)
    return {
        "sourcePath": str(source_path),
        "manifestName": manifest.name,
        "definition": definition,
        "definitionRoot": _root(definition),
        "contentRoot": content_root,
        "members": members,
    }


def inspect_registry(
    home: str | os.PathLike[str], key: str | None = None
) -> dict[str, Any]:
    root = registry_root(home)
    state = _load_state(root)
    entries = state["entries"]
    if key is not None:
        if key not in entries:
            raise SkillRegistryError("skill-not-found", key)
        entries = {key: entries[key]}
    active_paths = []
    for entry in entries.values():
        revision = entry.get("activeRevision")
        if revision is None or not entry.get("activeReference"):
            continue
        record = entry["revisions"][str(revision)]
        active_paths.append(str(root / record["payloadRef"]))
    report = {
        "schema": REPORT_SCHEMA,
        "authority": "python-single-writer-skill-registry-fold",
        "stateRoot": state["stateRoot"],
        "generation": state["generation"],
        "entries": copy.deepcopy(entries),
        "activePayloadPaths": sorted(active_paths),
        "kfxRegistry": str(Path(home).resolve() / "extensions"),
        "nonClaims": [
            "work-authority",
            "profile-authority",
            "fact-or-episode-authority",
            "kfx-package-or-capability-authority",
        ],
    }
    report["reportRoot"] = _root(report)
    return report


def active_payload_paths(home: str | os.PathLike[str]) -> list[str]:
    return list(inspect_registry(home)["activePayloadPaths"])


def active_payload_bindings(home: str | os.PathLike[str]) -> dict[str, str]:
    report = inspect_registry(home)
    root = registry_root(home)
    bindings: dict[str, str] = {}
    for key, entry in report["entries"].items():
        revision = entry.get("activeRevision")
        if revision is None or not entry.get("activeReference"):
            continue
        record = entry["revisions"][str(revision)]
        bindings[str(root / record["payloadRef"])] = key
    return bindings


def dependency_coordinates(home: str | os.PathLike[str], key: str) -> dict[str, Any]:
    """Read exact dependency coordinates without resolving or admitting them."""

    root = registry_root(home)
    state = _load_state(root)
    entry = state["entries"].get(key)
    if entry is None or not entry.get("activeReference"):
        raise SkillRegistryError("skill-not-found", key)
    revision = entry.get("activeRevision")
    if revision is None:
        raise SkillRegistryError("no-active-reference", key)
    record = entry["revisions"][str(revision)]
    definition = _read_json_required(root / record["definitionRef"])
    if _root(definition) != record["definitionRoot"]:
        raise SkillRegistryError("definition-root-mismatch", f"{key}@{revision}")
    result = {
        "schema": DEPENDENCY_COORDINATES_SCHEMA,
        "authority": "python-single-writer-skill-registry-fold",
        "skill": {
            "key": key,
            "revision": revision,
            "contentRoot": record["contentRoot"],
            "definitionRoot": record["definitionRoot"],
            "class": record["class"],
        },
        "dependencies": copy.deepcopy(definition["dependencies"]),
        "effects": copy.deepcopy(definition["effects"]),
        "kfxRegistry": str(Path(home).resolve() / "extensions"),
        "admission": "not-evaluated",
        "nonClaims": [
            "dependency-coordinate-is-not-kfx-admission",
            "dependency-coordinate-is-not-profile-authority",
            "skill-registry-does-not-own-kfx-package-bodies",
        ],
    }
    result["coordinatesRoot"] = _root(result)
    return result


def registry_history(
    home: str | os.PathLike[str], key: str | None = None
) -> dict[str, Any]:
    root = registry_root(home)
    state = _load_state(root)
    events = [
        copy.deepcopy(row)
        for row in state["events"]
        if key is None or row.get("key") == key
    ]
    receipts = []
    receipt_root = root / "receipts"
    if receipt_root.is_dir():
        for path in sorted(receipt_root.glob("*.json")):
            row = _read_json(path)
            if row is not None and (
                key is None or row.get("affected", {}).get("key") == key
            ):
                _verify_receipt(row)
                receipts.append(row)
    result = {
        "schema": HISTORY_SCHEMA,
        "stateRoot": state["stateRoot"],
        "generation": state["generation"],
        "events": events,
        "receipts": receipts,
    }
    result["historyRoot"] = _root(result)
    return result


def diagnose_registry(home: str | os.PathLike[str]) -> dict[str, Any]:
    root = registry_root(home)
    issues: list[dict[str, str]] = []
    try:
        state = _load_state(root)
    except SkillRegistryError as error:
        state = _blank_state()
        issues.append({"code": error.code, "detail": str(error)})
    for key, entry in state["entries"].items():
        for revision, record in entry["revisions"].items():
            definition_path = root / record["definitionRef"]
            definition = _read_json(definition_path)
            if definition is None or _root(definition) != record["definitionRoot"]:
                issues.append(
                    {
                        "code": "definition-missing-or-corrupt",
                        "detail": f"{key}@{revision}",
                    }
                )
                continue
            payload = root / record["payloadRef"]
            observed_members = []
            for member in definition["content"]["members"]:
                path = payload / member["path"]
                if (
                    not path.is_file()
                    or _bytes_root(path.read_bytes()) != member["root"]
                ):
                    issues.append(
                        {
                            "code": "payload-missing-or-corrupt",
                            "detail": f"{key}@{revision}:{member['path']}",
                        }
                    )
                else:
                    observed_members.append(member)
            if (
                len(observed_members) == len(definition["content"]["members"])
                and _closure_root(definition["content"]["entrypoint"], observed_members)
                != record["contentRoot"]
            ):
                issues.append(
                    {
                        "code": "payload-closure-root-mismatch",
                        "detail": f"{key}@{revision}",
                    }
                )
    staging = root / "staging"
    leftovers = (
        sorted(str(path) for path in staging.iterdir()) if staging.is_dir() else []
    )
    result = {
        "schema": DIAGNOSIS_SCHEMA,
        "verdict": "pass" if not issues else "fail",
        "stateRoot": state["stateRoot"],
        "generation": state["generation"],
        "issues": issues,
        "recoverableStaging": leftovers,
        "recovery": "remove only unreferenced staging after inspection; immutable roots and history stay retained",
    }
    result["diagnosisRoot"] = _root(result)
    return result


def diff_revisions(
    home: str | os.PathLike[str], key: str, left: int, right: int
) -> dict[str, Any]:
    state = _load_state(registry_root(home))
    entry = state["entries"].get(key)
    if entry is None:
        raise SkillRegistryError("skill-not-found", key)
    definitions = []
    for revision in (left, right):
        record = entry["revisions"].get(str(revision))
        if record is None:
            raise SkillRegistryError("revision-not-found", f"{key}@{revision}")
        definitions.append(
            _read_json_required(registry_root(home) / record["definitionRef"])
        )
    changes: list[dict[str, Any]] = []
    _diff_values("", definitions[0], definitions[1], changes)
    result = {
        "schema": DIFF_SCHEMA,
        "key": key,
        "leftRevision": left,
        "rightRevision": right,
        "changes": changes,
    }
    result["diffRoot"] = _root(result)
    return result


def _fold(
    state: Mapping[str, Any],
    operation: str,
    request: Mapping[str, Any],
    operation_root: str,
) -> tuple[dict[str, Any], bool]:
    next_state = copy.deepcopy(dict(state))
    key = str(request["key"])
    entries = next_state["entries"]
    entry = entries.get(key)
    changed = True

    if operation in {"install", "update"}:
        definition = request.get("definition")
        if not isinstance(definition, dict):
            raise SkillRegistryError("definition-required", operation)
        identity = definition["identity"]
        revision = int(identity["revision"])
        content_root = str(request["contentRoot"])
        if operation == "install" and entry is not None:
            existing = entry["revisions"].get(str(revision))
            if existing and existing["contentRoot"] == content_root:
                changed = False
            else:
                raise SkillRegistryError("already-installed", key)
        elif operation == "update":
            if entry is None or entry.get("activeRevision") is None:
                raise SkillRegistryError("not-installed", key)
            current_revision = int(entry["activeRevision"])
            current = entry["revisions"][str(current_revision)]
            existing = entry["revisions"].get(str(revision))
            if existing is not None:
                if existing["contentRoot"] != content_root:
                    raise SkillRegistryError(
                        "identity-collision", f"{key}@{revision} has another root"
                    )
                changed = revision != current_revision or entry["status"] != "installed"
            else:
                predecessor = definition["compatibility"]["predecessor"]
                if (
                    revision != current_revision + 1
                    or predecessor is None
                    or predecessor["key"] != key
                    or predecessor["revision"] != current_revision
                    or predecessor["contentRoot"] != current["contentRoot"]
                ):
                    raise SkillRegistryError(
                        "incompatible-revision",
                        "update must name the exact active revision as predecessor",
                    )
        if changed:
            if entry is None:
                entry = {
                    "key": key,
                    "revisions": {},
                    "activeRevision": None,
                    "activeReference": False,
                    "status": "historical",
                    "workSelections": [],
                }
                entries[key] = entry
            digest = content_root.removeprefix("sha256:")
            definition_digest = str(request["definitionRoot"]).removeprefix("sha256:")
            entry["revisions"][str(revision)] = {
                "revision": revision,
                "contentRoot": content_root,
                "definitionRoot": request["definitionRoot"],
                "definitionRef": f"definitions/sha256/{definition_digest}.json",
                "payloadRef": f"payloads/sha256/{digest}",
                "class": definition["class"],
                "provenance": copy.deepcopy(definition["provenance"]),
                "dependencies": copy.deepcopy(definition["dependencies"]),
            }
            entry["activeRevision"] = revision
            entry["activeReference"] = True
            entry["status"] = "installed"
    else:
        if entry is None:
            raise SkillRegistryError("not-installed", key)
        if operation != "rollback" and entry.get("activeRevision") is None:
            if operation == "remove" and entry["status"] == "historical":
                changed = False
            else:
                raise SkillRegistryError("no-active-reference", key)
        if operation == "enable":
            changed = entry["status"] != "enabled"
            entry["status"] = "enabled"
        elif operation == "select":
            work_ref = request.get("workRef")
            if not work_ref:
                raise SkillRegistryError("work-ref-required", key)
            work_root = request.get("workRoot")
            if not work_root:
                raise SkillRegistryError("work-root-required", key)
            _require_root(str(work_root), "work-root-invalid")
            current_revision = int(entry["activeRevision"])
            current = entry["revisions"][str(current_revision)]
            exact = {
                "workRef": work_ref,
                "workRoot": work_root,
                "revision": current_revision,
                "contentRoot": current["contentRoot"],
                "active": True,
            }
            changed = (
                exact not in entry["workSelections"] or entry["status"] != "selected"
            )
            if changed:
                for row in entry["workSelections"]:
                    if row["workRef"] == work_ref:
                        row["active"] = False
                entry["workSelections"].append(exact)
            entry["status"] = "selected"
        elif operation in {"load", "invoke", "suspend", "retire"}:
            target = {
                "load": "loaded",
                "invoke": "invoked",
                "suspend": "suspended",
                "retire": "retired",
            }[operation]
            changed = entry["status"] != target
            entry["status"] = target
        elif operation == "remove":
            changed = (
                entry.get("activeReference", False) or entry["status"] != "historical"
            )
            entry["activeReference"] = False
            entry["activeRevision"] = None
            entry["status"] = "historical"
            for row in entry["workSelections"]:
                row["active"] = False
        elif operation == "rollback":
            rollback_target = request.get("targetRevision")
            if (
                rollback_target is None
                or str(rollback_target) not in entry["revisions"]
            ):
                raise SkillRegistryError(
                    "revision-not-found", f"{key}@{rollback_target}"
                )
            changed = (
                entry.get("activeRevision") != int(rollback_target)
                or entry["status"] != "installed"
            )
            entry["activeRevision"] = int(rollback_target)
            entry["activeReference"] = True
            entry["status"] = "installed"

    if changed:
        next_state["generation"] = int(state["generation"]) + 1
        next_state["events"].append(
            {
                "generation": next_state["generation"],
                "operation": operation,
                "operationRoot": operation_root,
                "key": key,
                "revision": entries[key].get("activeRevision"),
                "contentRoot": _active_content_root(entries[key]),
                "status": entries[key]["status"],
            }
        )
    return _state_with_root(next_state), changed


def skill_roots(home: str, extra_paths: list[str] | None = None) -> list[str]:
    roots: list[str] = []
    env_path = os.environ.get("KF_SKILL_PATH")
    if env_path:
        roots.extend(path for path in env_path.split(os.pathsep) if path)
    if extra_paths:
        roots.extend(extra_paths)
    roots.extend(active_payload_paths(home))
    roots.append(os.path.join(home, "skills"))
    return roots


def discover_skills(
    home: str, extra_paths: list[str] | None = None
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    bindings = active_payload_bindings(home)
    for root in skill_roots(home, extra_paths):
        for skill_dir in _candidate_skill_dirs(root):
            try:
                skill = parse_skill(skill_dir)
            except SkillError:
                continue
            registry_key = bindings.get(os.path.abspath(skill_dir))
            if registry_key:
                skill["key"] = registry_key
            if skill["key"] in seen:
                continue
            seen.add(skill["key"])
            rows.append(skill)
    return rows


def find_skill(
    home: str, key_or_path: str, extra_paths: list[str] | None = None
) -> dict[str, Any]:
    if os.path.exists(key_or_path):
        return cast(dict[str, Any], parse_skill(key_or_path))
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
