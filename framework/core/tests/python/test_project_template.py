# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kungfu import assignment_orchestration, project_template
from kungfu.workspace import resolve_workspace_target


def _template(tmp_path: Path) -> Path:
    path = tmp_path / "template.json"
    path.write_text(
        json.dumps(
            {
                "schema": "kungfu.project-template/v1",
                "id": "example.starter",
                "version": "1",
                "title": "Example Starter",
                "description": "A bounded starter.",
                "suggestedDirectoryName": "example-starter",
                "files": [
                    {"path": "README.md", "content": "# Starter\n"},
                    {
                        "path": "deliverables/result.md",
                        "content": "# Result\n\nTBD\n",
                    },
                ],
                "initialWork": {
                    "initiativeId": "starter",
                    "assignmentId": "write-result",
                    "title": "Write the result",
                    "objective": "Complete deliverables/result.md.",
                    "acceptanceChecks": ["The result is complete"],
                },
                "openAction": {
                    "kind": "select-project-workspace",
                    "label": "Open Starter Project",
                },
                "nonClaims": ["No Git mutation."],
            }
        ),
        encoding="utf-8",
    )
    return path


def test_plan_is_read_only_and_binds_every_file(tmp_path):
    destination = tmp_path / "projects" / "example-starter"
    destination.parent.mkdir()

    plan = project_template.plan_project_template(
        "example.starter",
        destination,
        template_path=_template(tmp_path),
    )

    assert plan["schema"] == "kungfu.project-template.plan/v1"
    assert plan["templateId"] == "example.starter"
    assert plan["destination"] == str(destination.resolve())
    assert plan["confirmationRequired"] is True
    assert plan["writeOccurred"] is False
    assert plan["planRoot"].startswith("sha256:")
    assert [row["path"] for row in plan["files"]] == [
        "README.md",
        "deliverables/result.md",
    ]
    assert plan["initialWork"]["state"] == "capture-pending"
    assert not destination.exists()


def test_default_destination_uses_the_kungfu_documents_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(project_template.Path, "home", lambda: tmp_path)
    payload = json.loads(_template(tmp_path).read_text(encoding="utf-8"))
    first = tmp_path / "Documents" / "Kungfu" / "example-starter"

    assert project_template.default_project_destination(payload) == first

    first.mkdir(parents=True)
    assert project_template.default_project_destination(payload) == (
        tmp_path / "Documents" / "Kungfu" / "example-starter-2"
    )


def test_bundled_starter_includes_agent_collaboration_rules():
    payload, _, _ = project_template.load_project_template(
        project_template.DEFAULT_TEMPLATE_ID
    )
    files = {row["path"]: row["content"] for row in payload["files"]}

    assert "AGENTS.md" in files
    assert "`WORK.md`" in files["AGENTS.md"]
    assert "`deliverables/launch-brief.md`" in files["AGENTS.md"]
    assert "Do not edit `.kungfu/` directly" in files["AGENTS.md"]
    assert "Do not treat a process exit" in files["AGENTS.md"]


def test_create_writes_exact_files_and_captures_work_without_git(tmp_path):
    destination = tmp_path / "projects" / "example-starter"
    destination.parent.mkdir()
    template_path = _template(tmp_path)
    plan = project_template.plan_project_template(
        "example.starter",
        destination,
        template_path=template_path,
    )

    receipt = project_template.create_project_template(
        "example.starter",
        destination,
        expected_plan_root=plan["planRoot"],
        actor="local-user",
        template_path=template_path,
    )

    assert receipt["schema"] == "kungfu.project-template.creation-receipt/v1"
    assert receipt["status"] == "created"
    assert receipt["writeOccurred"] is True
    assert receipt["verification"]["ok"] is True
    assert (destination / "README.md").read_text() == "# Starter\n"
    assert (destination / "deliverables" / "result.md").exists()
    assert receipt["initialWork"]["state"] == "captured-pending-admission"
    assert Path(receipt["initialWork"]["requestPath"]).exists()
    assert not (destination / ".kungfu" / "runtime").exists()
    assert not (destination / ".git").exists()

    resumed = project_template.resume_project_template(
        destination,
        template_id="example.starter",
        template_path=template_path,
    )
    assert resumed["status"] == "resumed"
    assert resumed["writeOccurred"] is False
    assert (
        resumed["initialWork"]["requestRoot"] == receipt["initialWork"]["requestRoot"]
    )
    assert [work["assignmentId"] for work in resumed["works"]] == ["write-result"]
    assert resumed["works"][0]["title"] == "Write the result"
    assert resumed["verification"]["ok"] is True


