# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F401,F811

from datetime import datetime, timedelta, timezone
import importlib
import inspect
import json
from pathlib import Path
import shutil
from types import SimpleNamespace

import click
import kungfu
import pytest
from click.testing import CliRunner

from kungfu import (
    assignment_orchestration,
    initiative_family,
    profile_composition,
    profile_sdk,
)
from kungfu.initiative_family import canonical as assignment_canonical
from kungfu.initiative_family import typed_v2 as initiative_family_v2
from kungfu import work_control
from kungfu.assignment_runtime import LocalRuntimeError
from kungfu.cli.commands import kfc
from kungfu.workspace import (
    ensure_workspace_data_home,
    inspect_workspace,
    resolve_workspace_target,
)
from kungfu.workspace_federation import (
    build_relation,
    build_work_ref,
    query_federation,
)


SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "work-control"
ASSIGNMENT_CLI = importlib.import_module("kungfu.cli.commands.assignment")


@pytest.fixture(autouse=True)
def _bind_work_control_profile(monkeypatch):
    monkeypatch.setenv("KF_EXTENSION_PATH", str(SOURCE.parent))


def _sha256(marker):
    return "sha256:" + marker * 64


def _activate(runtime):
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


def _initiative_admission(
    initiative_id="initiative-a",
    title="Initiative A",
    intent="Own the continuing workstream",
):
    body = {
        "schema": assignment_orchestration.INITIATIVE_ADMISSION_SCHEMA,
        "initiativeId": initiative_id,
        "title": title,
        "intent": intent,
        "source": {
            "schema": assignment_orchestration.INITIATIVE_SOURCE_SCHEMA,
            "authority": "kungfu",
            "kind": "initiative-admission",
            "sourceId": initiative_id,
            "versionRoot": "sha256:" + "c" * 64,
        },
    }
    return {
        **body,
        "admissionRoot": assignment_canonical.semantic_root(body),
    }


def _family_blueprint():
    return {
        "schema": initiative_family.FAMILY_BLUEPRINT_SCHEMA,
        "initiative": {
            "initiativeId": "initiative-family-a",
            "versionRoot": _sha256("1"),
        },
        "wave": {
            "waveId": "wave-0",
            "ordinal": 0,
            "gateAssignmentId": "wave-0-gate",
        },
        "children": [
            {
                "assignmentId": "child-a",
                "workDefinitionRoot": _sha256("2"),
                "deliveryClass": "native-proof-required",
                "responsibilitySlices": ["schema"],
                "dependsOn": [],
            },
            {
                "assignmentId": "child-b",
                "workDefinitionRoot": _sha256("3"),
                "deliveryClass": "non-native-fast",
                "responsibilitySlices": ["cli", "tests"],
                "dependsOn": ["child-a"],
            },
            {
                "assignmentId": "child-c",
                "workDefinitionRoot": _sha256("4"),
                "deliveryClass": "cross-platform",
                "responsibilitySlices": ["compatibility"],
                "dependsOn": ["child-b"],
            },
        ],
        "acceptanceIds": ["evidence-completeness", "parent-liveness"],
    }


def _merged_terminal(marker="a"):
    return {
        "state": "merged",
        "recordedAt": "2026-07-28T03:00:00Z",
        "sourceRoot": _sha256(marker),
        "pullRequestRoot": _sha256("b"),
        "mergeCommitRoot": _sha256("c"),
        "finalAncestryRoot": _sha256("d"),
        "proofRoot": _sha256("e"),
        "sloRoot": _sha256("f"),
    }


def _transition(state, terminal_updates=None, acceptance_updates=None):
    return {
        "schema": initiative_family.FAMILY_TRANSITION_SCHEMA,
        "expectedStateRoot": state["stateRoot"],
        "terminalUpdates": terminal_updates or [],
        "acceptanceUpdates": acceptance_updates or [],
    }


def _typed_ref(
    kind,
    marker,
    *,
    identity=None,
    fact_world="work-control-world",
    cut_root=None,
    status="current",
):
    return {
        "kind": kind,
        "identity": identity or f"{kind}-{marker}",
        "root": _sha256(marker),
        "factWorld": fact_world,
        "cutRoot": cut_root or _sha256("0"),
        "schema": f"example.{kind}/v1",
        "status": status,
    }


