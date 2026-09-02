# SPDX-License-Identifier: Apache-2.0

"""Content verification and durable persistence primitives for Skill registry."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import tempfile
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

from kungfu.canonical_json import canonical_json_bytes
from kungfu.skill import contract as skill_contract


STATE_SCHEMA = "kungfu.skill-registry-state/v2"
PLAN_SCHEMA = "kungfu.skill-lifecycle-plan/v2"
RECEIPT_SCHEMA = "kungfu.skill-lifecycle-receipt/v2"
REPORT_SCHEMA = "kungfu.skill-registry-report/v2"
HISTORY_SCHEMA = "kungfu.skill-registry-history/v2"
DIAGNOSIS_SCHEMA = "kungfu.skill-registry-diagnosis/v2"
DIFF_SCHEMA = "kungfu.skill-registry-diff/v2"
DEPENDENCY_COORDINATES_SCHEMA = "kungfu.skill-dependency-coordinates/v2"
DEFINITION_NAMES = ("skill-definition.json", "kungfu.skill.json")
MUTATIONS = {
    "install",
    "update",
    "enable",
    "select",
    "load",
    "invoke",
    "suspend",
    "retire",
    "remove",
    "rollback",
}


class SkillRegistryError(ValueError):
    """Stable, machine-readable failure from the Skill registry."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _blank_state() -> dict[str, Any]:
    return _state_with_root(
        {"schema": STATE_SCHEMA, "generation": 0, "entries": {}, "events": []}
    )


def _load_state(root: Path) -> dict[str, Any]:
    path = root / "state.json"
    if not path.exists():
        return _blank_state()
    state = _read_json_required(path)
    if state.get("schema") != STATE_SCHEMA:
        raise SkillRegistryError("state-schema-invalid", str(path))
    skill_contract.validate_registry_state_v2(state)
    expected = state.get("stateRoot")
    actual = _state_with_root(state)["stateRoot"]
    if expected != actual:
        raise SkillRegistryError(
            "state-root-mismatch", f"expected {expected!r}, actual {actual!r}"
        )
    return state


