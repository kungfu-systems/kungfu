# SPDX-License-Identifier: Apache-2.0

import json
import sys

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc

storage_command_context = kfc.pass_context()


def _echo_json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _require_atlas(scope):
    if scope != "atlas":
        click.echo(
            "[storage] only --scope atlas is implemented in this slice", err=True
        )
        sys.exit(1)


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
@click.option("--scope", type=click.Choice(["atlas"]), required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def status(ctx, scope, as_json):
    _require_atlas(scope)
    from kungfu.atlas import store

    result = store.status(ctx.runtime_dir)
    if as_json:
        _echo_json(result)
        return
    for key, value in result.items():
        click.echo(f"  {key}: {value}")


@storage.command(help="verify runtime storage integrity for a scope")
@click.option("--scope", type=click.Choice(["atlas"]), required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def fsck(ctx, scope, as_json):
    _require_atlas(scope)
    from kungfu.atlas import store

    result = store.fsck(ctx.runtime_dir)
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
@click.option("--scope", type=click.Choice(["atlas"]), required=True)
@click.option("--format", "format_", type=click.Choice(["jsonl"]), default="jsonl")
@click.option("--out", "out_path", type=str, required=True, help="output path")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def export(ctx, scope, format_, out_path, as_json):
    _require_atlas(scope)
    from kungfu.atlas import store

    if format_ != "jsonl":
        click.echo("[storage] only --format jsonl is implemented", err=True)
        sys.exit(1)
    result = store.export_jsonl(ctx.runtime_dir, out_path)
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] exported {result['records']} {scope} records to {out_path}")
