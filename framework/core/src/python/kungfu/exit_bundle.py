# SPDX-License-Identifier: Apache-2.0

"""Domain-neutral Exit Bundle composition and exact-import orchestration.

The manifest owns composition only.  Member payloads remain opaque JSON values
whose roots, validation, import, and postflight semantics stay with their
domain services.
"""

from __future__ import annotations

import copy
import json
import tempfile
from pathlib import Path
from typing import Any, Mapping, cast

from kungfu import contract as contract_runtime
from kungfu import product_release_history
from kungfu import project_cut_exit
from kungfu.action_envelope import canonical_json_bytes
from kungfu.content_hash import compute_content_hash
from kungfu.storage import service as storage_service


# Backward-compatible import; behavior is owned by product_release_history.
ProductReleaseHistoryError = product_release_history.ProductReleaseHistoryError
_PRODUCT_RELEASE_HISTORY = cast(
    product_release_history.ProductReleaseHistoryPort, product_release_history
)


REQUEST_SCHEMA = "kungfu.exit-bundle-request/v1"
PACKAGE_SCHEMA = "kungfu.exit-package/v1"
MANIFEST_SCHEMA = "kungfu.exit-bundle/v1"
RECEIPT_SCHEMA = "kungfu.exit-import-receipt/v1"
INSPECTION_SCHEMA = "kungfu.exit-package-inspection/v1"

_ALL_CAPABILITIES = [
    "inspect",
    "verify-inventory",
    "verify-content",
    "materialize",
    "rebuild-projections",
    "continue",
]
_THIN_CAPABILITIES = ["inspect", "verify-inventory"]
_ALL_EQUIVALENCE = [
    "exact-physical-bytes",
    "exact-record-roots",
    "exact-semantic-state",
    "rebuilt-projection-equivalence",
    "declared-capability-equivalence",
]
_ROOT_PREFIX = b"kungfu.exit-bundle.root/v1\0"

_KINDS: dict[str, dict[str, Any]] = {
    "profile-source-v1": {
        "authority": "Profile SDK source closure",
        "schema": "kungfu.profile-source-bundle/v1",
        "protocol": "profile-source-closure/v1",
        "rank": 10,
        "idempotent": False,
        "capabilities": _ALL_CAPABILITIES[:-1],
        "verification": [
            "exact-physical-bytes",
            "exact-record-roots",
            "exact-semantic-state",
        ],
    },
    "fact-authority-v2": {
        "authority": "native Fact kernel yijinjing Hana POD journal authority",
        "schema": "kungfu.fact-authority-bundle/v2",
        "protocol": "kungfu.fact-root.canonical/v2",
        "rank": 20,
        "idempotent": True,
        "capabilities": _ALL_CAPABILITIES,
        "verification": [
            "exact-record-roots",
            "exact-semantic-state",
            "rebuilt-projection-equivalence",
            "declared-capability-equivalence",
        ],
    },
    "fact-cut-portable-v1": {
        "authority": "Fact integrity orchestration over native opt-in authority inventory",
        "schema": "kungfu.fact-kernel.portable-bundle/v1",
        "protocol": "fact-kernel.integrity-root/v1",
        "rank": 30,
        "idempotent": True,
        "capabilities": _ALL_CAPABILITIES,
        "verification": [
            "exact-record-roots",
            "exact-semantic-state",
            "rebuilt-projection-equivalence",
            "declared-capability-equivalence",
        ],
    },
    "storage-source-export-v1": {
        "authority": "libyijinjing storage record contract with libkungfu storage-service implementation",
        "schema": "kungfu.storage.export-bundle/v1",
        "protocol": "manifest-scoped-sync-root/v1",
        "rank": 40,
        "idempotent": True,
        "capabilities": _ALL_CAPABILITIES[:-1],
        "verification": [
            "exact-record-roots",
            "exact-semantic-state",
            "rebuilt-projection-equivalence",
        ],
    },
    "episode-v1": {
        "authority": "libkungfu Episode storage service over yijinjing manifest-journal authority",
        "schema": "kungfu.storage.episode-bundle/v1",
        "protocol": "episode-sealed-content-root/v1",
        "rank": 50,
        "idempotent": True,
        "capabilities": _ALL_CAPABILITIES[:-1],
        "verification": [
            "exact-physical-bytes",
            "exact-record-roots",
            "exact-semantic-state",
            "rebuilt-projection-equivalence",
        ],
    },
    "project-cut-v1": {
        "authority": "Project Cut protocol",
        "schema": "kungfu.project-cut.history-bundle/v1",
        "protocol": "project-cut-history-portability/v1",
        "rank": 55,
        "idempotent": True,
        "capabilities": _ALL_CAPABILITIES[:-1],
        "verification": [
            "exact-physical-bytes",
            "exact-record-roots",
            "exact-semantic-state",
        ],
    },
    "product-release-cut-v1": {
        "authority": "Product Release Cut and installed-product receipt owners",
        "schema": "kungfu.product-release-cut.history-bundle/v1",
        "protocol": "product-release-cut-history-portability/v1",
        "rank": 57,
        "idempotent": True,
        "capabilities": _ALL_CAPABILITIES[:-1],
        "verification": [
            "exact-physical-bytes",
            "exact-record-roots",
            "exact-semantic-state",
        ],
    },
    "fact-library-v1": {
        "authority": "Fact Library domain over Episode bundle authority",
        "schema": "kungfu.facts.library-bundle/v1",
        "protocol": "declared-facts-v1",
        "rank": 60,
        "idempotent": True,
        "capabilities": _ALL_CAPABILITIES,
        "verification": [
            "exact-physical-bytes",
            "exact-record-roots",
            "exact-semantic-state",
            "rebuilt-projection-equivalence",
            "declared-capability-equivalence",
        ],
    },
    "initiative-bundle-v1": {
        "authority": "Native Work Control over Episode bundles and proof-carrying queries",
        "schema": "kungfu.work-control.initiative-bundle/v1",
        "protocol": "work-control-initiative-portability/v1",
        "rank": 70,
        "idempotent": True,
        "capabilities": _ALL_CAPABILITIES,
        "verification": [
            "exact-physical-bytes",
            "exact-record-roots",
            "exact-semantic-state",
            "rebuilt-projection-equivalence",
            "declared-capability-equivalence",
        ],
    },
}


