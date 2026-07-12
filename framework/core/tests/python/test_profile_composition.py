# SPDX-License-Identifier: Apache-2.0

import hashlib
import json

import pytest
from click.testing import CliRunner

from kungfu import profile_composition, profile_sdk
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service as storage_service


def _brief():
    return {
        "schema": "kungfu.profile-brief/v1",
        "id": "example.week-day",
        "title": "Week / Day",
        "version": "1.0.0",
        "purposes": ["operator-review"],
        "permissions": [],
        "identity": {"authority": "workspace-owner"},
        "evidence": {"strength": "reported-with-references"},
        "migration": {"mode": "additive"},
    }


def _write_artifact(source, profile, path, value, ref):
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    (source / path).write_bytes(data)
    ref["sha256"] = hashlib.sha256(data).hexdigest()


def _source(tmp_path, *, unknown_view_surface=False):
    source = tmp_path / "profile"
    profile_sdk.apply_scaffold(profile_sdk.scaffold_plan(_brief(), source))
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    definition = storage_service.build_fact_query_definition(limit=10)
    _write_artifact(
        source,
        profile,
        "contracts/facts.json",
        {
            "schema": "kungfu.profile-fact-surfaces/v1",
            "surfaces": [{"id": "work-item", "schema": "example.work-item/v1"}],
        },
        profile["kfd1"]["factSurfaces"][0],
    )
    _write_artifact(
        source,
        profile,
        "claims/claims.json",
        {
            "schema": "kungfu.profile-claims/v1",
            "claims": [
                {
                    "id": "week-progress",
                    "type": "example.week-progress/v1",
                    "factSurfaces": ["work-item"],
                }
            ],
        },
        profile["kfd2"]["claims"][0],
    )
    _write_artifact(
        source,
        profile,
        "assessments/policies.json",
        {
            "schema": "kungfu.profile-assessment-policies/v1",
            "policies": [
                {
                    "id": "week-progress-policy",
                    "version": "1",
                    "claimId": "week-progress",
                    "purposes": ["operator-review"],
                    "requiredEvidence": ["query-proof"],
                    "responsibility": "workspace owner supplies work facts",
                    "residualRisks": ["reported state may be incomplete"],
                }
            ],
        },
        profile["kfd2"]["policies"][0],
    )
    _write_artifact(
        source,
        profile,
        "views/registry.json",
        {
            "schema": "kungfu.profile-views/v1",
            "views": [
                {
                    "id": "week-table",
                    "title": "Week table",
                    "factSurfaces": [
                        "missing" if unknown_view_surface else "work-item"
                    ],
                    "definition": definition,
                    "view": {"kind": "table", "columns": ["episode_id"]},
                }
            ],
        },
        profile["views"]["registry"],
    )
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")
    return source


def _activate(source, runtime):
    for action in ["install", "qualify", "activate"]:
        plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")


def test_catalog_joins_exact_profile_artifacts_without_new_authority(tmp_path):
    source = _source(tmp_path)
    result = profile_composition.catalog(source, tmp_path / "runtime")

    assert result["schema"] == "kungfu.profile-composition/v1"
    assert result["profileId"] == "example.week-day"
    assert result["activeExactRoot"] is False
    assert result["catalogRoot"].startswith("sha256:")
    assert [row["id"] for row in result["views"]] == ["week-table"]


def test_catalog_rejects_cross_profile_view_surface_reference(tmp_path):
    source = _source(tmp_path, unknown_view_surface=True)

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_composition.catalog(source, tmp_path / "runtime")

    assert raised.value.diagnosis["code"] == "view-surface-unresolved"


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


def test_installed_cli_catalog_and_query_plan_share_roots(tmp_path):
    source = _source(tmp_path)
    home = tmp_path / "home"
    _activate(source, home / "runtime")
    runner = CliRunner()

    catalog_result = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "catalog",
            str(source),
            "--require-active",
            "--json",
        ],
    )
    planned = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "query-plan",
            str(source),
            "week-table",
            "--json",
        ],
    )

    assert catalog_result.exit_code == 0, catalog_result.output
    assert planned.exit_code == 0, planned.output
    catalog_payload = json.loads(catalog_result.output)
    plan_payload = json.loads(planned.output)
    assert plan_payload["catalogRoot"] == catalog_payload["catalogRoot"]
    assert plan_payload["profileSuiteRoot"] == catalog_payload["profileSuiteRoot"]
