# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from kungfu import assignment_orchestration as orchestration
from kungfu import profile_composition, profile_sdk, projects
from kungfu import work_control
from kungfu.cli.commands import project as project_commands
from kungfu.project_template import BLANK_TEMPLATE_ID
from kungfu.rewind import reporting as rewind_reporting
from kungfu.storage import service as storage_service
from kungfu.workspace import (
    ensure_workspace_data_home,
    inspect_workspace,
    resolve_workspace_target,
)

SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "work-control"


@pytest.fixture(autouse=True)
def _bind_first_party_extension_root(monkeypatch):
    monkeypatch.setenv("KF_EXTENSION_PATH", str(SOURCE.parent))


def _activate_work_control(runtime):
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(
            runtime,
            action,
            SOURCE,
            **({"granted_permissions": ["storage"]} if action == "activate" else {}),
        )["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")
    contract = profile_composition.contract_materialization_plan(SOURCE, runtime)
    if contract["operations"]:
        profile_composition.authorized_contract_materialize(
            runtime,
            contract,
            profile_sdk.answer_decision(
                contract["decisionCard"], "approve", "test-owner"
            ),
        )


def test_completion_review_supports_equal_project_and_work_ids(tmp_path):
    runtime = tmp_path / ".kungfu" / "runtime"
    _activate_work_control(runtime)
    work_control.create_initiative(
        str(runtime),
        initiative_id="shared-project-work",
        title="Shared Project Work",
        intent="Settle Work captured before Project identity prefixes diverged",
        actor="local-user",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="shared-project-work",
        assignment_id="shared-project-work",
        title="Shared Project Work",
        objective="Retain an independently reviewed result",
        actor="local-user",
    )
    rewind_reporting.begin_run(
        str(runtime),
        run_id="shared-project-work-run",
        provider="codex",
        cwd=None,
        work_id="shared-project-work",
    )
    rewind_reporting.end_run(
        str(runtime),
        run_id="shared-project-work-run",
        status="succeeded",
        exit_code=0,
    )
    work_episode = next(
        row
        for row in storage_service.episode_list(runtime)["episodes"]
        if row["open"]["source"] == "rewind:shared-project-work-run"
    )
    work_control.claim_completion(
        str(runtime),
        initiative_id="shared-project-work",
        assignment_id="shared-project-work",
        statement="The retained result satisfies the Work definition",
        actor="local-user",
        evidence_episode_ids=[int(work_episode["episode_id"])],
        assignment_set=["shared-project-work"],
        acceptance_root="sha256:" + "a" * 64,
        proof_roots=["sha256:" + "b" * 64],
        evidence_availability=[
            {
                "acceptance": "Retained result is independently reviewable",
                "level": "full",
                "state": "available",
            }
        ],
    )
    state = work_control.query_state(
        str(runtime),
        initiative_id="shared-project-work",
    )
    assert state["canonical_state"] is True, state["lineage"]

    reviewed = work_control.review_completion(
        str(runtime),
        initiative_id="shared-project-work",
        assignment_id="shared-project-work",
        reviewer="reviewer-a",
        reviewer_source="independent-session-a",
    )

    assert reviewed["review"]["verdict"] == "fit"
    status = work_control.assignment_orchestration_status(
        str(runtime),
        initiative_id="shared-project-work",
        assignment_id="shared-project-work",
    )
    assert status["phase"] == "independently-reviewed"


def test_project_cli_first_layer_uses_new_and_open_language():
    commands = project_commands.project.commands

    assert "create" in commands
    assert "open" in commands
    assert "open-plan" in commands
    assert "import" not in commands
    assert "import-plan" not in commands
    template = next(
        parameter
        for parameter in commands["create"].params
        if parameter.name == "template_id"
    )
    assert template.default == BLANK_TEMPLATE_ID


def test_import_plan_is_read_only_and_import_changes_only_registry(tmp_path):
    project = tmp_path / "ordinary-project"
    project.mkdir()
    source = project / "README.md"
    source.write_text("# Existing\n", encoding="utf-8")
    config_home = tmp_path / "config"

    plan = projects.plan_import(project)

    assert plan["schema"] == "kungfu.project.import-plan/v1"
    assert plan["project"]["path"] == str(project.resolve())
    assert plan["writeOccurred"] is False
    assert not (project / ".kungfu").exists()

    receipt = projects.import_project(
        project,
        expected_plan_root=plan["planRoot"],
        config_home=str(config_home),
    )

    assert receipt["status"] == "imported"
    assert receipt["project"]["selected"] is True
    assert receipt["projectFilesChanged"] is False
    assert source.read_text(encoding="utf-8") == "# Existing\n"
    assert not (project / ".kungfu").exists()
    assert Path(receipt["registryPath"]).is_file()


def test_import_rejects_stale_plan_before_registry_write(tmp_path):
    project = tmp_path / "ordinary-project"
    project.mkdir()
    config_home = tmp_path / "config"

    with pytest.raises(ValueError, match="stale"):
        projects.import_project(
            project,
            expected_plan_root="sha256:" + ("0" * 64),
            config_home=str(config_home),
        )

    assert not config_home.exists()


