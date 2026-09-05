# SPDX-License-Identifier: Apache-2.0
"""Work Control and admitted runtime execution cases."""

import base64
import hashlib
import json
from pathlib import Path

from click.testing import CliRunner

from kungfu import profile_composition, profile_sdk, runtime_broker
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc

from _agent_profile_sdk_scaffold_cases import (
    create_source,
)


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
