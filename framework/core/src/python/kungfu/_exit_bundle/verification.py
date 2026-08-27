# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
from typing import Any, Mapping

from kungfu import contract as contract_runtime
from kungfu.action_envelope import canonical_json_bytes

from kungfu._exit_bundle.common import (
    INSPECTION_SCHEMA,
    MANIFEST_SCHEMA,
    PACKAGE_SCHEMA,
    ExitBundleError,
    _KINDS,
    _THIN_CAPABILITIES,
    _contract,
    _describe,
    _exit_facade_seam,
    _manifest_root,
    _material_root,
    _package_root,
    _schema_root,
)


def _validate_dependency_closure(package: Mapping[str, Any]) -> None:
    manifest = package["manifest"]
    members = {row["memberId"]: row for row in manifest["members"]}
    execution = package.get("execution") or {}
    profiles = [
        (member_id, members[member_id], str(value.get("profileSuiteRoot") or ""))
        for member_id, value in execution.items()
        if value.get("kind") == "profile-source-v1"
    ]
    for member_id, value in execution.items():
        if value.get("kind") != "initiative-bundle-v1":
            continue
        expected = str(value.get("requiresProfileSuiteRoot") or "")
        matches = [
            candidate_id
            for candidate_id, _descriptor, profile_root in profiles
            if profile_root == expected
        ]
        if len(matches) != 1:
            raise ExitBundleError(
                "initiative-profile-closure-invalid",
                "Initiative material requires exactly one matching Profile source member",
                initiativeMemberId=member_id,
                profileSuiteRoot=expected,
                matchingProfileMembers=matches,
            )


def _validate_mode_semantics(manifest: Mapping[str, Any]) -> None:
    mode = manifest.get("mode")
    closure = manifest.get("closure") or {}
    members = manifest.get("members") or []
    requirements = manifest.get("requirements") or {}
    if mode == "thin":
        expected = {
            "selfContained": False,
            "completeForScope": False,
            "materialMissing": True,
            "degraded": True,
        }
        overclaim = (
            closure != expected
            or any(
                value not in _THIN_CAPABILITIES for value in manifest["capabilities"]
            )
            or any(
                value not in _THIN_CAPABILITIES
                for value in requirements.get("requiredCapabilities") or []
            )
            or any(
                member["material"]["included"]
                or member["import"]["execute"]
                or any(
                    value not in _THIN_CAPABILITIES for value in member["capabilities"]
                )
                for member in members
            )
        )
        if overclaim:
            raise ExitBundleError(
                "thin-capability-overclaim",
                "thin package claims material, closure, or unsafe capabilities",
            )
        return
    expected = {
        "selfContained": True,
        "completeForScope": True,
        "materialMissing": False,
        "degraded": False,
    }
    if closure != expected:
        raise ExitBundleError(
            "full-closure-invalid",
            "full package does not declare complete self-contained closure",
        )
    if any(
        omission.get("requiredForScope") is True
        for omission in manifest.get("omissions") or []
    ) or any(
        member["requiredForScope"] and not member["material"]["included"]
        for member in members
    ):
        raise ExitBundleError(
            "required-omission",
            "full package omits material required for its declared scope",
        )


