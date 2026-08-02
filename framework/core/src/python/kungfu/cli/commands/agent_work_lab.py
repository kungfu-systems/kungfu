# SPDX-License-Identifier: Apache-2.0

import json
import tempfile
from pathlib import Path

import click

from kungfu import agent_work_lab as lab
from kungfu import project_template
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
    name="agent-work-lab",
    cls=PrioritizedCommandGroup,
    help_priority=1,
    help="inspect startup and qualify local agent continuity",
)
@click.help_option("-h", "--help")
@kfd3_api("kungfu.agent-work-lab")
@kfc.pass_context()
def agent_work_lab(ctx):
    """The shared, boot-safe Agent Work Lab authority."""


@agent_work_lab.command(help="resolve the boot route without writing state")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.inspect")
@kfc.pass_context()
def inspect(ctx, as_json):
    payload = lab.inspect_startup(ctx.runtime_dir, config_home=ctx.config_home)
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['route']}: {payload['message']}")


@agent_work_lab.command(help="list canonical Lab actions and startup state")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.catalog")
@kfc.pass_context()
def catalog(ctx, as_json):
    payload = lab.catalog(ctx.runtime_dir, config_home=ctx.config_home)
    if as_json:
        _json(payload)
        return
    click.echo("Agent Work Lab")
    click.echo(f"  startup: {payload['startup']['route']}")
    for action in payload["actions"]:
        click.echo(f"  {action['id']} ({action['mutation']})")


@agent_work_lab.command(help="discover local agent launchers without credentials")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.agents")
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


@agent_work_lab.command(help="preview the deterministic offline demo")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.plan")
def plan(as_json):
    payload = lab.demo_plan()
    if as_json:
        _json(payload)
        return
    click.echo(f"Agent Work Lab demo plan: {payload['planRoot']}")


@agent_work_lab.command(help="run the isolated two-session offline demo")
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
@kfd3_api("kungfu.agent-work-lab.demo")
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
    click.echo(f"Agent Work Lab demo: {payload['status']} ({payload['reportRoot']})")


@agent_work_lab.command(
    help="launch the guided offline autoplay in the shipped TUI",
)
@kfd3_api("kungfu.agent-work-lab")
@kfc.pass_context()
def autoplay(ctx):
    from kungfu.cli.tui_runtime import run_tui

    return run_tui(ctx, ("--agent-work-lab-autoplay",))


@agent_work_lab.command(
    name="project-tour",
    help="animate a disposable Project Work failure-and-recovery story",
)
@click.option(
    "--speed",
    type=click.FloatRange(min=0.25, max=2.0),
    default=1.0,
    show_default=True,
    help="playback speed multiplier; 0.5 doubles the reading time",
)
@kfd3_api("kungfu.agent-work-lab")
@kfc.pass_context()
def project_tour(ctx, speed):
    from kungfu.cli.tui_runtime import run_tui

    with tempfile.TemporaryDirectory(prefix="kungfu-project-tour-") as temporary:
        destination = Path(temporary) / "my-first-kungfu-project"
        return run_tui(
            ctx,
            (
                "--project-work-tour-root",
                str(destination),
                "--project-tour-speed",
                f"{speed:g}",
            ),
        )


@agent_work_lab.command(
    name="starter-plan",
    help="preview the Agent Work Starter project without writing",
)
@click.option("--destination", type=click.Path(path_type=Path))
@click.option("--parent", type=click.Path(path_type=Path))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab")
def starter_plan(destination, parent, as_json):
    try:
        payload = lab.plan_project_template(
            lab.DEFAULT_TEMPLATE_ID,
            destination,
            parent=parent,
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"Starter Project: {payload['destination']}")
    click.echo(f"  plan: {payload['planRoot']}")
    click.echo("  no files written; run starter-create after reviewing this plan")


@agent_work_lab.command(
    name="starter-create",
    help="create the exact reviewed Agent Work Starter project",
)
@click.option(
    "--destination",
    required=True,
    type=click.Path(path_type=Path),
)
@click.option("--expected-plan-root", required=True)
@click.option("--actor", required=True)
@click.option(
    "--execute",
    is_flag=True,
    help="confirm creation of the reviewed project and captured Work request",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab")
def starter_create(destination, expected_plan_root, actor, execute, as_json):
    if not execute:
        raise click.ClickException(
            "starter-create requires --execute after reviewing starter-plan"
        )
    try:
        payload = lab.create_project_template(
            lab.DEFAULT_TEMPLATE_ID,
            destination,
            expected_plan_root=expected_plan_root,
            actor=actor,
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"Created Starter Project: {payload['destination']}")
    click.echo(
        "  initial Work captured and pending explicit admission: "
        f"{payload['initialWork']['requestRoot']}"
    )


@agent_work_lab.command(
    name="starter-resume",
    help="resume one exact retained Agent Work Starter project without writing",
)
@click.option(
    "--workspace",
    required=True,
    type=click.Path(path_type=Path),
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.starter-resume")
def starter_resume(workspace, as_json):
    try:
        payload = project_template.resume_project_template(workspace)
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"Resumed Starter Project: {payload['destination']}")
    click.echo(f"  retained Work request: {payload['initialWork']['requestRoot']}")


@agent_work_lab.command(name="agent-plan", help="preview one exact local agent run")
@click.argument("profile_id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.agent-plan")
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


@agent_work_lab.command(
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
@kfd3_api("kungfu.agent-work-lab.agent-run")
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
    click.echo(f"Agent Work Lab run: {payload['status']} ({payload['reportRoot']})")
