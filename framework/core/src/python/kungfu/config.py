# SPDX-License-Identifier: Apache-2.0

import copy
import hashlib
import json
import os
import platform
import subprocess
from collections.abc import Mapping
from typing import Any, cast

from kungfu import contract as contract_runtime


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


def workspace_config_path(
    workspace_home: str | None = None,
    *,
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
) -> str | None:
    """Return the workspace-scoped override path, or None outside a workspace."""

    contract = load_contract(env=env)
    home = workspace_home or workspace_data_home(cwd, env=env)
    if not home:
        return None
    return os.path.join(home, contract["resolution"]["workspaceOverrideFile"])


def load_contract(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    contract = contract_runtime.load_contract("config", contract_path, env=env)
    _validate_contract_defaults(contract)
    return contract


def resolve_contract_path(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    return contract_runtime.resolve_contract_path("config", contract_path, env=env)


def contract_metadata(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, str | int]:
    return contract_runtime.contract_metadata("config", contract_path, env=env)


def contract_hash(contract_path: str | None = None) -> str:
    return contract_runtime.contract_hash("config", contract_path)


def config_schema(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return copy.deepcopy(load_contract(contract_path, env=env)["configSchema"])


def value_schema(
    name: str,
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Return one versioned non-config value schema from the config contract."""

    contract = load_contract(contract_path, env=env)
    schemas = contract.get("valueSchemas")
    if not isinstance(schemas, dict) or name not in schemas:
        raise ValueError(f"Unknown Kungfu config value schema: {name}")
    schema = copy.deepcopy(schemas[name])
    # Schemas such as WorkConsole and the Agent Console envelope embed WorkRef
    # by local reference. Inject the canonical sibling schema at validation
    # time so the contract keeps one WorkRef definition.
    schema.setdefault("$defs", {})["workRef"] = copy.deepcopy(schemas["workRef"])
    return schema


def validate_value(
    name: str,
    value: Any,
    *,
    contract: dict[str, Any] | None = None,
) -> None:
    contract = load_contract() if contract is None else contract
    schemas = contract.get("valueSchemas")
    if not isinstance(schemas, dict) or name not in schemas:
        raise ValueError(f"Unknown Kungfu config value schema: {name}")
    schema = copy.deepcopy(schemas[name])
    schema.setdefault("$defs", {})["workRef"] = copy.deepcopy(schemas["workRef"])
    contract_runtime.validate_json_schema(value, schema, name)


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
    cwd: str | None = None,
) -> dict[str, Any]:
    env = os.environ if env is None else env
    contract = load_contract(contract_path, env=env)
    runtime_home = runtime_home or default_runtime_home(env)
    config_home = config_home or default_config_home(env)
    workspace_home = workspace_data_home(cwd, env=env) or ""
    machine_home = machine_runtime_home(env)
    defaults = _expand_placeholders(
        contract["defaults"],
        {
            "configHome": os.path.abspath(os.path.expanduser(config_home)),
            "runtimeHome": os.path.abspath(os.path.expanduser(runtime_home)),
            "workspaceDataHome": workspace_home,
            "machineDataHome": machine_home,
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


def parse_config_value(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def set_user_config_value(
    key: str,
    value: Any,
    *,
    config_home: str | None = None,
    runtime_home: str | None = None,
    scope: str = "user",
    cwd: str | None = None,
) -> dict[str, Any]:
    contract = load_contract()
    config_home = default_config_home() if config_home is None else config_home
    config_path = _config_override_path(
        scope, config_home=config_home, cwd=cwd, contract=contract
    )
    override = load_user_config(config_path, contract=contract)
    override.setdefault("schema", contract["resolution"]["overrideSchema"])
    _set_dotted(override, key, value)
    validate_config(override, contract=contract, partial=True)
    _write_user_config(config_path, override)
    return resolve_config(runtime_home=runtime_home, config_home=config_home, cwd=cwd)


def unset_user_config_value(
    key: str,
    *,
    config_home: str | None = None,
    runtime_home: str | None = None,
    scope: str = "user",
    cwd: str | None = None,
) -> dict[str, Any]:
    contract = load_contract()
    config_home = default_config_home() if config_home is None else config_home
    config_path = _config_override_path(
        scope, config_home=config_home, cwd=cwd, contract=contract
    )
    override = load_user_config(config_path, contract=contract)
    override.setdefault("schema", contract["resolution"]["overrideSchema"])
    _unset_dotted(override, key)
    validate_config(override, contract=contract, partial=True)
    _write_user_config(config_path, override)
    return resolve_config(runtime_home=runtime_home, config_home=config_home, cwd=cwd)


def resolve_config(
    *,
    runtime_home: str | None = None,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    contract_path: str | None = None,
    cwd: str | None = None,
) -> dict[str, Any]:
    env = os.environ if env is None else env
    contract = load_contract(contract_path, env=env)
    resolution = contract["resolution"]
    workspace_home = workspace_data_home(cwd, env=env)
    machine_home = machine_runtime_home(env)
    runtime_home = os.path.abspath(
        os.path.expanduser(
            runtime_home
            or env.get(resolution["runtimeHomeEnv"])
            or workspace_home
            or machine_home
        )
    )
    config_home = (
        default_config_home(env)
        if config_home is None
        else os.path.abspath(os.path.expanduser(config_home))
    )
    config_path = os.path.join(config_home, resolution["userOverrideFile"])
    workspace_path = (
        os.path.join(workspace_home, resolution["workspaceOverrideFile"])
        if workspace_home
        else None
    )
    defaults = default_config(
        runtime_home,
        config_home=config_home,
        env=env,
        contract_path=resolve_contract_path(contract_path, env=env),
        cwd=cwd,
    )
    override = load_user_config(config_path, contract=contract)
    workspace_override = (
        load_user_config(workspace_path, contract=contract)
        if workspace_path
        else {"schema": resolution["overrideSchema"]}
    )
    merged = _deep_merge(_deep_merge(defaults, override), workspace_override)
    validate_config(merged, contract=contract)
    metadata = contract_metadata(contract_path, env=env)
    durability_policy = cast(dict[str, Any], merged["storage"])["durability"]
    durability_digest = _policy_digest(metadata["hash"], durability_policy)
    return {
        "schema": resolution["resolvedSchema"],
        "contract": metadata,
        "configHome": config_home,
        "configPath": config_path,
        "runtimeHome": runtime_home,
        "workspaceDataHome": workspace_home or "",
        "machineDataHome": machine_home,
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
            {
                "type": "workspace",
                "schema": workspace_override.get(
                    "schema", resolution["overrideSchema"]
                ),
                "path": workspace_path or "",
                "exists": bool(workspace_path and os.path.exists(workspace_path)),
                "active": bool(workspace_path),
            },
        ],
        "digests": {"storageDurability": durability_digest},
        "config": merged,
    }


def durability_policy(
    *,
    runtime_home: str | None = None,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    contract_path: str | None = None,
    cwd: str | None = None,
) -> dict[str, Any]:
    """Return the KFD-1 requested durability policy plus its canonical identity."""

    resolved = resolve_config(
        runtime_home=runtime_home,
        config_home=config_home,
        env=env,
        contract_path=contract_path,
        cwd=cwd,
    )
    return {
        "schema": "kungfu.durability-policy.requested/v1",
        "contract": resolved["contract"],
        "policyDigest": resolved["digests"]["storageDurability"],
        "workspaceDataHome": resolved["workspaceDataHome"],
        "policy": copy.deepcopy(resolved["config"]["storage"]["durability"]),
        "sources": copy.deepcopy(resolved["sources"]),
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
    contract_runtime.validate_json_schema(config, schema, "config")


def _validate_contract_defaults(contract: dict[str, Any]) -> None:
    required = [
        "id",
        "version",
        "weldedSurface",
        "contractSchema",
        "resolution",
        "valueSchemas",
        "configSchema",
        "defaults",
    ]
    for key in required:
        if key not in contract:
            raise ValueError(f"Kungfu config contract missing required key: {key}")
    contract_schema = contract["contractSchema"]
    if not isinstance(contract_schema, dict):
        raise ValueError("Kungfu config contractSchema must be a JSON object")
    contract_runtime.validate_json_schema(contract, contract_schema, "config contract")
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


def _dotted_parts(key: str) -> list[str]:
    parts = [part for part in key.split(".") if part]
    if not parts or len(parts) != len(key.split(".")):
        raise ValueError(f"invalid config key: {key!r}")
    return parts


def _set_dotted(target: dict[str, Any], key: str, value: Any) -> None:
    parts = _dotted_parts(key)
    current = target
    for part in parts[:-1]:
        existing = current.get(part)
        if existing is None:
            existing = {}
            current[part] = existing
        if not isinstance(existing, dict):
            raise ValueError(f"cannot set nested config under scalar key: {part}")
        current = existing
    current[parts[-1]] = value


def _unset_dotted(target: dict[str, Any], key: str) -> None:
    parts = _dotted_parts(key)
    stack: list[tuple[dict[str, Any], str]] = []
    current = target
    for part in parts[:-1]:
        existing = current.get(part)
        if not isinstance(existing, dict):
            return
        stack.append((current, part))
        current = existing
    current.pop(parts[-1], None)
    for parent, part in reversed(stack):
        child = parent.get(part)
        if isinstance(child, dict) and not child:
            parent.pop(part, None)


def _write_user_config(config_path: str, data: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")


def _config_override_path(
    scope: str,
    *,
    config_home: str,
    cwd: str | None,
    contract: dict[str, Any],
) -> str:
    if scope == "user":
        return os.path.join(config_home, contract["resolution"]["userOverrideFile"])
    if scope != "workspace":
        raise ValueError(f"unknown config scope: {scope}")
    home = workspace_data_home(cwd)
    if home is None:
        raise ValueError("workspace config scope requires a Kungfu or Git workspace")
    return os.path.join(home, contract["resolution"]["workspaceOverrideFile"])


def _policy_digest(contract_hash_value: Any, policy: Any) -> str:
    payload = {
        "contractHash": str(contract_hash_value),
        "policy": policy,
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


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


def machine_runtime_home(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    contract = load_contract(env=env)
    resolution = contract["resolution"]
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


def workspace_data_home(
    cwd: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str | None:
    env = os.environ if env is None else env
    start = os.path.realpath(
        os.path.abspath(os.path.expanduser(cwd or env.get("PWD") or os.getcwd()))
    )
    if os.path.isfile(start):
        start = os.path.dirname(start)
    existing = _nearest_existing_workspace_home(start)
    if existing:
        return existing
    git_root = _git_worktree_root(start)
    if git_root:
        return os.path.join(git_root, ".kungfu")
    return None


def default_runtime_home(
    env: Mapping[str, str] | None = None,
    *,
    cwd: str | None = None,
) -> str:
    env = os.environ if env is None else env
    contract = load_contract(env=env)
    resolution = contract["resolution"]
    env_name = resolution["runtimeHomeEnv"]
    if env.get(env_name):
        return os.path.abspath(os.path.expanduser(env[env_name]))
    workspace_home = workspace_data_home(cwd, env=env)
    return workspace_home or machine_runtime_home(env)


def _nearest_existing_workspace_home(start: str) -> str | None:
    current = os.path.realpath(os.path.abspath(start))
    legacy_user_home = os.path.realpath(
        os.path.join(os.path.expanduser("~"), ".kungfu")
    )
    while True:
        candidate = os.path.join(current, ".kungfu")
        if os.path.isdir(candidate) and candidate != legacy_user_home:
            return os.path.realpath(candidate)
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def _git_worktree_root(cwd: str) -> str | None:
    if not os.path.isdir(cwd):
        return None
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            check=False,
            capture_output=True,
            text=True,
        )
    except (OSError, ValueError):
        return None
    if result.returncode != 0:
        return None
    root = result.stdout.strip()
    if not root:
        return None
    return os.path.realpath(os.path.abspath(root))


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
