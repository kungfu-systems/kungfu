#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu atlas` — the Atlas bridge and Mission Control pre-release namespace.
# Imported Atlas records keep Atlas authority; Kungfu-native Mission/Go facts
# and portable Mission bundles share the same Fact Library and proof path.

import click
import json
import sys

from kungfu.cli.commands import kfc, PrioritizedCommandGroup

atlas_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="bridge Atlas facts and operate proof-backed Mission Control",
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


def _load_optional(ctx):
    from kungfu.atlas import store

    return store.load(ctx.runtime_dir)


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


@show.command(help="list admitted Atlas and Kungfu-native Missions")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def missions(ctx, as_json):
    from kungfu.atlas import mission_control

    projection = _load_optional(ctx)
    cards_by_id = dict((projection or {}).get("missions", {}))
    for record in mission_control.list_missions(ctx.runtime_dir):
        mission_id = str(record["mission_id"])
        cards_by_id[mission_id] = {**record, **cards_by_id.get(mission_id, {})}
    cards = sorted(cards_by_id.values(), key=lambda c: c["mission_id"])
    if as_json:
        _echo_json(cards)
        return
    for card in cards:
        click.echo(
            f"{card['mission_id']}  [{card['status']}]  {card['title']}"
            f"{'  stage: ' + card.get('stage_name', '') if card.get('stage_name') else ''}"
        )


