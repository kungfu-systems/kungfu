# SPDX-License-Identifier: Apache-2.0

"""Installed CLI commands for domain-neutral Work semantic facts."""

from __future__ import annotations

import json
from pathlib import Path

import click

from kungfu import profile_sdk
from kungfu.assignment_runtime import profile_source
from kungfu.cli.commands.assignment import (
    _emit,
    _ensure_profile,
    _profile_action,
    _run,
    _runtime,
    _status,
    assignment,
    assignment_context,
)
from kungfu.cli.surface_contract import surface
from kungfu.storage import service as storage_service


def _ensure_work_semantics_profile(runtime_dir: Path, authorized_by: str) -> list:
    """Activate Work Control and accept only its exact retained-history boundary."""

    try:
        return _ensure_profile(runtime_dir, authorized_by)
    except profile_sdk.ProfileSdkError as error:
        source = profile_source()
        domain = profile_sdk.load_member_python_package(
            source, "work-control-actions", "domain"
        )
        plan = domain.work_control.contract_materialization_plan(
            str(runtime_dir), str(source)
        )
        inspection = profile_sdk.validate_source(source, runtime_dir)["inspection"]
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=inspection["profile"]["id"]
        )
        exact_profile = (
            state.get("activated")
            and state.get("qualified")
            and state.get("profile_suite_root") == inspection["profile_suite_root"]
        )
        if (
            plan.get("status") != "retained-history-compatible"
            or plan.get("operations")
            or not exact_profile
        ):
            raise error
        return []


def _json_action(name: str, intent_id: str):
    @assignment.command(
        name=name, help=f"run the native {name} intent from a JSON input"
    )
    @click.argument(
        "input_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
    )
    @click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
    @click.option("--home", is_flag=True)
    @click.option("--authorized-by", required=True)
    @assignment_context
    @surface(id=f"kungfu.work.{name.replace('-', '.')}")
    def command(ctx, input_file, workspace_root, home, authorized_by):
        def work_semantics_operation():
            values = json.loads(input_file.read_text(encoding="utf-8"))
            _, runtime_dir, _ = _runtime(workspace_root, home)
            _ensure_work_semantics_profile(runtime_dir, authorized_by)
            receipt = _profile_action(runtime_dir, intent_id, values, authorized_by)
            initiative_id = str(
                values.get("initiativeId") or values.get("missionId") or ""
            )
            assignment_id = str(
                values.get("assignmentId") or values.get("goalId") or ""
            )
            current = _status(runtime_dir, initiative_id, assignment_id)
            return {
                **receipt,
                "status": current,
                "next_actions": current["next_actions"],
            }

        _emit(_run(work_semantics_operation))

    return command


record_input = _json_action("record-input", "work-input-snapshot")
record_run = _json_action("record-run", "work-managed-run")
authorize_effect = _json_action("authorize-effect", "work-effect-authorize")
record_effect_attempt = _json_action("record-effect-attempt", "work-effect-attempt")
record_effect_outcome = _json_action("record-effect-outcome", "work-effect-outcome")


__all__ = [
    "authorize_effect",
    "record_effect_attempt",
    "record_effect_outcome",
    "record_input",
    "record_run",
]
