# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from kungfu.action_envelope import canonical_json_bytes

from kungfu._exit_bundle.common import (
    MANIFEST_SCHEMA,
    PACKAGE_SCHEMA,
    _ALL_CAPABILITIES,
    _ALL_EQUIVALENCE,
    _THIN_CAPABILITIES,
    _build_material,
    _contract,
    _describe,
    _exit_facade_seam,
    _manifest_root,
    _material_root,
    _member_order,
    _normalized_root,
    _package_root,
    _require_full_material,
    _root,
    _schema_root,
    _validate_request,
)
from kungfu._exit_bundle.verification import inspect


def build(
    runtime_dir: str | Path,
    request: Mapping[str, Any],
    *,
    config_home: str | Path | None = None,
) -> dict[str, Any]:
    """Compose one deterministic package from existing domain exporters."""

    _validate_request(request)
    mode = str(request["mode"])
    requested = sorted((dict(row) for row in request["members"]), key=_member_order)
    materials: dict[str, Any] = {}
    manifest_members = []
    execution: dict[str, Any] = {}
    for row in requested:
        member_id = str(row["memberId"])
        kind = str(row["kind"])
        options = dict(row.get("options") or {})
        material = _build_material(
            runtime_dir, kind, options, mode, config_home=config_home
        )
        described = _describe(kind, material)
        if mode == "full":
            _require_full_material(kind, material)
        included = mode == "full"
        encoded = canonical_json_bytes(material)
        manifest_members.append(
            {
                "memberId": member_id,
                "authority": described["authority"],
                "schema": described["schema"],
                "protocol": described["protocol"],
                "identityRoot": described["identityRoot"],
                "contentRoot": described["contentRoot"],
                "requiredForScope": bool(row.get("requiredForScope", True)),
                "material": {
                    "included": included,
                    "encoding": "application/json" if included else None,
                    "byteLength": len(encoded) if included else 0,
                    "sha256": _material_root(material) if included else None,
                },
                "capabilities": (
                    described["capabilities"] if included else _THIN_CAPABILITIES
                ),
                "verification": (
                    described["verification"] if included else ["exact-record-roots"]
                ),
                "import": {
                    "validate": True,
                    "execute": included,
                    "idempotent": described["idempotent"],
                    "failClosed": True,
                },
            }
        )
        if included:
            materials[member_id] = material
        execution_entry = {
            "kind": kind,
            "grantedPermissions": sorted(
                set(str(value) for value in options.get("grantedPermissions") or [])
            ),
        }
        if kind == "profile-source-v1":
            execution_entry["profileSuiteRoot"] = described["identityRoot"]
        elif kind == "initiative-bundle-v1":
            execution_entry["requiresProfileSuiteRoot"] = str(
                (material.get("profile") or {}).get("suite_root") or ""
            )
        execution[member_id] = execution_entry

    initiative_profile_roots = {
        str(value.get("requiresProfileSuiteRoot") or "")
        for value in execution.values()
        if value.get("kind") == "initiative-bundle-v1"
    }
    fact_library_present = any(
        value.get("kind") == "fact-library-v1" for value in execution.values()
    )
    for value in execution.values():
        if value.get("kind") == "profile-source-v1" and (
            fact_library_present
            or value.get("profileSuiteRoot") in initiative_profile_roots
        ):
            value["deferContractMaterialization"] = True

    required_members = [
        row["memberId"] for row in manifest_members if row["requiredForScope"]
    ]
    scope_input = dict(request["scope"])
    cut_root = scope_input.get("cutRoot")
    if cut_root is not None:
        cut_root = _normalized_root(cut_root, "scope.cutRoot")
    scope_identity = {
        "id": scope_input["id"],
        "authority": scope_input["authority"],
        "schema": scope_input["schema"],
        "protocol": scope_input["protocol"],
        "cutRoot": cut_root,
        "members": [
            {
                "memberId": row["memberId"],
                "identityRoot": row["identityRoot"],
                "contentRoot": row["contentRoot"],
            }
            for row in manifest_members
            if row["requiredForScope"]
        ],
    }
    scope = {
        **{
            field: str(scope_input[field])
            for field in ("id", "authority", "schema", "protocol")
        },
        "root": _root("scope", scope_identity),
        "cutRoot": cut_root,
    }
    capabilities = (
        _THIN_CAPABILITIES
        if mode == "thin"
        else sorted(
            {
                capability
                for row in manifest_members
                for capability in row["capabilities"]
            },
            key=_ALL_CAPABILITIES.index,
        )
    )
    required_capabilities = list(
        request.get("requiredCapabilities")
        or (_THIN_CAPABILITIES if mode == "thin" else capabilities)
    )
    equivalence = list(
        request.get("equivalenceLevels")
        or sorted(
            {level for row in manifest_members for level in row["verification"]},
            key=_ALL_EQUIVALENCE.index,
        )
    )
    omissions = []
    loss = []
    if mode == "thin":
        for row in manifest_members:
            detail = {
                "memberId": row["memberId"],
                "identityRoot": row["identityRoot"],
                "contentRoot": row["contentRoot"],
                "reason": "thin-package-omits-domain-material",
            }
            omissions.append(
                {
                    "oinitiativeId": f"thin-material:{row['memberId']}",
                    "memberId": row["memberId"],
                    "kind": "missing",
                    "requiredForScope": row["requiredForScope"],
                    "affectsCapabilities": _ALL_CAPABILITIES[2:],
                    "detailRoot": _root("omission", detail),
                }
            )
        loss.append(
            {
                "lossId": "thin-capability-loss",
                "memberId": None,
                "kind": "capability",
                "reversible": True,
                "affectsCapabilities": _ALL_CAPABILITIES[2:],
                "detailRoot": _root(
                    "loss",
                    {
                        "mode": "thin",
                        "available": _THIN_CAPABILITIES,
                        "unavailable": _ALL_CAPABILITIES[2:],
                    },
                ),
            }
        )
    contract = _contract()
    manifest: dict[str, Any] = {
        "schema": MANIFEST_SCHEMA,
        "contractSchemaRoot": _schema_root(contract["manifestSchema"]),
        "bundleId": str(
            request.get("bundleId")
            or f"exit:{str(scope['id']).lower().replace(' ', '-')}"
        ),
        "mode": mode,
        "scope": scope,
        "closure": {
            "selfContained": mode == "full",
            "completeForScope": mode == "full",
            "materialMissing": mode == "thin",
            "degraded": mode == "thin",
        },
        "members": manifest_members,
        "requirements": {
            "requiredMembers": required_members,
            "requiredCapabilities": required_capabilities,
            "equivalenceLevels": equivalence,
        },
        "omissions": omissions,
        "loss": loss,
        "capabilities": capabilities,
        "compatibility": {
            "topLevelProtocol": MANIFEST_SCHEMA,
            "readerProtocols": [MANIFEST_SCHEMA],
            "successorOf": None,
            "mappingReceiptRoot": None,
        },
        "verificationPolicy": {
            "bundleRoot": "required-before-member-read",
            "memberRoots": "domain-verifier-required",
            "compatibility": "fail-closed-before-execute",
            "destination": "preflight-before-mutation",
            "receipt": "success-only-after-postflight-equivalence",
        },
    }
    manifest["bundleRoot"] = _manifest_root(manifest)
    package: dict[str, Any] = {
        "schema": PACKAGE_SCHEMA,
        "manifest": manifest,
        "materials": materials,
        "execution": execution,
    }
    package["packageRoot"] = _package_root(package)
    inspect(package)
    return package


build = _exit_facade_seam("build")(build)
