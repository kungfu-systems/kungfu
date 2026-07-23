# SPDX-License-Identifier: Apache-2.0

import os
import sys

import click

import kungfu
from kungfu.cli.commands import kfc


def _resolve_action_entry():
    override = os.environ.get("KUNGFU_ACTION_ENTRY")
    if override:
        return os.path.realpath(override) if os.path.isfile(override) else None
    binding_dir = os.path.dirname(kungfu.__binding__.__file__)
    for candidate in (
        os.path.join(binding_dir, "..", "action", "action.mjs"),
        os.path.join(binding_dir, "action", "action.mjs"),
    ):
        if os.path.isfile(candidate):
            return os.path.realpath(candidate)
    directory = binding_dir
    for _ in range(8):
        candidate = os.path.join(directory, "framework", "action", "action.mjs")
        if os.path.isfile(candidate):
            return os.path.realpath(candidate)
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    return None


def _run_action(commands):
    entry = _resolve_action_entry()
    if not entry:
        raise click.ClickException(
            "Kungfu Action package not found; installed products ship it under "
            "Resources/action, or set KUNGFU_ACTION_ENTRY to action.mjs"
        )
    os.environ["KUNGFU_ACTION_HOST"] = "embedded-libnode"
    os.environ["KUNGFU_ACTION_LAYOUT"] = (
        "installed" if os.environ.get("KUNGFU_INSTALL_SOURCE") else "source"
    )
    status = kungfu.__binding__.libnode.run(sys.argv[0], entry, *commands)
    if isinstance(status, int) and status != 0:
        raise SystemExit(status)
    return status


@kfc.command(
    help_priority=2,
    context_settings=dict(ignore_unknown_options=True),
    help="inspect the shared Action primitive kernel contract",
)
@click.argument("commands", nargs=-1, type=click.UNPROCESSED)
def action(commands):
    """Run the packaged Action MJS through Kungfu embedded libnode."""
    return _run_action(commands)
