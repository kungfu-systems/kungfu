# SPDX-License-Identifier: Apache-2.0

"""Versioned fold for the complete Kungfu CLI surface.

The Click command tree remains the authority for source-reachable paths.  This
module folds that tree with the small, versioned metadata registry shipped next
to it.  It deliberately does not maintain a second hand-written list of leaf
commands.
"""

from __future__ import annotations

import hashlib
import json
import re
from importlib import resources
from pathlib import Path
from typing import Any, Iterable

import click


_PACKAGE = "kungfu.cli"
_REGISTRY_FILE = "surface_contract.registry.json"
_SCHEMA_FILE = "surface_contract.schema.json"
_SURFACE_ATTR = "__kungfu_cli_surface__"
_KFD3_ATTR = "__kungfu_kfd3_api__"


def registry() -> dict[str, Any]:
    return _read_json(_REGISTRY_FILE)


def contract_schema() -> dict[str, Any]:
    return _read_json(_SCHEMA_FILE)


def _read_json(name: str) -> dict[str, Any]:
    return json.loads(resources.files(_PACKAGE).joinpath(name).read_text("utf-8"))


def refresh_expected_surface_root(contract: dict[str, Any], target: Path) -> bool:
    source = target.read_text(encoding="utf-8")
    registry = json.loads(source)
    projection = registry.get("catalogProjection")
    expected = contract.get("surfaceRoot")
    if not isinstance(projection, dict) or not isinstance(expected, str):
        raise ValueError("CLI registry has no catalog surface-root projection")
    current = projection.get("expectedSurfaceRoot")
    if not isinstance(current, str):
        raise ValueError("CLI registry expected surface root is missing")
    if current == expected:
        return False
    current_literal = json.dumps(current)
    if source.count(current_literal) != 1:
        raise ValueError("CLI registry expected surface root is not uniquely writable")
    updated = source.replace(current_literal, json.dumps(expected), 1)
    if (
        json.loads(updated).get("catalogProjection", {}).get("expectedSurfaceRoot")
        != expected
    ):
        raise ValueError("CLI registry expected surface root refresh failed")
    target.write_text(updated, encoding="utf-8")
    return True


def surface(**metadata: Any):
    """Attach non-derivable surface metadata to a Click callback.

    Existing commands need no annotation: stable Python symbol identity and
    family policy provide their first contract. A pre-release rename migrates
    every authored consumer and leaves no alias; ownership transfers and
    exceptional mutation policy use this hook or a registry override.
    """

    def decorate(callback):
        current = dict(getattr(callback, _SURFACE_ATTR, {}))
        current.update(metadata)
        setattr(callback, _SURFACE_ATTR, current)
        return callback

    return decorate


def _valid_output_declaration(output: Any, supported_modes: list[str]) -> bool:
    if not isinstance(output, dict):
        return False
    default_mode = output.get("defaultMode")
    modes = output.get("modes")
    schema_refs = output.get("schemaRefs")
    if not isinstance(modes, list) or not isinstance(schema_refs, list):
        return False
    if any(mode not in supported_modes for mode in modes):
        return False
    if any(not isinstance(reference, str) for reference in schema_refs):
        return False
    if default_mode not in supported_modes:
        return False
    if default_mode == "unspecified":
        return not modes and not schema_refs
    return default_mode in modes


def _dangling_output_schema_refs(
    output: Any, metadata_registry: dict[str, Any], known_api_ids: set[Any]
) -> list[str]:
    if not isinstance(output, dict) or not isinstance(output.get("schemaRefs"), list):
        return []
    return [
        reference
        for reference in output["schemaRefs"]
        if isinstance(reference, str)
        and not _known_schema_ref(reference, metadata_registry, known_api_ids)
    ]


def _validate_output_contract(
    row: dict[str, Any],
    *,
    label: str,
    errors: list[dict[str, str]],
    metadata_registry: dict[str, Any],
    schema: dict[str, Any],
    known_api_ids: set[Any],
) -> None:
    output = row.get("output", {})
    if not _valid_output_declaration(output, schema.get("outputModes", [])):
        _error(
            errors,
            "invalid-output-contract",
            label,
            f"unsupported output contract {output!r}",
        )
    for reference in _dangling_output_schema_refs(
        output, metadata_registry, known_api_ids
    ):
        _error(
            errors,
            "dangling-output-schema-ref",
            label,
            f"unknown output schema reference {reference}",
        )