def test_resume_allows_project_changes_but_rejects_missing_retained_files(tmp_path):
    destination = tmp_path / "projects" / "example-starter"
    destination.parent.mkdir()
    template_path = _template(tmp_path)
    plan = project_template.plan_project_template(
        "example.starter",
        destination,
        template_path=template_path,
    )
    project_template.create_project_template(
        "example.starter",
        destination,
        expected_plan_root=plan["planRoot"],
        actor="local-user",
        template_path=template_path,
    )

    (destination / "deliverables" / "result.md").write_text(
        "# Completed\n", encoding="utf-8"
    )
    assert project_template.resume_project_template(
        destination,
        template_id="example.starter",
        template_path=template_path,
    )["verification"]["ok"]

    (destination / "README.md").write_text("# Changed\n", encoding="utf-8")
    resumed = project_template.resume_project_template(
        destination,
        template_id="example.starter",
        template_path=template_path,
    )
    assert resumed["verification"]["ok"]
    readme_check = next(
        row for row in resumed["verification"]["checks"] if row["path"] == "README.md"
    )
    assert readme_check["matchesTemplate"] is False

    (destination / "README.md").unlink()
    with pytest.raises(
        project_template.ProjectTemplateError,
        match="missing one or more retained project files",
    ):
        project_template.resume_project_template(
            destination,
            template_id="example.starter",
            template_path=template_path,
        )


def test_resume_selects_latest_composed_project_work(tmp_path):
    destination = tmp_path / "projects" / "example-starter"
    destination.parent.mkdir()
    template_path = _template(tmp_path)
    plan = project_template.plan_project_template(
        "example.starter",
        destination,
        template_path=template_path,
    )
    project_template.create_project_template(
        "example.starter",
        destination,
        expected_plan_root=plan["planRoot"],
        actor="local-user",
        template_path=template_path,
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
            "assignment_id": "assignment-project-work-example",
            "initiative_id": "project-work-example",
            "title": "分析商业目标",
            "objective": "分析商业目标并给出行动计划",
            "acceptance_criteria": ["给出一份可行计划"],
        },
    }
    target = resolve_workspace_target(
        "capture-only",
        str(destination),
        cwd=str(destination),
    )
    captured = assignment_orchestration.capture_assignment_request(request, target)

    resumed = project_template.resume_project_template(
        destination,
        template_id="example.starter",
        template_path=template_path,
    )

    assert resumed["activeWork"] == {
        "state": "captured-pending-admission",
        "initiativeId": "project-work-example",
        "assignmentId": "assignment-project-work-example",
        "title": "分析商业目标",
        "objective": "分析商业目标并给出行动计划",
        "acceptanceChecks": ["给出一份可行计划"],
        "requestRoot": captured["requestRoot"],
        "receiptRoot": captured["receiptRoot"],
        "requestPath": captured["requestPath"],
    }
    assert [work["assignmentId"] for work in resumed["works"]] == [
        "write-result",
        "assignment-project-work-example",
    ]
    assert resumed["works"][1] == resumed["activeWork"]


def test_create_refuses_existing_destination_without_touching_contents(tmp_path):
    destination = tmp_path / "projects" / "example-starter"
    destination.parent.mkdir()
    template_path = _template(tmp_path)
    plan = project_template.plan_project_template(
        "example.starter",
        destination,
        template_path=template_path,
    )
    destination.mkdir()
    (destination / "keep.txt").write_text("mine\n", encoding="utf-8")

    with pytest.raises(project_template.ProjectTemplateError, match="exists"):
        project_template.create_project_template(
            "example.starter",
            destination,
            expected_plan_root=plan["planRoot"],
            actor="local-user",
            template_path=template_path,
        )

    assert (destination / "keep.txt").read_text() == "mine\n"


def test_create_refuses_a_stale_plan_before_writing(tmp_path):
    destination = tmp_path / "projects" / "example-starter"
    destination.parent.mkdir()
    template_path = _template(tmp_path)

    with pytest.raises(project_template.ProjectTemplateError, match="stale"):
        project_template.create_project_template(
            "example.starter",
            destination,
            expected_plan_root="sha256:" + ("0" * 64),
            actor="local-user",
            template_path=template_path,
        )

    assert not destination.exists()


@pytest.mark.parametrize(
    "unsafe_path",
    [
        "../escape.md",
        "/absolute.md",
        "nested/../../escape.md",
        ".kungfu/fake.json",
        "nested/.git/config",
    ],
)
def test_template_rejects_escaping_or_authority_paths(tmp_path, unsafe_path):
    template_path = _template(tmp_path)
    payload = json.loads(template_path.read_text(encoding="utf-8"))
    payload["files"][0]["path"] = unsafe_path
    template_path.write_text(json.dumps(payload), encoding="utf-8")
    destination = tmp_path / "projects" / "example-starter"
    destination.parent.mkdir()

    with pytest.raises(project_template.ProjectTemplateError):
        project_template.plan_project_template(
            "example.starter",
            destination,
            template_path=template_path,
        )
