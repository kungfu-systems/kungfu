# SPDX-License-Identifier: Apache-2.0

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.commands.primitive_role import register_role_commands


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="manage bounded authority through the Warrant primitive",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def warrant(ctx):
    del ctx


register_role_commands(warrant, "warrant")
