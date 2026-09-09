# SPDX-License-Identifier: Apache-2.0
"""KFD3 qualification and package-boundary cases."""

import hashlib
import json
from pathlib import Path

from click.testing import CliRunner

from kungfu import profile_sdk
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc

from _agent_profile_sdk_scaffold_cases import (
    _symlink_or_skip,
    create_source,
    create_symlink_or_skip,
    make_collaboration_action_lifecycle,
)


def test_kfd3_qualification_earns_receipt_and_witness_for_exact_active_root(
    tmp_path,
):
    source, _ = create_source(tmp_path)
    make_collaboration_action_lifecycle(source)
    home = tmp_path / "home"
    runtime = home / "runtime"
    for action in ["install", "qualify", "activate"]:
        core_plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, core_plan, f"test:{action}")

    before = profile_sdk.application(source, runtime)
    plan = profile_sdk.kfd3_qualification_plan(source, runtime)
    assert before["qualification"]["status"] == "untested"
    assert plan["requiresAuthorization"] is True
    assert profile_sdk.kfd3_status(source, runtime)["status"] == "untested"
    receipt = profile_sdk.authorize_kfd3_qualification(
        source, runtime, plan["planId"], "approve", "test-owner"
    )
    projected = profile_sdk.application(source, runtime)

    assert receipt["schema"] == "kungfu.profile-kfd3-qualification-receipt/v1"
    assert receipt["qualified"] is True
    assert receipt["qualificationSource"] == "local"
    assert receipt["noBypass"]["passed"] is True
    assert receipt["clientProbes"][0]["matched"] is True
    assert receipt["witness"]["qualificationReceiptId"] == receipt["receiptId"]
    assert receipt["witness"]["issuer"] == "kungfu-profile-runtime"
    assert projected["qualified"] is True
    assert projected["qualification"]["status"] == "qualified"
    assert projected["qualification"]["issuer"]["type"] == "local"
    assert projected["qualification"]["witnessId"] == receipt["witness"]["witnessId"]
    assert profile_sdk.verify_kfd3(source, runtime, receipt)["verified"] is True

    cli = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "kfd3-qualify",
            str(source),
            "--json",
        ],
    )
    assert cli.exit_code == 0, cli.output
    assert (
        json.loads(cli.output)["witness"]["witnessId"]
        == receipt["witness"]["witnessId"]
    )

    tampered = json.loads(json.dumps(receipt))
    tampered["knownLimits"][0]["description"] = "hidden drift"
    try:
        profile_sdk.verify_kfd3(source, runtime, tampered)
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "kfd3-qualification-stale-or-tampered"
    else:
        raise AssertionError("tampered KFD-3 receipt was verified")


def test_system_profile_release_receipt_is_exact_root_and_shared_with_status(
    tmp_path, monkeypatch
):
    repo = Path(__file__).resolve().parents[4]
    source = repo / "extensions" / "work-control"
    runtime = tmp_path / "runtime"
    manifest = profile_sdk.build_kfd3_release_manifest([source], runtime)
    receipt = manifest["entries"][0]["receipt"]

    assert receipt["profileId"] == "kungfu.work-control"
    assert receipt["qualificationSource"] == "release"
    assert receipt["noBypass"]["policy"] == "release-owned-shared-api-parity/v1"
    assert len(receipt["clientProbes"]) == 16
    assert all(row["matched"] for row in receipt["clientProbes"])
    assert {
        "claim-assignment",
        "advance-assignment",
        "append-assignment-relation-event",
        "work-input-snapshot",
        "work-managed-run",
        "work-effect-authorize",
        "work-effect-attempt",
        "work-effect-outcome",
    }.issubset({row["intentId"] for row in receipt["clientProbes"]})

    manifest_path = tmp_path / "profile-kfd3.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setenv("KF_PROFILE_KFD3_MANIFEST", str(manifest_path))
    for action in ["install", "qualify", "activate"]:
        core_plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, core_plan, f"test:{action}")

    status = profile_sdk.kfd3_status(source, runtime)
    assert status["status"] == "qualified"
    assert status["qualificationSource"] == "release"
    assert status["issuer"]["type"] == "release"
    assert status["receiptId"] == receipt["receiptId"]
    assert profile_sdk.verify_kfd3(source, runtime, receipt)["verified"] is True

    tampered = json.loads(json.dumps(manifest))
    tampered["entries"][0]["profileSuiteRoot"] = "sha256:" + "0" * 64
    manifest_path.write_text(json.dumps(tampered), encoding="utf-8")
    assert profile_sdk.kfd3_status(source, runtime)["status"] == "untested"


