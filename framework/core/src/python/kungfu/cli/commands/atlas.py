#  SPDX-License-Identifier: Apache-2.0

import click

from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.cli.commands.primitive_role import register_role_commands


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="operate the Xinfa Atlas role through native Profile authority",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def atlas(ctx):
    pass


register_role_commands(atlas, "atlas")
