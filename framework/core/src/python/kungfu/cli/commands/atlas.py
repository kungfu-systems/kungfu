#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu atlas` — the Atlas control-plane import profile (read-only slice).
# `import` snapshots an Atlas-style repository's mission/goal/worktree-marker
# state into the local journal; `show` renders the latest completed batch.
# The source repository remains the authority; nothing is written back.

import click
import json
import sys

from kungfu.cli.commands import kfc, PrioritizedCommandGroup

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


def _range_filter(since, from_time, until):
    from kungfu.sources.store import build_range_filter

    try:
        return build_range_filter(since=since, from_time=from_time, until=until)
    except ValueError as e:
        click.echo(f"[atlas] {e}", err=True)
        sys.exit(2)


@atlas.command(name="import", help="snapshot a control-plane repo into the journal")
@click.option("--repo", "repo_root", type=str, required=True, help="repo root path")
@click.option("--source", "storage_source_id", type=str, default="atlas")
@click.option("--since", type=str, default=None, help="relative window such as 3d/12h")
@click.option(
    "--from", "from_time", type=str, default=None, help="inclusive start time"
)
@click.option("--until", type=str, default=None, help="inclusive end time")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def import_cmd(ctx, repo_root, storage_source_id, since, from_time, until, as_json):
    from kungfu.atlas.store import ImportStore

    result = ImportStore(ctx.runtime_dir).run_import(
        repo_root,
        storage_source_id=storage_source_id,
        range_filter=_range_filter(since, from_time, until),
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] imported {result['import_id']}: {result['missions']} missions, "
        f"{result['goals']} goals, {result['markers']} markers "
        f"({len(result['warnings'])} warning(s)) episode {result['episode_id']}; "
        f"mission-control {result['mission_control']['status']} "
        f"({result['mission_control'].get('admitted', 0)} admitted, "
        f"{result['mission_control'].get('already_present', 0)} already present)"
    )
    for warning in result["warnings"]:
        click.echo(f"  warning: {warning}", err=True)


@atlas.command(help="compare the latest Kungfu Atlas import with the source repo")
@click.option("--repo", "repo_root", type=str, required=True, help="repo root path")
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option("--since", type=str, default=None, help="relative window such as 3d/12h")
@click.option(
    "--from", "from_time", type=str, default=None, help="inclusive start time"
)
@click.option("--until", type=str, default=None, help="inclusive end time")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def verify(ctx, repo_root, storage_source_id, since, from_time, until, as_json):
    from kungfu.atlas import store

    result = store.verify_against_repo(
        ctx.runtime_dir,
        repo_root,
        storage_source_id=storage_source_id,
        range_filter=_range_filter(since, from_time, until),
    )
    if as_json:
        _echo_json(result)
    else:
        click.echo(f"[atlas] verify {'ok' if result['ok'] else 'failed'}")
        for key in ("missing", "extra", "hash_mismatch"):
            for row in result[key]:
                click.echo(f"  {key}: {row}", err=True)
    if not result["ok"]:
        sys.exit(1)


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


@atlas.command(
    name="assess-mission",
    help="query admitted Mission/Go facts and persist a purpose-bound TrustReport",
)
@click.argument("mission_id", type=str)
@click.option("--source", "storage_source_id", type=str, default="atlas")
@click.option("--purpose", type=str, default="operator-review")
@click.option("--cut-system-time", type=int, default=0)
@click.option(
    "--executor",
    "executor_profile",
    type=click.Choice(["inline", "thread", "process"]),
    default="thread",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def assess_mission(
    ctx,
    mission_id,
    storage_source_id,
    purpose,
    cut_system_time,
    executor_profile,
    as_json,
):
    from kungfu.atlas import mission_control

    try:
        report = mission_control.assess_progress(
            ctx.runtime_dir,
            mission_id=mission_id,
            storage_source_id=storage_source_id,
            purpose=purpose,
            cut_system_time=cut_system_time,
            executor_profile=executor_profile,
        )
    except (RuntimeError, ValueError) as error:
        click.echo(f"[atlas] Mission assessment failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(report)
        return
    click.echo(
        f"[atlas] {mission_id}: {report['fitness']} for {purpose} "
        f"({report['assessment']['state']})"
    )
    click.echo(f"  assessment: {report['assessment_key']}")
    click.echo(f"  proof: {report['query_proof_root']}")
    for finding in report["findings"]:
        click.echo(f"  finding: {finding}")
