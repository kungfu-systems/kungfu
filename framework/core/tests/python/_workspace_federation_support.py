# SPDX-License-Identifier: Apache-2.0
"""Shared imports, fixtures, and builders for workspace federation contracts."""
# ruff: noqa: F401

import os
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import kungfu
import pytest

from kungfu import assignment_graph
from kungfu import workspace_federation as federation
from kungfu import workspace_federation_projection as federation_projection
from kungfu.workspace import (
    WorkspaceIdentity,
    ensure_workspace_data_home,
    inspect_workspace,
    maintain_workspace_catalog,
    observe_workspace_locator,
    select_workspace,
)
from kungfu.workspace_federation import (
    RELATION_TYPES,
    WorkRef,
    _retained_state_dominates,
    assignment_lifecycle_projection,
    build_dogfood_gate_receipt,
    build_relation,
    build_work_ref,
    qualify_assignment_graph,
    query_federation,
    traverse_assignment_graph,
    portfolio_state,
    verify_federation_query,
    verify_dogfood_gate_receipt,
)
from kungfu.workspace_federation_observer import _runtime_signal
import kungfu.cli.commands.workspace as workspace_command_module
from kungfu.cli.commands.workspace import (
    _human_initiative_group_line,
    _human_work_line,
)


ROOT_A = "sha256:" + "a" * 64
ROOT_B = "sha256:" + "b" * 64
ROOT_C = "sha256:" + "c" * 64
ROOT_D = "sha256:" + "d" * 64
CONTRACT = (
    Path(__file__).resolve().parents[4]
    / "framework"
    / "workspace-federation"
    / "workspace-federation.contract.json"
)
WORK_CONTROL_SOURCE = (
    Path(__file__).resolve().parents[4] / "extensions" / "work-control"
)


@pytest.fixture(autouse=True)
def _bind_work_control_profile(monkeypatch):
    monkeypatch.setenv("KF_EXTENSION_PATH", str(WORK_CONTROL_SOURCE.parent))


def _qualified_project(tmp_path, name):
    root = tmp_path / name
    root.mkdir()
    candidate = inspect_workspace(str(root), env={"HOME": str(tmp_path)})
    assert candidate is not None
    ensure_workspace_data_home(candidate, "create-assignment")
    identity = inspect_workspace(str(root), env={"HOME": str(tmp_path)})
    assert identity is not None
    return identity


def _ref(identity, subject, version=ROOT_A, cut=ROOT_B):
    return build_work_ref(
        identity,
        object_kind="assignment",
        subject=subject,
        version_root=version,
        cut_root=cut,
    )


def _component_fixture(identity, assignments):
    return {
        "availability": "available",
        "stale": False,
        "cut_root": ROOT_D,
        "query_proof_root": ROOT_D,
        "initiatives": [],
        "assignments": assignments.get(identity.identity_root, []),
        "relations": [],
        "problems": [],
        "profile_root": ROOT_A,
        "reader_runtime": {"runtime_root": ROOT_B},
        "workspace_runtime": {"runtime_root": ROOT_C},
        "compatibility": {
            "state": "compatible",
            "protocol": "kungfu.fact-material-read/v1",
        },
    }


def _retained_state(marker, assignment="kungfu:assignment-a"):
    return {
        "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
        "assignment_subject": assignment,
        "workspace_identity_root": ROOT_A,
        "state_root": "sha256:" + marker * 64,
        "query_proof_root": ROOT_B,
        "phase": "continuation-decided",
        "settled": True,
        "storage_kind": "git-common-dir",
    }


def _outcome_binding(state, marker, complete):
    return {
        "schema": "kungfu.assignment-orchestration.work-design-outcome-binding/v1",
        "assignment_subject": state["assignment_subject"],
        "workspace_identity_root": state["workspace_identity_root"],
        "settled_state_root": state["state_root"],
        "state_query_proof_root": state["query_proof_root"],
        "opening_estimate_root": None,
        "published_at": "2026-08-01T01:00:00Z",
        "outcome": {
            "outcomeRoot": "sha256:" + marker * 64,
            "coverage": {
                "complete": complete,
                "coverageRoot": ROOT_C,
            },
            "cohort": {"cohortRoot": ROOT_D},
            "evidence": {"settledStateRoot": state["state_root"]},
        },
        "binding_root": "sha256:" + marker * 64,
    }
