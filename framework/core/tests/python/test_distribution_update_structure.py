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
    distribution_update,
    distribution_update_planning,
    distribution_update_policy,
)


def test_distribution_update_compatibility_surface_reexports_extracted_layers() -> None:
    policy_exports = (
        "DistributionUpdateError",
        "compare_product_versions",
        "install_source",
        "local_dogfood_residency",
    )
    planning_exports = (
        "check_release",
        "plan_download",
        "plan_update",
        "validate_update_plan",
        "record_update_outcome",
    )
    for name in policy_exports:
        assert getattr(distribution_update, name) is getattr(
            distribution_update_policy, name
        )
    for name in planning_exports:
        assert getattr(distribution_update, name) is getattr(
            distribution_update_planning, name
        )
