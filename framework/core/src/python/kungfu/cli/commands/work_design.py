# SPDX-License-Identifier: Apache-2.0

"""Installed Work Design command surface."""

from pathlib import Path

import click
import kungfu

from kungfu.cli.commands import PrioritizedCommandGroup, kfc


@kfc.group(
    "work-design",
    cls=PrioritizedCommandGroup,
    help_priority=3,
    help="inspect and run read-only Work Design decisions",
)
@click.help_option("-h", "--help")
def work_design():
    pass


def _preflight_entry() -> Path:
    return (
        Path(__file__).resolve().parents[2]
        / "work_design_runtime"
        / "framework"
        / "work-design-preflight"
        / "tooling"
        / "work-design-preflight.mjs"
    )


@work_design.command("preflight", help="run a read-only Work Design preflight")
@click.option(
    "--input",
    "input_path",
    required=True,
    type=click.Path(exists=True, dir_okay=False, resolve_path=True),
    help="preflight request JSON",
)
@click.option(
    "--history-query",
    type=click.Path(exists=True, dir_okay=False, resolve_path=True),
    default=None,
    help="optional verified Work history query JSON",
)
def preflight(input_path, history_query):
    entry = _preflight_entry()
    if not entry.is_file():
        raise click.ClickException(
            "installed Work Design runtime is missing from this Kungfu product"
        )
    argv = ["node", str(entry), "--input", input_path]
    if history_query:
        argv.extend(["--history-query", history_query])
    return_code = kungfu.__binding__.libnode.run(*argv)
    if return_code:
        raise SystemExit(return_code)
