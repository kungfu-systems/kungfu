#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu atlas` — the Atlas control-plane import profile (read-only slice).
# `import` snapshots an Atlas-style repository's mission/goal/worktree-marker
# state into the local journal; `show` renders the latest completed batch.
# The source repository remains the authority; nothing is written back.

import click
import json
import sys

from kungfu.console.commands import kfc, PrioritizedCommandGroup

atlas_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="import and inspect an Atlas-style control plane (read-only)",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def atlas(ctx):
    pass


def _echo_json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _load(ctx):
    from kungfu.atlas import store

    projection = store.load(ctx.runtime_dir)
    if projection is None:
        click.echo(
            "[atlas] no completed import — run `kungfu atlas import` first", err=True
        )
        sys.exit(1)
    return projection


@atlas.command(name="import", help="snapshot a control-plane repo into the journal")
@click.option("--repo", "repo_root", type=str, required=True, help="repo root path")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def import_cmd(ctx, repo_root, as_json):
    from kungfu.atlas.store import ImportStore

    result = ImportStore(ctx.runtime_dir).run_import(repo_root)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] imported {result['import_id']}: {result['missions']} missions, "
        f"{result['goals']} goals, {result['markers']} markers "
        f"({len(result['warnings'])} warning(s))"
    )
    for warning in result["warnings"]:
        click.echo(f"  warning: {warning}", err=True)


@atlas.group(
    cls=PrioritizedCommandGroup,
    help="render the latest completed import (a projection, not the authority)",
)
@click.help_option("-h", "--help")
@atlas_command_context
def show(ctx):
    pass


@show.command(help="list imported missions")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def missions(ctx, as_json):
    projection = _load(ctx)
    cards = sorted(projection["missions"].values(), key=lambda c: c["mission_id"])
    if as_json:
        _echo_json(cards)
        return
    for card in cards:
        click.echo(
            f"{card['mission_id']}  [{card['status']}]  {card['title']}"
            f"{'  stage: ' + card['stage_name'] if card['stage_name'] else ''}"
        )


@show.command(help="list imported goals")
@click.option("--status", type=str, default=None, help="filter by goal status")
@click.option(
    "--mission", "mission_id", type=str, default=None, help="filter by mission"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def goals(ctx, status, mission_id, as_json):
    projection = _load(ctx)
    cards = [
        card
        for card in sorted(projection["goals"].values(), key=lambda c: c["goal_id"])
        if (status is None or card["status"] == status)
        and (mission_id is None or card["mission_id"] == mission_id)
    ]
    if as_json:
        _echo_json(cards)
        return
    for card in cards:
        click.echo(
            f"{card['goal_id']}  [{card['status']}]"
            f"{'  (archived)' if card['archived'] else ''}  {card['title']}"
        )


@show.command(help="list imported worktree-status markers")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def markers(ctx, as_json):
    projection = _load(ctx)
    cards = sorted(projection["markers"].values(), key=lambda c: c["branch"])
    if as_json:
        _echo_json(cards)
        return
    for card in cards:
        click.echo(f"{card['branch']}  [{card['status']}]  ready={card['ready']}")


@show.command(help="show one goal by its stable goal id")
@click.argument("goal_id", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def goal(ctx, goal_id, as_json):
    projection = _load(ctx)
    card = projection["goals"].get(goal_id)
    if card is None:
        click.echo(f"[atlas] unknown goal: {goal_id}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(card)
        return
    for key, value in card.items():
        if value not in (None, "", False):
            click.echo(f"  {key}: {value}")


@show.command(help="show one mission and its imported goals")
@click.argument("mission_id", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def mission(ctx, mission_id, as_json):
    projection = _load(ctx)
    card = projection["missions"].get(mission_id)
    if card is None:
        click.echo(f"[atlas] unknown mission: {mission_id}", err=True)
        sys.exit(1)
    linked = [
        goal_card
        for goal_card in sorted(
            projection["goals"].values(), key=lambda c: c["goal_id"]
        )
        if goal_card["mission_id"] == mission_id
    ]
    if as_json:
        _echo_json({"mission": card, "goals": linked})
        return
    for key, value in card.items():
        if value not in (None, ""):
            click.echo(f"  {key}: {value}")
    for goal_card in linked:
        click.echo(f"  goal: {goal_card['goal_id']}  [{goal_card['status']}]")


@show.command(name="import", help="show the latest import batch metadata")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def import_info(ctx, as_json):
    projection = _load(ctx)
    meta = {
        "import_id": projection["import_id"],
        "repo_root": projection["repo_root"],
        "repo_head": projection["repo_head"],
        "missions": len(projection["missions"]),
        "goals": len(projection["goals"]),
        "markers": len(projection["markers"]),
    }
    if as_json:
        _echo_json(meta)
        return
    for key, value in meta.items():
        click.echo(f"  {key}: {value}")
