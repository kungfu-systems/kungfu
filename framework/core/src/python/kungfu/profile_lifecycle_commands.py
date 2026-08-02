# SPDX-License-Identifier: Apache-2.0

"""Rooted Profile lifecycle command templates derived from the CLI catalog."""

from __future__ import annotations

import copy
import re
from typing import Any, Mapping

from kungfu import agent as agent_pack
from kungfu.profile_sdk_support import ProfileSdkError, _root


COMMAND_CONTRACT_SCHEMA = "kungfu.profile-lifecycle-command-contract/v1"
_PLACEHOLDER = re.compile(r"^\{([a-z][a-z0-9_]*)\}$")
_SHELL_TOKENS = {"sh", "bash", "zsh", "cmd", "powershell", "-c", "/c"}
_PLACEHOLDER_TYPES = {
    "binary": "executable-path",
    "profile_id": "profile-id",
    "source": "directory-path",
    "before_root": "sha256-root",
    "plan_file": "json-file-path",
    "authorization_file": "json-file-path",
    "expected_plan_id": "sha256-root",
    "choice": "approval-choice",
    "authorized_by": "actor-id",
}


def _is_root(value: Any) -> bool:
    if not isinstance(value, str) or not value.startswith("sha256:"):
        return False
    digest = value.removeprefix("sha256:")
    return len(digest) == 64 and all(char in "0123456789abcdef" for char in digest)


_OPERATIONS = (
    {
        "id": "profile.capabilities",
        "kind": "capabilities",
        "surface": "kungfu.cli.commands.profile.capabilities",
        "arguments": (),
        "preconditions": (),
        "output": "kungfu.agent-profile-sdk/v1",
        "receipt": "none",
        "impact": "Read the installed Profile SDK and lifecycle command contract.",
        "recovery": "Refresh the installed product if the contract root is unavailable.",
    },
    {
        "id": "profile.list",
        "kind": "list",
        "surface": "kungfu.cli.commands.profile.list.profiles",
        "arguments": (),
        "preconditions": (),
        "output": "kungfu.profile-lifecycle/v1",
        "receipt": "none",
        "impact": "Read the current Core-owned Profile lifecycle projection.",
        "recovery": "Inspect lifecycle diagnostics without applying a mutation.",
    },
    {
        "id": "profile.manager",
        "kind": "manager",
        "surface": "kungfu.cli.commands.profile.manager",
        "arguments": (),
        "preconditions": (),
        "output": "kungfu.profile-manager/v1",
        "receipt": "none",
        "impact": "Read lifecycle, source health, and composition projections.",
        "recovery": "Use Profile inspect to isolate a degraded source projection.",
    },
    {
        "id": "profile.inspect",
        "kind": "inspect",
        "surface": "kungfu.cli.commands.profile.inspect",
        "arguments": ("{profile_id}",),
        "preconditions": ("profile_id-present",),
        "output": "kungfu.profile-lifecycle/v1",
        "receipt": "none",
        "impact": "Read one exact Profile source or lifecycle state.",
        "recovery": "List Profiles and retry with one unambiguous Profile id.",
    },
    {
        "id": "profile.plan.upgrade",
        "kind": "plan",
        "surface": "kungfu.cli.commands.profile.plan",
        "arguments": (
            "upgrade",
            "{source}",
            "--expected-current-root",
            "{before_root}",
        ),
        "preconditions": ("source-exists", "before_root-matches-current"),
        "output": "kungfu.profile-agent-plan/v1",
        "receipt": "none",
        "impact": "Plan an upgrade at an exact current root without applying it.",
        "recovery": "Refresh Profile state and re-plan when the current root changes.",
    },
    {
        "id": "profile.apply",
        "kind": "apply",
        "surface": "kungfu.cli.commands.profile.apply",
        "arguments": (
            "{plan_file}",
            "--authorization-file",
            "{authorization_file}",
        ),
        "preconditions": (
            "plan_file-root-verified",
            "authorization_file-binds-plan",
        ),
        "output": "kungfu.profile-lifecycle-receipt/v1",
        "receipt": "kungfu.profile-lifecycle-receipt/v1",
        "impact": "Apply an authorized, still-current Profile lifecycle plan.",
        "recovery": "Inspect the receipt and current state before planning a rollback.",
    },
    {
        "id": "profile.authorize-upgrade",
        "kind": "authorize-lifecycle",
        "surface": "kungfu.cli.commands.profile.authorize.lifecycle",
        "arguments": (
            "upgrade",
            "{source}",
            "--expected-plan-id",
            "{expected_plan_id}",
            "--choice",
            "{choice}",
            "--authorized-by",
            "{authorized_by}",
        ),
        "preconditions": (
            "source-exists",
            "expected_plan_id-matches-current",
            "choice-explicit",
            "authorized_by-externally-verified",
        ),
        "output": "kungfu.profile-lifecycle-receipt/v1",
        "receipt": "kungfu.profile-lifecycle-receipt/v1",
        "impact": "Re-plan, authorize, and apply one exact Profile upgrade.",
        "recovery": "Re-plan after stale-root failure; use a reviewed rollback plan after mutation.",
    },
)


