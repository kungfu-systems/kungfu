# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
import tarfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


CONTRACT_SCHEMA = "kungfu.kfx.contract/v1"
CONTRACT_FILE = "kungfu-kfx.contract.json"
CONTRACT_ENV = "KUNGFU_KFX_CONTRACT"


def resolve_contract_path(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    env = os.environ if env is None else env
    explicit = contract_path or env.get(CONTRACT_ENV)
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))

    executable_candidate = (
        Path(sys.executable).resolve().parent / "config" / CONTRACT_FILE
    )
    if executable_candidate.is_file():
        return str(executable_candidate)

    for start in [Path(__file__).resolve(), Path.cwd().resolve()]:
        for directory in [start, *start.parents]:
            for rel in [
                Path("framework") / "kfx" / CONTRACT_FILE,
                Path("kfx") / CONTRACT_FILE,
                Path("config") / CONTRACT_FILE,
            ]:
                candidate = directory / rel
                if candidate.is_file():
                    return str(candidate)

    raise FileNotFoundError(f"Kungfu kfx contract not found: {CONTRACT_FILE}")


def load_contract(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    path = resolve_contract_path(contract_path, env=env)
    with open(path, encoding="utf-8") as f:
        contract = json.load(f)
    if not isinstance(contract, dict):
        raise ValueError(f"Kungfu kfx contract must be a JSON object: {path}")
    if contract.get("schema") != CONTRACT_SCHEMA:
        raise ValueError(
            f"Kungfu kfx contract schema mismatch: {contract.get('schema')!r}"
        )
    _validate_with_schema(contract, contract.get("contractSchema"), "contract")
    return contract


def contract_hash(contract_path: str | None = None) -> str:
    path = resolve_contract_path(contract_path)
    with open(path, "rb") as f:
        return "sha256:" + hashlib.sha256(f.read()).hexdigest()


def contract_metadata(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, str | int]:
    path = resolve_contract_path(contract_path, env=env)
    contract = load_contract(path, env=env)
    return {
        "schema": contract["schema"],
        "id": contract["id"],
        "version": contract["version"],
        "weldedSurface": contract["weldedSurface"],
        "path": path,
        "hash": contract_hash(path),
    }


def package_manifest_schema(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return copy.deepcopy(load_contract(contract_path, env=env)["packageManifestSchema"])


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
    if not isinstance(schema, dict):
        raise ValueError(f"Kungfu kfx contract missing object schema: {label}")
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(value), key=lambda e: list(e.path))
    if errors:
        error = errors[0]
        path = ".".join(str(part) for part in error.path) or "<root>"
        raise ValueError(
            f"Kungfu kfx {label} validation failed at {path}: {error.message}"
        )
