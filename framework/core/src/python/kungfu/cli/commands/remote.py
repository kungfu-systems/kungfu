#  SPDX-License-Identifier: Apache-2.0

import json
import sys

import click

from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.remote import store

remote_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=3,
    help="manage remote Kungfu fact sources and source-scoped mirrors",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def remote(ctx):
    pass


def _json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


@remote.command(help="register a remote Kungfu runtime source")
@click.argument("source_id", type=str)
@click.option("--host", required=True, type=str, help="ssh host or localhost")
@click.option("--home", required=True, type=str, help="remote KF_HOME/runtime root")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@remote_command_context
def add(ctx, source_id, host, home, as_json):
    row = store.add_source(ctx.runtime_dir, source_id, host, home)
    payload = {"schema": "kungfu.remote-add/v1", "source": row}
    if as_json:
        _json(payload)
    else:
        click.echo(f"[remote] added {source_id} ({row['transport']}): {host}:{home}")


@remote.command(name="list", help="list registered remote sources")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@remote_command_context
def list_sources(ctx, as_json):
    sources = store.load_sources(ctx.runtime_dir)
    payload = {"schema": "kungfu.remote-list/v1", "sources": sources}
    if as_json:
        _json(payload)
        return
    if not sources:
        click.echo("[remote] no sources")
        return
    for source_id, row in sorted(sources.items()):
        click.echo(f"{source_id}  {row['transport']}  {row['host']}:{row['home']}")


@remote.command(help="show one remote source and last sync manifest")
@click.argument("source_id", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@remote_command_context
def show(ctx, source_id, as_json):
    sources = store.load_sources(ctx.runtime_dir)
    if source_id not in sources:
        click.echo(f"[remote] unknown source: {source_id}", err=True)
        sys.exit(1)
    manifest = None
    path = store.manifest_path(ctx.runtime_dir, source_id)
    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            manifest = json.load(f)
    payload = {
        "schema": "kungfu.remote-show/v1",
        "source": sources[source_id],
        "manifest": manifest,
    }
    if as_json:
        _json(payload)
    else:
        row = sources[source_id]
        click.echo(f"[remote] {source_id}: {row['host']}:{row['home']}")
        click.echo(
            f"[remote] sync_state: {manifest.get('sync_state') if manifest else 'never'}"
        )


@remote.command(help="sync a remote source into a source-scoped local mirror")
@click.argument("source_id", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@remote_command_context
def sync(ctx, source_id, as_json):
    try:
        manifest = store.sync_source(ctx.runtime_dir, source_id)
    except KeyError:
        click.echo(f"[remote] unknown source: {source_id}", err=True)
        sys.exit(1)
    payload = {"schema": "kungfu.remote-sync/v1", "manifest": manifest}
    if as_json:
        _json(payload)
    else:
        click.echo(
            f"[remote] {source_id}: {manifest['sync_state']} -> "
            f"{manifest['mirror_runtime']}"
        )


@remote.command(name="work", help="list mirrored remote work items with source labels")
@click.argument("source_id", required=False, type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@remote_command_context
def work_items(ctx, source_id, as_json):
    try:
        items = store.list_work(ctx.runtime_dir, source_id)
    except KeyError:
        click.echo(f"[remote] unknown source: {source_id}", err=True)
        sys.exit(1)
    payload = {"schema": "kungfu.remote-work/v1", "items": items}
    if as_json:
        _json(payload)
        return
    if not items:
        click.echo("[remote] no mirrored work items")
        return
    for item in items:
        next_hint = f"  next: {item['next_action']}" if item["next_action"] else ""
        click.echo(
            f"{item['source']}  {item['work_id']}  [{item['status']}]  "
            f"sync={item['sync_state']}  ({item['kind']})  {item['title']}"
            f"{next_hint}"
        )


@remote.command(name="runs", help="list mirrored remote Rewind runs with source labels")
@click.argument("source_id", required=False, type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@remote_command_context
def runs(ctx, source_id, as_json):
    try:
        rows = store.list_runs(ctx.runtime_dir, source_id)
    except KeyError:
        click.echo(f"[remote] unknown source: {source_id}", err=True)
        sys.exit(1)
    payload = {"schema": "kungfu.remote-runs/v1", "runs": rows}
    if as_json:
        _json(payload)
        return
    if not rows:
        click.echo("[remote] no mirrored runs")
        return
    for row in rows:
        click.echo(
            f"{row['source']}  {row['run_id']}  sync={row['sync_state']}  "
            f"manifest={row['manifest'] or 'missing'}"
        )