def _fail(message: str, **details: Any) -> None:
    raise ProfileSdkError("lifecycle-command-contract-invalid", message, **details)


def _surface_index(catalog: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    surfaces = catalog.get("surfaces")
    if not isinstance(surfaces, list):
        _fail("CLI catalog surfaces are unavailable")
    return {
        str(row.get("id")): row
        for row in surfaces
        if isinstance(row, Mapping) and row.get("id")
    }


def _authority_projection(
    lifecycle_authority: Mapping[str, Any],
    sdk_contract: Mapping[str, Any],
    cli_catalog: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "lifecycle": {
            "schema": lifecycle_authority.get("schema"),
            "authority": lifecycle_authority.get("authority"),
            "root": _root(lifecycle_authority),
        },
        "sdk": {
            "schema": sdk_contract.get("schema"),
            "id": sdk_contract.get("id"),
            "version": sdk_contract.get("version"),
            "root": sdk_contract.get("root"),
        },
        "cli": {
            "schema": cli_catalog.get("schema"),
            "contractRoot": cli_catalog.get("contractRoot"),
            "catalogRoot": cli_catalog.get("catalogRoot"),
            "surfaceRoot": cli_catalog.get("surfaceRoot"),
        },
    }


def command_contract(
    lifecycle_authority: Mapping[str, Any],
    sdk_contract: Mapping[str, Any],
    cli_catalog: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the canonical command contract from installed authority projections."""

    catalog = cli_catalog or agent_pack.cli_surface_catalog()
    surfaces = _surface_index(catalog)
    commands = []
    for spec in _OPERATIONS:
        surface = surfaces.get(str(spec["surface"]))
        if surface is None:
            _fail(
                "declared command is absent from the CLI catalog", operation=spec["id"]
            )
        canonical_path = str(surface.get("canonical_path") or "").split()
        if canonical_path[:2] != ["kungfu", "profile"]:
            _fail("CLI catalog path is not a Profile command", operation=spec["id"])
        mutation_class = str(surface.get("mutation_class") or "")
        mutation = mutation_class == "write"
        argv = ["{binary}", *canonical_path[1:], *spec["arguments"], "--json"]
        placeholders = []
        for token in argv:
            match = _PLACEHOLDER.fullmatch(token)
            if match:
                name = match.group(1)
                placeholders.append({"name": name, "type": _PLACEHOLDER_TYPES[name]})
        commands.append(
            {
                "id": spec["id"],
                "kind": spec["kind"],
                "surfaceId": spec["surface"],
                "commandPath": canonical_path,
                "argv": argv,
                "placeholders": placeholders,
                "mutation": mutation,
                "mutationClass": mutation_class,
                "approvalPolicy": copy.deepcopy(surface.get("approval_policy")),
                "preconditions": list(spec["preconditions"]),
                "outputSchema": spec["output"],
                "receiptSchema": spec["receipt"],
                "impact": spec["impact"],
                "diagnostics": {
                    "format": "kungfu.profile-diagnosis/v1",
                    "stderr": "diagnostic-only",
                },
                "recovery": spec["recovery"],
            }
        )
    body = {
        "schema": COMMAND_CONTRACT_SCHEMA,
        "version": 1,
        "authorities": _authority_projection(
            lifecycle_authority, sdk_contract, catalog
        ),
        "placeholderTypes": copy.deepcopy(_PLACEHOLDER_TYPES),
        "commands": commands,
    }
    contract = {**body, "contractRoot": _root(body)}
    validate_command_contract(
        contract,
        cli_catalog=catalog,
        lifecycle_authority=lifecycle_authority,
        sdk_contract=sdk_contract,
    )
    return contract


def validate_command_contract(
    contract: Mapping[str, Any],
    *,
    cli_catalog: Mapping[str, Any] | None = None,
    lifecycle_authority: Mapping[str, Any] | None = None,
    sdk_contract: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Fail closed on drift, shell templates, or authority/mutation mismatch."""

    value = copy.deepcopy(dict(contract))
    recorded_root = value.pop("contractRoot", None)
    if value.get("schema") != COMMAND_CONTRACT_SCHEMA or recorded_root != _root(value):
        _fail("Profile lifecycle command contract root mismatch")
    catalog = cli_catalog or agent_pack.cli_surface_catalog()
    surfaces = _surface_index(catalog)
    expected_authorities = value.get("authorities")
    if value.get("placeholderTypes") != _PLACEHOLDER_TYPES:
        _fail("command placeholder types do not match the installed contract")
    if not isinstance(expected_authorities, Mapping):
        _fail("command contract authority roots are unavailable")
    lifecycle_projection = expected_authorities.get("lifecycle") or {}
    sdk_projection = expected_authorities.get("sdk") or {}
    cli_projection = expected_authorities.get("cli") or {}
    if not all(
        _is_root(candidate)
        for candidate in (
            lifecycle_projection.get("root"),
            sdk_projection.get("root"),
            cli_projection.get("contractRoot"),
            cli_projection.get("catalogRoot"),
            cli_projection.get("surfaceRoot"),
        )
    ):
        _fail("command contract authority roots are incomplete")
    if lifecycle_authority is not None and sdk_contract is not None:
        expected = _authority_projection(lifecycle_authority, sdk_contract, catalog)
        if expected_authorities != expected:
            _fail("command contract authority roots do not match installed authorities")
    commands = value.get("commands")
    if not isinstance(commands, list) or not commands:
        _fail("command contract has no commands")
    seen: set[str] = set()
    for command in commands:
        if not isinstance(command, Mapping):
            _fail("command declaration must be an object")
        operation_id = str(command.get("id") or "")
        if not operation_id or operation_id in seen:
            _fail(
                "command operation ids must be stable and unique",
                operation=operation_id,
            )
        seen.add(operation_id)
        surface = surfaces.get(str(command.get("surfaceId") or ""))
        if surface is None:
            _fail(
                "command surface is absent from the CLI catalog", operation=operation_id
            )
        path = str(surface.get("canonical_path") or "").split()
        if command.get("commandPath") != path:
            _fail("command path does not match the CLI catalog", operation=operation_id)
        mutation_class = str(surface.get("mutation_class") or "")
        expected_mutation = mutation_class == "write"
        if (
            command.get("mutationClass") != mutation_class
            or command.get("mutation") is not expected_mutation
        ):
            _fail(
                "command mutation metadata conflicts with the CLI catalog",
                operation=operation_id,
            )
        if command.get("approvalPolicy") != surface.get("approval_policy"):
            _fail(
                "command approval policy conflicts with the CLI catalog",
                operation=operation_id,
            )
        argv = command.get("argv")
        if not isinstance(argv, list) or argv[: len(path)] != ["{binary}", *path[1:]]:
            _fail(
                "command argv does not begin with its canonical CLI path",
                operation=operation_id,
            )
        declared_placeholders = {
            row.get("name")
            for row in command.get("placeholders") or []
            if isinstance(row, Mapping)
            and row.get("type")
            == value.get("placeholderTypes", {}).get(row.get("name"))
        }
        found_placeholders: set[str] = set()
        for token in argv:
            if (
                not isinstance(token, str)
                or not token
                or any(char.isspace() for char in token)
            ):
                _fail(
                    "command argv must contain structured tokens",
                    operation=operation_id,
                )
            if token.lower() in _SHELL_TOKENS:
                _fail(
                    "shell evaluation is forbidden in command argv",
                    operation=operation_id,
                )
            match = _PLACEHOLDER.fullmatch(token)
            if match:
                name = match.group(1)
                if name not in _PLACEHOLDER_TYPES:
                    _fail(
                        "command uses an unknown placeholder",
                        operation=operation_id,
                        placeholder=name,
                    )
                found_placeholders.add(name)
            elif "{" in token or "}" in token:
                _fail("placeholders must occupy one argv token", operation=operation_id)
        if declared_placeholders != found_placeholders:
            _fail(
                "command placeholder declarations do not match argv",
                operation=operation_id,
            )
        preconditions = command.get("preconditions")
        if not isinstance(preconditions, list):
            _fail("command preconditions must be explicit", operation=operation_id)
        approval = command.get("approvalPolicy") or {}
        if expected_mutation and (
            not preconditions or approval.get("mode") in (None, "", "none")
        ):
            _fail(
                "mutating commands require approval and preconditions",
                operation=operation_id,
            )
        for field in (
            "outputSchema",
            "receiptSchema",
            "impact",
            "diagnostics",
            "recovery",
        ):
            if command.get(field) in (None, "", {}):
                _fail(
                    "command metadata is incomplete",
                    operation=operation_id,
                    field=field,
                )
    return dict(contract)


def render_command(
    contract: Mapping[str, Any],
    operation_id: str,
    bindings: Mapping[str, str],
    *,
    allow_mutation: bool = False,
) -> list[str]:
    """Render one structured argv vector, fencing mutation by default."""

    validate_command_contract(contract)
    command = next(
        (row for row in contract["commands"] if row.get("id") == operation_id), None
    )
    if command is None:
        _fail("unknown command operation", operation=operation_id)
    if command.get("mutation") is True and not allow_mutation:
        raise ProfileSdkError(
            "lifecycle-command-mutation-rejected",
            "mutating Profile commands require an explicit higher-authority caller",
            operation=operation_id,
        )
    rendered = []
    for token in command["argv"]:
        match = _PLACEHOLDER.fullmatch(token)
        if not match:
            rendered.append(token)
            continue
        name = match.group(1)
        replacement = bindings.get(name)
        if (
            not isinstance(replacement, str)
            or not replacement
            or any(char in replacement for char in "{}\n\r\0")
        ):
            _fail(
                "command binding is missing or unsafe",
                operation=operation_id,
                placeholder=name,
            )
        rendered.append(replacement)
    return rendered
