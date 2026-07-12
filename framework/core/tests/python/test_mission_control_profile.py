# SPDX-License-Identifier: Apache-2.0

import shutil
from pathlib import Path

import pytest

from kungfu import profile_composition, profile_sdk


SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "mission-control"


def _activate(source: Path, runtime: Path) -> None:
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")


def _copy_source(tmp_path: Path) -> Path:
    root = tmp_path / "extensions"
    source = root / "mission-control"
    shutil.copytree(SOURCE, source)
    shutil.copytree(
        SOURCE.parent / "work-dashboard",
        root / "work-dashboard",
        ignore=shutil.ignore_patterns("node_modules"),
    )
    return source


def test_first_party_mission_control_suite_closes_and_activates(tmp_path):
    validated = profile_sdk.validate_source(SOURCE, tmp_path / "runtime")

    assert validated["ok"] is True
    assert validated["inspection"]["verified"] is True
    assert set(validated["source"]["memberRoots"]) == {
        "mission-control-actions",
        "mission-control-assessment",
        "mission-control-contract",
        "mission-control-views",
        "work-dashboard",
    }
    assert profile_sdk.qualify_source(SOURCE, tmp_path / "runtime")["status"] == (
        "qualified-for-install-plan"
    )

    runtime = tmp_path / "active-runtime"
    _activate(SOURCE, runtime)
    catalog = profile_composition.catalog(SOURCE, runtime, require_active=True)
    managed = profile_composition.manager(runtime)["profiles"][0]

    assert catalog["activeExactRoot"] is True
    assert catalog["views"] == []
    assert [row["code"] for row in catalog["diagnostics"]] == ["no-contributed-views"]
    assert managed["health"] == "active"
    assert managed["profileSuiteRoot"] == catalog["profileSuiteRoot"]


def test_first_party_mission_control_suite_rejects_missing_member(tmp_path):
    source = _copy_source(tmp_path)
    shutil.rmtree(source / "members" / "mission-control-actions")

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_sdk.resolve_source(source)

    assert raised.value.diagnosis["code"] == "member-resolution-failed"
    assert raised.value.diagnosis["decisionCards"][0]["kind"] == (
        "profile-member-missing"
    )


def test_first_party_mission_control_suite_rejects_artifact_drift(tmp_path):
    source = _copy_source(tmp_path)
    (source / "views" / "registry.json").write_text("{}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="artifact hash mismatch"):
        profile_sdk.validate_source(source, tmp_path / "runtime")
