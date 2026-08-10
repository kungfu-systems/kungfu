# SPDX-License-Identifier: Apache-2.0

"""Public commands for the Xinfa Atlas Action Primitive role."""

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.commands.primitive_role import register_role_commands


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="operate the Xinfa Atlas Action Primitive role",
)
@click.help_option("-h", "--help")
def atlas():
    pass


register_role_commands(atlas, "atlas")
