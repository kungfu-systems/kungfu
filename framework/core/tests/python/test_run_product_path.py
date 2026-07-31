# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

import pytest

from kungfu import assignment_orchestration as orchestration
from kungfu.cli.commands import run
from kungfu.workspace import resolve_workspace_target


def _capture(project: Path, assignment_id: str):
    target = resolve_workspace_target("capture-only", str(project), cwd=str(project))
    request = {
        "schema": "kungfu.assignment-request/v1",
        "source": {"kind": "test"},
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {
            "goal_id": assignment_id,
            "mission_id": "project-work",
            "title": assignment_id,
            "objective": f"Complete {assignment_id}",
            "acceptance_criteria": ["Result exists"],
        },
    }
    return orchestration.capture_assignment_request(request, target)


def test_next_work_selects_the_only_captured_assignment(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")

    selected = run._choose_work(str(project))

    assert selected["assignmentId"] == "first"
    assert selected["phase"] == "captured"


def test_next_work_requires_explicit_selection_when_ambiguous(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    _capture(project, "second")

    with pytest.raises(ValueError, match="multiple Work items"):
        run._choose_work(str(project))

    assert (
        run._choose_work(str(project), work_selector="second")["assignmentId"]
        == "second"
    )


def test_task_capture_creates_a_bounded_assignment_not_runtime(tmp_path):
    project = tmp_path / "project"
    project.mkdir()

    selected = run._capture_task(str(project), "Write a concise launch note")

    assert selected["phase"] == "captured"
    assert selected["initiativeId"] == "project-work"
    assert Path(selected["requestPath"]).is_file()
    assert not (project / ".kungfu" / "runtime").exists()