class ExitBundleError(ValueError):
    """Stable fail-closed diagnosis for public Exit Bundle operations."""

    def __init__(self, code: str, message: str, **details: Any):
        super().__init__(message)
        self.code = code
        self.details = details

    def diagnosis(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": str(self),
            "details": self.details,
        }


def _root(domain: str, value: Any) -> str:
    material = (
        _ROOT_PREFIX + domain.encode("utf-8") + b"\0" + canonical_json_bytes(value)
    )
    return compute_content_hash(material)


def _schema_root(value: Any) -> str:
    return compute_content_hash(canonical_json_bytes(value))


def _normalized_root(value: Any, field: str) -> str:
    if isinstance(value, Mapping):
        algorithm = str(value.get("algorithm") or "")
        digest = str(value.get("value") or "")
        value = (
            digest
            if algorithm and digest.startswith(f"{algorithm}:")
            else (f"{algorithm}:{digest}" if algorithm and digest else "")
        )
    text = str(value or "")
    if text and ":" not in text:
        text = "sha256:" + text
    if (
        len(text) != 71
        or not text.startswith("sha256:")
        or any(char not in "0123456789abcdef" for char in text[7:])
    ):
        raise ExitBundleError("member-root-invalid", f"{field} is not a sha256 root")
    return text


def _manifest_root(manifest: Mapping[str, Any]) -> str:
    body = dict(manifest)
    body.pop("bundleRoot", None)
    return _root("manifest", body)


def _package_root(package: Mapping[str, Any]) -> str:
    body = dict(package)
    body.pop("packageRoot", None)
    return _root("package", body)


def _contract() -> dict[str, Any]:
    return contract_runtime.load_contract("exit-bundle")


def _material_root(value: Any) -> str:
    return compute_content_hash(canonical_json_bytes(value))


def _episode_root(bundle: Mapping[str, Any]) -> str:
    return _normalized_root(
        (bundle.get("manifest") or {}).get("content_root"),
        "Episode manifest.content_root",
    )