def inspect(
    package: Mapping[str, Any],
    *,
    _contract_value: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Verify package, manifest, material bytes, and domain-owned member roots."""

    contract = dict(_contract_value) if _contract_value is not None else _contract()
    try:
        contract_runtime.validate_json_schema(
            package, contract["packageSchema"], "exit package"
        )
    except ValueError as error:
        raise ExitBundleError("package-schema-invalid", str(error)) from error
    if package.get("schema") != PACKAGE_SCHEMA:
        raise ExitBundleError("package-schema-invalid", f"expected {PACKAGE_SCHEMA}")
    if package.get("packageRoot") != _package_root(package):
        raise ExitBundleError("package-root-mismatch", "Exit package root mismatch")
    manifest = package.get("manifest")
    if not isinstance(manifest, Mapping):
        raise ExitBundleError("manifest-missing", "Exit package manifest is missing")
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise ExitBundleError(
            "unsupported-top-level-protocol",
            f"unsupported manifest schema: {manifest.get('schema')}",
        )
    expected_contract_root = _schema_root(contract["manifestSchema"])
    if manifest.get("contractSchemaRoot") != expected_contract_root:
        raise ExitBundleError(
            "contract-schema-root-mismatch",
            "Exit manifest was built against another contract schema",
            expected=expected_contract_root,
            actual=manifest.get("contractSchemaRoot"),
        )
    if manifest.get("bundleRoot") != _manifest_root(manifest):
        raise ExitBundleError("bundle-root-mismatch", "Exit manifest root mismatch")
    try:
        contract_runtime.validate_json_schema(
            manifest, contract["manifestSchema"], "exit bundle manifest"
        )
    except ValueError as error:
        raise ExitBundleError("manifest-schema-invalid", str(error)) from error
    _validate_mode_semantics(manifest)

    materials = package.get("materials")
    execution = package.get("execution")
    if not isinstance(materials, Mapping) or not isinstance(execution, Mapping):
        raise ExitBundleError(
            "package-inventory-invalid", "materials and execution must be objects"
        )
    member_ids: set[str] = set()
    identities: dict[tuple[str, str], str] = {}
    verified = []
    for member in manifest["members"]:
        member_id = str(member["memberId"])
        if member_id in member_ids:
            raise ExitBundleError("duplicate-member-identity", member_id)
        member_ids.add(member_id)
        kind = str((execution.get(member_id) or {}).get("kind") or "")
        spec = _KINDS.get(kind)
        if spec is None:
            if member["requiredForScope"]:
                raise ExitBundleError("unsupported-required-member", member_id)
            raise ExitBundleError("unsupported-optional-member", member_id)
        if member["schema"] != spec["schema"] or member["protocol"] != spec["protocol"]:
            raise ExitBundleError(
                "unsupported-member-protocol",
                f"{member_id} schema or protocol is unsupported",
            )
        identity = (str(member["authority"]), str(member["identityRoot"]))
        previous = identities.get(identity)
        if previous is not None and previous != member["contentRoot"]:
            raise ExitBundleError("conflicting-member-roots", member_id)
        identities[identity] = str(member["contentRoot"])
        material = materials.get(member_id)
        if manifest["mode"] == "thin":
            if material is not None or member["material"]["included"]:
                raise ExitBundleError(
                    "thin-capability-overclaim", "thin package contains material"
                )
            continue
        if material is None:
            raise ExitBundleError("required-material-missing", member_id)
        encoded = canonical_json_bytes(material)
        descriptor = member["material"]
        if (
            descriptor["included"] is not True
            or descriptor["encoding"] != "application/json"
            or descriptor["byteLength"] != len(encoded)
            or descriptor["sha256"] != _material_root(material)
        ):
            raise ExitBundleError("member-material-mismatch", member_id)
        described = _describe(kind, material)
        for field in ("authority", "schema", "protocol", "identityRoot", "contentRoot"):
            if member[field] != described[field]:
                raise ExitBundleError(
                    "member-root-mismatch",
                    f"{member_id} {field} differs from its domain descriptor",
                )
        verified.append(member_id)
    missing = set(manifest["requirements"]["requiredMembers"]) - member_ids
    if missing:
        raise ExitBundleError(
            "required-member-missing",
            "required members are missing",
            members=sorted(missing),
        )
    _validate_dependency_closure(package)
    return {
        "schema": INSPECTION_SCHEMA,
        "ok": True,
        "status": "degraded" if manifest["mode"] == "thin" else "verified",
        "mode": manifest["mode"],
        "bundleId": manifest["bundleId"],
        "bundleRoot": manifest["bundleRoot"],
        "packageRoot": package["packageRoot"],
        "verifiedMembers": verified,
        "materializedMembers": sorted(materials),
        "capabilities": manifest["capabilities"],
        "omissions": copy.deepcopy(manifest["omissions"]),
        "loss": copy.deepcopy(manifest["loss"]),
    }


for _exit_name in (
    "_validate_dependency_closure",
    "_validate_mode_semantics",
    "inspect",
):
    globals()[_exit_name] = _exit_facade_seam(_exit_name)(globals()[_exit_name])
del _exit_name
