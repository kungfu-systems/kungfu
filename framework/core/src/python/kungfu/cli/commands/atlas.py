#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu atlas` — the explicit Atlas compatibility bridge.
# Kungfu-native Work Control lives under `kungfu work`.

import click
import json
import sys

from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.cli.commands.primitive_role import register_role_commands
from kungfu.cli.commands.profile import profile, profile_context

atlas_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="bridge Atlas facts and operate proof-backed Atlas primitives",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def atlas(ctx):
    pass


register_role_commands(atlas, "atlas")


@profile.group(
    name="mission-control",
    cls=PrioritizedCommandGroup,
    help="hidden v3 compatibility reader; replacement: kungfu work",
    hidden=True,
)
@click.help_option("-h", "--help")
@profile_context
def mission_control(ctx):
    pass


def _echo_json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _profile_source(ctx):
    from kungfu import profile_sdk

    try:
        return profile_sdk.discover_source("kungfu.work-control", ctx.runtime_dir)[
            "source"
        ]
    except ValueError:
        return profile_sdk.discover_source("kungfu.mission-control", ctx.runtime_dir)[
            "source"
        ]


def _profile_read(ctx, operation, values):
    from kungfu import profile_sdk

    return profile_sdk.invoke_member_adapter(
        _profile_source(ctx),
        ctx.runtime_dir,
        "work-control-actions",
        operation,
        values,
    )["result"]


def _profile_action(ctx, intent_id, values):
    from kungfu import profile_sdk

    source = _profile_source(ctx)
    plan = profile_sdk.intent_plan(source, ctx.runtime_dir, intent_id, values)
    answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", "kungfu-cli")
    receipt = profile_sdk.intent_apply(ctx.runtime_dir, plan, answer)
    return receipt["actionReceipt"]["coreReceipt"]


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
    result = _profile_action(
        ctx,
        "import-atlas",
        {
            "repo": repo_root,
            "source": storage_source_id,
            "range": _range_filter(since, from_time, until),
        },
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] imported {result['import_id']}: {result['missions']} missions, "
        f"{result['goals']} goals, {result['markers']} markers "
        f"({len(result['warnings'])} warning(s)) episode {result['episode_id']}; "
        f"work-control {result['work_control']['status']} "
        f"({result['work_control'].get('admitted', 0)} admitted, "
        f"{result['work_control'].get('already_present', 0)} already present)"
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


@mission_control.command(
    name="authority-status",
    help="show Atlas/native Mission and Go authority parity and current writer",
    hidden=True,
)
@click.option("--source", "storage_source_id", type=str, default="atlas")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def authority_status_cmd(ctx, storage_source_id, as_json):
    try:
        result = _profile_read(ctx, "authority-status", {"source": storage_source_id})
    except (RuntimeError, ValueError) as error:
        click.echo(f"[atlas] authority status failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] writer={result['authority']['write_authority']} "
        f"state={result['authority']['state']} parity={result['parity']['status']} "
        f"root={result['parity']['parity_root']}"
    )


