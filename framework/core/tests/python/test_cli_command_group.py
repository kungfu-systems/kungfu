# SPDX-License-Identifier: Apache-2.0

import click
from click.testing import CliRunner

from kungfu.cli.commands import PrioritizedCommandGroup


def test_help_tolerates_hidden_command_added_without_priority():
    group = PrioritizedCommandGroup(name="kungfu")
    group.add_command(click.Command(name="runtime-host", hidden=True))

    result = CliRunner().invoke(group, ["--help"])

    assert result.exit_code == 0, result.output
    assert "runtime-host" not in result.output
