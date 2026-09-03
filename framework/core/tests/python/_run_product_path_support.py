# SPDX-License-Identifier: Apache-2.0
"""Shared imports and fixtures for run product path contracts."""
# ruff: noqa: F401

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from click.testing import CliRunner

from kungfu import assignment_lifecycle
from kungfu import assignment_orchestration as orchestration
from kungfu.agent import first_value as onboarding
from kungfu.agent import managed_run
from kungfu.agent import native_launch
from kungfu.agent import run_agent
from kungfu.cli.commands import assignment, assignment_review, kfc, run
from kungfu.workspace import (
    ensure_workspace_data_home,
    inspect_workspace,
    resolve_workspace_target,
    select_workspace,
)


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
            "assignment_id": assignment_id,
            "initiative_id": "project-work",
            "title": assignment_id,
            "objective": f"Complete {assignment_id}",
            "acceptance_criteria": ["Result exists"],
        },
    }
    return orchestration.capture_assignment_request(request, target)