def _fact_library_root(bundle: Mapping[str, Any]) -> str:
    episode_roots = sorted(_episode_root(row) for row in bundle.get("episodes") or [])
    identity = {
        "semanticProfile": bundle.get("semantic_profile"),
        "episodeRoots": episode_roots,
        "catalogRoot": _root("fact-library-catalog", bundle.get("catalog") or {}),
        "assessmentRoot": _root(
            "fact-library-assessments", bundle.get("assessments") or {}
        ),
    }
    return _root("fact-library-binding", identity)


def _describe(kind: str, material: Mapping[str, Any]) -> dict[str, Any]:
    spec = _KINDS.get(kind)
    if spec is None:
        raise ExitBundleError(
            "unsupported-member-kind", f"unsupported member kind: {kind}"
        )
    schema = str(material.get("schema") or "")
    if schema != spec["schema"]:
        raise ExitBundleError(
            "member-schema-mismatch",
            f"{kind} expected {spec['schema']}, got {schema or '<missing>'}",
        )
    if kind == "profile-source-v1":
        identity_root = _normalized_root(
            material.get("profileSuiteRoot"), "profileSuiteRoot"
        )
        content_root = _normalized_root(material.get("bundleRoot"), "bundleRoot")
    elif kind == "fact-authority-v2":
        identity_root = content_root = _normalized_root(
            material.get("bundleRoot"), "bundleRoot"
        )
    elif kind == "fact-cut-portable-v1":
        identity_root = content_root = _normalized_root(
            material.get("bundle_root"), "bundle_root"
        )
    elif kind == "storage-source-export-v1":
        identity_root = content_root = _normalized_root(
            (material.get("manifest") or {}).get("sync_root"), "manifest.sync_root"
        )
    elif kind == "episode-v1":
        identity_root = content_root = _episode_root(material)
    elif kind == "project-cut-v1":
        verified = _project_cut_verify_bundle(material)
        identity_root = _normalized_root(
            verified.get("primaryCutRoot"), "primaryCutRoot"
        )
        content_root = _normalized_root(verified.get("bundleRoot"), "bundleRoot")
    elif kind == "product-release-cut-v1":
        verified = _PRODUCT_RELEASE_HISTORY.verify(material)
        identity_root = _normalized_root(
            verified.get("selectedReleaseCutRoot"), "selectedReleaseCutRoot"
        )
        content_root = _normalized_root(verified.get("bundleRoot"), "bundleRoot")
    elif kind == "fact-library-v1":
        identity_root = content_root = _fact_library_root(material)
    elif kind == "initiative-bundle-v1":
        identity_root = content_root = _normalized_root(
            material.get("bundle_root"), "bundle_root"
        )
    else:  # pragma: no cover - guarded by the registry above
        raise ExitBundleError("unsupported-member-kind", kind)
    return {
        "authority": spec["authority"],
        "schema": spec["schema"],
        "protocol": spec["protocol"],
        "identityRoot": identity_root,
        "contentRoot": content_root,
        "capabilities": list(spec["capabilities"]),
        "verification": list(spec["verification"]),
        "idempotent": bool(spec["idempotent"]),
    }


def _require_full_material(kind: str, material: Mapping[str, Any]) -> None:
    """Reject domain exports that cannot substantiate a full-package claim."""

    complete = True
    if kind == "profile-source-v1":
        complete = (
            material.get("mode") == "full" and material.get("selfContained") is True
        )
    elif kind == "fact-cut-portable-v1":
        complete = material.get("loss") == []
    elif kind == "storage-source-export-v1":
        complete = len(material.get("records") or []) == len(
            (material.get("manifest") or {}).get("entries") or []
        )
    elif kind == "episode-v1":
        counts = material.get("material") or {}
        complete = (
            material.get("self_contained") is True
            and counts.get("missing_frame_count") == 0
            and counts.get("missing_ref_payload_count") == 0
        )
    elif kind == "project-cut-v1":
        complete = (
            material.get("mode") == "full"
            and bool(material.get("cuts"))
            and "verify-content" in (material.get("capabilities") or [])
        )
    elif kind == "product-release-cut-v1":
        complete = (
            material.get("mode") == "full"
            and isinstance(material.get("material"), Mapping)
            and "verify-content" in (material.get("capabilities") or [])
        )
    elif kind == "fact-library-v1":
        counts = material.get("material") or {}
        complete = (
            material.get("mode") == "full"
            and material.get("self_contained") is True
            and counts.get("missing_frame_count") == 0
        )
    elif kind == "initiative-bundle-v1":
        complete = (
            material.get("mode") == "full"
            and material.get("status") == "portable"
            and (material.get("closure") or {}).get("full_closure") is True
        )
    if not complete:
        raise ExitBundleError(
            "full-member-incomplete",
            f"{kind} exporter did not produce a complete self-contained member",
        )


