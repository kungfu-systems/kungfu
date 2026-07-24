# SPDX-License-Identifier: Apache-2.0

"""Developer and Mission Control compatibility namespaces.

Compatibility paths are registered with the same Click command objects. This
keeps parsing, handlers, KFD-3 identities, exit codes, and stdout payloads on a
single implementation while the surface registry owns per-command canonical
authority and migration diagnostics.
"""

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.commands.atlas import atlas
from kungfu.cli.commands.engage import engage
from kungfu.cli.commands.env import env
from kungfu.cli.commands.profile import profile, profile_context
from kungfu.cli.commands.schema import schema
from kungfu.cli.commands.sdk import sdk


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=3,
    help="developer toolchain and application assembly commands",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def dev(ctx):
    pass


@profile.group(
    name="mission-control",
    cls=PrioritizedCommandGroup,
    help="operate the installed Mission Control Profile",
)
@click.help_option("-h", "--help")
@profile_context
def mission_control(ctx):
    pass


def _add(group, command, name, priority=100):
    group.add_command(command, name)
    group.help_priorities[name] = priority


for _name, _command in (
    ("engage", engage),
    ("env", env),
    ("schema", schema),
    ("sdk", sdk),
):
    _add(dev, _command, _name)


for _name in (
    "authority-status",
    "authority-cutover",
    "authority-rollback",
    "assess-mission",
    "create-mission",
    "export-mission",
    "import-mission",
    "create-go",
    "claim-completion",
    "assess-completion",
    "review-completion",
    "decide-continuation",
):
    _add(mission_control, atlas.commands[_name], _name)


_atlas_show = atlas.commands["show"]
for _name in ("missions", "goals", "dashboard", "goal", "mission"):
    _add(mission_control, _atlas_show.commands[_name], _name)
