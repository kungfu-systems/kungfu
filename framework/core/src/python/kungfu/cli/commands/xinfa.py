# SPDX-License-Identifier: Apache-2.0

"""Public Kungfu adapter for the Xinfa component linked into kungfu-trunk."""

from __future__ import annotations

import os
import subprocess

import click

from kungfu.cli.commands import kfc
from kungfu.cli.commands.env import _resolve_trunk


def _run_xinfa(commands: tuple[str, ...]) -> int:
    trunk = _resolve_trunk()
    if not trunk:
        raise click.ClickException(
            "kungfu-trunk with the linked Xinfa component was not found next to "
            "the product; set KUNGFU_TRUNK_BIN for source qualification"
        )
    argv = [trunk, "xinfa", *commands]
    if os.name == "nt":
        raise SystemExit(subprocess.run(argv).returncode)
    os.execv(trunk, argv)
    return 0


@kfc.command(
    help_priority=2,
    context_settings={"ignore_unknown_options": True},
    help="compile workspace context into a verified Xinfa Atlas",
)
@click.argument("commands", nargs=-1, type=click.UNPROCESSED)
def xinfa(commands):
    """Run the linked Xinfa component through Kungfu's product trunk."""

    return _run_xinfa(commands)
