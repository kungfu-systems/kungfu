# SPDX-License-Identifier: Apache-2.0

import base64
import hashlib
import json
from pathlib import Path

import pytest
from click.testing import CliRunner

from kungfu import profile_composition, profile_sdk, runtime_broker
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service as storage_service


def brief(**changes):
    value = {
        "schema": "kungfu.profile-brief/v1",
        "id": "example.week-day",
        "title": "Week / Day",
        "version": "1.0.0",
        "purposes": ["operator-review", "handoff"],
        "permissions": [],
        "identity": {"authority": "workspace-owner"},
        "evidence": {"strength": "reported-with-references"},
        "migration": {"mode": "additive"},
    }
    value.update(changes)
    return value


def collaboration_brief():
    return {
        "summary": "Coordinate Week and Day work without hiding authority.",
        "participantBenefits": [
            {
                "participantKind": "human",
                "description": "Review exact plans and receipts.",
            },
            {
                "participantKind": "agent",
                "description": "Discover constraints and execute authorized intents.",
            },
        ],
        "participants": [
            {
                "id": "owner",
                "kind": "human",
                "title": "Owner",
                "authorityClasses": ["workflow-owner"],
            },
            {"id": "worker", "kind": "agent", "title": "Agent", "authorityClasses": []},
        ],
        "constraints": [
            {
                "id": "authorization",
                "description": "Material actions require declared authority.",
                "enforcement": "runtime",
                "appliesTo": ["*"],
            }
        ],
        "knownLimits": [
            {
                "id": "identity",
                "description": "Actor identity is externally verified.",
                "effect": "external-verification-required",
            }
        ],
    }


def create_source(tmp_path):
    source = tmp_path / "profile"
    plan = profile_sdk.scaffold_plan(brief(), source)
    assert plan["ok"] is True
    receipt = profile_sdk.apply_scaffold(plan)
    assert receipt["verified"] is True
    return source, plan


def create_symlink_or_skip(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target)
    except OSError as error:
        if getattr(error, "winerror", None) == 1314:
            pytest.skip("Windows runner does not grant symlink creation privilege")
        raise


def test_work_conformance_prefers_the_embedded_product_node_host(tmp_path, monkeypatch):
    front_door = tmp_path / "kungfu"
    front_door.write_bytes(b"")
    checker = tmp_path / "work-profile-conformance.mjs"
    checker.write_bytes(b"")
    monkeypatch.setenv("KUNGFU_CONTROLLER_ENTRYPOINT", str(front_door))
    monkeypatch.setattr(profile_sdk.shutil, "which", lambda _name: "/poison/node")

    command, environment = profile_sdk._work_profile_conformance_invocation(checker)

    assert command == [str(front_door.resolve()), str(checker)]
    assert environment is not None
    assert environment["KUNGFU_AS_VARIANT"] == "node"
    assert environment["KUNGFU_NODE_VARIANT_ENTRY"] == str(checker)


def test_work_conformance_falls_back_to_path_node_without_a_product_host(
    tmp_path, monkeypatch
):
    checker = tmp_path / "work-profile-conformance.mjs"
    checker.write_bytes(b"")
    monkeypatch.delenv("KUNGFU_CONTROLLER_ENTRYPOINT", raising=False)
    monkeypatch.delenv("KUNGFU_AGENT_SESSION_EXECUTABLE", raising=False)
    monkeypatch.setattr(profile_sdk.shutil, "which", lambda _name: "/toolchain/node")

    command, environment = profile_sdk._work_profile_conformance_invocation(checker)

    assert command == ["/toolchain/node", str(checker)]
    assert environment is None


def test_scaffold_writes_the_exact_planned_utf8_bytes(tmp_path):
    source = tmp_path / "profile"
    plan = profile_sdk.scaffold_plan(brief(), source)

    receipt = profile_sdk.apply_scaffold(plan)

    assert receipt["verified"] is True
    for relative, text in plan["files"].items():
        assert (source / relative).read_bytes() == text.encode("utf-8")


def _write_json(path, value):
    data = json.dumps(value, indent=2, sort_keys=True).encode() + b"\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {
        "path": path.relative_to(path.parents[1]).as_posix(),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _symlink_or_skip(link, target, *, target_is_directory=False):
    try:
        link.symlink_to(target, target_is_directory=target_is_directory)
    except OSError as error:
        if getattr(error, "winerror", None) == 1314:
            pytest.skip("Windows runner account cannot create symbolic links")
        raise


