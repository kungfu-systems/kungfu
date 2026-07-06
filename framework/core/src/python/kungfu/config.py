# SPDX-License-Identifier: Apache-2.0

import copy
import hashlib
import json
import os
import platform
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator


CONTRACT_SCHEMA = "kungfu.config.contract/v1"
CONFIG_SCHEMA = "kungfu.config.resolved/v1"
DEFAULTS_SCHEMA = "kungfu.config.defaults/v1"
OVERRIDE_SCHEMA = "kungfu.config.override/v1"
CONTRACT_FILE = "kungfu-config.contract.json"
CONTRACT_ENV = "KUNGFU_CONFIG_CONTRACT"


def default_config_home(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    contract = load_contract(env=env)
    resolution = contract["resolution"]
    return os.path.abspath(
        os.path.expanduser(
            env.get(resolution["configHomeEnv"]) or resolution["defaultConfigHome"]
        )
    )


def user_config_path(config_home: str | None = None) -> str:
    contract = load_contract()
    return os.path.join(
        config_home or default_config_home(),
        contract["resolution"]["userOverrideFile"],
    )


def load_contract(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    path = resolve_contract_path(contract_path, env=env)
    with open(path, encoding="utf-8") as f:
        contract = json.load(f)
    if not isinstance(contract, dict):
        raise ValueError(f"Kungfu config contract must be a JSON object: {path}")
    if contract.get("schema") != CONTRACT_SCHEMA:
        raise ValueError(
            f"Kungfu config contract schema mismatch: {contract.get('schema')!r}"
        )
    _validate_contract_defaults(contract)
    return contract


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
                Path("framework") / "config" / CONTRACT_FILE,
                Path("config") / CONTRACT_FILE,
            ]:
                candidate = directory / rel
                if candidate.is_file():
                    return str(candidate)

    raise FileNotFoundError(f"Kungfu config contract not found: {CONTRACT_FILE}")


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


def contract_hash(contract_path: str | None = None) -> str:
    path = resolve_contract_path(contract_path)
    with open(path, "rb") as f:
        return "sha256:" + hashlib.sha256(f.read()).hexdigest()


def config_schema(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return copy.deepcopy(load_contract(contract_path, env=env)["configSchema"])


def raw_default_config(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return copy.deepcopy(load_contract(contract_path, env=env)["defaults"])


def default_config(
    runtime_home: str | None = None,
    *,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    contract_path: str | None = None,
) -> dict[str, Any]:
    env = os.environ if env is None else env
    contract = load_contract(contract_path, env=env)
    runtime_home = runtime_home or default_runtime_home(env)
    config_home = config_home or default_config_home(env)
    defaults = _expand_placeholders(
        contract["defaults"],
        {
            "configHome": os.path.abspath(os.path.expanduser(config_home)),
            "runtimeHome": os.path.abspath(os.path.expanduser(runtime_home)),
        },
        contract["resolution"]["placeholders"],
    )
    validate_config(defaults, contract=contract)
    return cast(dict[str, Any], defaults)


def load_user_config(
    config_path: str,
    *,
    contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    contract = load_contract() if contract is None else contract
    if not os.path.exists(config_path):
        return {"schema": contract["resolution"]["overrideSchema"]}
    with open(config_path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"Kungfu config override must be a JSON object: {config_path}")
    validate_config(data, contract=contract, partial=True)
    return data


def resolve_config(
    *,
    runtime_home: str | None = None,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    contract_path: str | None = None,
) -> dict[str, Any]:
    env = os.environ if env is None else env
    contract = load_contract(contract_path, env=env)
    resolution = contract["resolution"]
    runtime_home = os.path.abspath(
        os.path.expanduser(
            runtime_home
            or env.get(resolution["runtimeHomeEnv"])
            or default_runtime_home(env)
        )
    )
    config_home = (
        default_config_home(env)
        if config_home is None
        else os.path.abspath(os.path.expanduser(config_home))
    )
    config_path = os.path.join(config_home, resolution["userOverrideFile"])
    defaults = default_config(
        runtime_home,
        config_home=config_home,
        env=env,
        contract_path=resolve_contract_path(contract_path, env=env),
    )
    override = load_user_config(config_path, contract=contract)
    merged = _deep_merge(defaults, override)
    validate_config(merged, contract=contract)
    metadata = contract_metadata(contract_path, env=env)
    return {
        "schema": resolution["resolvedSchema"],
        "contract": metadata,
        "configHome": config_home,
        "configPath": config_path,
        "runtimeHome": runtime_home,
        "sources": [
            {
                "type": "contract",
                "schema": metadata["schema"],
                "id": metadata["id"],
                "path": metadata["path"],
                "hash": metadata["hash"],
            },
            {
                "type": "user",
                "schema": override.get("schema", resolution["overrideSchema"]),
                "path": config_path,
                "exists": os.path.exists(config_path),
            },
        ],
        "config": merged,
    }


def validate_config(
    config: dict[str, Any],
    *,
    contract: dict[str, Any] | None = None,
    partial: bool = False,
) -> None:
    contract = load_contract() if contract is None else contract
    schema = contract["configSchema"]
    if partial:
        schema = _partial_schema(schema)
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(config), key=lambda e: list(e.path))
    if errors:
        error = errors[0]
        path = ".".join(str(part) for part in error.path) or "<root>"
        raise ValueError(f"Kungfu config validation failed at {path}: {error.message}")


def _validate_contract_defaults(contract: dict[str, Any]) -> None:
    required = [
        "id",
        "version",
        "weldedSurface",
        "contractSchema",
        "resolution",
        "configSchema",
        "defaults",
    ]
    for key in required:
        if key not in contract:
            raise ValueError(f"Kungfu config contract missing required key: {key}")
    contract_schema = contract["contractSchema"]
    if not isinstance(contract_schema, dict):
        raise ValueError("Kungfu config contractSchema must be a JSON object")
    validator = Draft202012Validator(contract_schema)
    errors = sorted(validator.iter_errors(contract), key=lambda e: list(e.path))
    if errors:
        error = errors[0]
        path = ".".join(str(part) for part in error.path) or "<root>"
        raise ValueError(
            f"Kungfu config contract validation failed at {path}: {error.message}"
        )
    validate_config(contract["defaults"], contract=contract)


def _partial_schema(schema: Any) -> Any:
    if isinstance(schema, list):
        return [_partial_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    result = copy.deepcopy(schema)
    result.pop("required", None)
    if isinstance(result.get("properties"), dict):
        result["properties"] = {
            key: _partial_schema(value) for key, value in result["properties"].items()
        }
    if "items" in result:
        result["items"] = _partial_schema(result["items"])
    return result


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if key == "schema":
            continue
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _expand_placeholders(
    value: Any,
    replacements: dict[str, str],
    placeholders: list[str],
) -> Any:
    if isinstance(value, str):
        expanded = value
        for key in placeholders:
            expanded = expanded.replace("${" + key + "}", replacements[key])
        return os.path.expanduser(expanded)
    if isinstance(value, list):
        return [
            _expand_placeholders(item, replacements, placeholders) for item in value
        ]
    if isinstance(value, dict):
        return {
            key: _expand_placeholders(item, replacements, placeholders)
            for key, item in value.items()
        }
    return value


def default_runtime_home(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    contract = load_contract(env=env)
    resolution = contract["resolution"]
    env_name = resolution["runtimeHomeEnv"]
    if env.get(env_name):
        return os.path.abspath(os.path.expanduser(env[env_name]))

    platform_key = {
        "Darwin": "darwin",
        "Windows": "win32",
        "Linux": "linux",
    }.get(platform.system(), "default")
    templates = resolution["defaultRuntimeHome"]
    template = templates.get(platform_key) or templates["default"]
    return os.path.abspath(
        os.path.expanduser(
            _expand_environment_template(
                template,
                env,
                resolution["environmentFallbacks"],
            )
        )
    )


def _expand_environment_template(
    value: str,
    env: Mapping[str, str],
    fallbacks: Mapping[str, str],
) -> str:
    expanded = value
    for _ in range(4):
        changed = False
        for key in sorted(fallbacks.keys()):
            token = "${" + key + "}"
            if token not in expanded:
                continue
            replacement = env.get(key) or fallbacks[key]
            expanded = expanded.replace(token, replacement)
            changed = True
        if not changed:
            break
    return expanded
