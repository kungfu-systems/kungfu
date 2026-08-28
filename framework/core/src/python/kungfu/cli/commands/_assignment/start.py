# SPDX-License-Identifier: Apache-2.0

"""Starter Assignment CLI commands."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import click

_facade = importlib.import_module("kungfu.cli.commands.assignment")
assignment = _facade.assignment
assignment_context = _facade.assignment_context
surface = _facade.surface
assignment_start = _facade.assignment_start
assignment_evidence = _facade.assignment_evidence


@assignment.command(
    name="start-plan",
    help="preview admission, lease, kickoff, and one bound Agent run",
)
@click.argument(
    "request_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True)
@click.option("--initiative-id", default="")
@click.option("--assignment-id", default="")
@click.option("--agent", "profile_id", required=True)
@click.option("--actor", default="local-user", show_default=True)
@click.option(
    "--allow-foreign-binding",
    is_flag=True,
    help="development/testing override; retained as degraded provenance",
)
@assignment_context
def start_plan(
    ctx,
    request_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    profile_id,
    actor,
    allow_foreign_binding,
):
    _facade._emit(
        _facade._run(
            lambda: _facade._work_start_plan(
                config_home=ctx.config_home,
                runtime_home=ctx.home,
                request_file=request_file,
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
                profile_id=profile_id,
                actor=actor,
                allow_foreign_binding=allow_foreign_binding,
            )
        )
    )


@assignment.command(
    name="start",
    help="admit, lease, kickoff, and launch one Agent from an exact plan",
)
@click.argument(
    "request_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True)
@click.option("--initiative-id", default="")
@click.option("--assignment-id", default="")
@click.option("--agent", "profile_id", required=True)
@click.option("--actor", default="local-user", show_default=True)
@click.option("--expected-plan-root", required=True)
@click.option("--execute", is_flag=True)
@click.option("--events-json", is_flag=True)
@click.option(
    "--allow-foreign-binding",
    is_flag=True,
    help="development/testing override; retained as degraded provenance",
)
@assignment_context
@surface(id="kungfu.work.start")
def start_work(
    ctx,
    request_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    profile_id,
    actor,
    expected_plan_root,
    execute,
    events_json,
    allow_foreign_binding,
    emit_result=True,
    on_event=None,
):
    event_index = 0

    def event(stage, status, text, root=None, activity=None):
        nonlocal event_index
        event_index += 1
        payload = {
            "schema": "kungfu.work-start.event/v1",
            "index": event_index,
            "stage": stage,
            "status": status,
            "text": text,
            "root": root,
        }
        if activity is not None:
            payload["activity"] = dict(activity)
        if on_event is not None:
            on_event(payload)
        if events_json:
            click.echo(json.dumps(payload, sort_keys=True))
            click.get_text_stream("stdout").flush()

    services = assignment_start.StartServices(
        plan=_facade._work_start_plan,
        receipt=_facade._work_start_receipt,
        status=_facade._status,
        admit=_facade._admit_captured_assignment,
        admission_summary=_facade._admission_summary,
        profile_action=_facade._profile_action,
        claim_summary=_facade._claim_summary,
        advance_bound=_facade._advance,
        kickoff_summary=_facade._kickoff_summary,
        project_prompt=_facade._project_work_prompt,
        agent_report_summary=_facade._agent_report_summary,
    )
    request = assignment_start.StartRequest(
        config_home=ctx.config_home,
        runtime_home=ctx.home,
        request_file=request_file,
        workspace_root=workspace_root,
        home=home,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        profile_id=profile_id,
        actor=actor,
        expected_plan_root=expected_plan_root,
        execute=execute,
        allow_foreign_binding=allow_foreign_binding,
    )
    result = assignment_start.execute(request, services, event)
    if emit_result:
        if events_json:
            click.echo(json.dumps(result, sort_keys=True))
        else:
            _facade._emit(result)
    return result


@assignment.command(
    name="resume-prepare",
    help="reconcile the exact Work Control Profile before product resume",
    hidden=True,
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True)
@click.option("--actor", default="kungfu-product", show_default=True)
@click.option("--execute", is_flag=True)
@assignment_context
def resume_prepare(
    ctx,
    workspace_root,
    home,
    actor,
    execute,
):
    del ctx

    def operation():
        if not execute:
            raise ValueError("resume-prepare requires explicit --execute")
        identity, runtime_dir, _ = _facade._runtime(
            workspace_root,
            home,
            "read-only",
        )
        return {
            **_facade._prepare_resume_profile(runtime_dir, actor),
            "workspace": identity.as_dict(),
        }

    _facade._emit(_facade._run(operation))


@assignment.command(
    name="start-resume",
    help="resume the latest retained Starter Agent run without writing",
)
@click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
@click.option("--home", is_flag=True)
@click.option("--initiative-id", required=True)
@click.option("--assignment-id", required=True)
@assignment_context
@surface(id="kungfu.work.start.resume")
def start_resume(
    ctx,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
):
    del ctx
    _facade._emit(
        _facade._run(
            lambda: assignment_evidence.resume_starter_work(
                workspace_root=workspace_root,
                home=home,
                initiative_id=initiative_id,
                assignment_id=assignment_id,
                services=_facade._EVIDENCE_SERVICES,
            )
        )
    )


for _symbol in ("start_plan", "start_work", "resume_prepare", "start_resume"):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.assignment"
    globals()[_symbol].callback.__qualname__ = _symbol