def add_collaboration(source):
    actions = {
        "schema": "kungfu.profile-actions/v1",
        "actions": [
            {
                "id": "complete-day",
                "title": "Complete day",
                "runner": "kfx-member",
                "operation": "example-week-day-actions",
                "runtimeOperation": "episode.append",
                "authorityClass": "workflow-owner",
                "requiredCapabilities": [],
                "effects": ["append-admitted-fact"],
            }
        ],
    }
    views = {
        "schema": "kungfu.profile-views/v1",
        "views": [
            {
                "id": "week-state",
                "title": "Week state",
                "factSurfaces": ["example.week-day.day"],
                "definition": {"schema": "kungfu.query.definition/v1"},
                "view": {
                    "kind": "profile",
                    "profileId": "example.week-day",
                    "profileVersion": "1.0.0",
                    "memberId": "example-week-day-dashboard",
                    "viewId": "week-plan",
                    "spec": {
                        "schema": "example.week-day.week-plan-view/v1",
                        "layout": "cards",
                        "dayField": "subject_key",
                    },
                },
            }
        ],
    }
    collaboration = {
        "schema": "kungfu.profile-collaboration/v1",
        "profileId": "example.week-day",
        "value": {
            "summary": "Coordinate Week and Day work without hiding authority.",
            "participantBenefits": [
                {
                    "participantKind": "human",
                    "description": "Review exact plans and receipts.",
                },
                {
                    "participantKind": "agent",
                    "description": "Discover constraints and execute authorized intents.",
                },
            ],
        },
        "participants": [
            {
                "id": "owner",
                "kind": "human",
                "title": "Owner",
                "authorityClasses": ["workflow-owner"],
            },
            {"id": "worker", "kind": "agent", "title": "Agent", "authorityClasses": []},
        ],
        "intents": [
            {
                "id": "complete-day",
                "title": "Complete day",
                "actionId": "complete-day",
                "inspectViewId": "week-state",
                "verifyViewId": "week-state",
                "requiredAuthority": "workflow-owner",
                "requiredCapabilities": [],
                "material": True,
                "protocol": {
                    "inspect": "profile.intent.inspect",
                    "advise": "profile.intent.advise",
                    "preview": "profile.intent.plan",
                    "authorize": "profile.decide",
                    "execute": "profile.intent.apply",
                    "receipt": "profile.intent.receipt",
                    "verify": "profile.intent.verify",
                },
            }
        ],
        "constraints": [
            {
                "id": "authorization",
                "description": "Owner approval is required.",
                "enforcement": "runtime",
                "appliesTo": ["*"],
            }
        ],
        "knownLimits": [
            {
                "id": "identity",
                "description": "Actor identity is externally verified.",
                "effect": "external-verification-required",
            }
        ],
        "presentation": {"mode": "generic", "homeViewId": "week-state"},
    }
    action_ref = _write_json(source / "actions" / "registry.json", actions)
    view_ref = _write_json(source / "views" / "registry.json", views)
    collaboration_ref = _write_json(
        source / "collaboration" / "interface.json", collaboration
    )
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["actions"]["registry"] = action_ref
    profile["views"]["registry"] = view_ref
    profile["kfd3"] = {"collaboration": collaboration_ref}
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")
    return collaboration


