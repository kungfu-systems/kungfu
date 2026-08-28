# SPDX-License-Identifier: Apache-2.0

"""Domain-neutral Exit Bundle composition and exact-import orchestration.

The manifest owns composition only.  Member payloads remain opaque JSON values
whose roots, validation, import, and postflight semantics stay with their
domain services.
"""

from __future__ import annotations

import functools
import json
import sys
from pathlib import Path
from typing import Any, Callable, Mapping, cast

from kungfu import contract as contract_runtime
from kungfu import product_release_history
from kungfu import project_cut_exit
from kungfu.action_envelope import canonical_json_bytes
from kungfu.content_hash import compute_content_hash
from kungfu.storage import service as storage_service


def _exit_facade_value(name: str, fallback: Any) -> Any:
    facade = sys.modules.get("kungfu.exit_bundle")
    return getattr(facade, name, fallback) if facade is not None else fallback


def _exit_facade_seam(
    name: str,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Keep a moved function injectable through its historical facade name."""

    def decorate(fallback: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fallback)
        def dispatch(*args: Any, **kwargs: Any) -> Any:
            candidate = _exit_facade_value(name, dispatch)
            target = fallback if candidate is dispatch else candidate
            return target(*args, **kwargs)

        return dispatch

    return decorate


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


for _exit_name in (
    "_root",
    "_schema_root",
    "_normalized_root",
    "_manifest_root",
    "_package_root",
    "_contract",
    "_material_root",
    "_episode_root",
    "_fact_library_root",
    "_describe",
    "_require_full_material",
    "_build_material",
    "_member_order",
    "_validate_request",
    "read",
    "write",
):
    globals()[_exit_name] = _exit_facade_seam(_exit_name)(globals()[_exit_name])
del _exit_name