def _state_with_root(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    result.pop("stateRoot", None)
    result["stateRoot"] = _root(result)
    return result


def _semantic_failure(document: Mapping[str, Any]) -> str | None:
    work = document.get("scope", {}).get("work", {})
    if (
        not document.get("scope", {}).get("distribution")
        or not document.get("scope", {}).get("appliesTo")
        or not work.get("binding")
        or work.get("selectionAuthority") != "kungfu-work"
        or work.get("completionAuthority") != "kungfu-work"
    ):
        return "ambiguous-scope"
    if (
        document.get("compatibility", {}).get("history") != "preserve-original-meaning"
        or document.get("recovery", {}).get("history")
        != "preserve-roots-receipts-and-work-meaning"
    ):
        return "history-reinterpretation"
    authority = document.get("authority", {})
    if any(
        authority.get(name) != "reference-only"
        for name in ("work", "profile", "factEpisode", "kfd", "kfx")
    ):
        return "duplicate-authority"
    kfx = document.get("dependencies", {}).get("kfx", [])
    profiles = document.get("dependencies", {}).get("profiles", [])
    effects = document.get("effects", {})
    skill_class = document.get("class")
    if skill_class == "instruction-only" and (
        kfx
        or profiles
        or effects.get("mode") != "none"
        or authority.get("capability") != "none"
    ):
        return "class-capability-mismatch"
    if skill_class == "operational" and (
        not kfx
        or profiles
        or authority.get("capability") != "separate-kfx-admission-required"
    ):
        return "class-capability-mismatch"
    if skill_class == "domain" and (
        not profiles
        or (kfx and authority.get("capability") != "separate-kfx-admission-required")
    ):
        return "class-capability-mismatch"
    members = document.get("content", {}).get("members", [])
    paths = [row.get("path") for row in members]
    if (
        document.get("content", {}).get("entrypoint") not in paths
        or len(paths) != len(set(paths))
        or paths != sorted(paths)
    ):
        return "incomplete-content-root"
    closure_root = _closure_root(document["content"]["entrypoint"], members)
    if (
        document.get("content", {}).get("root") != closure_root
        or document.get("identity", {}).get("contentRoot") != closure_root
    ):
        return "content-root-mismatch"
    predecessor = document.get("compatibility", {}).get("predecessor")
    revision = document.get("identity", {}).get("revision")
    if predecessor is None and revision != 1:
        return "mutable-identity"
    if predecessor and (
        predecessor.get("key") != document.get("identity", {}).get("key")
        or predecessor.get("revision", 0) + 1 != revision
        or predecessor.get("contentRoot") == closure_root
    ):
        return "mutable-identity"
    dependency_refs = {
        f"kfx:{row['key']}@{row['revision']}#{row['root']}" for row in kfx
    } | {f"profile:{row['id']}@{row['revision']}#{row['root']}" for row in profiles}
    if any(
        row.get("authorityRef") not in dependency_refs
        for row in effects.get("declarations", [])
    ):
        return "undeclared-dependency"
    requests = [value for row in kfx for value in row.get("capabilityRequests", [])]
    if requests and (effects.get("mode") == "none" or not effects.get("declarations")):
        return "hidden-external-effect"
    return None


def _stage_package(root: Path, package: Mapping[str, Any]) -> Path:
    staging_root = root / "staging"
    staging_root.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="package-", dir=staging_root))
    source = Path(str(package["sourcePath"]))
    for member in package["members"]:
        src = source / member["path"]
        dest = stage / member["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        if _bytes_root(dest.read_bytes()) != member["root"]:
            raise SkillRegistryError("staging-verification-failed", member["path"])
    return stage


def _publish_package(root: Path, package: Mapping[str, Any], staging: Path) -> None:
    digest = str(package["contentRoot"]).removeprefix("sha256:")
    payload = root / "payloads" / "sha256" / digest
    payload.parent.mkdir(parents=True, exist_ok=True)
    if payload.exists():
        _verify_published_payload(payload, package["members"])
        shutil.rmtree(staging)
    else:
        os.replace(staging, payload)
        _verify_published_payload(payload, package["members"])
    definition_digest = str(package["definitionRoot"]).removeprefix("sha256:")
    definition_path = root / "definitions" / "sha256" / f"{definition_digest}.json"
    if definition_path.exists():
        retained = _read_json_required(definition_path)
        if retained != package["definition"]:
            raise SkillRegistryError("definition-root-collision", definition_digest)
    else:
        _write_json_atomic(definition_path, package["definition"])


def _build_receipt(
    plan: Mapping[str, Any], state: Mapping[str, Any], *, recovered: bool
) -> dict[str, Any]:
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "planRoot": plan["planRoot"],
        "operationRoot": plan["operationRoot"],
        "operation": plan["operation"],
        "affected": {"key": plan["request"]["key"], "identities": plan["affected"]},
        "basis": copy.deepcopy(plan["basis"]),
        "result": {
            "generation": state["generation"],
            "stateRoot": state["stateRoot"],
            "changed": plan["changed"],
            "recovered": recovered,
        },
        "idempotency": "exact-plan-root",
        "history": "retained",
    }
    receipt["receiptRoot"] = _root(receipt)
    skill_contract.validate_lifecycle_receipt_v2(receipt)
    return receipt


def _publish_receipt_and_history(
    root: Path, receipt: Mapping[str, Any], state: Mapping[str, Any]
) -> None:
    _write_immutable_json(_receipt_path(root, str(receipt["planRoot"])), receipt)
    snapshot = (
        root
        / "history"
        / f"{int(state['generation']):020d}-{str(state['stateRoot']).removeprefix('sha256:')}.json"
    )
    _write_immutable_json(snapshot, state)


def _receipt_path(root: Path, plan_root: str) -> Path:
    return root / "receipts" / f"{plan_root.removeprefix('sha256:')}.json"


def _write_immutable_json(path: Path, value: Mapping[str, Any]) -> None:
    if path.exists():
        if _read_json_required(path) != value:
            raise SkillRegistryError("immutable-collision", str(path))
        return
    _write_json_atomic(path, value)


