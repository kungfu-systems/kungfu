# SPDX-License-Identifier: Apache-2.0

"""Installed CLI commands for domain-neutral Work semantic facts."""

from __future__ import annotations

import json
from pathlib import Path

import click

from kungfu import assignment_runtime as runtime_api
from kungfu.cli.commands.assignment import (
    _emit,
    _ensure_profile,
    _run,
    _runtime,
    _status,
    assignment,
    assignment_context,
)
from kungfu.cli.surface_contract import surface


_WORK_COMMAND_TYPES = {
    "work-input-snapshot": "work.input.snapshot",
    "work-managed-run": "work.run.record",
    "work-effect-authorize": "work.effect.authorize",
    "work-effect-attempt": "work.effect.attempt",
    "work-effect-outcome": "work.effect.outcome",
}


def _runtime_authority(
    snapshot: dict, initiative_id: str, assignment_id: str
) -> tuple[dict, dict]:
    matches = [
        row
        for row in snapshot.get("assignments") or []
        if row.get("initiativeId") == initiative_id
        and row.get("assignmentId") == assignment_id
    ]
    if len(matches) != 1:
        raise runtime_api.LocalRuntimeError(
            "ambiguous-identity",
            "Runtime Work semantic target does not resolve exactly once",
        )
    return (
        runtime_api._copy_json(matches[0].get("attempt")),
        runtime_api._copy_json(matches[0].get("lease")),
    )


def _authorize_work_semantics(
    runtime_dir: Path, intent_id: str, values: dict, authorized_by: str
) -> dict:
    application = runtime_api.LocalAssignmentRuntimeApplication(
        runtime_dir, client_id="kungfu.work.cli", kind="cli"
    )
    arguments = runtime_api._normalize_action_values(values)
    initiative_id = str(arguments.get("initiativeId") or "")
    assignment_id = str(arguments.get("assignmentId") or "")
    command_type = _WORK_COMMAND_TYPES[intent_id]
    with application._runtime() as runtime:
        client = runtime_api.EmbeddedAssignmentRuntimeClient(
            runtime, client_id=application.client_id, kind=application.kind
        )
        snapshot_response = client.snapshot()
        revision = dict(snapshot_response.get("revision") or {})
        attempt, lease = _runtime_authority(
            runtime_api._runtime_result(snapshot_response),
            initiative_id,
            assignment_id,
        )
        basis = {
            "clientId": application.client_id,
            "intentId": intent_id,
            "authorizedBy": authorized_by,
            "expectedRevision": revision,
            "arguments": arguments,
        }
        command_root = runtime_api._root(basis)
        result = runtime_api._runtime_result(
            client.submit(
                {
                    "schema": runtime_api.COMMAND_SCHEMA,
                    "commandId": f"command:{application.kind}:{command_root[7:39]}",
                    "type": command_type,
                    "target": {
                        "initiativeId": initiative_id,
                        "assignmentId": assignment_id,
                    },
                    "expectedRevision": revision,
                    "idempotencyKey": f"idempotency:{command_root[7:]}",
                    "attempt": attempt,
                    "lease": lease,
                    "warrant": None,
                    "arguments": arguments,
                }
            )
        )
    profile_result = dict(
        dict(result.get("authorityReceipt") or {}).get("result") or {}
    )
    if "coreReceipt" not in profile_result:
        raise runtime_api.LocalRuntimeError(
            "backend-unavailable",
            "Assignment Runtime omitted the native Work semantic receipt",
        )
    return runtime_api._copy_json(profile_result["coreReceipt"])


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
            _ensure_profile(runtime_dir, authorized_by)
            receipt = _authorize_work_semantics(
                runtime_dir, intent_id, values, authorized_by
            )
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