def test_kfd3_qualification_rejects_custom_view_mutation_boundary(tmp_path):
    source, _ = create_source(tmp_path)
    make_collaboration_action_lifecycle(source)
    member = source / "members" / "example-week-day-contract"
    manifest_path = member / "kungfu.kfx.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["kungfuConfig"]["config"] = {
        "view": {
            "title": "Private mutation view",
            "capabilities": ["profile"],
        }
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    bundle = member / "dist" / "view" / "index.js"
    bundle.parent.mkdir(parents=True)
    bundle.write_text("export function View() { return null; }\n")
    runtime = tmp_path / "runtime"
    for action in ["install", "qualify", "activate"]:
        core_plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, core_plan, f"test:{action}")

    try:
        profile_sdk.qualify_kfd3(source, runtime)
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "kfd3-no-bypass-failed"
        assert error.diagnosis["failures"][0]["facet"] == "view"
        assert error.diagnosis["failures"][0]["reasons"] == [
            "custom Profile views may not receive capability handles"
        ]
    else:
        raise AssertionError("custom mutation view bypass was qualified")


def test_kfd3_qualification_allows_capability_free_sandboxed_view(tmp_path):
    source, _ = create_source(tmp_path)
    make_collaboration_action_lifecycle(source)
    member = source / "members" / "example-week-day-contract"
    manifest_path = member / "kungfu.kfx.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["kungfuConfig"]["config"] = {
        "view": {
            "title": "Presentational view",
            "capabilities": [],
        }
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    bundle = member / "dist" / "view" / "index.js"
    bundle.parent.mkdir(parents=True)
    bundle.write_text("export function View() { return null; }\n")
    runtime = tmp_path / "runtime"
    for action in ["install", "qualify", "activate"]:
        core_plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, core_plan, f"test:{action}")

    receipt = profile_sdk.qualify_kfd3(source, runtime)

    assert receipt["noBypass"]["customViews"][0]["passed"] is True
    assert receipt["noBypass"]["customViews"][0]["runtime"] == "sandboxed-ipc"
    assert receipt["noBypass"]["customViews"][0]["bundleRoot"].startswith("sha256:")


def test_kfd3_qualification_requires_active_exact_root(tmp_path):
    source, _ = create_source(tmp_path)
    make_collaboration_action_lifecycle(source)

    try:
        profile_sdk.qualify_kfd3(source, tmp_path / "runtime")
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "kfd3-active-root-required"
    else:
        raise AssertionError("inactive Profile was KFD-3 qualified")