@show.command(help="list admitted Atlas and Kungfu-native Go facts")
@click.option("--status", type=str, default=None, help="filter by goal status")
@click.option(
    "--mission", "mission_id", type=str, default=None, help="filter by mission"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def goals(ctx, status, mission_id, as_json):
    from kungfu.atlas import mission_control

    projection = _load_optional(ctx)
    cards_by_id = dict((projection or {}).get("goals", {}))
    for record in mission_control.list_goals(ctx.runtime_dir):
        goal_id = str(record["goal_id"])
        cards_by_id[goal_id] = {**record, **cards_by_id.get(goal_id, {})}
    cards = [
        card
        for card in sorted(cards_by_id.values(), key=lambda c: c["goal_id"])
        if (status is None or card["status"] == status)
        and (
            mission_id is None
            or card.get("mission_id") == mission_id
            or card.get("mission_subject") == mission_id
        )
    ]
    if as_json:
        _echo_json(cards)
        return
    for card in cards:
        click.echo(
            f"{card['goal_id']}  [{card['status']}]"
            f"{'  (archived)' if card.get('archived') else ''}  {card['title']}"
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
    projection = _load_optional(ctx)
    card = (projection or {}).get("goals", {}).get(goal_id)
    if card is None:
        from kungfu.atlas import mission_control

        card = next(
            (
                row
                for row in mission_control.list_goals(ctx.runtime_dir)
                if row.get("goal_id") == goal_id
            ),
            None,
        )
    if card is None:
        click.echo(f"[atlas] unknown goal: {goal_id}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(card)
        return
    for key, value in card.items():
        if value not in (None, "", False):
            click.echo(f"  {key}: {value}")


@show.command(help="show one admitted Mission and its Go facts")
@click.argument("mission_id", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def mission(ctx, mission_id, as_json):
    from kungfu.atlas import mission_control

    try:
        state = mission_control.query_state(ctx.runtime_dir, mission_id=mission_id)
    except ValueError:
        click.echo(f"[atlas] unknown mission: {mission_id}", err=True)
        sys.exit(1)
    card = state["mission"]["payload"]["record"]
    linked = [row["payload"]["record"] for row in state["goals"]]
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
    profile = report["profile"]
    cost = profile["cost"]
    click.echo(
        f"  profile: cost={cost['status']} "
        f"state={profile['state']['value']} "
        f"proof={'canonical' if profile['proof']['canonical_state'] else 'degraded'}"
    )
    click.echo(
        f"  usage: {cost['tokens']['input_tokens']} input / "
        f"{cost['tokens']['output_tokens']} output tokens; "
        f"usd={cost['cost_usd'] if cost['cost_usd_known'] else 'unknown'}; "
        f"attribution={cost['attribution']['worst']}"
    )
    click.echo(f"  assessment: {report['assessment_key']}")
    click.echo(f"  proof: {report['query_proof_root']}")
    for finding in report["findings"]:
        click.echo(f"  finding: {finding}")


@atlas.command(
    name="create-mission",
    help="create a Kungfu-native Mission in the shared Fact Library",
)
@click.argument("mission_id", type=str)
@click.option("--title", type=str, required=True)
@click.option("--intent", type=str, required=True)
@click.option("--actor", type=str, required=True)
@click.option(
    "--actor-type",
    type=click.Choice(["user", "agent"]),
    default="agent",
)
@click.option(
    "--status", type=click.Choice(["proposed", "active", "paused"]), default="active"
)
@click.option("--horizon", type=str, default="long-term")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def create_mission_cmd(
    ctx, mission_id, title, intent, actor, actor_type, status, horizon, as_json
):
    from kungfu.atlas import mission_control

    try:
        result = mission_control.create_mission(
            ctx.runtime_dir,
            mission_id=mission_id,
            title=title,
            intent=intent,
            actor=actor,
            actor_type=actor_type,
            status=status,
            horizon=horizon,
        )
    except (RuntimeError, ValueError) as error:
        click.echo(f"[atlas] create Mission failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[atlas] {result['mission_subject']}: {result['receipt']['status']}")


@atlas.command(
    name="export-mission",
    help="export a full or thin portable Mission bundle",
)
@click.argument("mission_id", type=str)
@click.option("--out", "out_path", type=str, required=True)
@click.option("--mode", type=click.Choice(["full", "thin"]), default="full")
@click.option("--source", "storage_source_id", type=str, default="atlas")
@click.option("--purpose", type=str, default="operator-review")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def export_mission_cmd(
    ctx, mission_id, out_path, mode, storage_source_id, purpose, as_json
):
    from kungfu.atlas import mission_bundle

    try:
        result = mission_bundle.write_mission_bundle(
            ctx.runtime_dir,
            out_path,
            mission_id=mission_id,
            mode=mode,
            storage_source_id=storage_source_id,
            purpose=purpose,
        )
    except (OSError, RuntimeError, ValueError) as error:
        click.echo(f"[atlas] export Mission failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] exported {result['mode']} {result['mission_subject']} "
        f"to {result['out']}: {result['status']}"
    )


@atlas.command(
    name="import-mission",
    help="verify or materialize a portable Mission bundle",
)
@click.option("--from", "from_path", type=str, required=True)
@click.option(
    "--execute",
    is_flag=True,
    help="materialize a full bundle; thin bundles remain degraded references",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def import_mission_cmd(ctx, from_path, execute, as_json):
    from kungfu.atlas import mission_bundle

    try:
        result = mission_bundle.import_mission_bundle_file(
            ctx.runtime_dir, from_path, execute=execute
        )
    except (OSError, RuntimeError, ValueError) as error:
        click.echo(f"[atlas] import Mission failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] {result['mission_subject']} bundle {result['status']}; "
        f"accepted={result['accepted']} missing={result['missing_material_count']}"
    )
    if result["diagnosis"]:
        click.echo(f"  diagnosis: {result['diagnosis']}")


@atlas.command(
    name="create-go",
    help="create a Kungfu-native Go linked to an admitted Mission",
)
@click.argument("mission_id", type=str)
@click.argument("goal_id", type=str)
@click.option("--title", type=str, required=True)
@click.option("--objective", type=str, required=True)
@click.option("--actor", type=str, required=True)
@click.option(
    "--actor-type",
    type=click.Choice(["user", "agent"]),
    default="agent",
)
@click.option("--source", "storage_source_id", type=str, default="atlas")
@click.option(
    "--status",
    type=click.Choice(["proposed", "active", "blocked", "waiting-for-decision"]),
    default="active",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def create_go_cmd(
    ctx,
    mission_id,
    goal_id,
    title,
    objective,
    actor,
    actor_type,
    storage_source_id,
    status,
    as_json,
):
    from kungfu.atlas import mission_control

    try:
        result = mission_control.create_go(
            ctx.runtime_dir,
            mission_id=mission_id,
            goal_id=goal_id,
            title=title,
            objective=objective,
            actor=actor,
            actor_type=actor_type,
            storage_source_id=storage_source_id,
            status=status,
        )
    except (RuntimeError, ValueError) as error:
        click.echo(f"[atlas] create Go failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] {result['go_subject']} -> {result['mission_subject']}: "
        f"{result['receipt']['status']}"
    )


@atlas.command(
    name="claim-completion",
    help="record a completion claim and its independent Episode evidence",
)
@click.argument("mission_id", type=str)
@click.argument("goal_id", type=str)
@click.option("--statement", type=str, required=True)
@click.option("--actor", type=str, required=True)
@click.option(
    "--actor-type",
    type=click.Choice(["user", "agent"]),
    default="agent",
)
@click.option("--source", "storage_source_id", type=str, default="atlas")
@click.option(
    "--evidence-episode",
    "evidence_episode_ids",
    type=int,
    multiple=True,
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def claim_completion_cmd(
    ctx,
    mission_id,
    goal_id,
    statement,
    actor,
    actor_type,
    storage_source_id,
    evidence_episode_ids,
    as_json,
):
    from kungfu.atlas import mission_control

    try:
        result = mission_control.claim_completion(
            ctx.runtime_dir,
            mission_id=mission_id,
            goal_id=goal_id,
            statement=statement,
            actor=actor,
            actor_type=actor_type,
            storage_source_id=storage_source_id,
            evidence_episode_ids=list(evidence_episode_ids),
        )
    except (RuntimeError, ValueError) as error:
        click.echo(f"[atlas] completion claim failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] {result['claim']['claim_id']} claims "
        f"{result['go_subject']} complete: {result['receipt']['status']}"
    )


@atlas.command(
    name="assess-completion",
    help="assess one Go completion claim for a declared purpose",
)
@click.argument("mission_id", type=str)
@click.argument("goal_id", type=str)
@click.option("--source", "storage_source_id", type=str, default="atlas")
@click.option("--purpose", type=str, default="handoff")
@click.option("--cut-system-time", type=int, default=0)
@click.option(
    "--executor",
    "executor_profile",
    type=click.Choice(["inline", "thread", "process"]),
    default="thread",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def assess_completion_cmd(
    ctx,
    mission_id,
    goal_id,
    storage_source_id,
    purpose,
    cut_system_time,
    executor_profile,
    as_json,
):
    from kungfu.atlas import mission_control

    try:
        report = mission_control.assess_completion(
            ctx.runtime_dir,
            mission_id=mission_id,
            goal_id=goal_id,
            storage_source_id=storage_source_id,
            purpose=purpose,
            cut_system_time=cut_system_time,
            executor_profile=executor_profile,
        )
    except (RuntimeError, ValueError) as error:
        click.echo(f"[atlas] completion assessment failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(report)
        return
    click.echo(
        f"[atlas] {goal_id}: {report['fitness']} for {purpose} "
        f"({report['assessment']['state']})"
    )
    click.echo(f"  assessment: {report['assessment_key']}")
    click.echo(f"  proof: {report['query_proof_root']}")
    for finding in report["findings"]:
        click.echo(f"  finding: {finding}")
