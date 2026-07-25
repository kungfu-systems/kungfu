# SPDX-License-Identifier: Apache-2.0

import json
import sys

import click

from kungfu.agent import run_agent
from kungfu.cli.commands import kfc
from kungfu.agent.kfd3 import api_help, kfd3_api


run_command_context = kfc.pass_context()


def _json_file(handle, label):
    if handle is None:
        return None
    try:
        value = json.load(handle)
    except json.JSONDecodeError as error:
        raise click.ClickException(f"invalid {label} JSON: {error}") from error
    if not isinstance(value, dict):
        raise click.ClickException(f"{label} must be a JSON object")
    return value


@kfc.group(help_priority=2, help=api_help("kungfu.run"))
@kfd3_api("kungfu.run")
def run():
    """Launch provider-neutral runtime operations."""


@run.command(name="agent", help=api_help("kungfu.run.agent"))
@click.option("--prompt", required=True, help="bounded task for the fresh Agent")
@click.option(
    "--agent",
    "profile_id",
    default=None,
    help="Agent Runtime Profile id; defaults to the verified configured selection",
)
@click.option(
    "--workspace",
    "workspace_root",
    type=click.Path(exists=True, file_okay=False, resolve_path=True),
    default=None,
    help="project working directory for workspace-root profiles",
)
@click.option(
    "--work-ref",
    type=click.File("r", encoding="utf-8"),
    default=None,
    help="exact kungfu.work-ref/v1 JSON",
)
@click.option(
    "--continuation",
    type=click.File("r", encoding="utf-8"),
    default=None,
    help="exact transcript-free continuation envelope JSON",
)
@click.option(
    "--timeout",
    "timeout_seconds",
    type=click.FloatRange(min=1),
    default=900.0,
    show_default=True,
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.run.agent")
@run_command_context
def agent(
    ctx,
    prompt,
    profile_id,
    workspace_root,
    work_ref,
    continuation,
    timeout_seconds,
    as_json,
):
    try:
        payload = run_agent.execute(
            prompt=prompt,
            runtime_dir=ctx.runtime_dir,
            config_home=ctx.config_home,
            profile_id=profile_id,
            workspace_root=workspace_root,
            home=ctx.home,
            work_ref=_json_file(work_ref, "WorkRef"),
            continuation=_json_file(continuation, "continuation envelope"),
            timeout_seconds=timeout_seconds,
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        click.echo(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        click.echo(
            f"{payload['runId']}  {payload['runtimeProfile']['provider']}  "
            f"exit={payload['launch']['exitCode']}"
        )
        click.echo(f"proof: {payload['episode']['manifestPath']}")
        click.echo("Work settlement: independent assessment required")
    sys.exit(int(payload["launch"]["exitCode"]))
