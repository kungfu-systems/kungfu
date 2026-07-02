#  SPDX-License-Identifier: Apache-2.0

import click
import sys

from kungfu.console.commands import kfc, PrioritizedCommandGroup
from kungfu.rewind.supervisor import Supervisor

trace_command_context = kfc.pass_context()


@kfc.command(
    help_priority=3,
    context_settings={"ignore_unknown_options": True},
    help="capture an agent run into a local trace store: kungfu trace -- <command>",
)
@click.option(
    "--run-id",
    type=str,
    default=None,
    hidden=True,
    help="fix the run id (fixtures/CI); defaults to a fresh uuid",
)
@click.argument("command", nargs=-1, type=click.UNPROCESSED, required=True)
@trace_command_context
def trace(ctx, run_id, command):
    supervisor = Supervisor(ctx.runtime_dir, command, run_id=run_id)
    click.echo(f"[rewind] run {supervisor.run_id} starts", err=True)
    exit_code, status, manifest_path = supervisor.run()
    click.echo(
        f"[rewind] run {supervisor.run_id} ended with exit code {exit_code}; "
        f"bundle at {manifest_path}",
        err=True,
    )
    sys.exit(exit_code)
