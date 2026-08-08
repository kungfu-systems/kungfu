# SPDX-License-Identifier: Apache-2.0

import pytest

from kungfu.cli.commands import assignment as ASSIGNMENT_CLI


@pytest.mark.parametrize(
    "command",
    [
        ASSIGNMENT_CLI.close_resume,
        ASSIGNMENT_CLI.close_plan,
        ASSIGNMENT_CLI.close_work,
        ASSIGNMENT_CLI.claim,
        ASSIGNMENT_CLI.kickoff,
        ASSIGNMENT_CLI.stage,
        ASSIGNMENT_CLI.status,
        ASSIGNMENT_CLI.gate,
        ASSIGNMENT_CLI.bind,
        ASSIGNMENT_CLI.seal,
    ],
)
def test_assignment_identity_options_are_reusable(command):
    parameter_names = {parameter.name for parameter in command.params}

    assert {"workspace_root", "home", "initiative_id", "assignment_id"} <= (
        parameter_names
    )