def _build_material(
    runtime_dir: str | Path,
    kind: str,
    options: Mapping[str, Any],
    mode: str,
    *,
    config_home: str | Path | None = None,
) -> dict[str, Any]:
    thin = mode == "thin"
    if kind == "episode-v1":
        episode_id = int(options.get("episodeId") or 0)
        if not episode_id:
            raise ExitBundleError("member-option-required", "episodeId is required")
        return storage_service.build_export_bundle(
            runtime_dir, episode_id=episode_id, thin=thin
        )
    if kind == "storage-source-export-v1":
        source_id = str(options.get("sourceId") or "")
        if not source_id:
            raise ExitBundleError("member-option-required", "sourceId is required")
        return storage_service.build_export_bundle(
            runtime_dir, source_id=source_id, thin=thin
        )
    if kind == "fact-authority-v2":
        from kungfu.agent import work_profile

        response = work_profile.export_authority(runtime_dir)
        if response.get("ok") is not True:
            raise ExitBundleError(
                "fact-authority-export-failed",
                "native Fact authority export failed",
                response=response,
            )
        return dict((response.get("result") or {}).get("bundle") or {})
    if kind == "fact-cut-portable-v1":
        cut_root = str(options.get("cutRoot") or "")
        ref_name = str(options.get("refName") or "")
        return storage_service.fact_kernel_export(
            runtime_dir, cut_root=cut_root, ref_name=ref_name
        )
    if kind == "fact-library-v1":
        return storage_service.fact_library_export(runtime_dir, thin=thin)
    if kind == "project-cut-v1":
        return _project_cut_build_bundle(options, mode=mode)
    if kind == "product-release-cut-v1":
        try:
            return _PRODUCT_RELEASE_HISTORY.build(config_home or runtime_dir, mode=mode)
        except product_release_history.ProductReleaseHistoryError as error:
            raise ExitBundleError(error.code, str(error), **error.details) from error
    if kind == "profile-source-v1":
        from kungfu import profile_sdk

        source = str(options.get("source") or "")
        if not source:
            raise ExitBundleError(
                "member-option-required", "profile source is required"
            )
        return profile_sdk.export_source_bundle(source, runtime_dir, thin=thin)
    if kind == "initiative-bundle-v1":
        from kungfu import initiative_bundle

        initiative_id = str(options.get("initiativeId") or "")
        if not initiative_id:
            raise ExitBundleError("member-option-required", "initiativeId is required")
        return initiative_bundle.build_initiative_bundle(
            str(runtime_dir),
            initiative_id=initiative_id,
            mode=mode,
            storage_source_id=str(options.get("sourceId") or "kungfu"),
            purpose=str(options.get("purpose") or "operator-review"),
        )
    raise ExitBundleError("unsupported-member-kind", kind)


def _member_order(member: Mapping[str, Any]) -> tuple[int, str]:
    return (_KINDS[str(member["kind"])]["rank"], str(member["memberId"]))


