# SPDX-License-Identifier: Apache-2.0

import json
import sys

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc

source_command_context = kfc.pass_context()


def _echo_json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _range_filter(since, from_time, until):
    from kungfu.sources.store import build_range_filter

    try:
        return build_range_filter(since=since, from_time=from_time, until=until)
    except ValueError as e:
        click.echo(f"[source] {e}", err=True)
        sys.exit(2)


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="manage peer storage sources and one-way sync",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def source(ctx):
    pass


@source.command(name="add", help="register or update a read-only storage source")
@click.argument("source_id", type=str)
@click.option("--type", "source_type", type=click.Choice(["atlas"]), required=True)
@click.option("--repo", type=str, required=True, help="source repo root path")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@source_command_context
def add_cmd(ctx, source_id, source_type, repo, as_json):
    from kungfu.sources.store import add_source

    result = add_source(
        ctx.runtime_dir,
        source_id=source_id,
        source_type=source_type,
        repo=repo,
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[source] registered {source_id} ({source_type}) -> {result['repo']}")


@source.command(name="list", help="list registered storage sources")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@source_command_context
def list_cmd(ctx, as_json):
    from kungfu.sources.store import list_sources

    sources = list_sources(ctx.runtime_dir)
    if as_json:
        _echo_json(sources)
        return
    for row in sources:
        click.echo(
            f"{row['source_id']}  [{row['type']}]  {row['repo']}"
            f"{'  synced: ' + row['last_synced_at'] if row.get('last_synced_at') else ''}"
        )


@source.command(help="show one registered storage source")
@click.argument("source_id", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@source_command_context
def show(ctx, source_id, as_json):
    from kungfu.sources.store import get_source

    try:
        result = get_source(ctx.runtime_dir, source_id)
    except KeyError:
        click.echo(f"[source] unknown source: {source_id}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    for key, value in result.items():
        if value not in (None, ""):
            click.echo(f"  {key}: {value}")


@source.command(help="pull source records into local Kungfu storage")
@click.argument("source_id", type=str)
@click.option("--since", type=str, default=None, help="relative window such as 3d/12h")
@click.option(
    "--from", "from_time", type=str, default=None, help="inclusive start time"
)
@click.option("--until", type=str, default=None, help="inclusive end time")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@source_command_context
def sync(ctx, source_id, since, from_time, until, as_json):
    from kungfu.sources.store import sync_source

    try:
        result = sync_source(
            ctx.runtime_dir,
            source_id,
            range_filter=_range_filter(since, from_time, until),
        )
    except KeyError:
        click.echo(f"[source] unknown source: {source_id}", err=True)
        sys.exit(1)
    except ValueError as e:
        click.echo(f"[source] {e}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    sync_result = result["sync"]
    click.echo(
        f"[source] synced {source_id}: {sync_result['missions']} missions, "
        f"{sync_result['goals']} goals, {sync_result['markers']} markers, "
        f"{sync_result['payloads']} payloads"
    )
    for warning in sync_result["warnings"]:
        click.echo(f"  warning: {warning}", err=True)


@source.command(help="compare the latest synced source with its authority")
@click.argument("source_id", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@source_command_context
def fsck(ctx, source_id, as_json):
    from kungfu.sources.store import fsck_source

    try:
        result = fsck_source(ctx.runtime_dir, source_id)
    except KeyError:
        click.echo(f"[source] unknown source: {source_id}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
    else:
        click.echo(f"[source] {source_id} fsck {'ok' if result['ok'] else 'failed'}")
        for row in result.get("missing", []):
            click.echo(f"  missing: {row}", err=True)
        for row in result.get("extra", []):
            click.echo(f"  extra: {row}", err=True)
        for row in result.get("hash_mismatch", []):
            click.echo(f"  hash_mismatch: {row}", err=True)
        for row in result.get("errors", []):
            click.echo(f"  error: {row}", err=True)
    if not result["ok"]:
        sys.exit(1)