def test_catalog_lists_only_project_workspaces(tmp_path):
    project = tmp_path / "ordinary-project"
    project.mkdir()
    config_home = tmp_path / "config"
    plan = projects.plan_import(project)
    projects.import_project(
        project,
        expected_plan_root=plan["planRoot"],
        config_home=str(config_home),
    )

    result = projects.catalog(config_home=str(config_home))

    assert result["schema"] == "kungfu.projects.catalog/v1"
    assert [(row["name"], row["selected"]) for row in result["projects"]] == [
        ("ordinary-project", True)
    ]
    assert result["projects"][0]["workCount"] == 0
    assert result["projects"][0]["updatedAt"].endswith("Z")
    assert result["writeOccurred"] is False
    assert Path(result["libraryPath"]).is_file()


def test_catalog_projects_all_active_initialized_workspaces_without_scanning(tmp_path):
    config_home = tmp_path / "config"
    environment = {
        "HOME": str(tmp_path / "home"),
        "KF_CONFIG_HOME": str(config_home),
    }
    active = tmp_path / "active-project"
    disposable = tmp_path / "test-project"
    active.mkdir()
    disposable.mkdir()
    active_identity = inspect_workspace(str(active), env=environment)
    disposable_identity = inspect_workspace(str(disposable), env=environment)
    assert active_identity is not None
    assert disposable_identity is not None
    ensure_workspace_data_home(active_identity, "first Work")
    ensure_workspace_data_home(
        disposable_identity,
        "isolated test",
        catalog_lifecycle="test-only",
    )

    result = projects.catalog(config_home=str(config_home))

    assert [row["path"] for row in result["projects"]] == [str(active.resolve())]
    assert result["projects"][0]["source"] == "workspace-catalog"
    assert result["sources"] == {"workspace-catalog": 1}
    assert result["writeOccurred"] is False
    assert not Path(result["libraryPath"]).exists()


def test_remove_hides_catalog_project_without_touching_workspace(tmp_path):
    config_home = tmp_path / "config"
    environment = {
        "HOME": str(tmp_path / "home"),
        "KF_CONFIG_HOME": str(config_home),
    }
    project = tmp_path / "catalog-project"
    project.mkdir()
    source = project / "README.md"
    source.write_text("# Keep\n", encoding="utf-8")
    identity = inspect_workspace(str(project), env=environment)
    assert identity is not None
    ensure_workspace_data_home(identity, "first Work")
    listed = projects.catalog(config_home=str(config_home))["projects"][0]

    plan = projects.plan_remove(listed["id"], config_home=str(config_home))
    receipt = projects.remove(
        listed["id"],
        expected_plan_root=plan["planRoot"],
        config_home=str(config_home),
    )

    assert receipt["status"] == "removed"
    assert projects.catalog(config_home=str(config_home))["projects"] == []
    assert (project / ".kungfu").is_dir()
    assert source.read_text(encoding="utf-8") == "# Keep\n"


def test_opening_hidden_project_returns_it_to_library(tmp_path):
    config_home = tmp_path / "config"
    environment = {
        "HOME": str(tmp_path / "home"),
        "KF_CONFIG_HOME": str(config_home),
    }
    project = tmp_path / "catalog-project"
    project.mkdir()
    identity = inspect_workspace(str(project), env=environment)
    assert identity is not None
    ensure_workspace_data_home(identity, "first Work")
    listed = projects.catalog(config_home=str(config_home))["projects"][0]
    remove_plan = projects.plan_remove(listed["id"], config_home=str(config_home))
    projects.remove(
        listed["id"],
        expected_plan_root=remove_plan["planRoot"],
        config_home=str(config_home),
    )

    projects.select_project(project, config_home=str(config_home))

    reopened = projects.catalog(config_home=str(config_home))
    assert [row["path"] for row in reopened["projects"]] == [str(project.resolve())]
    assert reopened["projects"][0]["source"] == "library"


def test_remove_forgets_only_the_project_locator(tmp_path):
    project = tmp_path / "ordinary-project"
    project.mkdir()
    source = project / "README.md"
    source.write_text("# Keep me\n", encoding="utf-8")
    config_home = tmp_path / "config"
    import_plan = projects.plan_import(project)
    imported = projects.import_project(
        project,
        expected_plan_root=import_plan["planRoot"],
        config_home=str(config_home),
    )

    plan = projects.plan_remove(
        imported["project"]["id"],
        config_home=str(config_home),
    )
    receipt = projects.remove(
        imported["project"]["id"],
        expected_plan_root=plan["planRoot"],
        config_home=str(config_home),
    )

    assert receipt["schema"] == "kungfu.project.remove-receipt/v1"
    assert receipt["projectFilesChanged"] is False
    assert receipt["projectDirectoryDeleted"] is False
    assert projects.catalog(config_home=str(config_home))["projects"] == []
    assert project.is_dir()
    assert source.read_text(encoding="utf-8") == "# Keep me\n"


