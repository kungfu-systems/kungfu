#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu atlas` — the Atlas bridge and Mission Control pre-release namespace.
# Imported Atlas records keep Atlas authority; Kungfu-native Mission/Go facts
# and portable Mission bundles share the same Fact Library and proof path.

import click
import json
import sys

from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.cli.commands.primitive_role import register_role_commands

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


register_role_commands(atlas, "atlas")


def _echo_json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _profile_source(ctx):
    from kungfu import profile_sdk

    return profile_sdk.discover_source("kungfu.mission-control", ctx.runtime_dir)[
        "source"
    ]


def _profile_read(ctx, operation, values):
    from kungfu import profile_sdk

    return profile_sdk.invoke_member_adapter(
        _profile_source(ctx),
        ctx.runtime_dir,
        "mission-control-actions",
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


@atlas.command(
    name="authority-status",
    help="show Atlas/native Mission and Go authority parity and current writer",
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


@atlas.command(
    name="authority-cutover",
    help="cut Mission and Go writes over to Kungfu native authority",
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
            "cutover-authority",
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


@atlas.command(
    name="authority-rollback",
    help="roll Mission and Go writes back to Atlas without deleting native facts",
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
            "rollback-authority",
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


@show.command(help="list admitted Atlas and Kungfu-native Missions")
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


@show.command(help="list admitted Atlas and Kungfu-native Go facts")
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


@show.command(help="render one cut-consistent Mission Control dashboard snapshot")
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


@show.command(help="show one goal by its stable goal id")
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


@show.command(help="show one admitted Mission and its Go facts")
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
@click.option("--authorized-by", default="kungfu-cli", show_default=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def assess_mission(
    ctx,
    mission_id,
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
                "missionId": mission_id,
                "source": storage_source_id,
                "purpose": purpose,
                "cutSystemTime": cut_system_time,
                "executorProfile": executor_profile,
                "authorizedBy": authorized_by,
            },
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
    try:
        result = _profile_action(
            ctx,
            "create-mission",
            {
                "missionId": mission_id,
                "title": title,
                "intent": intent,
                "actor": actor,
                "actorType": actor_type,
                "status": status,
                "horizon": horizon,
            },
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
    try:
        result = _profile_action(
            ctx,
            "export-mission",
            {
                "missionId": mission_id,
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
    try:
        result = _profile_action(
            ctx,
            "import-mission",
            {"from": from_path, "execute": execute},
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
@click.option("--parent-go", "parent_goal_id", type=str, default="")
@click.option("--depends-on", "depends_on", type=str, multiple=True)
@click.option("--owning-workspace-identity-root", type=str, default="")
@click.option("--responsibility", type=str, default="")
@click.option("--acceptance-root", type=str, default="")
@click.option("--atlas-root", type=str, default="")
@click.option(
    "--context-binding-json",
    type=str,
    default="{}",
    help="verified xinfa.go-context-binding/v1 JSON object",
)
@click.option("--project-cut-root", type=str, default="")
@click.option("--episode-root", "evidence_episode_roots", type=str, multiple=True)
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
    parent_goal_id,
    depends_on,
    owning_workspace_identity_root,
    responsibility,
    acceptance_root,
    atlas_root,
    context_binding_json,
    project_cut_root,
    evidence_episode_roots,
    status,
    as_json,
):
    try:
        context_binding = json.loads(context_binding_json)
        if not isinstance(context_binding, dict):
            raise ValueError("context binding JSON must be an object")
        result = _profile_action(
            ctx,
            "create-go",
            {
                "missionId": mission_id,
                "goalId": goal_id,
                "title": title,
                "objective": objective,
                "actor": actor,
                "actorType": actor_type,
                "source": storage_source_id,
                "status": status,
                "parentGoalId": parent_goal_id,
                "dependsOn": list(depends_on),
                "owningWorkspaceIdentityRoot": owning_workspace_identity_root,
                "responsibility": responsibility,
                "acceptanceRoot": acceptance_root,
                "atlasRoot": atlas_root,
                "contextBinding": context_binding,
                "projectCutRoot": project_cut_root,
                "evidenceEpisodeRoots": list(evidence_episode_roots),
            },
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
@click.option("--go-set", "go_set", multiple=True)
@click.option("--acceptance-root", default="")
@click.option("--input-atlas-root", default="")
@click.option("--result-atlas-root", default="")
@click.option("--project-cut-root", default="")
@click.option("--project-cut-receipt-root", default="")
@click.option("--git-commit", default="")
@click.option("--git-tree-root", default="")
@click.option("--proof-root", "proof_roots", multiple=True)
@click.option("--known-gap", "known_gaps", multiple=True)
@click.option(
    "--evidence-availability",
    "evidence_availability",
    multiple=True,
    help="JSON object with acceptance, level, and state",
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
    go_set,
    acceptance_root,
    input_atlas_root,
    result_atlas_root,
    project_cut_root,
    project_cut_receipt_root,
    git_commit,
    git_tree_root,
    proof_roots,
    known_gaps,
    evidence_availability,
    as_json,
):
    try:
        availability = [json.loads(row) for row in evidence_availability]
        result = _profile_action(
            ctx,
            "claim-completion",
            {
                "missionId": mission_id,
                "goalId": goal_id,
                "statement": statement,
                "actor": actor,
                "actorType": actor_type,
                "source": storage_source_id,
                "evidenceEpisodeIds": list(evidence_episode_ids),
                "goSet": list(go_set),
                "acceptanceRoot": acceptance_root,
                "inputAtlasRoot": input_atlas_root,
                "resultAtlasRoot": result_atlas_root,
                "projectCutRoot": project_cut_root,
                "projectCutReceiptRoot": project_cut_receipt_root,
                "gitCommit": git_commit,
                "gitTreeRoot": git_tree_root,
                "proofRoots": list(proof_roots),
                "knownGaps": list(known_gaps),
                "evidenceAvailability": availability,
            },
        )
    except (json.JSONDecodeError, RuntimeError, ValueError) as error:
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
                "missionId": mission_id,
                "goalId": goal_id,
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


@atlas.command(
    name="review-completion",
    help="independently review one exact-root completion claim",
)
@click.argument("mission_id", type=str)
@click.argument("goal_id", type=str)
@click.option("--reviewer", required=True)
@click.option("--reviewer-source", required=True)
@click.option("--checkout", "checkout_path", default="")
@click.option("--source", "storage_source_id", default="atlas")
@click.option("--purpose", default="handoff")
@click.option("--cut-system-time", type=int, default=0)
@click.option(
    "--executor",
    "executor_profile",
    type=click.Choice(["inline", "thread", "process"]),
    default="thread",
)
@click.option(
    "--follow-up",
    "proposed_followups",
    multiple=True,
    help="JSON follow-up Go object; repeat at most six times",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def review_completion_cmd(
    ctx,
    mission_id,
    goal_id,
    reviewer,
    reviewer_source,
    checkout_path,
    storage_source_id,
    purpose,
    cut_system_time,
    executor_profile,
    proposed_followups,
    as_json,
):
    try:
        result = _profile_action(
            ctx,
            "review-completion",
            {
                "missionId": mission_id,
                "goalId": goal_id,
                "reviewer": reviewer,
                "reviewerSource": reviewer_source,
                "checkoutPath": checkout_path,
                "source": storage_source_id,
                "purpose": purpose,
                "cutSystemTime": cut_system_time,
                "executorProfile": executor_profile,
                "proposedFollowups": [json.loads(row) for row in proposed_followups],
            },
        )
    except (json.JSONDecodeError, RuntimeError, ValueError) as error:
        click.echo(f"[atlas] completion review failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] {result['review']['review_id']}: {result['review']['verdict']}"
    )
    click.echo(f"  review: {result['review_root']}")
    click.echo(f"  continuation: {result['continuation_plan_root']}")


@atlas.command(
    name="decide-continuation",
    help="apply one exact-root continuation decision",
)
@click.argument("mission_id", type=str)
@click.argument("goal_id", type=str)
@click.argument("review_id", type=str)
@click.option("--expected-review-root", required=True)
@click.option("--expected-plan-root", required=True)
@click.option(
    "--action",
    type=click.Choice(
        [
            "approve",
            "adjust",
            "request-evidence",
            "reopen",
            "stop",
            "close",
            "create-follow-up",
        ]
    ),
    required=True,
)
@click.option("--actor", required=True)
@click.option("--actor-type", type=click.Choice(["user", "agent"]), default="agent")
@click.option(
    "--change-class",
    type=click.Choice(
        [
            "mechanical",
            "mission",
            "authority",
            "privacy",
            "security",
            "public-claim",
            "irreversible",
        ]
    ),
    default="mechanical",
)
@click.option("--source", "storage_source_id", default="atlas")
@click.option("--reason", required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@atlas_command_context
def decide_continuation_cmd(
    ctx,
    mission_id,
    goal_id,
    review_id,
    expected_review_root,
    expected_plan_root,
    action,
    actor,
    actor_type,
    change_class,
    storage_source_id,
    reason,
    as_json,
):
    try:
        result = _profile_action(
            ctx,
            "decide-continuation",
            {
                "missionId": mission_id,
                "goalId": goal_id,
                "reviewId": review_id,
                "expectedReviewRoot": expected_review_root,
                "expectedPlanRoot": expected_plan_root,
                "action": action,
                "actor": actor,
                "actorType": actor_type,
                "changeClass": change_class,
                "source": storage_source_id,
                "reason": reason,
            },
        )
    except (RuntimeError, ValueError) as error:
        click.echo(f"[atlas] continuation decision failed: {error}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[atlas] {result['decision']['decision_id']}: {result['decision']['action']}"
    )
    click.echo(f"  follow-ups: {len(result['created_followups'])}")