def _settlement(
    publication_state="published",
    *,
    fact_world="work-control-world",
    cut_root=None,
):
    cut_root = cut_root or _sha256("0")
    lag_started_at = (
        None if publication_state == "published" else "2026-07-28T03:00:01Z"
    )
    failure = {"present": False, "reference": None}
    if publication_state == "failed":
        failure = {
            "present": True,
            "reference": _typed_ref(
                "publication-failure",
                "3",
                fact_world=fact_world,
                cut_root=cut_root,
                status="visible",
            ),
        }
    return {
        "factWorld": fact_world,
        "factCutRoot": cut_root,
        "references": {
            "completionClaim": _typed_ref(
                "completion-claim",
                "b",
                fact_world=fact_world,
                cut_root=cut_root,
                status="claimed-complete",
            ),
            "assessment": _typed_ref(
                "assessment",
                "c",
                fact_world=fact_world,
                cut_root=cut_root,
                status="fit",
            ),
            "decision": _typed_ref(
                "decision",
                "d",
                fact_world=fact_world,
                cut_root=cut_root,
                status="accepted",
            ),
            "admissionReceipt": _typed_ref(
                "admission-receipt",
                "e",
                fact_world=fact_world,
                cut_root=cut_root,
                status="admitted",
            ),
            "episode": _typed_ref(
                "episode",
                "f",
                fact_world=fact_world,
                cut_root=cut_root,
                status="sealed",
            ),
            "projectCut": _typed_ref(
                "project-cut",
                "1",
                fact_world=fact_world,
                cut_root=cut_root,
                status="settled",
            ),
            "deliveryEvidence": _typed_ref(
                "delivery-evidence",
                "2",
                fact_world=fact_world,
                cut_root=cut_root,
                status="verified",
            ),
        },
        "publication": {
            "state": publication_state,
            "lagStartedAt": lag_started_at,
            "failure": failure,
        },
    }


def _seal_binding_manifest(manifest):
    manifest.pop("bindingRoot", None)
    manifest["bindingRoot"] = assignment_canonical.semantic_root(manifest)
    return manifest


def _family_binding_manifest(state, publication_state="published"):
    fact_world = "work-control-world"
    cut_root = _sha256("0")
    children = []
    for index, child in enumerate(state["children"], start=4):
        marker = f"{index:x}"[-1]
        settlement = {"present": False, "value": None}
        if (child["terminal"] or {}).get("state") == "merged":
            settlement = {
                "present": True,
                "value": _settlement(
                    publication_state,
                    fact_world=fact_world,
                    cut_root=cut_root,
                ),
            }
        work_definition = _typed_ref(
            "work-definition",
            marker,
            identity=f"{child['assignmentId']}:work-definition",
            fact_world=fact_world,
            cut_root=cut_root,
            status="accepted",
        )
        work_definition["root"] = child["workDefinitionRoot"]
        children.append(
            {
                "assignmentId": child["assignmentId"],
                "assignmentState": _typed_ref(
                    "assignment-state",
                    marker,
                    identity=child["assignmentId"],
                    fact_world=fact_world,
                    cut_root=cut_root,
                    status=("terminal" if child["terminal"] is not None else "active"),
                ),
                "workDefinition": work_definition,
                "pursuit": _typed_ref(
                    "pursuit",
                    "5",
                    fact_world=fact_world,
                    cut_root=cut_root,
                    status="active",
                ),
                "atlas": _typed_ref(
                    "atlas",
                    "6",
                    fact_world=fact_world,
                    cut_root=cut_root,
                    status="current",
                ),
                "executionWarrant": _typed_ref(
                    "execution-warrant",
                    "7",
                    fact_world=fact_world,
                    cut_root=cut_root,
                    status="active",
                ),
                "settlement": settlement,
            }
        )
    manifest = {
        "schema": initiative_family_v2.FAMILY_BINDING_V2_SCHEMA,
        "v1StateRoot": state["stateRoot"],
        "factWorld": fact_world,
        "factCutRoot": cut_root,
        "initiative": {
            "initiativeId": state["initiative"]["initiativeId"],
            "pursuit": _typed_ref(
                "pursuit",
                "1",
                fact_world=fact_world,
                cut_root=cut_root,
                status="active",
            ),
            "atlas": _typed_ref(
                "atlas",
                "2",
                fact_world=fact_world,
                cut_root=cut_root,
                status="current",
            ),
            "acceptancePolicy": _typed_ref(
                "acceptance-policy",
                "3",
                fact_world=fact_world,
                cut_root=cut_root,
                status="current",
            ),
        },
        "children": children,
    }
    return _seal_binding_manifest(manifest)


__all__ = [name for name in globals() if not name.startswith("__")]