def test_kfd3_receipt_survives_portable_import_and_invalidates_on_upgrade(
    tmp_path,
):
    source, _ = create_source(tmp_path / "author")
    make_collaboration_action_lifecycle(source)
    runtime_a = tmp_path / "runtime-a"
    for action in ["install", "qualify", "activate"]:
        plan = profile_sdk.lifecycle_plan(runtime_a, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime_a, plan, f"portable-a:{action}")
    receipt_a = profile_sdk.qualify_kfd3(source, runtime_a)

    bundle = profile_sdk.export_source_bundle(source, runtime_a)
    import_plan = profile_sdk.source_import_plan(bundle, tmp_path / "imported")
    import_answer = profile_sdk.answer_decision(
        import_plan["decisionCard"], "approve", "portable-owner"
    )
    imported = profile_sdk.authorized_source_import(import_plan, import_answer)
    imported_source = Path(imported["destination"])
    runtime_b = tmp_path / "runtime-b"
    for action in ["install", "qualify", "activate"]:
        plan = profile_sdk.lifecycle_plan(runtime_b, action, imported_source)[
            "corePlan"
        ]
        profile_sdk.lifecycle_apply(runtime_b, plan, f"portable-b:{action}")
    receipt_b = profile_sdk.qualify_kfd3(imported_source, runtime_b)

    assert receipt_b["profileSuiteRoot"] == receipt_a["profileSuiteRoot"]
    assert receipt_b["receiptId"] == receipt_a["receiptId"]
    assert receipt_b["witness"]["witnessId"] == receipt_a["witness"]["witnessId"]

    collaboration_path = imported_source / "collaboration" / "interface.json"
    collaboration = json.loads(collaboration_path.read_text())
    collaboration["knownLimits"][0]["description"] = "Identity evidence upgraded."
    collaboration_bytes = (
        json.dumps(collaboration, indent=2, sort_keys=True) + "\n"
    ).encode()
    collaboration_path.write_bytes(collaboration_bytes)
    profile_path = imported_source / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["version"] = "1.1.0"
    profile["kfd3"]["collaboration"]["sha256"] = hashlib.sha256(
        collaboration_bytes
    ).hexdigest()
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")

    upgrade = profile_sdk.lifecycle_plan(runtime_b, "upgrade", imported_source)[
        "corePlan"
    ]
    profile_sdk.lifecycle_apply(runtime_b, upgrade, "portable-b:upgrade")
    for action in ["qualify", "activate"]:
        plan = profile_sdk.lifecycle_plan(runtime_b, action, imported_source)[
            "corePlan"
        ]
        profile_sdk.lifecycle_apply(runtime_b, plan, f"portable-b:{action}-v2")
    receipt_v2 = profile_sdk.qualify_kfd3(imported_source, runtime_b)
    assert receipt_v2["profileSuiteRoot"] != receipt_b["profileSuiteRoot"]
    try:
        profile_sdk.verify_kfd3(imported_source, runtime_b, receipt_b)
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "kfd3-qualification-stale-or-tampered"
    else:
        raise AssertionError("pre-upgrade KFD-3 receipt remained current")

    rollback = profile_sdk.lifecycle_plan(
        runtime_b,
        "rollback",
        None,
        profile_id="example.week-day",
        target_root=receipt_b["profileSuiteRoot"],
    )["corePlan"]
    profile_sdk.lifecycle_apply(runtime_b, rollback, "portable-b:rollback")
    rolled_back = profile_sdk.qualify_kfd3(source, runtime_b)
    assert rolled_back["profileSuiteRoot"] == receipt_b["profileSuiteRoot"]
    assert rolled_back["receiptId"] == receipt_b["receiptId"]


def test_missing_member_fails_with_stable_decision_card(tmp_path):
    source, _ = create_source(tmp_path)
    missing = source / "members" / "example-week-day-actions"
    for child in missing.iterdir():
        child.unlink()
    missing.rmdir()

    try:
        profile_sdk.resolve_source(source)
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "member-resolution-failed"
        assert error.diagnosis["decisionCards"][0]["kind"] == "profile-member-missing"
    else:
        raise AssertionError("missing member was accepted")


def test_member_package_symlink_fails_closed(tmp_path):
    source, _ = create_source(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside")
    create_symlink_or_skip(
        source / "members" / "example-week-day-contract" / "outside-link",
        outside,
    )

    try:
        profile_sdk.resolve_source(source)
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "member-package-symlink"
    else:
        raise AssertionError("symlinked member material was accepted")


def test_member_package_ignores_dependency_directory_symlinks(tmp_path):
    source, _ = create_source(tmp_path)
    member = source / "members" / "example-week-day-contract"
    dependencies = member / "node_modules"
    dependencies.mkdir()
    _symlink_or_skip(
        dependencies / "dependency",
        tmp_path,
        target_is_directory=True,
    )

    result = profile_sdk.validate_source(source, tmp_path / "runtime")

    assert result["ok"] is True
