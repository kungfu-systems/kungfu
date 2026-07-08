# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from kungfu.content_hash import compute_content_hash


REGISTRY_SCHEMA = "kungfu.contract-registry/v1"
REGISTRY_FILE = "kungfu-contracts.registry.json"
REGISTRY_ENV = "KUNGFU_CONTRACT_REGISTRY"


def resolve_registry_path(
    registry_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    env = os.environ if env is None else env
    explicit = registry_path or env.get(REGISTRY_ENV)
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))

    executable_candidate = (
        Path(sys.executable).resolve().parent / "config" / REGISTRY_FILE
    )
    if executable_candidate.is_file():
        return str(executable_candidate)

    for start in [Path(__file__).resolve(), Path.cwd().resolve()]:
        for directory in [start, *start.parents]:
            for rel in [
                Path("framework") / "contract" / REGISTRY_FILE,
                Path("config") / REGISTRY_FILE,
            ]:
                candidate = directory / rel
                if candidate.is_file():
                    return str(candidate)

    raise FileNotFoundError(f"Kungfu contract registry not found: {REGISTRY_FILE}")


def load_registry(
    registry_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    path = resolve_registry_path(registry_path, env=env)
    with open(path, encoding="utf-8") as f:
        registry = json.load(f)
    if not isinstance(registry, dict):
        raise ValueError(f"Kungfu contract registry must be a JSON object: {path}")
    if registry.get("schema") != REGISTRY_SCHEMA:
        raise ValueError(
            f"Kungfu contract registry schema mismatch: {registry.get('schema')!r}"
        )
    if not isinstance(registry.get("contracts"), list):
        raise ValueError("Kungfu contract registry missing contracts array")
    return registry


def contract_entry(
    surface: str,
    *,
    registry: dict[str, Any] | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    registry = load_registry(env=env) if registry is None else registry
    for entry in registry["contracts"]:
        if isinstance(entry, dict) and entry.get("surface") == surface:
            return entry
    raise KeyError(f"Kungfu contract surface is not registered: {surface}")


def resolve_contract_path(
    surface: str,
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    env = os.environ if env is None else env
    entry = contract_entry(surface, env=env)
    explicit = contract_path or env.get(str(entry["env"]))
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))

    artifact = Path(str(entry["artifact"]))
    executable_candidate = Path(sys.executable).resolve().parent / artifact
    if executable_candidate.is_file():
        return str(executable_candidate)

    source = Path(str(entry["source"]))
    for start in [Path(__file__).resolve(), Path.cwd().resolve()]:
        for directory in [start, *start.parents]:
            for rel in [source, artifact, Path("config") / str(entry["file"])]:
                candidate = directory / rel
                if candidate.is_file():
                    return str(candidate)

    raise FileNotFoundError(f"Kungfu {surface} contract not found: {entry['file']}")


def load_contract(
    surface: str,
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    entry = contract_entry(surface, env=env)
    path = resolve_contract_path(surface, contract_path, env=env)
    with open(path, encoding="utf-8") as f:
        contract = json.load(f)
    if not isinstance(contract, dict):
        raise ValueError(f"Kungfu {surface} contract must be a JSON object: {path}")
    if contract.get("schema") != entry["schema"]:
        raise ValueError(
            f"Kungfu {surface} contract schema mismatch: {contract.get('schema')!r}"
        )
    validate_json_schema(
        contract, contract.get("contractSchema"), f"{surface} contract"
    )
    return contract


def contract_hash(surface: str, contract_path: str | None = None) -> str:
    path = resolve_contract_path(surface, contract_path)
    with open(path, "rb") as f:
        return compute_content_hash(f.read())


def contract_metadata(
    surface: str,
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, str | int]:
    path = resolve_contract_path(surface, contract_path, env=env)
    contract = load_contract(surface, path, env=env)
    return {
        "schema": contract["schema"],
        "id": contract["id"],
        "version": contract["version"],
        "weldedSurface": contract["weldedSurface"],
        "path": path,
        "hash": contract_hash(surface, path),
    }


def contract_rows(
    *,
    env: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    registry_path = resolve_registry_path(env=env)
    registry = load_registry(registry_path, env=env)
    rows: list[dict[str, Any]] = []
    for entry in registry["contracts"]:
        if not isinstance(entry, dict):
            continue
        surface = str(entry["surface"])
        metadata = contract_metadata(surface, env=env)
        rows.append(
            {
                "surface": surface,
                "id": metadata["id"],
                "schema": metadata["schema"],
                "version": metadata["version"],
                "weldedSurface": metadata["weldedSurface"],
                "path": metadata["path"],
                "hash": metadata["hash"],
                "env": entry["env"],
                "artifact": entry["artifact"],
            }
        )
    return rows


def validate_json_schema(value: Any, schema: Any, label: str) -> None:
    if not isinstance(schema, dict):
        raise ValueError(f"Kungfu {label} missing object schema")
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(value), key=lambda e: list(e.path))
    if errors:
        error = errors[0]
        path = ".".join(str(part) for part in error.path) or "<root>"
        raise ValueError(f"Kungfu {label} validation failed at {path}: {error.message}")