def fold(
    root_command: click.Command,
    *,
    metadata_registry: dict[str, Any] | None = None,
    schema: dict[str, Any] | None = None,
    kfd3_registry: dict[str, Any] | None = None,
    command_catalog: dict[str, Any] | None = None,
    contributions: Iterable[dict[str, Any]] = (),
) -> dict[str, Any]:
    """Fold live Click commands and optional KFX contributions into one graph."""

    metadata_registry = metadata_registry or registry()
    schema = schema or contract_schema()
    kfd3_registry = kfd3_registry or _load_kfd3_registry()
    command_catalog = command_catalog or _load_command_catalog()
    observed = list(_walk_click_tree(root_command, root_command.name or "kungfu"))
    records = _coalesce_click_paths(observed, metadata_registry)
    stable_ids = _stable_ids(records)
    api_map = {row["id"]: row for row in kfd3_registry.get("apis", [])}
    api_paths = _kfd3_path_map(
        kfd3_registry, {path: True for path, _command in observed}
    )

    surfaces = []
    for record, stable_id in zip(records, stable_ids):
        surfaces.append(
            _click_surface(record, stable_id, metadata_registry, api_map, api_paths)
        )

    contribution_rows = list(metadata_registry.get("contributions", []))
    contribution_rows.extend(contributions)
    surfaces.extend(
        _contribution_surface(row, metadata_registry) for row in contribution_rows
    )
    surfaces.sort(key=lambda row: (row["canonical_path"], row["id"]))
    registry_root = _content_root(metadata_registry)
    schema_root = _content_root(schema)
    surface_root = _content_root(surfaces)
    contract_root = _content_root(
        {
            "schema": "kungfu.cli-surface-contract/v1",
            "version": metadata_registry.get("version"),
            "registryRoot": registry_root,
            "schemaRoot": schema_root,
            "surfaceRoot": surface_root,
        }
    )

    diagnostics = validate(
        surfaces,
        metadata_registry=metadata_registry,
        schema=schema,
        kfd3_registry=kfd3_registry,
        command_catalog=command_catalog,
        observed_paths=[path for path, _command in observed],
    )
    return {
        "schema": "kungfu.cli-surface-contract/v1",
        "contractId": metadata_registry.get("contractId"),
        "version": metadata_registry.get("version"),
        "contractRoot": contract_root,
        "registryRoot": registry_root,
        "schemaRoot": schema_root,
        "surfaceRoot": surface_root,
        "source": {
            "pathAuthority": "live-click-tree",
            "root": root_command.name or "kungfu",
            "linkedAuthorities": metadata_registry.get("linkedAuthorities", {}),
        },
        "surfaces": surfaces,
        "diagnostics": diagnostics,
        "nonClaims": metadata_registry.get("nonClaims", []),
    }


