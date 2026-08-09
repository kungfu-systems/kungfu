# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import sys
import types


fake = types.ModuleType("pykungfu")
fake.__file__ = "/nonexistent/pykungfu.so"
fake.runtime = types.ModuleType("pykungfu.runtime")
fake.runtime.coordinator = type("FakeNativeCoordinator", (), {})
fake.yijinjing = types.SimpleNamespace()
sys.modules.setdefault("pykungfu", fake)
sys.modules.setdefault("pykungfu.runtime", fake.runtime)

from kungfu import (  # noqa: E402
    profile_sdk,
    profile_sdk_kfd3,
    profile_sdk_source,
    profile_sdk_support,
)


def test_profile_sdk_compatibility_surface_reexports_extracted_layers() -> None:
    support_exports = (
        "ProfileSdkError",
        "_confined",
        "_root",
        "_validate_sdk_value",
    )
    source_exports = (
        "package_content_root",
        "_collaboration_closure",
        "_package_dirs",
        "_read_ref_json",
        "_source_files",
        "_validate_action_registry",
    )
    kfd3_exports = (
        "_agent_interface_authority",
        "_profile_facet_audit",
        "_release_qualification_receipt",
        "_shared_api_release_audit",
        "_validate_kfd3_receipt_integrity",
    )
    for name in support_exports:
        assert getattr(profile_sdk, name) is getattr(profile_sdk_support, name)
    for name in source_exports:
        assert getattr(profile_sdk, name) is getattr(profile_sdk_source, name)
    for name in kfd3_exports:
        assert getattr(profile_sdk, name) is getattr(profile_sdk_kfd3, name)


def test_profile_sdk_public_kfd3_entrypoints_remain_on_compatibility_module() -> None:
    for name in (
        "authorize_kfd3_qualification",
        "build_kfd3_release_manifest",
        "kfd3_qualification_plan",
        "kfd3_status",
        "qualify_kfd3",
        "verify_kfd3",
    ):
        assert getattr(profile_sdk, name).__module__ == "kungfu.profile_sdk"
