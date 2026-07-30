#  SPDX-License-Identifier: Apache-2.0

import sys

import click

import kungfu
from kungfu.cli.commands import kfc
from kungfu.cli.commands.sdk import _resolve_sdk_entry


@kfc.command(
    help_priority=2,
    context_settings=dict(ignore_unknown_options=True),
    help="query and check Kungfu KFD capability facts",
)
@click.argument("commands", nargs=-1, type=click.UNPROCESSED)
def kfd(commands):
    """Expose Kungfu KFD capability facts through the installed CLI.

    The implementation delegates to the SDK-distributed Buildchain bridge so an
    installed Kungfu runtime can answer `kungfu kfd query --json` without asking
    users to install the `buildchain` executable separately.
    """
    entry = _resolve_sdk_entry()
    if not entry:
        raise click.ClickException(
            "kungfu SDK entry not found; set KUNGFU_SDK_ENTRY to a built sdk.js, "
            "or run inside the monorepo where developer/sdk/src/sdk.js exists"
        )
    argv = [sys.argv[0], entry, "kfd", *commands]
    kungfu.__binding__.libnode.run(*argv)
