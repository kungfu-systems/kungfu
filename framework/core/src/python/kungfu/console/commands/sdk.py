#  SPDX-License-Identifier: Apache-2.0

# `kungfu sdk` — the application assembly toolkit: scaffold apps and view
# extensions, and build/clean kfx packages. It runs the SDK's Node CLI through
# kungfu's own embedded Node runtime (libnode), the same bridge `kungfu tui`
# uses — no separate node install. Unlike the TUI, the SDK is a plain Node
# program (esbuild + fs) that does not load the kungfu_node binding, so it needs
# no runtime-home wiring.

import os
import sys

import click

import kungfu
from kungfu.console.commands import kfc


def _resolve_sdk_entry():
    override = os.environ.get("KUNGFU_SDK_ENTRY")
    if override and os.path.exists(override):
        return os.path.abspath(override)
    binding_dir = os.path.dirname(kungfu.__binding__.__file__)
    # Packaged app: the SDK ships as a sibling of the frozen runtime.
    for candidate in (
        os.path.join(binding_dir, "..", "sdk", "sdk.js"),
        os.path.join(binding_dir, "sdk", "sdk.js"),
    ):
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    # Dev / workspace: walk up to the monorepo's developer/sdk source.
    directory = binding_dir
    for _ in range(8):
        candidate = os.path.join(directory, "developer", "sdk", "src", "sdk.js")
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    return None


@kfc.command(
    help_priority=2,
    context_settings=dict(ignore_unknown_options=True),
    help="assemble Kungfu applications: scaffold apps/extensions, build kfx",
)
@click.argument("commands", nargs=-1, type=click.UNPROCESSED)
def sdk(commands):
    """Kungfu application assembly toolkit.

    Scaffold apps and view extensions, and build/clean kfx packages, e.g.
    `kungfu sdk create app my-app`, `kungfu sdk create extension my-view`,
    `kungfu sdk kfx build`.
    """
    entry = _resolve_sdk_entry()
    if not entry:
        raise click.ClickException(
            "kungfu SDK entry not found; set KUNGFU_SDK_ENTRY to a built sdk.js, "
            "or run inside the monorepo where developer/sdk/src/sdk.js exists"
        )
    argv = [sys.argv[0], entry, *commands]
    kungfu.__binding__.libnode.run(*argv)