def make_collaboration_action_lifecycle(source):
    collaboration = add_collaboration(source)
    actions_path = source / "actions" / "registry.json"
    actions = json.loads(actions_path.read_text())
    actions["actions"][0].update(
        {
            "title": "Remove Profile",
            "runner": "profile-lifecycle",
            "operation": "remove",
            "effects": ["append-Removed-event"],
        }
    )
    action_ref = _write_json(actions_path, actions)
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["actions"]["registry"] = action_ref
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")
    return collaboration


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
    assert len(receipt["clientProbes"]) == 12
    assert all(row["matched"] for row in receipt["clientProbes"])
    assert {
        "claim-assignment",
        "advance-assignment",
        "append-assignment-relation-event",
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


def test_cli_exposes_collaboration_closure_to_agents(tmp_path):
    source, _ = create_source(tmp_path)
    add_collaboration(source)
    runner = CliRunner()

    result = runner.invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "profile",
            "collaboration",
            str(source),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == "declared-closed"
    assert payload["protocol"] == [
        "inspect",
        "advise",
        "preview",
        "authorize",
        "execute",
        "receipt",
        "verify",
    ]

    application = runner.invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "profile",
            "application",
            str(source),
            "--json",
        ],
    )
    assert application.exit_code == 0, application.output
    application_payload = json.loads(application.output)
    assert application_payload["schema"] == "kungfu.profile-application/v1"
    assert application_payload["qualified"] is False

    inspected = runner.invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "profile",
            "intent",
            "inspect",
            str(source),
            "complete-day",
            "--json",
        ],
    )
    assert inspected.exit_code == 0, inspected.output
    assert json.loads(inspected.output)["intent"]["id"] == "complete-day"


def test_cli_installed_flow_plans_then_applies_core_lifecycle(tmp_path):
    source, _ = create_source(tmp_path)
    home = tmp_path / "home"
    runner = CliRunner()

    capability = runner.invoke(
        kfc, ["--home", str(home), "profile", "capabilities", "--json"]
    )
    assert capability.exit_code == 0, capability.output
    capability_payload = json.loads(capability.output)
    assert capability_payload["schema"] == "kungfu.agent-profile-sdk/v1"
    assert (
        capability_payload["schemas"]["collaboration"]["properties"]["schema"]["const"]
        == "kungfu.profile-collaboration/v1"
    )

    plan_file = tmp_path / "install-plan.json"
    planned = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "plan",
            "install",
            str(source),
            "--out",
            str(plan_file),
            "--json",
        ],
    )
    assert planned.exit_code == 0, planned.output
    plan_payload = json.loads(planned.output)
    assert plan_payload["decisionCard"]["answer"] is None
    assert plan_file.is_file()

    answer_file = tmp_path / "answer.json"
    decided = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "decide",
            str(plan_file),
            "--choice",
            "approve",
            "--authorized-by",
            "test-operator",
            "--out",
            str(answer_file),
            "--json",
        ],
    )
    assert decided.exit_code == 0, decided.output
    assert answer_file.is_file()

    applied = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "apply",
            str(plan_file),
            "--authorization-file",
            str(answer_file),
            "--json",
        ],
    )
    assert applied.exit_code == 0, applied.output
    assert json.loads(applied.output)["state"]["state"] == "installed"


def test_cli_exports_and_imports_profile_source_without_lifecycle_mutation(tmp_path):
    source, _ = create_source(tmp_path)
    home = tmp_path / "home"
    full_path = tmp_path / "profile.full.json"
    thin_path = tmp_path / "profile.thin.json"
    imported_source = tmp_path / "imported-profile"
    runner = CliRunner()

    exported = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "export",
            str(source),
            "--out",
            str(full_path),
            "--json",
        ],
    )
    assert exported.exit_code == 0, exported.output
    full = json.loads(full_path.read_text())
    assert full["schema"] == "kungfu.profile-source-bundle/v1"
    assert full["mode"] == "full"
    assert all("contentBase64" in row for row in full["entries"])

    planned = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "import",
            str(full_path),
            "--out",
            str(imported_source),
            "--json",
        ],
    )
    assert planned.exit_code == 0, planned.output
    assert json.loads(planned.output)["requiresAuthorization"] is True
    imported = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "import",
            str(full_path),
            "--out",
            str(imported_source),
            "--execute",
            "--authorized-by",
            "test-owner",
            "--json",
        ],
    )
    assert imported.exit_code == 0, imported.output
    receipt = json.loads(imported.output)
    assert receipt["lifecycleMutation"] is False
    assert profile_sdk.validate_source(imported_source, home / "runtime")["ok"]
    assert (
        storage_service.profile_lifecycle(
            home / "runtime", "list", include_removed=True
        )["profiles"]
        == []
    )

    thin = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "export",
            str(source),
            "--out",
            str(thin_path),
            "--thin",
            "--json",
        ],
    )
    assert thin.exit_code == 0, thin.output
    assert all(
        "contentBase64" not in row
        for row in json.loads(thin_path.read_text())["entries"]
    )
    thin_import = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "profile",
            "import",
            str(thin_path),
            "--out",
            str(tmp_path / "thin-import"),
            "--execute",
            "--authorized-by",
            "test-owner",
            "--json",
        ],
    )
    assert thin_import.exit_code == 2
    assert json.loads(thin_import.output)["code"] == "source-import-not-ready"


