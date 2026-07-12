# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import json
import os
import tarfile
from collections.abc import Mapping
from typing import Any

from kungfu import contract as contract_runtime


CONTRACT_SCHEMA = "kungfu.kfx.contract/v1"
CONTRACT_FILE = "kungfu-kfx.contract.json"
CONTRACT_ENV = "KUNGFU_KFX_CONTRACT"


def resolve_contract_path(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    return contract_runtime.resolve_contract_path("kfx", contract_path, env=env)


def load_contract(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return contract_runtime.load_contract("kfx", contract_path, env=env)


def contract_hash(contract_path: str | None = None) -> str:
    return contract_runtime.contract_hash("kfx", contract_path)


def contract_metadata(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, str | int]:
    return contract_runtime.contract_metadata("kfx", contract_path, env=env)


def package_manifest_schema(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return copy.deepcopy(load_contract(contract_path, env=env)["packageManifestSchema"])


def profile_suite_schema(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return copy.deepcopy(load_contract(contract_path, env=env)["profileSuiteSchema"])


def validate_package_manifest(
    manifest: dict[str, Any],
    *,
    contract: dict[str, Any] | None = None,
) -> None:
    contract = load_contract() if contract is None else contract
    _validate_with_schema(
        manifest,
        contract.get("packageManifestSchema"),
        "package manifest",
    )


def validate_profile_suite(
    profile: dict[str, Any],
    *,
    contract: dict[str, Any] | None = None,
    suite_members: list[str] | None = None,
) -> None:
    contract = load_contract() if contract is None else contract
    _validate_with_schema(
        profile,
        contract.get("profileSuiteSchema"),
        "Profile Suite",
    )
    members = profile.get("members") or {}
    required = members.get("required") or []
    optional = members.get("optional") or []
    overlap = sorted(set(required) & set(optional))
    if overlap:
        raise ValueError(
            "kfx Profile Suite validation failed: members cannot be both "
            f"required and optional: {', '.join(overlap)}"
        )
    if suite_members is not None and set(required) | set(optional) != set(
        suite_members
    ):
        raise ValueError(
            "kfx Profile Suite validation failed: profile members must match "
            "kungfuConfig.suite.members"
        )


def validate_first_party_manifest(
    manifest: dict[str, Any],
    *,
    contract: dict[str, Any] | None = None,
) -> None:
    contract = load_contract() if contract is None else contract
    _validate_with_schema(
        manifest,
        contract.get("firstPartyManifestSchema"),
        "first-party manifest",
    )


def read_manifest_from_dir(package_dir: str) -> dict[str, Any]:
    manifest_path = os.path.join(package_dir, "package.json")
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    if not isinstance(manifest, dict):
        raise ValueError(f"KFX package manifest must be a JSON object: {manifest_path}")
    validate_package_manifest(manifest)
    return manifest


def read_manifest_from_tgz(tgz: str) -> dict[str, Any]:
    with tarfile.open(tgz, "r:gz") as archive:
        member = archive.getmember("package/package.json")
        extracted = archive.extractfile(member)
        if extracted is None:
            raise ValueError("package/package.json is not a file")
        manifest = json.load(extracted)
    if not isinstance(manifest, dict):
        raise ValueError(f"KFX package manifest must be a JSON object: {tgz}")
    validate_package_manifest(manifest)
    return manifest


def package_key(manifest: Mapping[str, Any]) -> str | None:
    config = manifest.get("kungfuConfig")
    if not isinstance(config, Mapping):
        return None
    key = config.get("key")
    return key if isinstance(key, str) and key else None


def package_kind(manifest: Mapping[str, Any], package_dir: str | None = None) -> str:
    config = manifest.get("kungfuConfig")
    if not isinstance(config, Mapping):
        return "unknown"
    if "suite" in config:
        return "suite"
    facets = []
    facet_config = config.get("config")
    if isinstance(facet_config, Mapping):
        facets = sorted(str(key) for key in facet_config.keys())
    if facets:
        return "+".join(facets)
    build = manifest.get("kungfuBuild")
    if isinstance(build, Mapping) and build.get("python"):
        return "python-aot"
    if package_dir and os.path.isfile(os.path.join(package_dir, "CMakeLists.txt")):
        return "cpp"
    return "unknown"


def package_summary(
    manifest: Mapping[str, Any],
    *,
    package_dir: str | None = None,
) -> dict[str, Any]:
    return {
        "key": package_key(manifest),
        "name": manifest.get("name"),
        "version": manifest.get("version"),
        "kind": package_kind(manifest, package_dir),
    }


def resolve_kfx_package(package_dir: str, expected_key: str) -> dict[str, Any] | None:
    manifest_path = os.path.join(package_dir, "package.json")
    if not os.path.isfile(manifest_path):
        return None
    try:
        manifest = read_manifest_from_dir(package_dir)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    key = package_key(manifest) or os.path.basename(package_dir)
    if key != expected_key:
        return None
    summary = package_summary(manifest, package_dir=package_dir)
    summary["key"] = key
    return summary


def _validate_with_schema(value: Any, schema: Any, label: str) -> None:
    contract_runtime.validate_json_schema(value, schema, f"kfx {label}")
