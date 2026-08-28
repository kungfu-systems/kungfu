# SPDX-License-Identifier: Apache-2.0

"""Stable facade for Exit Bundle composition, verification, and import."""

from __future__ import annotations

import copy as copy
import tempfile as tempfile

from kungfu._exit_bundle.common import (
    json as json,
    Path as Path,
    Any as Any,
    Mapping as Mapping,
    cast as cast,
    contract_runtime as contract_runtime,
    product_release_history as product_release_history,
    project_cut_exit as project_cut_exit,
    canonical_json_bytes as canonical_json_bytes,
    compute_content_hash as compute_content_hash,
    storage_service as storage_service,
    ProductReleaseHistoryError as ProductReleaseHistoryError,
    _PRODUCT_RELEASE_HISTORY as _PRODUCT_RELEASE_HISTORY,
    REQUEST_SCHEMA as REQUEST_SCHEMA,
    PACKAGE_SCHEMA as PACKAGE_SCHEMA,
    MANIFEST_SCHEMA as MANIFEST_SCHEMA,
    RECEIPT_SCHEMA as RECEIPT_SCHEMA,
    INSPECTION_SCHEMA as INSPECTION_SCHEMA,
    _ALL_CAPABILITIES as _ALL_CAPABILITIES,
    _THIN_CAPABILITIES as _THIN_CAPABILITIES,
    _ALL_EQUIVALENCE as _ALL_EQUIVALENCE,
    _ROOT_PREFIX as _ROOT_PREFIX,
    _KINDS as _KINDS,
    ExitBundleError as ExitBundleError,
    _root as _root,
    _schema_root as _schema_root,
    _normalized_root as _normalized_root,
    _manifest_root as _manifest_root,
    _package_root as _package_root,
    _contract as _contract,
    _material_root as _material_root,
    _episode_root as _episode_root,
    _fact_library_root as _fact_library_root,
    _describe as _describe,
    _require_full_material as _require_full_material,
    _build_material as _build_material,
    _member_order as _member_order,
    _validate_request as _validate_request,
    read as read,
    write as write,
    ProjectCutExitError as ProjectCutExitError,
    _PROJECT_CUT_EXIT as _PROJECT_CUT_EXIT,
    _project_cut_build_bundle as _project_cut_build_bundle,
    _project_cut_verify_bundle as _project_cut_verify_bundle,
    _project_cut_import_bundle as _project_cut_import_bundle,
)
from kungfu._exit_bundle.verification import (
    _validate_dependency_closure as _validate_dependency_closure,
    _validate_mode_semantics as _validate_mode_semantics,
    inspect as inspect,
)
from kungfu._exit_bundle.importer import (
    _profile_source as _profile_source,
    _apply_profile as _apply_profile,
    _apply_member as _apply_member,
    _receipt as _receipt,
    import_package as import_package,
)
from kungfu._exit_bundle.builder import (
    build as build,
)


for _facade_callable in (
    ExitBundleError,
    _root,
    _schema_root,
    _normalized_root,
    _manifest_root,
    _package_root,
    _contract,
    _material_root,
    _episode_root,
    _fact_library_root,
    _describe,
    _require_full_material,
    _build_material,
    _member_order,
    _validate_request,
    build,
    _validate_dependency_closure,
    _validate_mode_semantics,
    inspect,
    _profile_source,
    _apply_profile,
    _apply_member,
    _receipt,
    import_package,
    read,
    write,
):
    _facade_callable.__module__ = __name__
del _facade_callable
