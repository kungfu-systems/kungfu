#  SPDX-License-Identifier: Apache-2.0

from kungfu.console.commands import kfc
import kungfu
import sys
import click
import os


@kfc.command(help_priority=1)
@click.argument("commands", nargs=-1, required=False)
@click.option("-l", "--list", is_flag=True, help="list process for monitor")
@click.option("-h", "--help", is_flag=True, help="show help")
@click.option("-v", "--version", is_flag=True, help="show cli version")
@kfc.pass_context()
def cli(ctx, commands, list, help, version):
    os.environ["KUNGFU_AS_VARIANT"] = "node"
    cli_prod_path = os.path.abspath(
        os.path.join(
            os.path.dirname(__file__),
            "..",
            "..",
            "..",
            "..",
            "app",
            "dist",
            "cli",
            "index.js",
        )
    )
    cli_path = ctx.cli_dev_path if ctx.cli_dev_path else cli_prod_path
    argv = [
        sys.argv[0],
        cli_path,
        *commands,
        "-l" if list else "",
        "-h" if help else "",
        "-V" if version else "",
    ]
    kungfu.__binding__.libnode.run(*argv)
