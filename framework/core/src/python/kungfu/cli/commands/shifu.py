# SPDX-License-Identifier: Apache-2.0

"""Public adapter for the Shifu library linked into kungfu-trunk."""

import click

from kungfu.cli.commands import kfc
from kungfu.cli.commands.env import _run_trunk_component


@kfc.command(
    help_priority=3,
    context_settings={"ignore_unknown_options": True},
    help="run the linked Shifu development and recovery launcher",
)
@click.argument("commands", nargs=-1, type=click.UNPROCESSED)
def shifu(commands):
    """Run the linked Shifu component through Kungfu's product trunk."""

    return _run_trunk_component(
        "shifu",
        commands,
        "kungfu-trunk with linked Shifu was not found; set KUNGFU_TRUNK_BIN",
    )
