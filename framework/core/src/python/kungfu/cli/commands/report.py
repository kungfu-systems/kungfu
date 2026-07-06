#  SPDX-License-Identifier: Apache-2.0

import json
import os
import sys

import click

from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.rewind import reporting

report_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=3,
    help="report external agent work facts into Kungfu without managed-run",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def report(ctx):
    pass


def _json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _require_work(runtime_dir, work_id):
    if not work_id:
        return
    from kungfu.work import store

    if work_id not in store.load(runtime_dir):
        click.echo(f"[report] unknown work item: {work_id}", err=True)
        sys.exit(1)


def _link_work(runtime_dir, work_id, run_id):
    if not work_id:
        return
    from kungfu.work.store import WorkStore

    WorkStore(runtime_dir).link_run(work_id, run_id)


@report.group(help="report a non-managed run lifecycle")
@report_command_context
def run(ctx):
    pass


@run.command(name="begin", help="begin a reported run and optionally link work")
@click.option("--work", "work_id", type=str, default=None, help="work item id")
@click.option("--provider", required=True, type=str, help="provider label")
@click.option("--cwd", type=str, default=None, help="working directory of the run")
@click.option("--run-id", type=str, default=None, help="stable run id")
@click.option("--command", type=str, default=None, help="reported command label")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@report_command_context
def begin(ctx, work_id, provider, cwd, run_id, command, as_json):
    _require_work(ctx.runtime_dir, work_id)
    actual_run_id = run_id or reporting.new_run_id()
    manifest = reporting.begin_run(
        ctx.runtime_dir,
        run_id=actual_run_id,
        provider=provider,
        cwd=cwd or os.getcwd(),
        work_id=work_id,
        command=command,
    )
    _link_work(ctx.runtime_dir, work_id, actual_run_id)
    payload = {
        "schema": "kungfu.report-run-begin/v1",
        "run_id": actual_run_id,
        "work_id": work_id,
        "provider": provider,
        "capture_mode": "reported",
        "manifest": manifest,
    }
    if as_json:
        _json(payload)
    else:
        click.echo(f"[report] run {actual_run_id} began ({provider})")


@run.command(name="end", help="end a reported run")
@click.option("--run", "run_id", required=True, type=str, help="run id")
@click.option(
    "--status",
    required=True,
    type=click.Choice(["succeeded", "failed", "blocked", "interrupted"]),
    help="terminal run status",
)
@click.option("--exit-code", type=int, default=0, help="reported exit code")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@report_command_context
def end(ctx, run_id, status, exit_code, as_json):
    manifest = reporting.end_run(
        ctx.runtime_dir, run_id=run_id, status=status, exit_code=exit_code
    )
    payload = {
        "schema": "kungfu.report-run-end/v1",
        "run_id": run_id,
        "status": status,
        "exit_code": exit_code,
        "manifest": manifest,
    }
    if as_json:
        _json(payload)
    else:
        click.echo(f"[report] run {run_id} ended: {status}")


@report.command(help="report a cost or usage snapshot for a run")
@click.option("--run", "run_id", required=True, type=str, help="run id")
@click.option("--work", "work_id", type=str, default=None, help="work item id")
@click.option("--provider", required=True, type=str, help="provider label")
@click.option("--surface", default="reported", help="provider surface")
@click.option("--model", default=None, help="model name")
@click.option("--session-id", default=None, help="provider session id")
@click.option(
    "--source",
    default="manual_report",
    help="source label for this reported cost fact",
)
@click.option(
    "--attribution",
    type=click.Choice(sorted(reporting.ATTRIBUTION_BY_NAME)),
    default="manual_estimate",
    help="cost attribution level",
)
@click.option("--input-tokens", type=int, default=0)
@click.option("--output-tokens", type=int, default=0)
@click.option("--cached-input-tokens", type=int, default=0)
@click.option("--cache-creation-input-tokens", type=int, default=0)
@click.option("--reasoning-tokens", type=int, default=0)
@click.option("--usd", "cost_usd", type=float, default=None)
@click.option("--raw-ref", type=str, default=None)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@report_command_context
def cost(
    ctx,
    run_id,
    work_id,
    provider,
    surface,
    model,
    session_id,
    source,
    attribution,
    input_tokens,
    output_tokens,
    cached_input_tokens,
    cache_creation_input_tokens,
    reasoning_tokens,
    cost_usd,
    raw_ref,
    as_json,
):
    _require_work(ctx.runtime_dir, work_id)
    manifest = reporting.report_cost(
        ctx.runtime_dir,
        run_id=run_id,
        work_id=work_id,
        provider=provider,
        surface=surface,
        model=model,
        session_id=session_id,
        source=source,
        attribution=attribution,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_input_tokens=cached_input_tokens,
        cache_creation_input_tokens=cache_creation_input_tokens,
        reasoning_tokens=reasoning_tokens,
        cost_usd=cost_usd,
        raw_ref=raw_ref,
    )
    payload = {
        "schema": "kungfu.report-cost/v1",
        "run_id": run_id,
        "work_id": work_id,
        "provider": provider,
        "attribution": attribution,
        "cost_usd_known": cost_usd is not None,
        "manifest": manifest,
    }
    if as_json:
        _json(payload)
    else:
        click.echo(f"[report] cost recorded for run {run_id} ({attribution})")


@report.command(help="report an approval decision fact for a run")
@click.option("--run", "run_id", required=True, type=str, help="run id")
@click.option(
    "--decision",
    required=True,
    type=click.Choice(sorted(reporting.DECISION_BY_NAME)),
    help="decision label",
)
@click.option("--request-id", default=None, help="provider request id")
@click.option("--surface", default="reported", help="decision surface")
@click.option("--decided-by", default=None, help="who made the decision")
@click.option("--detail", default=None, help="decision detail")
@click.option("--reason", default=None, help="decision reason")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@report_command_context
def approval(
    ctx,
    run_id,
    decision,
    request_id,
    surface,
    decided_by,
    detail,
    reason,
    as_json,
):
    manifest = reporting.report_approval(
        ctx.runtime_dir,
        run_id=run_id,
        decision=decision,
        request_id=request_id,
        surface=surface,
        decided_by=decided_by,
        detail=detail,
        reason=reason,
    )
    payload = {
        "schema": "kungfu.report-approval/v1",
        "run_id": run_id,
        "decision": decision,
        "manifest": manifest,
    }
    if as_json:
        _json(payload)
    else:
        click.echo(f"[report] approval recorded for run {run_id}: {decision}")


@report.command(help="append a reported run event note")
@click.option("--run", "run_id", required=True, type=str, help="run id")
@click.option("--type", "event_type", required=True, type=str, help="event type")
@click.option("--message", required=True, type=str, help="event message")
@click.option(
    "--severity",
    type=click.Choice(["info", "warning", "error"]),
    default="info",
    help="event severity",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@report_command_context
def event(ctx, run_id, event_type, message, severity, as_json):
    manifest = reporting.report_event(
        ctx.runtime_dir,
        run_id=run_id,
        event_type=event_type,
        message=message,
        severity=severity,
    )
    payload = {
        "schema": "kungfu.report-event/v1",
        "run_id": run_id,
        "type": event_type,
        "severity": severity,
        "manifest": manifest,
    }
    if as_json:
        _json(payload)
    else:
        click.echo(f"[report] event recorded for run {run_id}: {event_type}")