def _validate_request(request: Mapping[str, Any]) -> None:
    try:
        contract_runtime.validate_json_schema(
            request, _contract()["requestSchema"], "exit bundle request"
        )
    except ValueError as error:
        raise ExitBundleError("request-schema-invalid", str(error)) from error
    if request.get("schema") != REQUEST_SCHEMA:
        raise ExitBundleError("request-schema-invalid", f"expected {REQUEST_SCHEMA}")
    mode = request.get("mode")
    if mode not in {"full", "thin"}:
        raise ExitBundleError("request-mode-invalid", "mode must be full or thin")
    required_capabilities = request.get("requiredCapabilities")
    if required_capabilities is not None:
        if not isinstance(required_capabilities, list) or any(
            value not in _ALL_CAPABILITIES for value in required_capabilities
        ):
            raise ExitBundleError(
                "request-capabilities-invalid",
                "requiredCapabilities must contain supported capabilities",
            )
        if mode == "thin" and any(
            value not in _THIN_CAPABILITIES for value in required_capabilities
        ):
            raise ExitBundleError(
                "thin-capability-overclaim",
                "thin packages may require only inspect and verify-inventory",
            )
    scope = request.get("scope")
    if not isinstance(scope, Mapping):
        raise ExitBundleError("request-scope-invalid", "scope must be an object")
    for field in ("id", "authority", "schema", "protocol"):
        if not str(scope.get(field) or ""):
            raise ExitBundleError("request-scope-invalid", f"scope.{field} is required")
    members = request.get("members")
    if not isinstance(members, list) or not members:
        raise ExitBundleError("request-members-invalid", "members must be non-empty")
    ids: set[str] = set()
    for row in members:
        if not isinstance(row, Mapping):
            raise ExitBundleError("request-member-invalid", "member must be an object")
        member_id = str(row.get("memberId") or "")
        kind = str(row.get("kind") or "")
        if not member_id or member_id in ids:
            raise ExitBundleError(
                "duplicate-member-identity", f"duplicate or empty memberId: {member_id}"
            )
        if kind not in _KINDS:
            raise ExitBundleError("unsupported-member-kind", kind)
        ids.add(member_id)


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


def _profile_source(
    runtime_dir: str | Path,
    bundle: Mapping[str, Any],
) -> tuple[Path, bool]:
    from kungfu import profile_sdk

    profile_id = str(bundle["profileId"])
    try:
        discovered = profile_sdk.discover_source(profile_id, runtime_dir)
        source = Path(discovered["source"])
        current = profile_sdk.export_source_bundle(source, runtime_dir, thin=False)
        if current.get("bundleRoot") != bundle.get("bundleRoot"):
            raise ExitBundleError(
                "profile-source-diverged",
                "installed Profile source has the same id but different bytes",
                profileId=profile_id,
            )
        return source, True
    except profile_sdk.ProfileSdkError as error:
        if error.diagnosis.get("code") != "profile-source-unresolved":
            raise
    target = (
        Path(runtime_dir).expanduser().resolve().parent
        / "extensions"
        / f"{profile_id}-{str(bundle['profileSuiteRoot'])[7:19]}"
    )
    return target, False


def _apply_profile(
    runtime_dir: str | Path,
    bundle: Mapping[str, Any],
    execution: Mapping[str, Any],
    actor: str,
) -> dict[str, Any]:
    from kungfu import profile_composition, profile_sdk

    source, already_source = _profile_source(runtime_dir, bundle)
    written: list[str] = []
    source_receipt = None
    if not already_source:
        plan = profile_sdk.source_import_plan(bundle, source)
        answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", actor)
        source_receipt = profile_sdk.authorized_source_import(plan, answer)
        written = list(source_receipt["written"])

    lifecycle = []
    state = None
    try:
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=str(bundle["profileId"])
        )
    except ValueError as error:
        if not str(error).startswith("Profile not found:"):
            raise
    exact_active = bool(
        state
        and state.get("activated")
        and state.get("profile_suite_root") == bundle["profileSuiteRoot"]
    )
    if state and state.get("profile_suite_root") != bundle["profileSuiteRoot"]:
        raise ExitBundleError(
            "profile-destination-diverged",
            "destination Profile id is bound to another Suite root",
            profileId=bundle["profileId"],
        )
    if not exact_active:
        actions = (
            ("qualify", "activate")
            if state is not None
            else ("install", "qualify", "activate")
        )
        for action in actions:
            values = (
                {"granted_permissions": list(execution.get("grantedPermissions") or [])}
                if action == "activate"
                else {}
            )
            plan = profile_sdk.lifecycle_plan(runtime_dir, action, source, **values)
            answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", actor)
            receipt = profile_sdk.authorized_lifecycle_apply(runtime_dir, plan, answer)
            lifecycle.append({"action": action, "receipt": receipt})
    contract_plan: dict[str, Any] = {"operations": []}
    contract_receipt = None
    if not execution.get("deferContractMaterialization"):
        contract_plan = profile_composition.contract_materialization_plan(
            source, runtime_dir
        )
        if contract_plan["operations"]:
            contract_receipt = profile_composition.authorized_contract_materialize(
                runtime_dir,
                contract_plan,
                profile_sdk.answer_decision(
                    contract_plan["decisionCard"], "approve", actor
                ),
            )
    verified = profile_sdk.export_source_bundle(source, runtime_dir, thin=False)
    if verified["bundleRoot"] != bundle["bundleRoot"]:
        raise ExitBundleError(
            "profile-postflight-mismatch", "Profile source root changed after import"
        )
    return {
        "ok": True,
        "status": (
            "already_present"
            if already_source and exact_active and not contract_plan["operations"]
            else "imported"
        ),
        "writeOccurred": bool(written or lifecycle or contract_receipt),
        "sourceReceipt": source_receipt,
        "lifecycle": lifecycle,
        "contractReceipt": contract_receipt,
        "profileSuiteRoot": bundle["profileSuiteRoot"],
        "bundleRoot": bundle["bundleRoot"],
    }