def validate(
    surfaces: Iterable[dict[str, Any]],
    *,
    metadata_registry: dict[str, Any] | None = None,
    schema: dict[str, Any] | None = None,
    kfd3_registry: dict[str, Any] | None = None,
    command_catalog: dict[str, Any] | None = None,
    observed_paths: Iterable[str] | None = None,
) -> dict[str, Any]:
    metadata_registry = metadata_registry or registry()
    schema = schema or contract_schema()
    kfd3_registry = kfd3_registry or _load_kfd3_registry()
    command_catalog = command_catalog or _load_command_catalog()
    rows = list(surfaces)
    errors: list[dict[str, str]] = []

    required = schema.get("surfaceRequiredFields", [])
    enum_fields = {
        "owner": "owners",
        "maturity": "maturity",
        "visibility": "visibility",
        "mutation_class": "mutationClasses",
    }
    ids: dict[str, dict[str, Any]] = {}
    paths: dict[str, dict[str, Any]] = {}
    known_api_ids = {row.get("id") for row in kfd3_registry.get("apis", [])}
    observed_api_ids = set()

    if metadata_registry.get("aliases"):
        _error(
            errors,
            "registry-alias-forbidden",
            "registry",
            "canonical-only CLI registry must contain zero aliases",
        )
    if metadata_registry.get("aliasDispositionProfiles"):
        _error(
            errors,
            "alias-policy-forbidden",
            "registry",
            "canonical-only CLI registry must not retain alias policy",
        )

    for row in rows:
        label = str(row.get("id") or row.get("canonical_path") or "<unknown>")
        nullable = {"kfd3_api_id"}
        for field in required:
            if field not in row or (row.get(field) is None and field not in nullable):
                _error(errors, "missing-field", label, f"missing field {field}")
        for field, enum_name in enum_fields.items():
            value = row.get(field)
            if value not in schema.get(enum_name, []):
                _error(
                    errors,
                    f"unknown-{field.replace('_', '-')}",
                    label,
                    f"unsupported {field} {value!r}",
                )
        for audience in row.get("audience", []):
            if audience not in schema.get("audiences", []):
                _error(
                    errors,
                    "unknown-audience",
                    label,
                    f"unsupported audience {audience!r}",
                )
        approval = row.get("approval_policy", {})
        if approval.get("mode") not in schema.get("approvalModes", []):
            _error(
                errors,
                "unknown-approval-policy",
                label,
                f"unsupported approval mode {approval.get('mode')!r}",
            )
        availability = row.get("availability", {})
        state = availability.get("state")
        if state not in schema.get("availabilityStates", []):
            _error(
                errors,
                "unknown-availability",
                label,
                f"unsupported availability state {state!r}",
            )
        if state != "available" and not availability.get("reason"):
            _error(
                errors,
                "unavailable-without-reason",
                label,
                "degraded or unavailable contributions require a typed reason",
            )
        _validate_output_contract(
            row,
            label=label,
            errors=errors,
            metadata_registry=metadata_registry,
            schema=schema,
            known_api_ids=known_api_ids,
        )

        row_id = row.get("id")
        if not isinstance(row_id, str) or not row_id:
            _error(errors, "invalid-id", label, "stable id must be a non-empty string")
        elif row_id in ids:
            _error(errors, "duplicate-id", label, f"duplicate stable id {row_id}")
        else:
            ids[row_id] = row
        path = row.get("canonical_path")
        if not isinstance(path, str) or not path.startswith("kungfu"):
            _error(
                errors,
                "invalid-canonical-path",
                label,
                f"canonical path must start with kungfu: {path!r}",
            )
        if isinstance(path, str) and path in paths:
            prior = paths[path]
            code = (
                "owner-conflict"
                if prior.get("owner") != row.get("owner")
                else "duplicate-canonical-path"
            )
            _error(errors, code, label, f"canonical path already claimed: {path}")
        elif isinstance(path, str):
            paths[path] = row

        if row.get("aliases"):
            _error(
                errors,
                "runtime-alias-forbidden",
                label,
                f"command is registered at multiple paths: {row.get('aliases')}",
            )

        api_ids = row.get("kfd3_api_ids", [])
        api_id = row.get("kfd3_api_id")
        if api_id and api_id not in api_ids:
            api_ids = [api_id, *api_ids]
        for linked_api_id in api_ids:
            observed_api_ids.add(linked_api_id)
            if linked_api_id not in known_api_ids:
                _error(
                    errors,
                    "dangling-kfd3-api",
                    label,
                    f"unknown KFD-3 API id {linked_api_id}",
                )
        for reference in row.get("schema_refs", []):
            if not _known_schema_ref(reference, metadata_registry, known_api_ids):
                _error(
                    errors,
                    "dangling-schema-ref",
                    label,
                    f"unknown schema reference {reference}",
                )
        if row.get("kind") == "family" and not row.get("source", {}).get(
            "familyPolicy"
        ):
            _error(
                errors,
                "orphan-family-policy",
                label,
                "top-level Click family has no explicit registry policy",
            )

    expected_api_ids = {
        row.get("id")
        for row in kfd3_registry.get("apis", [])
        if row.get("anchor", {}).get("kind") == "runtime-click"
    }
    for api_id in sorted(expected_api_ids - observed_api_ids):
        _error(
            errors,
            "orphan-kfd3-api",
            str(api_id),
            "runtime-click KFD-3 API is not linked to a live CLI surface",
        )

    if observed_paths is not None:
        expected_paths = set(observed_paths)
        folded_paths = {
            path
            for row in rows
            if row.get("source", {}).get("kind") == "runtime-click"
            for path in [row.get("canonical_path"), *row.get("aliases", [])]
        }
        for path in sorted(expected_paths - folded_paths):
            _error(errors, "orphan-click-command", path, "live Click path is absent")
        for path in sorted(folded_paths - expected_paths):
            _error(errors, "stale-click-surface", path, "folded path is not live")

    surface_by_path = {
        path: row
        for row in rows
        for path in [row.get("canonical_path"), *row.get("aliases", [])]
    }
    for catalog_row in command_catalog.get("commands", []):
        path = _resolve_catalog_path(
            catalog_row.get("name"),
            surface_by_path,
            metadata_registry.get("standaloneCatalogRoutes", []),
        )
        api_id = catalog_row.get("apiId")
        linked = surface_by_path.get(path)
        if linked is None:
            _error(
                errors,
                "orphan-agent-catalog",
                str(catalog_row.get("name")),
                f"catalog path is not source-reachable: {path}",
            )
        elif api_id not in linked.get("kfd3_api_ids", []):
            _error(
                errors,
                "agent-catalog-link-mismatch",
                path,
                f"catalog expects {api_id}, surface links {linked.get('kfd3_api_ids')}",
            )

    errors.sort(key=lambda row: (row["code"], row["subject"], row["message"]))
    return {
        "schema": "kungfu.cli-surface-diagnostics/v1",
        "ok": not errors,
        "surfaceCount": len(rows),
        "familyCount": sum(
            row.get("path_depth") == 2
            and row.get("source", {}).get("kind") == "runtime-click"
            for row in rows
        ),
        "leafCount": sum(row.get("kind") == "command" for row in rows),
        "contributionCount": sum(
            row.get("source", {}).get("kind") == "kfx-contribution" for row in rows
        ),
        "errors": errors,
    }


