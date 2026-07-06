# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from kungfu import contract as contract_runtime


CONTRACT_SCHEMA = "kungfu.skill.contract/v1"
CONTRACT_FILE = "kungfu-skill.contract.json"
CONTRACT_ENV = "KUNGFU_SKILL_CONTRACT"


def resolve_contract_path(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    return contract_runtime.resolve_contract_path("skill", contract_path, env=env)


def load_contract(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    contract = contract_runtime.load_contract("skill", contract_path, env=env)
    for name in contract["schemaFiles"]:
        load_schema(name, contract=contract, contract_path=contract_path, env=env)
    return contract


def contract_hash(contract_path: str | None = None) -> str:
    return contract_runtime.contract_hash("skill", contract_path)


def contract_metadata(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, str | int]:
    return contract_runtime.contract_metadata("skill", contract_path, env=env)


def load_schema(
    name: str,
    *,
    contract: dict[str, Any] | None = None,
    contract_path: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    contract = load_contract(contract_path, env=env) if contract is None else contract
    schema_files = contract["schemaFiles"]
    if name not in schema_files:
        raise KeyError(f"Kungfu skill schema is not registered: {name}")
    row = schema_files[name]
    path = _schema_path(row, resolve_contract_path(contract_path, env=env))
    with open(path, encoding="utf-8") as f:
        schema = json.load(f)
    if not isinstance(schema, dict):
        raise ValueError(f"Kungfu skill schema must be a JSON object: {path}")
    if schema.get("$id") != row["schema"]:
        raise ValueError(
            f"Kungfu skill schema mismatch for {name}: {schema.get('$id')!r}"
        )
    return schema


def schema_bundle(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    contract = load_contract(contract_path, env=env)
    return {
        name: load_schema(
            name,
            contract=contract,
            contract_path=contract_path,
            env=env,
        )
        for name in contract["schemaFiles"]
    }


def validate_skill_source(value: dict[str, Any]) -> None:
    _validate("source", value, "skill source")


def validate_catalog(value: dict[str, Any]) -> None:
    _validate("catalog", value, "skill catalog")


def validate_context(value: dict[str, Any]) -> None:
    _validate("context", value, "skill context")


def validate_dependencies(value: dict[str, Any]) -> None:
    _validate("dependencies", value, "skill dependencies")


def validate_manager(value: dict[str, Any]) -> None:
    _validate("manager", value, "skill manager")


def _validate(schema_name: str, value: dict[str, Any], label: str) -> None:
    contract_runtime.validate_json_schema(
        value,
        load_schema(schema_name),
        label,
    )


def _schema_path(row: Mapping[str, Any], contract_path: str) -> Path:
    contract_parent = Path(contract_path).resolve().parent
    candidates = [
        contract_parent / str(row["source"]),
        contract_parent / str(row["artifact"]),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"Kungfu skill schema not found: {row['source']} or {row['artifact']}"
    )