def test_lifecycle_apply_rejects_tampered_decision_answer(tmp_path):
    source, _ = create_source(tmp_path)
    runtime = tmp_path / "runtime"
    plan = profile_sdk.lifecycle_plan(runtime, "install", source)
    answer = profile_sdk.answer_decision(
        plan["decisionCard"], "approve", "test-operator"
    )
    answer["authorizedBy"] = "another-actor"

    try:
        profile_sdk.authorized_lifecycle_apply(runtime, plan, answer)
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "decision-answer-tampered"
    else:
        raise AssertionError("tampered decision answer was accepted")


def test_semantic_diff_classifies_permission_and_requires_decision(tmp_path):
    left = tmp_path / "left"
    right = tmp_path / "right"
    profile_sdk.apply_scaffold(profile_sdk.scaffold_plan(brief(), left))
    profile_sdk.apply_scaffold(
        profile_sdk.scaffold_plan(brief(permissions=["journal.read.batch"]), right)
    )

    result = profile_sdk.semantic_diff(left, right)

    assert "permission" in result["changedCategories"]
    assert result["decisionCards"][0]["kind"] == "profile-permission-change"


def _activate_work_control(runtime):
    source = Path(__file__).resolve().parents[4] / "extensions" / "work-control"
    for action in ["install", "qualify", "activate"]:
        core_plan = profile_sdk.lifecycle_plan(
            runtime,
            action,
            source,
            **({"granted_permissions": ["storage"]} if action == "activate" else {}),
        )["corePlan"]
        profile_sdk.lifecycle_apply(runtime, core_plan, f"test:{action}")
    return source


def test_work_control_exposes_only_canonical_creation_actions():
    source = Path(__file__).resolve().parents[4] / "extensions" / "work-control"
    profile = json.loads((source / "profile.json").read_text())
    registry = json.loads((source / "actions" / "registry.json").read_text())

    profile_sdk._validate_action_registry(registry, profile)
    actions = {row["id"]: row for row in registry["actions"]}
    assert actions["create-initiative"]["runtimeOperation"] == "episode.append"
    assert actions["create-assignment"]["runtimeOperation"] == "episode.append"
    assert "create-mission" not in actions
    assert "create-go" not in actions


def _write_native_runtime_evidence(runtime, config_home):
    runtime_path = Path(runtime).resolve()
    evidence = {
        "schema": "kungfu.runtime.native-readiness-evidence/v1",
        "workspaceId": runtime_broker.workspace_id(runtime_path),
        "runtimeHome": str(runtime_path.parent),
        "dataRoot": str(runtime_path),
        "minimumCut": {
            "stream_id": "1",
            "container_epoch": "1",
            "sequence": "1",
            "frame_uid": "1",
        },
        "durability": {
            "requestId": "17",
            "requestedProfile": "durable_sync",
            "writerResourceId": "00000007.0000000b",
            "qualificationProfile": "test/disposable-powercut/v1",
        },
        "projection": None,
    }
    path = runtime_broker.native_readiness_evidence_path(runtime, config_home)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(evidence))
    return evidence


