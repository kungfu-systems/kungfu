# SPDX-License-Identifier: Apache-2.0

"""Public Kungfu adapter for the Shifu library linked into kungfu-trunk."""

from __future__ import annotations

import os
import subprocess

import click

from kungfu.cli.commands import kfc
from kungfu.cli.commands.env import _resolve_trunk


def _run_shifu(commands: tuple[str, ...]) -> int:
    trunk = _resolve_trunk()
    if not trunk:
        raise click.ClickException(
            "kungfu-trunk with the linked Shifu component was not found next to "
            "the product; set KUNGFU_TRUNK_BIN for source qualification"
        )
    argv = [trunk, "shifu", *commands]
    if os.name == "nt":
        raise SystemExit(subprocess.run(argv).returncode)
    os.execv(trunk, argv)
    return 0


@kfc.command(
    help_priority=3,
    context_settings={"ignore_unknown_options": True},
    help="run the linked Shifu development and recovery launcher",
)
@click.argument("commands", nargs=-1, type=click.UNPROCESSED)
def shifu(commands):
    """Run the linked Shifu component through Kungfu's product trunk."""

    return _run_shifu(commands)
