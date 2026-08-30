# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F401

from _profile_composition_support import (
    DOGFOOD_SOURCE,
    CliRunner,
    Path,
    __registry__,
    _activate,
    _brief,
    _dynamic_source,
    _fact_state_definition,
    _set_retired_fact_surface,
    _set_work_item_authorities,
    _source,
    _upgrade,
    _write_artifact,
    hashlib,
    json,
    kfc,
    profile_composition,
    profile_sdk,
    pytest,
    storage_service,
    time,
)

__all__ = [
    "test_catalog_joins_exact_profile_artifacts_without_new_authority",
    "test_manager_projects_lifecycle_and_current_source_health",
    "test_manager_relocates_removed_source_from_exact_bundled_root",
    "test_manager_reports_source_drift_without_hiding_lifecycle_state",
    "test_current_lifecycle_authorization_rejects_drift_then_applies",
    "test_catalog_rejects_cross_profile_view_surface_reference",
    "test_catalog_accepts_profile_owned_view_without_domain_interpretation",
    "test_catalog_rejects_uninstalled_artifact_schema",
    "test_query_plan_requires_exact_active_root_and_delegates_to_adr0048",
]


def test_catalog_joins_exact_profile_artifacts_without_new_authority(tmp_path):
    source = _source(tmp_path)
    result = profile_composition.catalog(source, tmp_path / "runtime")

    assert result["schema"] == "kungfu.profile-composition/v1"
    assert result["profileId"] == "example.week-day"
    assert result["activeExactRoot"] is False
    assert result["catalogRoot"].startswith("sha256:")
    assert [row["id"] for row in result["views"]] == ["week-table"]


def test_manager_projects_lifecycle_and_current_source_health(tmp_path):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    _activate(source, runtime)

    result = profile_composition.manager(runtime)

    assert result["schema"] == "kungfu.profile-manager/v1"
    assert result["count"] == 1
    managed = result["profiles"][0]
    assert managed["profileId"] == "example.week-day"
    assert managed["health"] == "active"
    assert managed["source"] == str(source.resolve())
    assert managed["catalog"]["activeExactRoot"] is True
    assert [view["id"] for view in managed["catalog"]["views"]] == ["week-table"]


def test_manager_relocates_removed_source_from_exact_bundled_root(
    tmp_path, monkeypatch
):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    _activate(source, runtime)
    bundled_root = tmp_path / "current-image" / "extensions"
    bundled_root.mkdir(parents=True)
    relocated = source.rename(bundled_root / "week-day")
    monkeypatch.setenv("KF_BUNDLED_EXTENSION_ROOT", str(bundled_root))

    managed = profile_composition.manager(runtime)["profiles"][0]

    assert managed["health"] == "active"
    assert managed["source"] == str(relocated.resolve())
    assert managed["catalog"]["activeExactRoot"] is True


def test_manager_reports_source_drift_without_hiding_lifecycle_state(tmp_path):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    _activate(source, runtime)
    (source / "views" / "registry.json").write_text("{}\n", encoding="utf-8")

    managed = profile_composition.manager(runtime)["profiles"][0]

    assert managed["lifecycleState"] == "activated"
    assert managed["health"] == "degraded"
    assert managed["catalog"] is None
    assert managed["diagnostics"][0]["ok"] is False


def test_current_lifecycle_authorization_rejects_drift_then_applies(tmp_path):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    planned = profile_sdk.lifecycle_plan(runtime, "install", source)
    plan_id = planned["corePlan"]["plan_id"]

    with pytest.raises(profile_sdk.ProfileSdkError, match="review a new decision"):
        profile_sdk.authorize_current_lifecycle(
            runtime, "install", source, "sha256:stale", "approve", "operator"
        )

    receipt = profile_sdk.authorize_current_lifecycle(
        runtime, "install", source, plan_id, "approve", "operator"
    )
    assert receipt["state"]["state"] == "installed"
    assert receipt["plan_id"] == plan_id


def test_catalog_rejects_cross_profile_view_surface_reference(tmp_path):
    source = _source(tmp_path, unknown_view_surface=True)

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_composition.catalog(source, tmp_path / "runtime")

    assert raised.value.diagnosis["code"] == "view-surface-unresolved"


def test_catalog_accepts_profile_owned_view_without_domain_interpretation(tmp_path):
    source = _source(tmp_path, profile_view=True)

    result = profile_composition.catalog(source, tmp_path / "runtime")

    assert result["views"][0]["view"]["kind"] == "profile"
    assert result["views"][0]["view"]["spec"]["groupBy"] == "day"


def test_catalog_rejects_uninstalled_artifact_schema(tmp_path):
    source = _source(tmp_path, unsupported_view_schema=True)

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_composition.catalog(source, tmp_path / "runtime")

    assert raised.value.diagnosis["code"] == "composition-schema-unsupported"


def test_query_plan_requires_exact_active_root_and_delegates_to_adr0048(tmp_path):
    source = _source(tmp_path)
    runtime = tmp_path / "runtime"
    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_composition.query_plan(source, runtime, "week-table")
    assert raised.value.diagnosis["code"] == "profile-not-active"

    _activate(source, runtime)
    plan = profile_composition.query_plan(source, runtime, "week-table")

    assert plan["schema"] == "kungfu.profile-query-plan/v1"
    assert plan["profileRevision"] == 3
    assert plan["corePlan"]["schema"] == "kungfu.query.explain/v1"