def validate_action_topology(
    contract: dict[str, Any], action_topology: dict[str, Any]
) -> dict[str, Any]:
    """Check KF-ADR-019f86da-4f90-710c-a3b6-5e0cb5a28ad0's Action CLI topology against the folded live tree."""

    available = {
        path
        for row in contract.get("surfaces", [])
        if row.get("availability", {}).get("state") == "available"
        for path in [row.get("canonical_path"), *row.get("aliases", [])]
    }
    expected = {action_topology.get("onboarding", {}).get("command")}
    for name, group in action_topology.get("groups", {}).items():
        group_path = group.get("command") or f"kungfu {name}"
        expected.add(group_path)
        expected.update(
            f"{group_path} {operation}" for operation in group.get("operations", [])
        )
    expected.discard(None)
    missing = sorted(expected - available)
    return {
        "schema": "kungfu.cli-action-topology-parity/v1",
        "ok": not missing,
        "expected": sorted(expected),
        "missing": missing,
    }


def _walk_click_tree(command: click.Command, path: str):
    yield path, command
    for name, child in getattr(command, "commands", {}).items():
        yield from _walk_click_tree(child, f"{path} {name}")


def _coalesce_click_paths(observed, metadata_registry):
    aliases = {row.get("path") for row in metadata_registry.get("aliases", [])}
    by_object: dict[int, dict[str, Any]] = {}
    order = []
    for path, command in observed:
        key = id(command)
        if key not in by_object:
            by_object[key] = {"command": command, "paths": []}
            order.append(key)
        by_object[key]["paths"].append(path)
    records = []
    for key in order:
        record = by_object[key]
        paths = record["paths"]
        canonical = next((path for path in paths if path not in aliases), paths[0])
        record["canonical_path"] = canonical
        record["aliases"] = [path for path in paths if path != canonical]
        records.append(record)
    return records


def _stable_ids(records):
    bases = [_stable_id_base(record["command"]) for record in records]
    counts = {base: bases.count(base) for base in set(bases)}
    result = []
    for record, base in zip(records, bases):
        if counts[base] > 1:
            base = f"{base}.{_slug(record['canonical_path'])}"
        result.append(base)
    return result


def _stable_id_base(command):
    callback = getattr(command, "callback", None)
    api_id = _callback_attr(callback, _KFD3_ATTR)
    if api_id:
        return api_id
    explicit = _callback_attr(callback, _SURFACE_ATTR).get("id")
    if explicit:
        return explicit
    module = getattr(callback, "__module__", command.__class__.__module__)
    symbol = getattr(
        callback, "__qualname__", command.name or command.__class__.__name__
    )
    module = module.removeprefix("kungfu.")
    namespace = "kungfu" if module.startswith("cli.") else "kungfu.cli"
    return f"{namespace}.{_slug(module)}.{_slug(symbol)}"


