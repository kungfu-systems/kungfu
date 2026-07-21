# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import json
import os
import tarfile
from collections.abc import Mapping
from typing import Any

from kungfu import contract as contract_runtime


CONTRACT_SCHEMA = "kungfu.kfx.contract/v1"
CONTRACT_FILE = "kungfu-kfx.contract.json"
CONTRACT_ENV = "KUNGFU_KFX_CONTRACT"
FIRST_PARTY_MANIFEST_SCHEMA = "kungfu.first-party-manifest/v1"


def resolve_contract_path(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    return contract_runtime.resolve_contract_path("kfx", contract_path, env=env)


def load_contract(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return contract_runtime.load_contract("kfx", contract_path, env=env)


def contract_hash(contract_path: str | None = None) -> str:
    return contract_runtime.contract_hash("kfx", contract_path)


def contract_metadata(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, str | int]:
    return contract_runtime.contract_metadata("kfx", contract_path, env=env)


def package_manifest_schema(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return copy.deepcopy(load_contract(contract_path, env=env)["packageManifestSchema"])


def profile_suite_schema(
    contract_path: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return copy.deepcopy(load_contract(contract_path, env=env)["profileSuiteSchema"])


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


def validate_profile_suite(
    profile: dict[str, Any],
    *,
    contract: dict[str, Any] | None = None,
    suite_members: list[str] | None = None,
) -> None:
    contract = load_contract() if contract is None else contract
    _validate_with_schema(
        profile,
        contract.get("profileSuiteSchema"),
        "Profile Suite",
    )
    members = profile.get("members") or {}
    required = members.get("required") or []
    optional = members.get("optional") or []
    overlap = sorted(set(required) & set(optional))
    if overlap:
        raise ValueError(
            "kfx Profile Suite validation failed: members cannot be both "
            f"required and optional: {', '.join(overlap)}"
        )
    home_view = (profile.get("experience") or {}).get("homeView")
    if home_view and home_view not in {*required, *optional}:
        raise ValueError(
            "kfx Profile Suite validation failed: experience.homeView must be "
            "a profile member"
        )
    if suite_members is not None and set(required) | set(optional) != set(
        suite_members
    ):
        raise ValueError(
            "kfx Profile Suite validation failed: profile members must match "
            "kungfuConfig.suite.members"
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


def compare_kfx_shadow_plans(
    legacy: Mapping[str, Any], native: Mapping[str, Any]
) -> dict[str, Any]:
    """Classify legacy Python/TS projection drift without treating it as truth."""

    legacy_views = {
        str(row.get("id")): row for row in legacy.get("entries", []) if row.get("id")
    }
    legacy_services = {
        str(row.get("id")): row for row in legacy.get("services", []) if row.get("id")
    }
    packages = list(native.get("packages", []))
    native_keys = {str(row.get("key")) for row in packages}
    findings = []
    for package in sorted(packages, key=lambda row: str(row.get("key"))):
        key = str(package.get("key"))
        view = legacy_views.get(key)
        service = legacy_services.get(key)
        facets = set(package.get("facets", []))
        if (
            facets.intersection({"view", "service"})
            and view is None
            and service is None
        ):
            findings.append(
                {
                    "packageKey": key,
                    "classification": "legacy-defect",
                    "reason": "native closure contains a loadable facet the legacy scan missed",
                }
            )
            continue
        if package.get("admissionGrade") != "unverified":
            findings.append(
                {
                    "packageKey": key,
                    "classification": "adr-required-divergence",
                    "reason": "legacy loader has no KFD admission-grade axis",
                }
            )
            continue
        if view is not None:
            expected = (
                "node-integrated"
                if package.get("runtimeTier") == "first-party-pinned"
                else "sandboxed-ipc"
            )
            matches = view.get("tier") == expected
            findings.append(
                {
                    "packageKey": key,
                    "classification": (
                        "intended-match" if matches else "adr-required-divergence"
                    ),
                    "reason": (
                        "view placement matches the native runtime tier"
                        if matches
                        else "legacy view placement conflicts with the native runtime tier"
                    ),
                }
            )
            continue
        if service is not None:
            expected = package.get("runtimeTier") == "first-party-pinned"
            matches = service.get("trusted") is expected
            findings.append(
                {
                    "packageKey": key,
                    "classification": (
                        "intended-match" if matches else "adr-required-divergence"
                    ),
                    "reason": (
                        "service placement matches the native runtime tier"
                        if matches
                        else "legacy service trust conflicts with the native runtime tier"
                    ),
                }
            )
    for key in sorted(set(legacy_views) | set(legacy_services)):
        if key not in native_keys:
            findings.append(
                {
                    "packageKey": key,
                    "classification": "legacy-defect",
                    "reason": "legacy plan contains a package absent from the canonical native roots",
                }
            )
    counts = {
        "intended-match": 0,
        "legacy-defect": 0,
        "adr-required-divergence": 0,
    }
    for finding in findings:
        counts[finding["classification"]] += 1
    return {
        "schema": "kungfu.kfx.shadow-parity/v1",
        "nativeRegistryRoot": native.get("registryRoot"),
        "nativePlanRoot": native.get("planRoot"),
        "findings": findings,
        "counts": counts,
    }


def _validate_with_schema(value: Any, schema: Any, label: str) -> None:
    contract_runtime.validate_json_schema(value, schema, f"kfx {label}")
