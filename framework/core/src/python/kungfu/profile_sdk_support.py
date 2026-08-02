# SPDX-License-Identifier: Apache-2.0

"""Shared contracts and deterministic helpers for the Profile SDK layers."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Mapping

from kungfu import agent as agent_pack
from kungfu import contract as contract_runtime


SDK_SCHEMA = "kungfu.agent-profile-sdk/v1"
BRIEF_SCHEMA = "kungfu.profile-brief/v1"
DECISION_CARD_SCHEMA = "kungfu.decision-card/v1"
DIAGNOSIS_SCHEMA = "kungfu.profile-diagnosis/v1"
SOURCE_PLAN_SCHEMA = "kungfu.profile-source-plan/v1"
ACTION_REGISTRY_SCHEMA = "kungfu.profile-actions/v1"
ACTION_PLAN_SCHEMA = "kungfu.profile-action-plan/v1"
ACTION_RECEIPT_SCHEMA = "kungfu.profile-action-receipt/v1"
DECISION_ANSWER_SCHEMA = "kungfu.decision-answer/v1"
SOURCE_IMPORT_PLAN_SCHEMA = "kungfu.profile-source-import-plan/v1"
COLLABORATION_SCHEMA = "kungfu.profile-collaboration/v1"
INTENT_PLAN_SCHEMA = "kungfu.profile-intent-plan/v1"
INTENT_RECEIPT_SCHEMA = "kungfu.profile-intent-receipt/v1"
KFD3_QUALIFICATION_RECEIPT_SCHEMA = "kungfu.profile-kfd3-qualification-receipt/v1"
KFD3_WITNESS_SCHEMA = "kungfu.profile-kfd3-witness/v1"
KFD3_QUALIFICATION_PLAN_SCHEMA = "kungfu.profile-kfd3-qualification-plan/v1"
KFD3_RELEASE_MANIFEST_SCHEMA = "kungfu.system-profile-kfd3-manifest/v1"

_TOKEN = re.compile(r"^[A-Za-z0-9._-]+$")
_IGNORED_PARTS = {".git", "node_modules", "__pycache__", ".DS_Store"}


class ProfileSdkError(ValueError):
    def __init__(self, code: str, message: str, **details: Any):
        self.diagnosis = {
            "schema": DIAGNOSIS_SCHEMA,
            "ok": False,
            "code": code,
            "message": message,
            **details,
        }
        super().__init__(message)


def _validate_sdk_value(schema_key: str, value: Any, label: str) -> None:
    try:
        contract_runtime.validate_json_schema(
            value, agent_pack.profile_sdk_contract()[schema_key], label
        )
    except ValueError as error:
        raise ProfileSdkError(
            "profile-sdk-contract-invalid", str(error), artifact=label
        ) from error


def _changes(
    left: Mapping[str, Any], right: Mapping[str, Any], keys: list[str]
) -> list[dict[str, Any]]:
    return [
        {"field": key, "left": left.get(key), "right": right.get(key)}
        for key in keys
        if left.get(key) != right.get(key)
    ]


def _portable_source_paths(root: Path) -> list[Path]:
    paths = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part in _IGNORED_PARTS for part in relative.parts):
            continue
        if path.is_symlink():
            raise ProfileSdkError(
                "source-bundle-symlink-rejected",
                "Profile source bundles do not follow symlinks",
                path=relative.as_posix(),
            )
        if path.is_file():
            paths.append(path)
    return sorted(paths, key=lambda path: path.relative_to(root).as_posix())


def _validate_source_bundle(bundle: Mapping[str, Any]) -> dict[str, Any]:
    normalized = dict(bundle)
    _validate_sdk_value("sourceBundleSchema", normalized, "Profile source bundle")
    expected = str(normalized.get("bundleRoot") or "")
    body = dict(normalized)
    body.pop("bundleRoot", None)
    if expected != _root(body):
        raise ProfileSdkError(
            "source-bundle-root-mismatch", "Profile source bundle root mismatch"
        )
    paths = []
    for entry in normalized["entries"]:
        relative = str(entry["path"])
        candidate = Path(relative)
        if (
            candidate.is_absolute()
            or not relative
            or ".." in candidate.parts
            or any(part in _IGNORED_PARTS for part in candidate.parts)
        ):
            raise ProfileSdkError(
                "source-bundle-path-invalid",
                "Profile source bundle contains an unsafe path",
                path=relative,
            )
        paths.append(relative)
        if normalized["mode"] == "full":
            try:
                data = base64.b64decode(entry["contentBase64"], validate=True)
            except (ValueError, TypeError) as error:
                raise ProfileSdkError(
                    "source-bundle-content-invalid",
                    "Profile source bundle content is not canonical base64",
                    path=relative,
                ) from error
            if len(data) != entry["size"] or _sha256(data) != entry["sha256"]:
                raise ProfileSdkError(
                    "source-bundle-content-mismatch",
                    "Profile source bundle content does not match its inventory",
                    path=relative,
                )
    if paths != sorted(set(paths)):
        raise ProfileSdkError(
            "source-bundle-inventory-invalid",
            "Profile source bundle paths must be unique and sorted",
        )
    return normalized


def _confined(root: Path, relative: str) -> Path:
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise ProfileSdkError(
            "path-escape", f"path escapes Profile source root: {relative}"
        )
    return target


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _pretty(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _root(value: Any) -> str:
    return "sha256:" + _sha256(_canonical(value))
