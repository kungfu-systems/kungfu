# SPDX-License-Identifier: Apache-2.0

"""Canonical developer-toolchain namespace."""

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.commands.engage import engage
from kungfu.cli.commands.schema import schema


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=3,
    help="developer toolchain and application assembly commands",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def dev(ctx):
    pass


def _add(group, command, name, priority=100):
    group.add_command(command, name)
    group.help_priorities[name] = priority


for _name, _command, _priority in (
    ("engage", engage, 3),
    ("schema", schema, 4),
):
    _add(dev, _command, _name, _priority)
