# SPDX-License-Identifier: Apache-2.0
"""Shared imports, fixtures, and builders for runtime service contracts."""
# ruff: noqa: F401

import json
import os
import sys
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest


class _FakeCoordinator:
    def __init__(
        self,
        location,
        low_latency=False,
        durability_config=None,
        runtime_generation=1,
        coordinator_epoch=1,
    ):
        self.location = location
        self.low_latency = low_latency
        self.durability_config = durability_config
        self.runtime_generation = runtime_generation
        self.coordinator_epoch = coordinator_epoch

    def run(self):
        return None


def _install_fake_pykungfu():
    fake = types.ModuleType("pykungfu")
    fake.__file__ = "/nonexistent/pykungfu.so"
    fake.yijinjing = types.SimpleNamespace(
        enums=types.SimpleNamespace(
            mode=types.SimpleNamespace(LIVE="LIVE"),
            location_role=types.SimpleNamespace(SYSTEM="SYSTEM"),
        )
    )
    runtime = types.ModuleType("pykungfu.runtime")
    runtime.coordinator = _FakeCoordinator
    runtime.compute_content_hash = lambda payload, algorithm="sha256": (
        algorithm + ":" + __import__("hashlib").sha256(payload).hexdigest()
    )
    runtime.durability_capability_typed = lambda: {
        "schema": "kungfu.durability.capability/v1",
        "profile": "single-host-institutional-production-candidate-v1",
        "qualification_profile": "candidate/current-hardware-single-host/v1",
        "production_eligible": False,
        "admission": {
            "current_hardware_candidate_complete": True,
            "evidence_sha256": "8" * 64,
        },
    }
    runtime.locator = lambda runtime_dir: {"runtime_dir": runtime_dir}
    runtime.location = lambda mode, role, namespace, name, locator: {
        "mode": mode,
        "role": role,
        "namespace": namespace,
        "name": name,
        "locator": locator,
    }
    fake.runtime = runtime
    sys.modules.setdefault("pykungfu", fake)
    sys.modules.setdefault("pykungfu.runtime", runtime)


_install_fake_pykungfu()

from kungfu import (  # noqa: E402
    runtime_broker,
    runtime_processes,
    runtime_service,
    runtime_service_config,
)


ROOT = Path(__file__).parents[4]
LEASE_FIXTURES = json.loads(
    (ROOT / "tests/fixtures/runtime-lease-recovery/cases.json").read_text()
)
