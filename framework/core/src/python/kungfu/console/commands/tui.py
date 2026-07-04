#  SPDX-License-Identifier: Apache-2.0

# The reference TUI (Ink) runs through kungfu's own embedded Node runtime
# (libnode), the same bridge `kungfu cli` uses — no separate node install. The
# TUI bundle is shipped next to the runtime (packaged app: Resources/tui/tui.mjs)
# and loads the kungfu_node binding at runtime from KUNGFU_DIR.

import os
import sys

import click

import kungfu
from kungfu.console.commands import kfc


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


@kfc.command(help_priority=1)
@click.argument("commands", nargs=-1, required=False)
@kfc.pass_context()
def tui(ctx, commands):
    """Kungfu reference TUI (Ink) — the shell-native reference surface."""
    os.environ["KUNGFU_AS_VARIANT"] = "node"
    # Point the TUI at this runtime's binding directory so it loads
    # kungfu_node.node from the shipped runtime rather than resolving a
    # workspace package that does not exist in the packaged app.
    os.environ.setdefault("KUNGFU_DIR", os.path.dirname(kungfu.__binding__.__file__))
    # Open the same runtime home the rest of the CLI uses (<home>/runtime),
    # not a directory derived from the current working directory — otherwise
    # the TUI shows a different/empty ledger per cwd and crashes when the cwd
    # is not writable.
    os.environ.setdefault("KF_RUNTIME_DIR", ctx.runtime_dir)
    entry = _resolve_tui_entry()
    if not entry:
        raise click.ClickException(
            "kungfu TUI bundle not found; the packaged app ships it under "
            "Resources/tui, or set KUNGFU_TUI_ENTRY to a built tui.mjs"
        )
    argv = [sys.argv[0], entry, *commands]
    kungfu.__binding__.libnode.run(*argv)
