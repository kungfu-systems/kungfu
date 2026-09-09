# SPDX-License-Identifier: Apache-2.0
"""CLI, Profile lifecycle, exact-root diagnosis, and recovery cases."""
# ruff: noqa: F401,F403

from _dogfood_profile_support import *
from _dogfood_profile_support import _active_runtime


def test_cli_runtime_failure_is_a_stable_json_diagnosis(tmp_path):
    workspace = tmp_path / "uninitialized"
    workspace.mkdir()

    result = CliRunner().invoke(
        kfc,
        ["dogfood", "query", "--workspace", str(workspace)],
    )

    assert result.exit_code == 2
    assert "Traceback" not in result.output
    diagnosis = json.loads(result.output)
    assert diagnosis == {
        "cause": None,
        "code": "dogfood-operation-failed",
        "message": "Dogfood requires an initialized project or Home workspace",
        "next_actions": [],
        "ok": False,
        "schema": "kungfu.dogfood-feedback.diagnosis/v1",
    }


def test_cli_missing_lookup_is_one_stable_json_result(tmp_path):
    identity, _ = _active_runtime(tmp_path)

    result = CliRunner().invoke(
        kfc,
        [
            "dogfood",
            "show",
            ROOT_A,
            "--workspace",
            str(identity.workspace_root),
        ],
    )

    assert result.exit_code == 3
    assert "Traceback" not in result.output
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["identity"] == ROOT_A
    assert payload["match_count"] == 0


def test_profile_closes_and_declares_native_kfd1_fact_surfaces(tmp_path):
    validated = profile_sdk.validate_source(SOURCE, tmp_path / "runtime")
    world = json.loads((SOURCE / "contracts" / "world.json").read_text())

    assert validated["ok"] is True
    assert validated["inspection"]["verified"] is True
    assert set(validated["source"]["memberRoots"]) == {
        "dogfood-actions",
        "dogfood-assessment",
        "dogfood-contract",
        "work-dashboard",
    }
    assert {
        (
            intent["protocol"]["apiId"],
            intent["protocol"]["guiMember"],
            intent["protocol"]["guiMethod"],
        )
        for intent in validated["collaboration"]["intents"]
    } == {("kungfu.profile.application", "work-dashboard", "intentPlan")}
    release_manifest = profile_sdk.build_kfd3_release_manifest(
        [SOURCE], tmp_path / "release-runtime"
    )
    release_receipt = release_manifest["entries"][0]["receipt"]
    assert release_receipt["qualified"] is True
    assert release_receipt["qualificationSource"] == "release"
    assert all(probe["matched"] for probe in release_receipt["clientProbes"])
    assert world["contractWorld"] == {
        "id": "kungfu.dogfood-feedback",
        "version": "1",
        "factSurfaceIds": [
            "kungfu.dogfood-feedback.finding",
            "kungfu.dogfood-feedback.issue",
            "kungfu.dogfood-feedback.consideration",
        ],
    }


def test_exact_root_diagnosis_is_read_only_and_recovery_is_explicit_and_idempotent(
    tmp_path,
):
    identity, runtime = _active_runtime(tmp_path)
    alternate = tmp_path / "alternate-dogfood"

    def ignore_dangling_links(directory, names):
        return [
            name
            for name in names
            if (Path(directory) / name).is_symlink()
            and not (Path(directory) / name).exists()
        ]

    shutil.copytree(
        SOURCE,
        alternate,
        ignore=ignore_dangling_links,
    )
    readme = alternate / "dogfood-actions" / "README.md"
    readme.write_text(
        readme.read_text(encoding="utf-8") + "\nExact-root drift fixture.\n",
        encoding="utf-8",
    )
    for action in ("upgrade", "qualify", "activate"):
        values = {"granted_permissions": ["storage"]} if action == "activate" else {}
        plan = profile_sdk.lifecycle_plan(str(runtime), action, alternate, **values)
        answer = profile_sdk.answer_decision(
            plan["decisionCard"], "approve", "test-owner"
        )
        profile_sdk.authorized_lifecycle_apply(str(runtime), plan, answer)

    lifecycle_before = storage_service.profile_lifecycle(
        str(runtime), "list", include_removed=True
    )
    facts_before = storage_service.fact_state(str(runtime))
    first = dogfood_api.profile_diagnosis(str(runtime))
    second = dogfood_api.profile_diagnosis(str(runtime))
    with pytest.raises(
        profile_sdk.ProfileSdkError, match="exact active Profile root"
    ) as error:
        dogfood_api.read(
            str(runtime),
            "query",
            {"workspaceRoot": identity.workspace_root, "scope": "local"},
        )

    assert first == second
    assert first["current_root"] != first["desired_root"]
    assert first["cause"] == "exact-profile-root-drift"
    assert first["writes"] == []
    assert error.value.diagnosis["profileDiagnosis"] == first
    assert error.value.diagnosis["currentRoot"] == first["current_root"]
    assert error.value.diagnosis["desiredRoot"] == first["desired_root"]
    assert EXACT_ROOT_DRIFT_FINDING.startswith("sha256:")
    assert (
        storage_service.profile_lifecycle(str(runtime), "list", include_removed=True)
        == lifecycle_before
    )
    assert storage_service.fact_state(str(runtime)) == facts_before

    plan = dogfood_api.recovery_plan(str(runtime))
    assert plan["status"] == "ready"
    assert [row["operation"] for row in plan["operations"]] == [
        "upgrade",
        "qualify",
        "activate",
        "materialize-contract",
    ]
    recovered = dogfood_api.apply_recovery(
        str(runtime),
        expected_plan_root=plan["plan_root"],
        authorized_by="test-owner",
    )
    assert recovered["status"] == "recovered"
    assert recovered["diagnosis"]["ok"] is True

    repeated_plan = dogfood_api.recovery_plan(str(runtime))
    repeated = dogfood_api.apply_recovery(
        str(runtime),
        expected_plan_root=repeated_plan["plan_root"],
        authorized_by="test-owner",
    )
    assert repeated_plan["status"] == "no-op"
    assert repeated["status"] == "already-current"
    assert repeated["verified_no_op"] is True
