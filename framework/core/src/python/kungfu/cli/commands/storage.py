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
