# SPDX-License-Identifier: Apache-2.0

import json
import sys

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc

storage_command_context = kfc.pass_context()


def _echo_json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _require_source(source_id):
    if not source_id:
        click.echo("[storage] --source is required for --scope source", err=True)
        sys.exit(2)


def _range_filter(since, from_time, until):
    from kungfu.sources.store import build_range_filter

    try:
        return build_range_filter(since=since, from_time=from_time, until=until)
    except ValueError as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(2)


def _source_for_scope(scope, storage_source_id):
    if scope == "source":
        _require_source(storage_source_id)
        return storage_source_id
    return None


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="inspect and maintain runtime fact storage",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def storage(ctx):
    pass


@storage.command(help="summarize a storage scope")
@click.option("--scope", type=click.Choice(["atlas", "source", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def status(ctx, scope, storage_source_id, as_json):
    if scope == "atlas":
        from kungfu.atlas import store

        result = store.status(ctx.runtime_dir)
    else:
        from kungfu.storage import service

        result = service.status(
            ctx.runtime_dir,
            source_id=storage_source_id if scope == "source" else None,
        )
    if as_json:
        _echo_json(result)
        return
    for key, value in result.items():
        click.echo(f"  {key}: {value}")


@storage.command(help="verify runtime storage integrity for a scope")
@click.option("--scope", type=click.Choice(["atlas", "source", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def fsck(ctx, scope, storage_source_id, as_json):
    if scope == "atlas":
        from kungfu.atlas import store

        result = store.fsck(ctx.runtime_dir)
    else:
        from kungfu.storage import service

        result = service.fsck(
            ctx.runtime_dir,
            source_id=storage_source_id if scope == "source" else None,
        )
    if as_json:
        _echo_json(result)
    else:
        click.echo(f"[storage] {scope} fsck {'ok' if result['ok'] else 'failed'}")
        for error in result["errors"]:
            click.echo(f"  error: {error}", err=True)
        for warning in result["warnings"]:
            click.echo(f"  warning: {warning}", err=True)
    if not result["ok"]:
        sys.exit(1)


@storage.command(help="export a storage scope")
@click.option("--scope", type=click.Choice(["atlas", "source"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option("--since", type=str, default=None, help="relative window such as 3d/12h")
@click.option(
    "--from", "from_time", type=str, default=None, help="inclusive start time"
)
@click.option("--until", type=str, default=None, help="inclusive end time")
@click.option(
    "--format",
    "format_",
    type=click.Choice(["jsonl", "bundle-json"]),
    default="jsonl",
    help="export format; bundle-json is available for --scope source",
)
@click.option("--out", "out_path", type=str, required=True, help="output path")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def export(
    ctx,
    scope,
    storage_source_id,
    since,
    from_time,
    until,
    format_,
    out_path,
    as_json,
):
    if scope == "atlas" and format_ != "jsonl":
        click.echo("[storage] --scope atlas supports only --format jsonl", err=True)
        sys.exit(1)
    try:
        if scope == "atlas":
            from kungfu.atlas import store

            result = store.export_jsonl(
                ctx.runtime_dir,
                out_path,
                storage_source_id=storage_source_id,
                range_filter=_range_filter(since, from_time, until),
            )
        else:
            from kungfu.storage import service

            _require_source(storage_source_id)
            if format_ == "bundle-json":
                result = service.export_bundle_json(
                    ctx.runtime_dir,
                    out_path,
                    source_id=storage_source_id,
                    range_filter=_range_filter(since, from_time, until),
                )
            else:
                result = service.export_jsonl(
                    ctx.runtime_dir,
                    out_path,
                    source_id=storage_source_id,
                    range_filter=_range_filter(since, from_time, until),
                )
    except ValueError as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] exported {result['records']} {scope} records to {out_path}")


@storage.command(name="import", help="import a manifest-backed storage bundle")
@click.option("--from", "from_path", type=str, required=True, help="bundle JSON path")
@click.option(
    "--no-verify", "no_verify", is_flag=True, help="skip manifest verification"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def import_cmd(ctx, from_path, no_verify, as_json):
    from kungfu.storage import service

    try:
        with open(from_path, encoding="utf-8") as f:
            bundle = json.load(f)
        result = service.import_bundle(ctx.runtime_dir, bundle, verify=not no_verify)
    except (OSError, ValueError) as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[storage] imported {result['records']} records for {result['source_id']}"
    )


@storage.command(name="rebuild-index", help="rebuild derived storage indexes")
@click.option("--scope", type=click.Choice(["atlas", "source", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option(
    "--dry-run",
    "dry_run",
    is_flag=True,
    help="show registry changes without writing the derived index",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def rebuild_index(ctx, scope, storage_source_id, dry_run, as_json):
    from kungfu.storage import service

    if scope == "atlas":
        result = {
            "ok": True,
            "scope": "atlas",
            "dry_run": True,
            "projection": {
                "name": "atlas-journal-fold",
                "rebuildable": False,
                "reason": (
                    "Atlas cards are folded from journal frames at read time; "
                    "there is no standalone SQLite projection to rebuild."
                ),
            },
        }
    else:
        result = service.rebuild_index(
            ctx.runtime_dir,
            source_id=_source_for_scope(scope, storage_source_id),
            dry_run=dry_run,
        )
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[storage] rebuild-index {scope}: "
        f"{'would write' if result.get('would_write') else 'up to date'}"
    )
    for error in result.get("errors", []):
        click.echo(f"  error: {error}", err=True)
    if not result["ok"]:
        sys.exit(1)


@storage.command(help="query the rebuildable SQLite storage projection")
@click.option(
    "--table",
    "query_table",
    type=click.Choice(["sources", "manifests", "entries"]),
    default="entries",
    show_default=True,
)
@click.option("--scope", type=click.Choice(["source", "all"]), default="all")
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option("--kind", type=str, default=None, help="filter entry rows by kind")
@click.option("--since", type=str, default=None, help="relative window such as 3d/12h")
@click.option(
    "--from", "from_time", type=str, default=None, help="inclusive start time"
)
@click.option("--until", type=str, default=None, help="inclusive end time")
@click.option("--limit", type=click.IntRange(min=0), default=100, show_default=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def query(
    ctx,
    query_table,
    scope,
    storage_source_id,
    kind,
    since,
    from_time,
    until,
    limit,
    as_json,
):
    from kungfu.storage import service

    if scope == "source":
        _require_source(storage_source_id)
    result = service.query_projection(
        ctx.runtime_dir,
        query=query_table,
        source_id=storage_source_id if scope == "source" else None,
        kind=kind,
        range_filter=_range_filter(since, from_time, until),
        limit=limit,
    )
    if as_json:
        _echo_json(result)
        return
    if not result["ok"]:
        for error in result.get("errors", []):
            click.echo(f"  error: {error}", err=True)
        sys.exit(1)
    click.echo(
        f"[storage] query {query_table}: {result['row_count']} rows "
        f"from {result['projection']['path']}"
    )
    for row in result["rows"]:
        click.echo(json.dumps(row, sort_keys=True))


@storage.group(help="manage yijinjing-backed Episode manifests")
@storage_command_context
def episode(ctx):
    pass


@episode.command(help="begin an Episode manifest")
@click.option("--title", type=str, default="")
@click.option("--actor", type=str, default="")
@click.option("--source", type=str, default="")
@click.option("--episode-id", type=int, default=0)
@click.option("--parent-episode-id", type=int, default=0)
@click.option("--root-trigger-frame-uid", type=int, default=0)
@click.option("--location-uid", type=int, default=0)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def begin(
    ctx,
    title,
    actor,
    source,
    episode_id,
    parent_episode_id,
    root_trigger_frame_uid,
    location_uid,
    as_json,
):
    from kungfu.storage import service

    result = service.episode_begin(
        ctx.runtime_dir,
        title=title,
        actor=actor,
        source=source,
        episode_id=episode_id,
        parent_episode_id=parent_episode_id,
        root_trigger_frame_uid=root_trigger_frame_uid,
        location_uid=location_uid,
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] episode {result['episode_id']} begun")


@episode.command(help="append an Episode heartbeat")
@click.option("--episode-id", type=int, required=True)
@click.option("--last-frame-uid", type=int, default=0)
@click.option("--frame-count", type=int, default=0)
@click.option("--note", type=str, default="")
@click.option("--location-uid", type=int, default=0)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def heartbeat(
    ctx, episode_id, last_frame_uid, frame_count, note, location_uid, as_json
):
    from kungfu.storage import service

    result = service.episode_heartbeat(
        ctx.runtime_dir,
        episode_id=episode_id,
        last_frame_uid=last_frame_uid,
        frame_count=frame_count,
        note=note,
        location_uid=location_uid,
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] episode {episode_id} heartbeat appended")


@episode.command(name="attach-frame", help="attach a frame receipt to an Episode")
@click.option("--episode-id", type=int, required=True)
@click.option("--frame-uid", type=int, required=True)
@click.option("--trigger-frame-uid", type=int, default=0)
@click.option("--stream-id", type=int, default=0)
@click.option("--carrier-type", type=int, default=0)
@click.option("--source", type=int, default=0)
@click.option("--dest", type=int, default=0)
@click.option("--data-length", type=int, default=0)
@click.option("--location-uid", type=int, default=0)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def attach_frame(
    ctx,
    episode_id,
    frame_uid,
    trigger_frame_uid,
    stream_id,
    carrier_type,
    source,
    dest,
    data_length,
    location_uid,
    as_json,
):
    from kungfu.storage import service

    result = service.episode_attach_frame(
        ctx.runtime_dir,
        episode_id=episode_id,
        frame_uid=frame_uid,
        trigger_frame_uid=trigger_frame_uid,
        stream_id=stream_id,
        carrier_type=carrier_type,
        source=source,
        dest=dest,
        data_length=data_length,
        location_uid=location_uid,
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] episode {episode_id} attached frame {frame_uid}")


@episode.command(name="attach-ref", help="attach an external reference to an Episode")
@click.option("--episode-id", type=int, required=True)
@click.option(
    "--ref-kind",
    type=click.Choice(["input_frame", "payload", "schema", "episode"]),
    default="input_frame",
    show_default=True,
)
@click.option("--ref-uid", type=int, default=0)
@click.option("--ref-id", type=str, default="")
@click.option("--ref-hash", type=str, default="")
@click.option("--location-uid", type=int, default=0)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def attach_ref(
    ctx, episode_id, ref_kind, ref_uid, ref_id, ref_hash, location_uid, as_json
):
    from kungfu.storage import service

    result = service.episode_attach_ref(
        ctx.runtime_dir,
        episode_id=episode_id,
        ref_kind=ref_kind,
        ref_uid=ref_uid,
        ref_id=ref_id,
        ref_hash=ref_hash,
        location_uid=location_uid,
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] episode {episode_id} attached {ref_kind} ref")


@episode.command(name="end", help="seal an Episode as ended")
@click.option("--episode-id", type=int, required=True)
@click.option("--last-frame-uid", type=int, default=0)
@click.option("--frame-count", type=int, default=0)
@click.option("--reason", type=str, default="")
@click.option("--location-uid", type=int, default=0)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def episode_end(
    ctx, episode_id, last_frame_uid, frame_count, reason, location_uid, as_json
):
    from kungfu.storage import service

    result = service.episode_end(
        ctx.runtime_dir,
        episode_id=episode_id,
        last_frame_uid=last_frame_uid,
        frame_count=frame_count,
        reason=reason,
        location_uid=location_uid,
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] episode {episode_id} ended")


@episode.command(name="abort", help="seal an Episode as aborted")
@click.option("--episode-id", type=int, required=True)
@click.option("--last-frame-uid", type=int, default=0)
@click.option("--frame-count", type=int, default=0)
@click.option("--reason", type=str, default="")
@click.option("--location-uid", type=int, default=0)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def episode_abort(
    ctx, episode_id, last_frame_uid, frame_count, reason, location_uid, as_json
):
    from kungfu.storage import service

    result = service.episode_abort(
        ctx.runtime_dir,
        episode_id=episode_id,
        last_frame_uid=last_frame_uid,
        frame_count=frame_count,
        reason=reason,
        location_uid=location_uid,
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] episode {episode_id} aborted")


@episode.command(name="list", help="list Episodes")
@click.option("--location-uid", type=int, default=0)
@click.option("--limit", type=click.IntRange(min=0), default=100, show_default=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def episode_list(ctx, location_uid, limit, as_json):
    from kungfu.storage import service

    result = service.episode_list(
        ctx.runtime_dir, location_uid=location_uid, limit=limit
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] episodes: {result['episode_count']}")
    for item in result["episodes"]:
        click.echo(json.dumps(item, sort_keys=True))


@episode.command(name="inspect", help="inspect one Episode")
@click.option("--episode-id", type=int, required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def episode_inspect(ctx, episode_id, as_json):
    from kungfu.storage import service

    result = service.episode_inspect(ctx.runtime_dir, episode_id=episode_id)
    if as_json:
        _echo_json(result)
        return
    if not result["ok"]:
        for error in result.get("errors", []):
            click.echo(f"  error: {error}", err=True)
        sys.exit(1)
    click.echo(json.dumps(result["episode"], sort_keys=True))


@storage.command(help="plan unreachable payload garbage collection")
@click.option("--scope", type=click.Choice(["source", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option(
    "--dry-run",
    "dry_run",
    is_flag=True,
    help="required; no payloads are deleted",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def gc(ctx, scope, storage_source_id, dry_run, as_json):
    from kungfu.storage import service

    if not dry_run:
        click.echo("[storage] gc requires --dry-run in this release", err=True)
        sys.exit(2)
    try:
        result = service.gc_plan(
            ctx.runtime_dir,
            source_id=_source_for_scope(scope, storage_source_id),
            dry_run=True,
        )
    except ValueError as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(2)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[storage] gc dry-run {scope}: {result['candidate_count']} candidates, "
        f"{result['candidate_bytes']} bytes"
    )


@storage.command(help="plan fact-ledger compaction without rewriting storage")
@click.option("--scope", type=click.Choice(["source", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option(
    "--dry-run",
    "dry_run",
    is_flag=True,
    help="required; no storage files are rewritten",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def compact(ctx, scope, storage_source_id, dry_run, as_json):
    from kungfu.storage import service

    if not dry_run:
        click.echo("[storage] compact requires --dry-run in this release", err=True)
        sys.exit(2)
    try:
        result = service.compact_plan(
            ctx.runtime_dir,
            source_id=_source_for_scope(scope, storage_source_id),
            dry_run=True,
        )
    except ValueError as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(2)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[storage] compact dry-run {scope}: "
        f"{len(result['retained_manifests'])} retained manifests, "
        f"{result['gc']['candidate_count']} gc candidates"
    )
    if not result["ok"]:
        sys.exit(1)


@storage.command(name="verify-sync", help="simulate local bundle export/import/fsck")
@click.option("--source", "storage_source_id", type=str, required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def verify_sync(ctx, storage_source_id, as_json):
    from kungfu.storage import service

    try:
        result = service.verify_local_sync(ctx.runtime_dir, source_id=storage_source_id)
    except (FileNotFoundError, ValueError) as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
    else:
        click.echo(
            f"[storage] verify-sync {storage_source_id} "
            f"{'ok' if result['ok'] else 'failed'}"
        )
    if not result["ok"]:
        sys.exit(1)
