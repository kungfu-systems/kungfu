#  SPDX-License-Identifier: Apache-2.0

import sys

import click

from kungfu.console.commands import kfc
from kungfu.rewind.managed_cli import run_and_report
from kungfu.rewind.managed_run import managed_providers

managed_run_command_context = kfc.pass_context()


@kfc.command(
    help_priority=3,
    help=(
        "run a provider under management and report its cost: "
        "kungfu managed-run --provider claude --prompt <task>"
    ),
)
@click.option(
    "--provider",
    required=True,
    type=click.Choice(managed_providers()),
    help="which provider CLI to run under management",
)
@click.option("--prompt", required=True, help="the task to run")
@click.option(
    "--work-id",
    type=str,
    default=None,
    help="work item this run belongs to, when known",
)
@managed_run_command_context
def managed_run(ctx, provider, prompt, work_id):
    sys.exit(
        run_and_report(provider, prompt, runtime_dir=ctx.runtime_dir, work_id=work_id)
    )
