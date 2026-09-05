# SPDX-License-Identifier: Apache-2.0
"""Profile CLI and lifecycle cases."""

import json

from click.testing import CliRunner

from kungfu import profile_sdk
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service as storage_service

from _agent_profile_sdk_scaffold_cases import (
    add_collaboration,
    brief,
    create_source,
)


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
