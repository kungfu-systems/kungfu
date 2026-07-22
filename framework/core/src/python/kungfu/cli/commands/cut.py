#  SPDX-License-Identifier: Apache-2.0

"""Read-only public Project Cut projection."""

import json

import click

from kungfu.cli.commands import kfc
from kungfu.project_cut_read_model import inspect_project_cut


@kfc.command(
    help_priority=2,
    help="inspect the current Project Cut, confidence, gaps, and next actions",
)
@click.option("--repo", default=".", type=click.Path(file_okay=False))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def cut(repo, as_json):
    projection = inspect_project_cut(repo)
    if as_json:
        click.echo(json.dumps(projection, indent=2, sort_keys=True))
        return
    click.echo(f"Project Cut: {projection['status']} ({projection['confidence']})")
    current = projection["current"]
    if current:
        click.echo(f"  cut: {current['cutRoot']}")
        click.echo(f"  source: {current['sourceRoot']}")
        click.echo(f"  atlas: {current['atlasRoot']}")
        click.echo(f"  episodes: {len(current['episodeRoots'])}")
    for gap in projection["gaps"]:
        click.echo(f"  gap: {gap}")
    click.echo(f"  next: {', '.join(projection['nextActions'])}")