def test_action_invoke_rechecks_active_root_and_returns_core_receipt(tmp_path):
    source, _ = create_source(tmp_path)
    registry_path = source / "actions" / "registry.json"
    registry = {
        "schema": "kungfu.profile-actions/v1",
        "actions": [
            {
                "id": "retire",
                "title": "Retire Profile",
                "runner": "profile-lifecycle",
                "operation": "remove",
                "runtimeOperation": "episode.append",
                "authorityClass": "workspace-profile-operator",
                "requiredCapabilities": [],
                "effects": ["append-Removed-event"],
            }
        ],
    }
    registry_bytes = (json.dumps(registry, indent=2, sort_keys=True) + "\n").encode()
    registry_path.write_bytes(registry_bytes)
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["actions"]["registry"]["sha256"] = hashlib.sha256(
        registry_bytes
    ).hexdigest()
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")
    runtime = tmp_path / "runtime"

    install = profile_sdk.lifecycle_plan(runtime, "install", source)["corePlan"]
    profile_sdk.lifecycle_apply(runtime, install, "test:install")
    qualify = profile_sdk.lifecycle_plan(runtime, "qualify", source)["corePlan"]
    profile_sdk.lifecycle_apply(runtime, qualify, "test:qualify")
    activate = profile_sdk.lifecycle_plan(runtime, "activate", source)["corePlan"]
    profile_sdk.lifecycle_apply(runtime, activate, "test:activate")

    action_plan = profile_sdk.plan_action(source, runtime, "retire", {})
    answer = profile_sdk.answer_decision(
        action_plan["decisionCard"], "approve", "test-operator"
    )
    receipt = profile_sdk.authorized_action_invoke(runtime, action_plan, answer)

    assert receipt["schema"] == "kungfu.profile-action-receipt/v1"
    assert receipt["coreReceipt"]["state"]["state"] == "removed"
    assert receipt["verified"] is True


def test_work_control_profile_action_executes_through_public_intent(tmp_path):
    runtime = tmp_path / "runtime"
    source = _activate_work_control(runtime)
    contract = profile_composition.contract_materialization_plan(source, runtime)
    profile_composition.authorized_contract_materialize(
        runtime,
        contract,
        profile_sdk.answer_decision(contract["decisionCard"], "approve", "test-owner"),
    )

    values = {
        "initiativeId": "mission:test",
        "title": "Test Mission",
        "intent": "Prove public Profile action execution",
        "actor": "test-agent",
        "actorType": "agent",
    }
    plan = profile_sdk.intent_plan(source, runtime, "create-initiative", values)
    cli_plan = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path),
            "profile",
            "intent",
            "plan",
            str(source),
            "create-initiative",
            "--input-base64",
            base64.b64encode(json.dumps(values).encode()).decode(),
            "--json",
        ],
    )
    assert cli_plan.exit_code == 0, cli_plan.output
    assert json.loads(cli_plan.output)["planId"] == plan["planId"]
    answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", "test-owner")
    receipt = profile_sdk.intent_apply(runtime, plan, answer)

    execution = receipt["actionReceipt"]
    assert execution["schema"] == "kungfu.profile-action-receipt/v1"
    assert execution["runtimeReceipt"]["accepted"] is True
    assert execution["runtimeReceipt"]["activation"]["outcome"] == "daemonless"
    assert plan["actionPlan"]["runtimePlan"]["operation"]["id"] == "episode.append"
    assert execution["coreReceipt"]["initiative_subject"] == "kungfu:mission:test"
    assert execution["memberReceipt"]["schema"] == ("kungfu.profile-member-receipt/v1")
    assert execution["memberReceipt"]["profileSuiteRoot"] == plan["profileSuiteRoot"]
    assert execution["memberReceipt"]["memberId"] == "work-control-actions"
    assert execution["memberReceipt"]["memberRoot"].startswith("sha256:")
    assert execution["affected"] == {
        "profileId": "kungfu.work-control",
        "entityKeys": ["kungfu:mission:test"],
        "queryKeys": [
            "initiative-state",
            "initiative-timeline",
            "initiative-attention",
        ],
    }
    assert receipt["executionReceiptVerified"] is True


def test_profile_action_rejects_tampered_runtime_execution_material(tmp_path):
    runtime = tmp_path / "runtime"
    source = _activate_work_control(runtime)
    plan = profile_sdk.plan_action(
        source,
        runtime,
        "create-initiative",
        {
            "initiativeId": "mission:tampered-runtime",
            "title": "Tampered Runtime",
            "intent": "The callback must not bypass its exact runtime plan",
            "actor": "test-agent",
        },
    )
    answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", "test-owner")
    plan["runtimePlan"]["operation"]["id"] = "assessment.request"

    try:
        profile_sdk.authorized_action_invoke(runtime, plan, answer)
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "action-plan-stale"
        assert error.diagnosis["message"] == (
            "runtime execution material changed after planning"
        )
    else:
        raise AssertionError("tampered runtime execution material reached the callback")


