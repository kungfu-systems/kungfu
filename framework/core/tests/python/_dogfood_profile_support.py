# SPDX-License-Identifier: Apache-2.0
"""Shared imports, roots, and builders for Dogfood Profile contracts."""
# ruff: noqa: F401

import json
from pathlib import Path
import shutil

from click.testing import CliRunner
import pytest

from kungfu import dogfood as dogfood_api
from kungfu import profile_sdk
from kungfu.cli.commands import kfc
from kungfu.cli.commands import dogfood as _dogfood_command  # noqa: F401
from kungfu.storage import service as storage_service
from kungfu.workspace import (
    ensure_workspace_data_home,
    inspect_workspace,
    observe_workspace_locator,
)


SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "dogfood"
ROOT_A = "sha256:" + "a" * 64
ROOT_B = "sha256:" + "b" * 64
ROOT_C = "sha256:" + "c" * 64
ROOT_D = "sha256:" + "d" * 64
EXACT_ROOT_DRIFT_FINDING = (
    "sha256:f9ffba0229835b0521c566fb82c8c4bb48730a8b235ff63600d502f0e8290cd7"
)
INSTALLED_REGRESSION_CASES = (
    (
        EXACT_ROOT_DRIFT_FINDING,
        "Installed Dogfood exact Profile-root drift",
    ),
    (
        "sha256:7d2d57c2a3eb89e5ae40aa3b2a59f78d6133b9d16ad434e938313135084cff97",
        "Installed CLI package omits a declared Work Control Suite member",
    ),
    (
        "sha256:9de6878fe13c157c4003af332e5769cea8e12fcf1e2c1cd9188dfaf670ca26d7",
        "Work Dashboard refresh starvation hides Initiative data",
    ),
    (
        "sha256:30e7c086ece6ee836b73bc39e819c28f061eda5ed2c5704f2cd53ebbd8a6544f",
        "Embedded Python writes into the signed macOS App bundle",
    ),
)


def _workspace(tmp_path: Path, name: str):
    root = tmp_path / name
    root.mkdir()
    identity = inspect_workspace(str(root), env={"HOME": str(tmp_path)})
    assert identity is not None
    ensure_workspace_data_home(identity, "dogfood-test")
    identity = inspect_workspace(str(root), env={"HOME": str(tmp_path)})
    assert identity is not None
    return identity, Path(identity.data_home) / "runtime"


def _active_runtime(tmp_path: Path, name: str = "repo"):
    identity, runtime = _workspace(tmp_path, name)
    dogfood_api.ensure_profile(str(runtime), "test-owner")
    return identity, runtime


def _capture(runtime: Path, suffix: str = "one", **overrides):
    values = {
        "findingId": f"finding-{suffix}",
        "title": f"Finding {suffix}",
        "summary": "The installed command returned the wrong contract.",
        "episodeRoot": ROOT_A,
        "evidenceRoots": [ROOT_B],
        "dimensions": {
            "repository": ["kungfu"],
            "component": ["profile"],
            "capability": ["installed-product"],
            "error": ["contract-mismatch"],
            "platform": ["macos"],
        },
        "privacy": "internal",
        "runtimeSurface": "source-checkout",
        "runtimeReceiptRoot": ROOT_D,
        "actor": "test-agent",
        "observedAt": "2026-07-01T00:00:00Z",
        "impact": "normal",
    }
    values.update(overrides)
    return dogfood_api.action(str(runtime), "capture-finding", values, "test-owner")


def _admit(runtime: Path, finding_root: str, suffix: str = "one", **overrides):
    values = {
        "issueId": f"issue-{suffix}",
        "title": f"Issue {suffix}",
        "owner": "owner-a",
        "findingRoots": [finding_root],
        "impact": "normal",
        "verificationCriteria": ["installed command returns the declared schema"],
        "actor": "test-agent",
        "admittedAt": "2026-07-02T00:00:00Z",
    }
    values.update(overrides)
    return dogfood_api.action(str(runtime), "admit-issue", values, "test-owner")


def _assignment(root: str = ROOT_C):
    return {
        "assignment_id": "assignment-a",
        "work_definition_root": root,
        "work_definition": {
            "context_admission": {
                "required_capabilities": ["installed-product"],
                "subjects": ["profile"],
            }
        },
        "dogfood_dimensions": {
            "repository": ["kungfu"],
            "component": ["profile"],
            "capability": ["installed-product"],
            "error": ["contract-mismatch"],
            "platform": ["macos"],
        },
    }
