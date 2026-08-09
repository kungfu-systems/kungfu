# SPDX-License-Identifier: Apache-2.0

from kungfu.content_hash import compute_content_hash_value


_API_ATTR = "__kungfu_kfd3_api__"
_REGISTRY_FILE = "kfd3_api.registry.json"
_SCHEMA_FILE = "kfd3_api.schema.json"


def registry():
    from kungfu import agent as agent_pack

    return agent_pack.registry()


def registry_schema():
    from kungfu import agent as agent_pack

    return agent_pack.registry_schema()


def registry_digest():
    from kungfu import agent as agent_pack

    data = agent_pack.document_text(_REGISTRY_FILE).encode("utf-8")
    return compute_content_hash_value(data)


def kfd3_api(api_id):
    def decorate(fn):
        setattr(fn, _API_ATTR, api_id)
        return fn

    return decorate


def api_help(api_id):
    api = _api_map().get(api_id)
    if api is None:
        return f"KFD-3 API {api_id}"
    return api["purpose"]


def registry_summary():
    data = registry()
    apis = data.get("apis", [])
    runtime = [
        row for row in apis if row.get("anchor", {}).get("kind") == "runtime-click"
    ]
    catalog = [row for row in apis if row.get("anchor", {}).get("kind") == "catalog"]
    return {
        "schema": data.get("schema"),
        "registryId": data.get("registryId"),
        "standard": data.get("standard"),
        "profile": data.get("profile"),
        "sha256": registry_digest(),
        "apiCount": len(apis),
        "runtimeAnchoredCount": len(runtime),
        "catalogOnlyCount": len(catalog),
        "auditBoundary": data.get("auditBoundary"),
        "witness": data.get("witness"),
    }


def verify_agent_interface(root_command):
    data = registry()
    schema = registry_schema()
    commands = _commands()
    registry_errors = _validate_registry_shape(data, schema)
    runtime_audit = _audit_click_tree(root_command)
    catalog_audit = _audit_command_catalog(data, commands)
    ok = (
        not registry_errors
        and not runtime_audit["missingRuntimeAnchors"]
        and not runtime_audit["staleRuntimeAnchors"]
        and not runtime_audit["hiddenRuntimeCommands"]
        and not catalog_audit["missingRegistryEntries"]
        and not catalog_audit["missingCatalogEntries"]
    )
    return {
        "schema": "kungfu.agent-verify/v1",
        "ok": ok,
        "standard": data.get("standard"),
        "profile": data.get("profile"),
        "auditBoundary": data.get("auditBoundary"),
        "registry": registry_summary(),
        "registryErrors": registry_errors,
        "runtimeAnchors": runtime_audit,
        "commandCatalog": catalog_audit,
        "hiddenUsableApis": runtime_audit["hiddenRuntimeCommands"],
        "witness": data.get("witness"),
    }


def _api_map():
    return {row["id"]: row for row in registry().get("apis", [])}


def _commands():
    from kungfu import agent as agent_pack

    return agent_pack.commands()


def _validate_registry_shape(data, schema):
    failures = []
    for field in schema.get("requiredTopLevel", []):
        if field not in data:
            failures.append(f"registry missing top-level field {field}")
    required = schema.get("apiRequiredFields", [])
    ids = set()
    for index, row in enumerate(data.get("apis", [])):
        row_id = row.get("id", f"<index:{index}>")
        if row_id in ids:
            failures.append(f"registry duplicate api id {row_id}")
        ids.add(row_id)
        for field in required:
            if field not in row:
                failures.append(f"registry api {row_id} missing field {field}")
        visibility = row.get("visibility")
        if visibility not in schema.get("visibility", []):
            failures.append(
                f"registry api {row_id} has invalid visibility {visibility}"
            )
        anchor_kind = row.get("anchor", {}).get("kind")
        if anchor_kind not in schema.get("anchorKinds", []):
            failures.append(
                f"registry api {row_id} has invalid anchor kind {anchor_kind}"
            )
    return failures


def _audit_click_tree(root_command):
    registry_ids = set(_api_map())
    expected = {
        row["id"]
        for row in registry().get("apis", [])
        if row.get("anchor", {}).get("kind") == "runtime-click"
    }
    observed = []
    hidden = []
    for path, command in _walk_click_tree(root_command, "kungfu agent"):
        api_id = _command_api_id(command)
        if api_id:
            observed.append({"path": path, "apiId": api_id})
        else:
            hidden.append(path)
    observed_ids = {row["apiId"] for row in observed}
    return {
        "root": "kungfu agent",
        "expected": sorted(expected),
        "observed": observed,
        "missingRuntimeAnchors": sorted(expected - observed_ids),
        "staleRuntimeAnchors": sorted(observed_ids - registry_ids),
        "hiddenRuntimeCommands": sorted(hidden),
    }


def _walk_click_tree(command, path):
    yield path, command
    for name, child in getattr(command, "commands", {}).items():
        yield from _walk_click_tree(child, f"{path} {name}")


def _command_api_id(command):
    callback = getattr(command, "callback", None)
    api_id = getattr(callback, _API_ATTR, None)
    if api_id:
        return api_id
    return getattr(command, _API_ATTR, None)


def _audit_command_catalog(data, commands):
    catalog_names = {
        row.get("name")
        for row in commands.get("commands", [])
        if isinstance(row.get("name"), str)
    }
    registry_names = set()
    for row in data.get("apis", []):
        if "commands.json" not in row.get("projections", []):
            continue
        registry_names.add(row.get("name"))
        for alias in row.get("aliases", []):
            registry_names.add(alias)
    return {
        "schema": commands.get("schema"),
        "catalogCount": len(catalog_names),
        "registryProjectedCount": len(registry_names),
        "missingRegistryEntries": sorted(catalog_names - registry_names),
        "missingCatalogEntries": sorted(registry_names - catalog_names),
    }