def test_live_profile_action_plan_fails_without_native_evidence(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    source = _activate_work_control(runtime)
    monkeypatch.setenv("KF_CONFIG_HOME", str(tmp_path / "config"))

    try:
        profile_sdk.plan_action(
            source, runtime, "assess-progress", {"missionId": "mission:test"}
        )
    except profile_sdk.ProfileSdkError as error:
        assert error.diagnosis["code"] == "runtime-evidence-unavailable"
        assert error.diagnosis["operationId"] == "assessment.request"
    else:
        raise AssertionError("live action planned without native evidence")


def test_completion_review_plans_as_storage_append_without_native_runtime_evidence(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "runtime"
    source = _activate_work_control(runtime)
    monkeypatch.setenv("KF_CONFIG_HOME", str(tmp_path / "config"))

    plan = profile_sdk.plan_action(
        source,
        runtime,
        "review-completion",
        {
            "missionId": "mission:test",
            "goalId": "goal:test",
            "reviewer": "independent-reviewer",
            "reviewerSource": "qualification",
            "executorProfile": "inline",
        },
    )

    assert plan["runtimePlan"]["operation"]["id"] == "episode.append"
    assert plan["runtimePlan"]["requirement"]["operationClass"] == "storage-only"
    assert plan["runtimePlan"]["requirement"]["minimumCut"] is None


def test_live_profile_action_does_not_run_callback_when_broker_refuses(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "runtime"
    source = _activate_work_control(runtime)
    config_home = tmp_path / "config"
    monkeypatch.setenv("KF_CONFIG_HOME", str(config_home))
    evidence = _write_native_runtime_evidence(runtime, config_home)
    calls = []
    monkeypatch.setattr(
        profile_sdk,
        "invoke_member_adapter",
        lambda *_args: calls.append("callback") or {"result": {"coreReceipt": {}}},
    )
    monkeypatch.setattr(
        runtime_broker.RuntimeCapabilityBroker,
        "for_process",
        classmethod(
            lambda cls, *_args, **_kwargs: runtime_broker.RuntimeCapabilityBroker()
        ),
    )

    plan = profile_sdk.plan_action(
        source, runtime, "assess-progress", {"missionId": "mission:test"}
    )
    answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", "test-owner")
    receipt = profile_sdk.authorized_action_invoke(runtime, plan, answer)

    assert plan["runtimePlan"]["operation"]["id"] == "assessment.request"
    assert plan["runtimePlan"]["requirement"]["minimumCut"] == evidence["minimumCut"]
    assert receipt["runtimeReceipt"]["accepted"] is False
    assert receipt["runtimeReceipt"]["activation"]["error"]["code"] == (
        "runtime_unavailable"
    )
    assert receipt["verified"] is False
    assert calls == []


def test_live_profile_action_runs_only_through_admitted_runtime_receipt(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "runtime"
    source = _activate_work_control(runtime)
    config_home = tmp_path / "config"
    monkeypatch.setenv("KF_CONFIG_HOME", str(config_home))
    _write_native_runtime_evidence(runtime, config_home)
    calls = []

    def invoke_action(*_args, **_kwargs):
        calls.append("callback")
        return {
            "result": {
                "coreReceipt": {"scheduled": True},
                "affected": {"entityKeys": []},
            }
        }

    class AdmittingBroker:
        def invoke(self, plan, callback):
            activation = {"outcome": "activated"}
            return {
                "schema": "kungfu.runtime.invocation-receipt/v1",
                "planId": plan["planId"],
                "operationId": plan["operation"]["id"],
                "accepted": True,
                "activation": activation,
                "result": callback(activation),
            }

    monkeypatch.setattr(profile_sdk, "invoke_member_adapter", invoke_action)
    monkeypatch.setattr(
        runtime_broker.RuntimeCapabilityBroker,
        "for_process",
        classmethod(lambda cls, *_args, **_kwargs: AdmittingBroker()),
    )

    plan = profile_sdk.plan_action(
        source, runtime, "assess-progress", {"missionId": "mission:test"}
    )
    answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", "test-owner")
    receipt = profile_sdk.authorized_action_invoke(runtime, plan, answer)

    assert calls == ["callback"]
    assert receipt["runtimeReceipt"]["accepted"] is True
    assert receipt["coreReceipt"] == {"scheduled": True}
    assert receipt["verified"] is True