def _write_json_atomic(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        fd, name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        temporary = Path(name)
        with os.fdopen(fd, "wb") as output:
            output.write(
                json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True).encode(
                    "utf-8"
                )
                + b"\n"
            )
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        raise SkillRegistryError("json-unreadable", f"{path}: {error}") from error
    if not isinstance(value, dict):
        raise SkillRegistryError("json-not-object", str(path))
    return value


def _read_json_required(path: Path) -> dict[str, Any]:
    value = _read_json(path)
    if value is None:
        raise SkillRegistryError("json-missing", str(path))
    return value


def _verify_receipt(value: Mapping[str, Any]) -> None:
    receipt = dict(value)
    expected = receipt.pop("receiptRoot", None)
    actual = _root(receipt)
    if expected != actual:
        raise SkillRegistryError(
            "receipt-root-mismatch", f"expected {expected!r}, actual {actual!r}"
        )
    receipt["receiptRoot"] = expected
    skill_contract.validate_lifecycle_receipt_v2(receipt)


def _verify_published_payload(payload: Path, members: Any) -> None:
    for member in members:
        path = payload / member["path"]
        if not path.is_file() or _bytes_root(path.read_bytes()) != member["root"]:
            raise SkillRegistryError(
                "immutable-payload-corrupt", f"{payload}:{member['path']}"
            )


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _root(value: Any) -> str:
    return _bytes_root(canonical_json_bytes(value))


def _bytes_root(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _require_root(value: str, code: str) -> None:
    if (
        len(value) != 71
        or not value.startswith("sha256:")
        or any(character not in "0123456789abcdef" for character in value[7:])
    ):
        raise SkillRegistryError(code, value)


def _closure_root(entrypoint: str, members: Any) -> str:
    return _root(
        {
            "schema": "kungfu.skill-content-closure/v2",
            "entrypoint": entrypoint,
            "members": members,
        }
    )


def _validate_member_path(value: str) -> None:
    pure = PurePosixPath(value)
    if (
        not value
        or value.startswith("/")
        or "//" in value
        or any(part in {"", ".", ".."} for part in pure.parts)
        or unicodedata.normalize("NFC", value) != value
    ):
        raise SkillRegistryError("path-escape", value)


def _active_content_root(entry: Mapping[str, Any]) -> str | None:
    revision = entry.get("activeRevision")
    if revision is None:
        return None
    return str(entry["revisions"][str(revision)]["contentRoot"])


def _affected(
    operation: str,
    request: Mapping[str, Any],
    state: Mapping[str, Any],
    next_state: Mapping[str, Any],
) -> list[dict[str, Any]]:
    del operation, state
    entry = next_state["entries"][str(request["key"])]
    return [
        {
            "key": request["key"],
            "revision": entry.get("activeRevision"),
            "contentRoot": _active_content_root(entry),
            "status": entry["status"],
            "workRef": request.get("workRef"),
        }
    ]


def _rollback_guidance(
    operation: str, request: Mapping[str, Any], state: Mapping[str, Any]
) -> dict[str, Any]:
    entry = state["entries"].get(str(request["key"]))
    return {
        "operation": "rollback" if entry and entry.get("activeRevision") else "remove",
        "targetRevision": entry.get("activeRevision") if entry else None,
        "policy": "move-active-reference-only; never-delete-history-payloads-work-bindings-or-kfx",
        "fromOperation": operation,
    }


def _diff_values(path: str, left: Any, right: Any, out: list[dict[str, Any]]) -> None:
    if type(left) is not type(right):
        out.append({"path": path or "/", "left": left, "right": right})
    elif isinstance(left, dict):
        for key in sorted(set(left) | set(right)):
            child = f"{path}/{key}"
            if key not in left:
                out.append({"path": child, "left": None, "right": right[key]})
            elif key not in right:
                out.append({"path": child, "left": left[key], "right": None})
            else:
                _diff_values(child, left[key], right[key], out)
    elif isinstance(left, list):
        if left != right:
            out.append({"path": path or "/", "left": left, "right": right})
    elif left != right:
        out.append({"path": path or "/", "left": left, "right": right})
