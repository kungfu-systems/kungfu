# SPDX-License-Identifier: Apache-2.0

"""Episode command ownership behind the stable storage CLI facade."""

import json
from pathlib import Path
import sys

import click

from kungfu.cli.commands import kfc
from kungfu.cli.preflight import command_preflight

storage_command_context = kfc.pass_context()


def _echo_json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


@click.group(help="manage yijinjing-backed Episode manifests")
@storage_command_context
def episode(ctx):
    pass


def _run_episode_write(ctx, as_json, operation, action):
    from kungfu.storage.episode_control import EpisodeWriterBusyError
    from kungfu.cli.commands import storage as storage_cli

    storage_cli.run_command_preflight(ctx, "episode-write")
    try:
        result = dict(action())
    except RuntimeError as cause:
        if not str(cause).startswith("episode_writer_busy_timeout:"):
            raise
        exc = EpisodeWriterBusyError(
            operation=operation, attempts=0, busy_retries=0, elapsed_ms=0
        )
        payload = {"ok": False, "error": exc.to_dict()}
        if as_json:
            _echo_json(payload)
        else:
            from kungfu import diagnostics

            translated = diagnostics.problem_from_exception(exc, area="episode")
            click.echo(f"[storage] {diagnostics.actionable_text(translated)}", err=True)
        ctx.exit(1)
    retry = dict(result.get("write_retry") or {})
    if not retry:
        raise RuntimeError(
            f"{operation}: native Episode write did not return a retry receipt"
        )
    if retry["busyRetries"] and not as_json:
        click.echo(
            f"[storage] absorbed {retry['busyRetries']} manifest writer "
            f"contention retries in {retry['elapsedMs']} ms",
            err=True,
        )
    return result


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

    result = _run_episode_write(
        ctx,
        as_json,
        "episode_begin",
        lambda: service.episode_begin(
            ctx.runtime_dir,
            title=title,
            actor=actor,
            source=source,
            episode_id=episode_id,
            parent_episode_id=parent_episode_id,
            root_trigger_frame_uid=root_trigger_frame_uid,
            location_uid=location_uid,
        ),
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

    result = _run_episode_write(
        ctx,
        as_json,
        "episode_heartbeat",
        lambda: service.episode_heartbeat(
            ctx.runtime_dir,
            episode_id=episode_id,
            last_frame_uid=last_frame_uid,
            frame_count=frame_count,
            note=note,
            location_uid=location_uid,
        ),
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

    result = _run_episode_write(
        ctx,
        as_json,
        "episode_attach_frame",
        lambda: service.episode_attach_frame(
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
        ),
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

    result = _run_episode_write(
        ctx,
        as_json,
        "episode_attach_ref",
        lambda: service.episode_attach_ref(
            ctx.runtime_dir,
            episode_id=episode_id,
            ref_kind=ref_kind,
            ref_uid=ref_uid,
            ref_id=ref_id,
            ref_hash=ref_hash,
            location_uid=location_uid,
        ),
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] episode {episode_id} attached {ref_kind} ref")


@episode.command(
    name="attach-payload",
    help="publish payload bytes and attach their verified content reference",
)
@click.option("--episode-id", type=int, required=True)
@click.option(
    "--path",
    "payload_path",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--ref-id", type=str, default="")
@click.option("--content-hash", type=str, default="")
@click.option("--location-uid", type=int, default=0)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def attach_payload(
    ctx,
    episode_id,
    payload_path,
    ref_id,
    content_hash,
    location_uid,
    as_json,
):
    from kungfu.storage import service
    from kungfu.storage.episode_lifecycle import publish_payload_reference

    reference = publish_payload_reference(
        ctx.runtime_dir,
        str(payload_path),
        content_hash=content_hash,
        ref_id=ref_id or None,
    )
    result = _run_episode_write(
        ctx,
        as_json,
        "episode_attach_payload",
        lambda: service.episode_attach_ref(
            ctx.runtime_dir,
            episode_id=episode_id,
            ref_kind="payload",
            ref_id=reference["ref_id"],
            ref_hash=reference["ref_hash"],
            location_uid=location_uid,
        ),
    )
    result["payload_reference"] = {
        "ref_id": reference["ref_id"],
        "ref_hash": reference["ref_hash"],
        "status": reference["payload"].get("status"),
    }
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[storage] episode {episode_id} attached payload {reference['ref_hash']}"
    )


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

    result = _run_episode_write(
        ctx,
        as_json,
        "episode_end",
        lambda: service.episode_end(
            ctx.runtime_dir,
            episode_id=episode_id,
            last_frame_uid=last_frame_uid,
            frame_count=frame_count,
            reason=reason,
            location_uid=location_uid,
        ),
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

    result = _run_episode_write(
        ctx,
        as_json,
        "episode_abort",
        lambda: service.episode_abort(
            ctx.runtime_dir,
            episode_id=episode_id,
            last_frame_uid=last_frame_uid,
            frame_count=frame_count,
            reason=reason,
            location_uid=location_uid,
        ),
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] episode {episode_id} aborted")


@episode.command(
    name="recover",
    help="plan or execute a fenced abort of one stale open Episode",
)
@click.option("--episode-id", type=click.IntRange(min=1), required=True)
@click.option("--location-uid", type=click.IntRange(min=0), default=0)
@click.option(
    "--stale-after-seconds",
    type=click.FloatRange(min=0),
    default=300.0,
    show_default=True,
)
@click.option("--reason", type=str, default="operator recovery", show_default=True)
@click.option("--plan", "plan_only", is_flag=True, help="print a read-only plan")
@click.option("--execute", is_flag=True, help="execute only if the plan is eligible")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
@command_preflight("episode-recovery")
def episode_recover(
    ctx,
    episode_id,
    location_uid,
    stale_after_seconds,
    reason,
    plan_only,
    execute,
    as_json,
):
    from kungfu.storage.episode_control import (
        EpisodeRecoveryError,
        EpisodeWriterBusyError,
        execute_episode_recovery,
        plan_episode_recovery,
    )

    if plan_only and execute:
        raise click.UsageError("choose exactly one of --plan or --execute")
    if not execute:
        plan = plan_episode_recovery(
            ctx.runtime_dir,
            episode_id=episode_id,
            location_uid=location_uid,
            stale_after_seconds=stale_after_seconds,
        )
        if as_json:
            _echo_json(plan)
            return
        state = "eligible" if plan["eligible"] else "blocked"
        click.echo(f"[storage] episode {episode_id} recovery plan: {state}")
        for blocker in plan["blockers"]:
            click.echo(f"  {blocker['code']}: {blocker['message']}")
        return

    try:
        receipt = execute_episode_recovery(
            ctx.runtime_dir,
            episode_id=episode_id,
            location_uid=location_uid,
            stale_after_seconds=stale_after_seconds,
            reason=reason,
        )
    except (EpisodeRecoveryError, EpisodeWriterBusyError) as exc:
        payload = exc.to_dict()
        if as_json:
            _echo_json(payload)
        else:
            from kungfu import diagnostics

            translated = diagnostics.problem_from_exception(exc, area="episode")
            click.echo(f"[storage] {diagnostics.actionable_text(translated)}", err=True)
        ctx.exit(1)
    if as_json:
        _echo_json(receipt)
        return
    click.echo(f"[storage] episode {episode_id} recovered as aborted")


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


@episode.command(
    name="rebuild-projection",
    help="rebuild the derived Episode SQLite query projection",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def episode_rebuild_projection(ctx, as_json):
    from kungfu.storage import service

    result = service.episode_projection_rebuild(ctx.runtime_dir)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        "[storage] Episode query projection rebuilt: "
        f"{result['query_records']} append records"
    )
