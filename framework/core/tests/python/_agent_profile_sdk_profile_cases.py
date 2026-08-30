# SPDX-License-Identifier: Apache-2.0
"""Profile resolution, composition, validation, and intent cases."""

import json
from pathlib import Path


from kungfu import profile_sdk
from kungfu.cli.commands import __registry__  # noqa: F401

from _agent_profile_sdk_scaffold_cases import (
    _write_json,
    add_collaboration,
    brief,
    collaboration_brief,
    create_source,
    make_collaboration_action_lifecycle,
)


def test_profile_resolution_skips_unreadable_unrelated_siblings(tmp_path, monkeypatch):
    source, _ = create_source(tmp_path)
    blocked_manifest = tmp_path / "unrelated" / "package.json"
    blocked_manifest.parent.mkdir()
    original_is_file = Path.is_file

    def guarded_is_file(path):
        if path == blocked_manifest:
            raise PermissionError("unrelated sibling is not readable")
        return original_is_file(path)

    monkeypatch.setattr(Path, "is_file", guarded_is_file)
    assert profile_sdk.validate_source(source, tmp_path / "runtime")["ok"] is True


def test_scaffold_is_plan_first_deterministic_and_does_not_self_certify(tmp_path):
    source = tmp_path / "profile"
    first = profile_sdk.scaffold_plan(brief(), source)
    second = profile_sdk.scaffold_plan(brief(), source)

    assert first["planId"] == second["planId"]
    assert first["selfCertifiedFields"] == []
    assert not source.exists()
    assert "profile_suite_root" not in first["files"]["profile.json"]


def test_scaffold_materializes_exact_planned_utf8_bytes(tmp_path):
    source = tmp_path / "profile"
    plan = profile_sdk.scaffold_plan(brief(), source)

    receipt = profile_sdk.apply_scaffold(plan)

    assert receipt["verified"] is True
    for relative, text in plan["files"].items():
        assert (source / relative).read_bytes() == text.encode("utf-8")


def test_scaffold_can_declare_generic_dual_first_collaboration(tmp_path):
    source = tmp_path / "profile"
    plan = profile_sdk.scaffold_plan(brief(collaboration=collaboration_brief()), source)
    profile_sdk.apply_scaffold(plan)

    profile = json.loads((source / "profile.json").read_text())
    assert profile["kfd3"]["collaboration"]["path"] == ("collaboration/interface.json")
    closure = profile_sdk.collaboration(source, tmp_path / "runtime")
    assert closure["declared"] is True
    assert closure["qualified"] is False
    assert closure["genericRenderer"] is True
    assert closure["actionIds"] == []
    qualification = profile_sdk.qualify_source(source, tmp_path / "runtime")
    assert qualification["kfd3"]["declared"] is True
    assert qualification["kfd3"]["qualified"] is False


def test_unresolved_semantics_return_open_decision_cards(tmp_path):
    incomplete = brief(identity={}, evidence={}, migration={})
    plan = profile_sdk.scaffold_plan(incomplete, tmp_path / "profile")

    assert plan["status"] == "needs-decision"
    assert {card["kind"] for card in plan["decisionCards"]} == {
        "identity-authority",
        "evidence-strength",
        "migration-mode",
    }
    assert all(card["answer"] is None for card in plan["decisionCards"])


def test_destructive_migration_and_unsupported_evidence_fail_closed(tmp_path):
    plan = profile_sdk.scaffold_plan(
        brief(
            evidence={"strength": "agent-self-certified"},
            migration={"mode": "explicit-destructive-plan"},
        ),
        tmp_path / "profile",
    )

    assert plan["status"] == "needs-decision"
    assert {card["kind"] for card in plan["decisionCards"]} == {
        "evidence-strength",
        "destructive-migration",
    }


def test_scaffold_rejects_tampered_plan_material(tmp_path):
    plan = profile_sdk.scaffold_plan(brief(), tmp_path / "profile")
    plan["files"]["profile.json"] += " "

    try:
        profile_sdk.apply_scaffold(plan)
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "source-plan-tampered"
    else:
        raise AssertionError("tampered source plan was written")


def test_resolver_computes_exact_member_roots_and_core_verifies_closure(tmp_path):
    source, _ = create_source(tmp_path)
    runtime = tmp_path / "runtime"

    result = profile_sdk.validate_source(source, runtime)

    assert result["ok"] is True
    assert result["inspection"]["verified"] is True
    assert set(result["source"]["memberRoots"]) == {
        "example-week-day-contract",
        "example-week-day-actions",
        "example-week-day-assessment",
    }
    assert all(
        root.startswith("sha256:") for root in result["source"]["memberRoots"].values()
    )


def test_validation_scope_reuses_exact_result_without_leaking_mutation(
    tmp_path, monkeypatch
):
    source, _ = create_source(tmp_path)
    runtime = tmp_path / "runtime"
    calls = 0
    original = profile_sdk._work_profile_conformance

    def observed(inspection, surface):
        nonlocal calls
        calls += 1
        return original(inspection, surface)

    monkeypatch.setattr(profile_sdk, "_work_profile_conformance", observed)

    with profile_sdk.validation_scope():
        first = profile_sdk.validate_source(source, runtime)
        first["source"]["memberRoots"].clear()
        second = profile_sdk.validate_source(source, runtime)
        with profile_sdk.validation_scope():
            third = profile_sdk.validate_source(source, runtime)

    assert calls == 1
    assert second == third
    assert second["source"]["memberRoots"]

    profile_sdk.validate_source(source, runtime)
    assert calls == 2


