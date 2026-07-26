# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path

import click

from kungfu import qualification_lab as lab
from kungfu.agent.kfd3 import kfd3_api
from kungfu.agent import runtime_profiles
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.config import resolve_config


def _json(value):
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _event_json(value):
    click.echo(json.dumps(value, sort_keys=True))
    click.get_text_stream("stdout").flush()


@kfc.group(
    name="qualification-lab",
    cls=PrioritizedCommandGroup,
    help_priority=1,
    help="inspect startup and qualify local agent continuity",
)
@click.help_option("-h", "--help")
@kfd3_api("kungfu.qualification-lab")
@kfc.pass_context()
def qualification_lab(ctx):
    """The shared, boot-safe Agent Qualification Lab authority."""


@qualification_lab.command(help="resolve the boot route without writing state")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.qualification-lab.inspect")
@kfc.pass_context()
def inspect(ctx, as_json):
    payload = lab.inspect_startup(ctx.runtime_dir, config_home=ctx.config_home)
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['route']}: {payload['message']}")


@qualification_lab.command(help="list canonical Lab actions and startup state")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.qualification-lab.catalog")
@kfc.pass_context()
def catalog(ctx, as_json):
    payload = lab.catalog(ctx.runtime_dir, config_home=ctx.config_home)
    if as_json:
        _json(payload)
        return
    click.echo("Agent Qualification Lab")
    click.echo(f"  startup: {payload['startup']['route']}")
    for action in payload["actions"]:
        click.echo(f"  {action['id']} ({action['mutation']})")


@qualification_lab.command(help="discover local agent launchers without credentials")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.qualification-lab.agents")
@kfc.pass_context()
def agents(ctx, as_json):
    payload = runtime_profiles.discover_catalog(
        resolved_config=resolve_config(
            config_home=ctx.config_home, runtime_home=ctx.home
        )
    )
    if as_json:
        _json(payload)
        return
    for row in payload["discovered"]:
        click.echo(f"{row['profile']['id']}  {row['profile']['label']}")


@qualification_lab.command(help="preview the deterministic offline demo")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.qualification-lab.plan")
def plan(as_json):
    payload = lab.demo_plan()
    if as_json:
        _json(payload)
        return
    click.echo(f"Qualification demo plan: {payload['planRoot']}")


@qualification_lab.command(help="run the isolated two-session offline demo")
@click.option(
    "--output",
    type=click.Path(path_type=Path),
    help="new discardable evidence directory; defaults to an OS temporary root",
)
@click.option(
    "--events-json",
    is_flag=True,
    help="emit stable event boundaries followed by the final report",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.qualification-lab.demo")
def demo(output, events_json, as_json):
    try:
        payload = lab.run_demo(
            output,
            on_event=_event_json if events_json else None,
        )
    except (OSError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if events_json:
        _event_json(payload)
        return
    if as_json:
        _json(payload)
        return
    click.echo(
        f"Agent Qualification Lab demo: {payload['status']} ({payload['reportRoot']})"
    )


@qualification_lab.command(name="agent-plan", help="preview one exact local agent run")
@click.argument("profile_id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.qualification-lab.agent-plan")
@kfc.pass_context()
def agent_plan(ctx, profile_id, as_json):
    try:
        payload = lab.agent_plan(
            profile_id, config_home=ctx.config_home, runtime_home=ctx.home
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo("Command preview:")
    click.echo(
        "  " + " ".join(json.dumps(value) for value in payload["commandPreview"])
    )


@qualification_lab.command(
    name="agent-run",
    help="run two fresh sessions of one exact local agent after confirmation",
)
@click.argument("profile_id")
@click.option(
    "--execute",
    is_flag=True,
    help="authorize local provider execution in a discardable directory",
)
@click.option(
    "--target-profile",
    help="use a different discovered profile for the fresh continuation session",
)
@click.option(
    "--output",
    type=click.Path(path_type=Path),
    help="new discardable evidence directory; defaults to an OS temporary root",
)
@click.option(
    "--timeout",
    "timeout_seconds",
    type=click.IntRange(min=1, max=3600),
    default=300,
    show_default=True,
)
@click.option(
    "--events-json",
    is_flag=True,
    help="stream stable event boundaries followed by the final report",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.qualification-lab.agent-run")
@kfc.pass_context()
def agent_run(
    ctx,
    profile_id,
    execute,
    target_profile,
    output,
    timeout_seconds,
    events_json,
    as_json,
):
    if not execute:
        raise click.UsageError(
            "agent-run requires --execute; inspect agent-plan before authorizing "
            "provider execution"
        )
    try:
        payload = lab.run_agent(
            profile_id,
            target_profile_id=target_profile,
            config_home=ctx.config_home,
            runtime_home=ctx.home,
            output_dir=output,
            timeout_seconds=timeout_seconds,
            on_event=_event_json if events_json else None,
        )
    except (OSError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if events_json:
        _event_json(payload)
        return
    if as_json:
        _json(payload)
        return
    click.echo(
        f"Local agent qualification: {payload['status']} ({payload['reportRoot']})"
    )