@mission_control.command(
    name="authority-cutover",
    help="cut Mission and Go writes over to Kungfu native authority",
    hidden=True,
)
@click.option("--source", "storage_source_id", type=str, default="atlas")
@click.option("--expected-parity-root", type=str, required=True)
@click.option("--project-cut-root", type=str, required=True)
@click.option("--atlas-root", type=str, required=True)
@click.option("--actor", type=str, required=True)
@click.option("--actor-type", type=click.Choice(["user", "agent"]), default="agent")
@click.option("--reason", type=str, required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def authority_cutover_cmd(
    ctx,
    storage_source_id,
    expected_parity_root,
    project_cut_root,
    atlas_root,
    actor,
    actor_type,
    reason,
    as_json,
):
    try:
        result = _profile_action(
            ctx,
            "activate-work-control",
            {
                "source": storage_source_id,
                "expectedParityRoot": expected_parity_root,
                "projectCutRoot": project_cut_root,
                "atlasRoot": atlas_root,
                "actor": actor,
                "actorType": actor_type,
                "reason": reason,
            },
        )
    except (RuntimeError, ValueError) as error:
        click.echo(f"[atlas] authority cutover failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    migration = result.get("migration") or result.get("latest") or {}
    click.echo(
        f"[atlas] {migration.get('migration_id', '')}: "
        f"{result['status']} writer=kungfu-native"
    )


@mission_control.command(
    name="authority-rollback",
    help="roll Mission and Go writes back to Atlas without deleting native facts",
    hidden=True,
)
@click.option("--expected-migration-id", type=str, required=True)
@click.option("--actor", type=str, required=True)
@click.option("--actor-type", type=click.Choice(["user", "agent"]), default="agent")
@click.option("--reason", type=str, required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def authority_rollback_cmd(
    ctx, expected_migration_id, actor, actor_type, reason, as_json
):
    try:
        result = _profile_action(
            ctx,
            "restore-atlas-authority",
            {
                "expectedMigrationId": expected_migration_id,
                "actor": actor,
                "actorType": actor_type,
                "reason": reason,
            },
        )
    except (RuntimeError, ValueError) as error:
        click.echo(f"[atlas] authority rollback failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] {result['migration']['migration_id']}: "
        "rolled-back writer=atlas-adapter"
    )


@atlas.group(
    cls=PrioritizedCommandGroup,
    help="render the latest completed import (a projection, not the authority)",
)
@click.help_option("-h", "--help")
@atlas_command_context
def show(ctx):
    pass


@mission_control.command(
    help="list admitted Atlas and Kungfu-native Missions", hidden=True
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def missions(ctx, as_json):
    cards = _mission_cards(ctx)
    if as_json:
        _echo_json(cards)
        return
    for card in cards:
        click.echo(
            f"{card['mission_id']}  [{card['status']}]  {card['title']}"
            f"{'  stage: ' + card.get('stage_name', '') if card.get('stage_name') else ''}"
        )


def _mission_cards(ctx, *, cut_system_time=0):
    return _profile_read(ctx, "dashboard", {})["missions"]


@mission_control.command(
    help="list admitted Atlas and Kungfu-native Go facts", hidden=True
)
@click.option("--status", type=str, default=None, help="filter by goal status")
@click.option(
    "--mission", "mission_id", type=str, default=None, help="filter by mission"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def goals(ctx, status, mission_id, as_json):
    cards = _goal_cards(
        ctx,
        status=status,
        mission_id=mission_id,
    )
    if as_json:
        _echo_json(cards)
        return
    for card in cards:
        click.echo(
            f"{card['goal_id']}  [{card['status']}]"
            f"{'  (archived)' if card.get('archived') else ''}  {card['title']}"
        )


def _goal_cards(ctx, *, status=None, mission_id=None, cut_system_time=0):
    return _profile_read(
        ctx,
        "goals",
        {"status": status, "missionId": mission_id},
    )


@mission_control.command(
    help="render one cut-consistent Mission Control dashboard snapshot",
    hidden=True,
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def dashboard(ctx, as_json):
    payload = _profile_read(ctx, "dashboard", {})
    if as_json:
        _echo_json(payload)
        return
    click.echo(
        f"cut={payload['cut']['system_time']} missions={len(payload['missions'])} "
        f"goals={len(payload['goals'])}"
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


@mission_control.command(help="show one goal by its stable goal id", hidden=True)
@click.argument("goal_id", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def goal(ctx, goal_id, as_json):
    projection = _load_optional(ctx)
    card = (projection or {}).get("goals", {}).get(goal_id)
    if card is None:
        card = next(
            (
                row
                for row in _profile_read(ctx, "goals", {})
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


@mission_control.command(help="show one admitted Mission and its Go facts", hidden=True)
@click.argument("mission_id", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def mission(ctx, mission_id, as_json):
    try:
        payload = _profile_read(ctx, "mission", {"missionId": mission_id})
    except ValueError:
        click.echo(f"[atlas] unknown mission: {mission_id}", err=True)
        sys.exit(1)
    card = payload["mission"]
    linked = payload["goals"]
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


@mission_control.command(
    name="export-mission",
    help="export a full or thin portable Mission bundle",
    hidden=True,
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
    try:
        result = _profile_action(
            ctx,
            "export-initiative",
            {
                "initiativeId": mission_id,
                "out": out_path,
                "mode": mode,
                "source": storage_source_id,
                "purpose": purpose,
            },
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


@mission_control.command(
    name="import-mission",
    help="verify or materialize a portable Mission bundle",
    hidden=True,
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
    try:
        result = _profile_action(
            ctx,
            "import-initiative",
            {
                "from": from_path,
                "execute": execute,
                "compatibilityMode": "legacy",
            },
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


@mission_control.command(
    name="assess-completion",
    help="assess one Go completion claim for a declared purpose",
    hidden=True,
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
@click.option("--authorized-by", default="kungfu-cli", show_default=True)
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
    authorized_by,
    as_json,
):
    try:
        report = _profile_action(
            ctx,
            "assess-progress",
            {
                "initiativeId": mission_id,
                "assignmentId": goal_id,
                "source": storage_source_id,
                "purpose": purpose,
                "cutSystemTime": cut_system_time,
                "executorProfile": executor_profile,
                "authorizedBy": authorized_by,
            },
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