def _click_surface(record, stable_id, metadata_registry, api_map, api_paths):
    command = record["command"]
    path = record["canonical_path"]
    tokens = path.split()
    family = tokens[1] if len(tokens) > 1 else None
    defaults = dict(metadata_registry.get("defaults", {}))
    policy = metadata_registry.get("familyPolicies", {}).get(family, {})
    inherited_policy = dict(policy)
    if len(tokens) > 2:
        inherited_policy.pop("visibility", None)
    callback_metadata = _callback_attr(
        getattr(command, "callback", None), _SURFACE_ATTR
    )
    override = metadata_registry.get("overrides", {}).get(stable_id, {})
    path_override = metadata_registry.get("overrides", {}).get(path, {})
    metadata = _merge(
        defaults, inherited_policy, callback_metadata, override, path_override
    )
    explicit_api_id = (
        _callback_attr(getattr(command, "callback", None), _KFD3_ATTR) or None
    )
    linked_api_ids = {
        api_id
        for observed_path in record["paths"]
        for api_id in api_paths.get(observed_path, set())
    }
    if explicit_api_id:
        linked_api_ids.add(explicit_api_id)
    api_ids = sorted(linked_api_ids, key=lambda value: (value.count("."), value))
    api_id = explicit_api_id or (api_ids[0] if api_ids else None)
    mutation_class, approval = _mutation_policy(command, path, metadata_registry)
    explicit_maturity = any(
        "maturity" in value
        for value in (inherited_policy, callback_metadata, override, path_override)
    )
    if api_id and api_id in api_map and not explicit_maturity:
        metadata["maturity"] = api_map[api_id].get("maturity", "stable")
    explicit_visibility = any(
        "visibility" in value for value in (callback_metadata, override, path_override)
    )
    if api_id and api_id in api_map and len(tokens) > 2 and not explicit_visibility:
        metadata["visibility"] = {
            "public-agent": "public",
            "public-human": "public",
            "adjacent-agent": "advanced",
            "internal": "hidden-internal",
        }.get(api_map[api_id].get("visibility"), metadata.get("visibility"))
    kind = (
        "root"
        if len(tokens) == 1
        else "family"
        if len(tokens) == 2 and isinstance(command, click.Group)
        else ("group" if isinstance(command, click.Group) else "command")
    )
    hidden = bool(getattr(command, "hidden", False))
    availability = metadata.get("availability") or {
        "state": "available",
        "conditions": ["source-runtime"],
    }
    return {
        "id": metadata.get("id", stable_id),
        "canonical_path": path,
        "aliases": sorted(set(record["aliases"] + metadata.get("aliases", []))),
        "owner": metadata.get("owner"),
        "audience": metadata.get("audience", []),
        "maturity": metadata.get("maturity"),
        "visibility": "hidden-internal" if hidden else metadata.get("visibility"),
        "section": "internal" if hidden else metadata.get("section"),
        "kfd3_api_id": api_id,
        "kfd3_api_ids": api_ids,
        "mutation_class": metadata.get("mutation_class", mutation_class),
        "approval_policy": metadata.get("approval_policy", approval),
        "schema_refs": metadata.get("schema_refs", []),
        "output": metadata.get(
            "output",
            {"defaultMode": "unspecified", "modes": [], "schemaRefs": []},
        ),
        "availability": availability,
        "kind": kind,
        "path_depth": len(tokens),
        "summary": _clean(command.get_short_help_str(limit=240)),
        "parameters": [_parameter_contract(param) for param in command.params],
        "source": {
            "kind": "runtime-click",
            "module": getattr(getattr(command, "callback", None), "__module__", None),
            "symbol": getattr(getattr(command, "callback", None), "__qualname__", None),
            "familyPolicy": family is None
            or family in metadata_registry.get("familyPolicies", {}),
        },
    }


def _contribution_surface(row, metadata_registry):
    metadata = _merge(metadata_registry.get("defaults", {}), row)
    source = dict(metadata.get("source", {}))
    source.setdefault("kind", "kfx-contribution")
    return {
        "id": metadata.get("id"),
        "canonical_path": metadata.get("canonical_path"),
        "aliases": metadata.get("aliases", []),
        "owner": metadata.get("owner"),
        "audience": metadata.get("audience", []),
        "maturity": metadata.get("maturity"),
        "visibility": metadata.get("visibility"),
        "section": metadata.get("section"),
        "kfd3_api_id": metadata.get("kfd3_api_id"),
        "kfd3_api_ids": metadata.get(
            "kfd3_api_ids",
            [metadata["kfd3_api_id"]] if metadata.get("kfd3_api_id") else [],
        ),
        "mutation_class": metadata.get("mutation_class", "read"),
        "approval_policy": metadata.get(
            "approval_policy", {"mode": "none", "preconditions": []}
        ),
        "schema_refs": metadata.get("schema_refs", []),
        "output": metadata.get(
            "output",
            {"defaultMode": "unspecified", "modes": [], "schemaRefs": []},
        ),
        "availability": metadata.get("availability", {"state": "unavailable"}),
        "kind": metadata.get("kind", "command"),
        "path_depth": len(str(metadata.get("canonical_path", "")).split()),
        "summary": metadata.get("summary", ""),
        "parameters": metadata.get("parameters", []),
        "source": source,
    }


