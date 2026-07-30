# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kungfu import agent_work_lab as project_template


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