def _apply_member(
    runtime_dir: str | Path,
    kind: str,
    material: Mapping[str, Any],
    execution: Mapping[str, Any],
    actor: str,
    *,
    config_home: str | Path | None = None,
) -> dict[str, Any]:
    if kind == "profile-source-v1":
        return _apply_profile(runtime_dir, material, execution, actor)
    if kind == "storage-source-export-v1":
        source_id = str((material.get("manifest") or {}).get("source_id") or "")
        try:
            current = storage_service.build_export_bundle(
                runtime_dir, source_id=source_id
            )
            if (
                _describe(kind, current)["contentRoot"]
                == _describe(kind, material)["contentRoot"]
            ):
                return {
                    "ok": True,
                    "status": "already_present",
                    "writeOccurred": False,
                    "sourceId": source_id,
                    "syncRoot": (material.get("manifest") or {}).get("sync_root"),
                }
        except (RuntimeError, ValueError):
            pass
        result = storage_service.import_bundle(
            runtime_dir, dict(material), verify=True, execute=True
        )
        return {
            **result,
            "status": "imported",
            "writeOccurred": True,
        }
    if kind == "episode-v1":
        result = storage_service.import_bundle(
            runtime_dir, dict(material), verify=True, execute=True
        )
        return {
            **result,
            "status": result.get("status") or "imported",
            "writeOccurred": result.get("status") != "already_present",
        }
    if kind == "fact-authority-v2":
        from kungfu.agent import work_profile

        result = work_profile.import_authority(
            runtime_dir, dict(material), execute=True
        )
        write_occurred = result.get("write_occurred") is True
        return {
            **result,
            "status": "imported" if write_occurred else "already_present",
            "writeOccurred": write_occurred,
        }
    if kind == "fact-cut-portable-v1":
        target = material.get("target") or {}
        ref_name = str(target.get("ref_name") or "")
        if ref_name:
            current = storage_service.fact_kernel(
                runtime_dir, "query", {"ref_name": ref_name}
            )
            if current.get("cut_root") == target.get("cut_root"):
                return {
                    "ok": True,
                    "status": "already_present",
                    "writeOccurred": False,
                    "observed_cut_root": current["cut_root"],
                    "bundle_root": material.get("bundle_root"),
                }
        return storage_service.fact_kernel_import(
            runtime_dir, dict(material), dry_run=False
        )
    if kind == "fact-library-v1":
        result = storage_service.fact_library_import(
            runtime_dir, dict(material), dry_run=False
        )
        write_occurred = any(
            row.get("status") != "already_present"
            for row in result.get("receipts") or []
        )
        return {
            **result,
            "status": (
                "imported"
                if result.get("ok") and write_occurred
                else ("already_present" if result.get("ok") else "rejected")
            ),
            "writeOccurred": write_occurred,
        }
    if kind == "project-cut-v1":
        return _project_cut_import_bundle(runtime_dir, material, execute=True)
    if kind == "product-release-cut-v1":
        try:
            return _PRODUCT_RELEASE_HISTORY.import_history(
                config_home or runtime_dir, material, execute=True
            )
        except product_release_history.ProductReleaseHistoryError as error:
            raise ExitBundleError(error.code, str(error), **error.details) from error
    if kind == "initiative-bundle-v1":
        from kungfu import initiative_bundle

        result = initiative_bundle.import_initiative_bundle(
            str(runtime_dir), dict(material), execute=True
        )
        write_occurred = any(
            row.get("status") != "already_present"
            for row in result.get("receipts") or []
        )
        return {
            **result,
            "ok": result.get("accepted") is True,
            "status": (
                "already_present"
                if result.get("accepted") is True and not write_occurred
                else "imported"
            ),
            "writeOccurred": write_occurred,
        }
    raise ExitBundleError("unsupported-member-kind", kind)