def _mutation_policy(command, path, metadata_registry):
    rules = metadata_registry.get("mutationRules", {})
    tokens = set(re.split(r"[._-]+", path.rsplit(" ", 1)[-1].lower()))
    option_names = {
        param.name for param in command.params if isinstance(param, click.Option)
    }
    execute_flag = "execute" in option_names
    expected = sorted(
        name
        for name in option_names
        if name is not None
        and (
            name.startswith("expected_")
            or name in {"authorization_file", "authorization_id"}
        )
    )
    if tokens & set(rules.get("destructiveTokens", [])):
        mutation = "destructive"
    elif tokens & set(rules.get("externalEffectTokens", [])):
        mutation = "external-effect"
    elif execute_flag:
        mutation = "write"
    elif tokens & set(rules.get("planTokens", [])):
        mutation = "plan"
    elif tokens & set(rules.get("writeTokens", [])):
        mutation = "write"
    else:
        mutation = "read"

    if {"authorization_file", "authorization_id", "authorized_by"} & option_names:
        mode = "authorization-artifact"
    elif execute_flag:
        mode = "explicit-execute"
    else:
        mode = "none"
    return mutation, {
        "mode": mode,
        "preconditions": expected,
        "caller_confirmation_required": mutation in {"destructive", "external-effect"},
    }


def _parameter_contract(param):
    row = {
        "name": param.name,
        "kind": "option" if isinstance(param, click.Option) else "argument",
        "required": bool(param.required),
        "arity": param.nargs,
        "type": param.type.name,
    }
    if isinstance(param, click.Option):
        row["flags"] = list(param.opts + param.secondary_opts)
        row["hidden"] = bool(param.hidden)
    return row


def _known_schema_ref(reference, metadata_registry, known_api_ids):
    if not isinstance(reference, str):
        return False
    if reference.startswith("click://"):
        return True
    if reference.startswith("kfd3://api/"):
        return reference.removeprefix("kfd3://api/") in known_api_ids
    return reference in metadata_registry.get("schemaCatalog", [])


def _load_kfd3_registry():
    from kungfu import agent as agent_pack

    return agent_pack.registry()


def _load_command_catalog():
    from kungfu import agent as agent_pack

    return agent_pack.commands()


def _kfd3_path_map(kfd3_registry, live_paths):
    result: dict[str, set[str]] = {}
    for row in kfd3_registry.get("apis", []):
        for name in [row.get("name"), *row.get("aliases", [])]:
            path = _resolve_catalog_path(name, live_paths)
            if path:
                result.setdefault(path, set()).add(row.get("id"))
    return result


def _canonical_cli_path(name):
    if not isinstance(name, str):
        return None
    tokens = []
    for token in name.split():
        if token.startswith(("-", "[", "<", "{")):
            break
        tokens.append(token)
    return " ".join(tokens)


def _resolve_catalog_path(name, surface_by_path, standalone_routes=None):
    for route in standalone_routes or []:
        prefix = route.get("prefix")
        target = route.get("target")
        if (
            isinstance(name, str)
            and isinstance(prefix, str)
            and isinstance(target, str)
            and (name == prefix or name.startswith(f"{prefix} "))
            and target in surface_by_path
        ):
            return target
    path = _canonical_cli_path(name)
    tokens = (path or "").split()
    while len(tokens) >= 2:
        candidate = " ".join(tokens)
        if candidate in surface_by_path:
            return candidate
        tokens.pop()
    return path


def _callback_attr(callback, name):
    if callback is None:
        return {} if name == _SURFACE_ATTR else None
    value = getattr(callback, name, None)
    if name == _SURFACE_ATTR:
        return dict(value or {})
    return value


def _merge(*values):
    result = {}
    for value in values:
        if value:
            result.update(value)
    return result


def _content_root(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def content_root(value):
    """Return the contract's canonical content root for consumer projections."""

    return _content_root(value)


def _slug(value):
    return re.sub(r"[^a-z0-9]+", ".", str(value).lower()).strip(".")


def _clean(value):
    return " ".join((value or "").split())


def _error(errors, code, subject, message):
    errors.append({"code": code, "subject": subject, "message": message})