def test_remove_rejects_a_stale_plan_before_registry_write(tmp_path):
    project = tmp_path / "ordinary-project"
    project.mkdir()
    config_home = tmp_path / "config"
    import_plan = projects.plan_import(project)
    imported = projects.import_project(
        project,
        expected_plan_root=import_plan["planRoot"],
        config_home=str(config_home),
    )

    with pytest.raises(ValueError, match="stale"):
        projects.remove(
            imported["project"]["id"],
            expected_plan_root="sha256:" + ("0" * 64),
            config_home=str(config_home),
        )

    assert projects.catalog(config_home=str(config_home))["projects"]


def test_blank_project_creates_guidance_without_assignment_or_runtime(tmp_path):
    config_home = tmp_path / "config"
    plan = projects.plan_create(
        parent=tmp_path,
        template_id=BLANK_TEMPLATE_ID,
    )

    receipt = projects.create(
        destination=plan["destination"],
        expected_plan_root=plan["planRoot"],
        actor="test-user",
        template_id=BLANK_TEMPLATE_ID,
        config_home=str(config_home),
    )

    destination = Path(receipt["destination"])
    assert receipt["initialWork"] == {"state": "not-created"}
    assert (destination / "README.md").is_file()
    assert (destination / "AGENTS.md").is_file()
    assert (destination / "WORK.md").is_file()
    assert not (destination / ".kungfu").exists()


def test_template_catalog_contains_starter_and_blank_project():
    result = projects.templates()

    assert [row["id"] for row in result["templates"]] == [
        "kungfu.agent-work-starter",
        "kungfu.blank-project",
    ]
    assert result["templates"][1]["initialWorkTitle"] is None


def test_project_work_inventory_lists_multiple_captured_work_without_writing(tmp_path):
    project = tmp_path / "ordinary-project"
    project.mkdir()
    config_home = tmp_path / "config"
    plan = projects.plan_import(project)
    projects.import_project(
        project,
        expected_plan_root=plan["planRoot"],
        config_home=str(config_home),
    )
    target = resolve_workspace_target(
        "capture-only",
        str(project),
        cwd=str(project),
    )
    for index in range(2):
        request = {
            "schema": "kungfu.assignment-request/v1",
            "source": {
                "kind": "kungfu-product",
                "surface": "project-work-composer",
            },
            "retention": {
                "policy": "explicit-expiry-retain-bytes-v1",
                "expiresAt": None,
            },
            "workDefinition": {
                "assignment_id": f"assignment-example-{index}",
                "initiative_id": "project-work-example",
                "title": f"Example Work {index}",
                "objective": f"Produce result {index}",
                "acceptance_criteria": [f"Result {index} is reviewable"],
            },
        }
        orchestration.capture_assignment_request(request, target)

    inventory = projects.work_inventory(project)

    assert inventory["schema"] == "kungfu.project-work.inventory/v1"
    assert [work["assignmentId"] for work in inventory["works"]] == [
        "assignment-example-0",
        "assignment-example-1",
    ]
    assert inventory["activeWork"]["assignmentId"] == "assignment-example-1"
    assert inventory["writeOccurred"] is False
    assert inventory["inventoryRoot"].startswith("sha256:")
    summary = projects.catalog(config_home=str(config_home))["projects"][0]
    assert summary["workCount"] == 2
    assert summary["updatedAt"].endswith("Z")


def test_project_work_inventory_projects_live_executing_phase(tmp_path):
    project = tmp_path / "ordinary-project"
    project.mkdir()
    target = resolve_workspace_target(
        "capture-only",
        str(project),
        cwd=str(project),
    )
    request = {
        "schema": "kungfu.assignment-request/v1",
        "source": {
            "kind": "kungfu-product",
            "surface": "project-work-composer",
        },
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {
            "assignment_id": "assignment-example",
            "initiative_id": "project-work-example",
            "title": "Example Work",
            "objective": "Produce a reviewable result",
            "acceptance_criteria": ["The result is reviewable"],
        },
    }
    orchestration.capture_assignment_request(request, target)
    runtime = project / ".kungfu" / "runtime"
    _activate_work_control(runtime)
    work_control.create_initiative(
        str(runtime),
        initiative_id="project-work-example",
        title="Project Work Example",
        intent="Retain live Work state in the Project view",
        actor="local-user",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="project-work-example",
        assignment_id="assignment-example",
        title="Example Work",
        objective="Produce a reviewable result",
        actor="local-user",
    )
    work_control.claim_assignment_execution(
        str(runtime),
        initiative_id="project-work-example",
        assignment_id="assignment-example",
        owner="local-user",
        agent="native-agent",
        slot="interactive",
        lease_id="lease-example",
        lease_expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        authorized_by="local-user",
    )
    work_control.advance_assignment_phase(
        str(runtime),
        initiative_id="project-work-example",
        assignment_id="assignment-example",
        to_phase="executing",
        actor="native-agent",
        reason="begin retained Project Work",
    )

    inventory = projects.work_inventory(project)

    assert inventory["activeWork"]["phase"] == "executing"
    assert inventory["activeWork"]["settled"] is False
    assert inventory["writeOccurred"] is False
