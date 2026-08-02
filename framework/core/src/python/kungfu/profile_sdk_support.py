# SPDX-License-Identifier: Apache-2.0

"""Shared contracts and deterministic helpers for the Profile SDK layers."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Mapping, NoReturn

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


def _fail(message: str, **details: Any) -> NoReturn:
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
