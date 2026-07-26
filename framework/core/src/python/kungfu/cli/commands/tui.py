#  SPDX-License-Identifier: Apache-2.0

# The reference TUI (Ink) runs through kungfu's own embedded Node runtime
# (libnode), the same bridge `kungfu sdk` uses — no separate node install. The
# TUI bundle is shipped next to the runtime (packaged app: Resources/tui/tui.mjs)
# and loads the kungfu_node binding at runtime from KUNGFU_DIR.

import os
import sys

import click

import kungfu
from kungfu.cli.commands import kfc


def _resolve_tui_entry():
    override = os.environ.get("KUNGFU_TUI_ENTRY")
    if override and os.path.exists(override):
        return os.path.abspath(override)
    # Packaged app: the frozen runtime is Resources/kungfu; the TUI bundle is
    # shipped as a sibling Resources/tui/tui.mjs.
    binding_dir = os.path.dirname(kungfu.__binding__.__file__)
    candidates = [
        os.path.join(binding_dir, "..", "tui", "tui.mjs"),
        os.path.join(binding_dir, "tui.mjs"),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    return None


def run_tui(ctx, commands=()):
    """Launch the shipped TUI without creating a second command authority."""

    os.environ["KUNGFU_AS_VARIANT"] = "node"
    os.environ.setdefault("KUNGFU_DIR", os.path.dirname(kungfu.__binding__.__file__))
    os.environ.setdefault(
        "KUNGFU_KFX_CONTRACT",
        os.path.join(os.environ["KUNGFU_DIR"], "config", "kungfu-kfx.contract.json"),
    )
    os.environ.setdefault("KF_RUNTIME_DIR", ctx.runtime_dir)
    entry = _resolve_tui_entry()
    if not entry:
        raise click.ClickException(
            "kungfu TUI bundle not found; the packaged app ships it under "
            "Resources/tui, or set KUNGFU_TUI_ENTRY to a built tui.mjs"
        )
    argv = [sys.argv[0], entry, *commands]
    return kungfu.__binding__.libnode.run(*argv)


@kfc.command(
    help_priority=1,
    context_settings=dict(ignore_unknown_options=True),
)
@click.argument(
    "commands",
    nargs=-1,
    required=False,
    type=click.UNPROCESSED,
)
@kfc.pass_context()
def tui(ctx, commands):
    """Open Kungfu's interactive terminal product surface."""

    return run_tui(ctx, commands)