def test_collaboration_closure_binds_dual_first_actions_views_and_limits(tmp_path):
    source, _ = create_source(tmp_path)
    add_collaboration(source)

    result = profile_sdk.collaboration(source, tmp_path / "runtime")

    assert result["status"] == "declared-closed"
    assert result["declared"] is True
    assert result["qualified"] is False
    assert result["actionIds"] == ["complete-day"]
    assert result["viewIds"] == ["week-state"]
    assert result["closureRoot"].startswith("sha256:")
    assert {row["kind"] for row in result["participants"]} == {"human", "agent"}


def test_profile_without_collaboration_is_explicitly_not_declared(tmp_path):
    source, _ = create_source(tmp_path)

    result = profile_sdk.collaboration(source, tmp_path / "runtime")

    assert result["status"] == "not-declared"
    assert result["declared"] is False
    assert result["qualified"] is False


def test_collaboration_rejects_missing_agent_participant(tmp_path):
    source, _ = create_source(tmp_path)
    collaboration = add_collaboration(source)
    collaboration["participants"][1] = {
        "id": "reviewer",
        "kind": "human",
        "title": "Reviewer",
        "authorityClasses": [],
    }
    ref = _write_json(source / "collaboration" / "interface.json", collaboration)
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["kfd3"] = {"collaboration": ref}
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")

    try:
        profile_sdk.collaboration(source, tmp_path / "runtime")
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "collaboration-dual-first-required"
    else:
        raise AssertionError("single-participant collaboration was accepted")


def test_collaboration_rejects_action_capability_drift(tmp_path):
    source, _ = create_source(tmp_path)
    collaboration = add_collaboration(source)
    collaboration["intents"][0]["requiredCapabilities"] = ["network"]
    ref = _write_json(source / "collaboration" / "interface.json", collaboration)
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["kfd3"] = {"collaboration": ref}
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")

    try:
        profile_sdk.collaboration(source, tmp_path / "runtime")
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "collaboration-capability-drift"
    else:
        raise AssertionError("capability drift was accepted")


def test_collaboration_rejects_material_action_without_authority(tmp_path):
    source, _ = create_source(tmp_path)
    collaboration = add_collaboration(source)
    collaboration["intents"][0]["requiredAuthority"] = "none"
    collaboration_ref = _write_json(
        source / "collaboration" / "interface.json", collaboration
    )
    actions_path = source / "actions" / "registry.json"
    actions = json.loads(actions_path.read_text())
    actions["actions"][0]["authorityClass"] = "none"
    action_ref = _write_json(actions_path, actions)
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["actions"]["registry"] = action_ref
    profile["kfd3"] = {"collaboration": collaboration_ref}
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")

    try:
        profile_sdk.collaboration(source, tmp_path / "runtime")
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "profile-sdk-contract-invalid"
    else:
        raise AssertionError("material action without authority was accepted")


def test_application_projection_is_generic_and_binds_both_participants(tmp_path):
    source, _ = create_source(tmp_path)
    add_collaboration(source)

    result = profile_sdk.application(source, tmp_path / "runtime")

    assert result["schema"] == "kungfu.profile-application/v1"
    assert result["presentation"] == {"mode": "generic"}
    assert result["activeExactRoot"] is False
    assert {row["kind"] for row in result["participants"]} == {"human", "agent"}
    assert result["intents"][0]["action"]["id"] == "complete-day"
    assert result["intents"][0]["inspectView"]["id"] == "week-state"
    assert result["qualified"] is False


def test_intent_protocol_shares_plan_receipt_and_verify_identities(tmp_path):
    source, _ = create_source(tmp_path)
    make_collaboration_action_lifecycle(source)
    runtime = tmp_path / "runtime"
    for action in ["install", "qualify", "activate"]:
        core_plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, core_plan, f"test:{action}")

    inspected = profile_sdk.intent_inspect(source, runtime, "complete-day")
    advised = profile_sdk.intent_advise(source, runtime, "complete-day")
    plan = profile_sdk.intent_plan(source, runtime, "complete-day", {})
    answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", "test-owner")
    receipt = profile_sdk.intent_apply(runtime, plan, answer)
    verification = profile_sdk.intent_verify(source, runtime, receipt)

    assert inspected["closureRoot"] == advised["closureRoot"] == plan["closureRoot"]
    assert advised["eligible"] is True
    assert plan["actionPlan"]["intentId"] == "complete-day"
    assert receipt["verified"] is False
    assert receipt["executionReceiptVerified"] is True
    assert verification["receiptId"] == receipt["receiptId"]
    assert verification["verified"] is True


def test_intent_authorize_rejects_stale_reviewed_plan(tmp_path):
    source, _ = create_source(tmp_path)
    make_collaboration_action_lifecycle(source)
    runtime = tmp_path / "runtime"
    for action in ["install", "qualify", "activate"]:
        core_plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
        profile_sdk.lifecycle_apply(runtime, core_plan, f"test:{action}")

    try:
        profile_sdk.authorize_current_intent(
            runtime,
            source,
            "complete-day",
            {},
            "sha256:stale",
            "approve",
            "test-owner",
        )
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "intent-plan-stale"
    else:
        raise AssertionError("stale intent plan was authorized")