def _receipt(
    package: Mapping[str, Any],
    *,
    status: str,
    execute: bool,
    member_receipts: list[dict[str, Any]],
    already_present: list[str],
    written: list[str],
    remaining: list[str],
    failure: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifest = package["manifest"]
    value: dict[str, Any] = {
        "schema": RECEIPT_SCHEMA,
        "status": status,
        "ok": status in {"validated", "imported", "already_present"},
        "execute": execute,
        "bundleId": manifest["bundleId"],
        "bundleRoot": manifest["bundleRoot"],
        "packageRoot": package["packageRoot"],
        "alreadyPresent": already_present,
        "writtenMembers": written,
        "remainingMembers": remaining,
        "memberReceipts": member_receipts,
        "omissions": copy.deepcopy(manifest["omissions"]),
        "loss": copy.deepcopy(manifest["loss"]),
        "residualRisk": (
            []
            if status in {"validated", "imported", "already_present"}
            else [
                "Append-only domain writes listed in memberReceipts may remain after a partial import."
            ]
        ),
        "recoveryNextAction": (
            "none"
            if status in {"imported", "already_present"}
            else (
                "rerun validate-only after resolving the diagnosis"
                if status == "rejected"
                else "rerun the same exact package; completed member imports are idempotent"
            )
        ),
        "failure": failure,
    }
    value["receiptRoot"] = _root("receipt", value)
    try:
        contract_runtime.validate_json_schema(
            value, _contract()["receiptSchema"], "exit import receipt"
        )
    except ValueError as error:  # pragma: no cover - implementation invariant
        raise ExitBundleError("receipt-schema-invalid", str(error)) from error
    return value


def import_package(
    runtime_dir: str | Path,
    package: Mapping[str, Any],
    *,
    config_home: str | Path | None = None,
    execute: bool = False,
    authorized_by: str = "",
    _fault_after_member: int | None = None,
) -> dict[str, Any]:
    """Validate by default; explicitly execute after isolated full replay."""

    inspection = inspect(package)
    manifest = package["manifest"]
    ordered = sorted(
        manifest["members"],
        key=lambda row: (
            _KINDS[str(package["execution"][row["memberId"]]["kind"])]["rank"],
            row["memberId"],
        ),
    )
    member_ids = [str(row["memberId"]) for row in ordered]
    if not execute:
        return _receipt(
            package,
            status="validated",
            execute=False,
            member_receipts=[],
            already_present=[],
            written=[],
            remaining=member_ids,
        )
    if inspection["mode"] == "thin":
        return _receipt(
            package,
            status="rejected",
            execute=True,
            member_receipts=[],
            already_present=[],
            written=[],
            remaining=member_ids,
            failure={
                "code": "thin-materialization-forbidden",
                "message": "thin Exit packages are inventory-only",
            },
        )
    actor = authorized_by.strip()
    if not actor:
        return _receipt(
            package,
            status="rejected",
            execute=True,
            member_receipts=[],
            already_present=[],
            written=[],
            remaining=member_ids,
            failure={
                "code": "authorization-actor-required",
                "message": "explicit execute requires authorized_by",
            },
        )

    try:
        with tempfile.TemporaryDirectory(prefix="kungfu-exit-preflight-") as root:
            preflight_runtime = Path(root) / "runtime"
            for row in ordered:
                member_id = str(row["memberId"])
                execution = package["execution"][member_id]
                result = _apply_member(
                    preflight_runtime,
                    str(execution["kind"]),
                    package["materials"][member_id],
                    execution,
                    "kungfu-exit-preflight",
                    config_home=Path(root) / "config",
                )
                if result.get("ok") is not True:
                    raise ExitBundleError(
                        "isolated-preflight-failed",
                        f"isolated preflight rejected {member_id}",
                        memberId=member_id,
                        receipt=result,
                    )
    except (ExitBundleError, OSError, RuntimeError, ValueError) as error:
        failure = (
            error.diagnosis()
            if isinstance(error, ExitBundleError)
            else {"code": "isolated-preflight-failed", "message": str(error)}
        )
        return _receipt(
            package,
            status="rejected",
            execute=True,
            member_receipts=[],
            already_present=[],
            written=[],
            remaining=member_ids,
            failure=failure,
        )

    receipts: list[dict[str, Any]] = []
    already: list[str] = []
    written: list[str] = []
    for index, row in enumerate(ordered):
        member_id = str(row["memberId"])
        execution = package["execution"][member_id]
        if _fault_after_member is not None and index >= _fault_after_member:
            return _receipt(
                package,
                status="partial",
                execute=True,
                member_receipts=receipts,
                already_present=already,
                written=written,
                remaining=member_ids[index:],
                failure={
                    "code": "qualification-fault",
                    "message": "deterministic test fault after completed member",
                },
            )
        try:
            result = _apply_member(
                runtime_dir,
                str(execution["kind"]),
                package["materials"][member_id],
                execution,
                actor,
                config_home=config_home,
            )
        except (ExitBundleError, OSError, RuntimeError, ValueError) as error:
            failure = (
                error.diagnosis()
                if isinstance(error, ExitBundleError)
                else {"code": "member-import-failed", "message": str(error)}
            )
            return _receipt(
                package,
                status="partial" if receipts else "rejected",
                execute=True,
                member_receipts=receipts,
                already_present=already,
                written=written,
                remaining=member_ids[index:],
                failure={"memberId": member_id, **failure},
            )
        wrapped = {"memberId": member_id, "kind": execution["kind"], "receipt": result}
        receipts.append(wrapped)
        if result.get("ok") is not True:
            return _receipt(
                package,
                status="partial" if written else "rejected",
                execute=True,
                member_receipts=receipts,
                already_present=already,
                written=written,
                remaining=member_ids[index:],
                failure={
                    "code": "member-import-rejected",
                    "memberId": member_id,
                    "receipt": result,
                },
            )
        status = str(result.get("status") or "")
        if status in {"already_present", "already-present", "current"} or (
            result.get("writeOccurred") is False
        ):
            already.append(member_id)
        else:
            written.append(member_id)
    final_status = "already_present" if not written else "imported"
    return _receipt(
        package,
        status=final_status,
        execute=True,
        member_receipts=receipts,
        already_present=already,
        written=written,
        remaining=[],
    )


def read(path: str | Path) -> dict[str, Any]:
    value = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ExitBundleError("package-invalid", "Exit package must be a JSON object")
    return value


def write(path: str | Path, package: Mapping[str, Any]) -> None:
    target = Path(path).expanduser()
    if not target.parent.is_dir():
        raise FileNotFoundError(f"Exit package parent does not exist: {target.parent}")
    target.write_text(
        json.dumps(package, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


# Backward-compatible imports; Project Cut behavior is owned by project_cut_exit.
ProjectCutExitError = project_cut_exit.ProjectCutExitError
_PROJECT_CUT_EXIT = cast(project_cut_exit.ProjectCutExitPort, project_cut_exit)
_project_cut_build_bundle = _PROJECT_CUT_EXIT.build_bundle
_project_cut_verify_bundle = _PROJECT_CUT_EXIT.verify_bundle
_project_cut_import_bundle = _PROJECT_CUT_EXIT.import_bundle
