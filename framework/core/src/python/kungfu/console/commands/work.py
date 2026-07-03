#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu work` — the default work profile: manage work items whose facts
# live in the journal. Mutations append events through the work store's
# single writer; `list` / `show` fold the event stream into the current
# projection. Every subcommand offers --json so agents consume the same
# facts the human-readable output shows.

import click
import json
import sys

from kungfu.console.commands import kfc, PrioritizedCommandGroup

work_command_context = kfc.pass_context()

_STATUS_VERBS = {
    "start": ("active", "start a work item (-> active)"),
    "resume": ("active", "resume a work item (-> active)"),
    "pause": ("waiting", "pause a work item (-> waiting)"),
    "block": ("blocked", "block a work item (-> blocked)"),
    "ready": ("ready", "mark a work item ready (-> ready)"),
    "done": ("done", "mark a work item done (-> done)"),
}


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="manage work items: create, drive the lifecycle, and inspect state",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def work(ctx):
    pass


def _load(ctx):
    from kungfu.work import store

    return store.load(ctx.runtime_dir)


def _require(ctx, work_id):
    items = _load(ctx)
    if work_id not in items:
        click.echo(f"[work] unknown work item: {work_id}", err=True)
        sys.exit(1)
    return items[work_id]


def _echo(payload, as_json, text):
    if as_json:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    else:
        click.echo(text)


@work.command(help="create a work item (a created item starts active)")
@click.argument("title", type=str)
@click.option("--kind", type=str, default="task", help="work item kind")
@click.option("--summary", type=str, default=None, help="one-line summary")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@work_command_context
def create(ctx, title, kind, summary, as_json):
    from kungfu.work.store import WorkStore

    work_id = WorkStore(ctx.runtime_dir).create(title, kind, summary)
    _echo(
        {"work_id": work_id, "title": title, "kind": kind, "status": "active"},
        as_json,
        f"[work] created {work_id} ({kind}): {title}",
    )


def _register_status_verb(verb, status_name, help_text):
    @work.command(name=verb, help=help_text)
    @click.argument("work_id", type=str)
    @click.option("--reason", type=str, default=None, help="free-text reason")
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    @work_command_context
    def _cmd(ctx, work_id, reason, as_json, _status=status_name, _verb=verb):
        from kungfu.work import store as work_store

        _require(ctx, work_id)
        work_store.WorkStore(ctx.runtime_dir).set_status(
            work_id, work_store.STATUS_BY_NAME[_status], reason or _verb
        )
        _echo(
            {"work_id": work_id, "status": _status},
            as_json,
            f"[work] {work_id} -> {_status}",
        )


for _verb, (_status, _help_text) in _STATUS_VERBS.items():
    _register_status_verb(_verb, _status, _help_text)


@work.command(name="next", help="set the item's current next action")
@click.argument("work_id", type=str)
@click.argument("next_action", type=str)
@work_command_context
def next_action(ctx, work_id, next_action):
    from kungfu.work.store import WorkStore

    _require(ctx, work_id)
    WorkStore(ctx.runtime_dir).set_next_action(work_id, next_action)
    click.echo(f"[work] {work_id} next: {next_action}")


@work.command(help="record a recovery checkpoint note")
@click.argument("work_id", type=str)
@click.argument("note", type=str)
@work_command_context
def checkpoint(ctx, work_id, note):
    from kungfu.work.store import WorkStore

    _require(ctx, work_id)
    WorkStore(ctx.runtime_dir).checkpoint(work_id, note)
    click.echo(f"[work] {work_id} checkpoint recorded")


@work.command(help="record a decision")
@click.argument("work_id", type=str)
@click.argument("decision", type=str)
@click.option("--by", "decided_by", type=str, default=None, help="who decided")
@work_command_context
def decide(ctx, work_id, decision, decided_by):
    from kungfu.work.store import WorkStore

    _require(ctx, work_id)
    WorkStore(ctx.runtime_dir).decide(work_id, decision, decided_by)
    click.echo(f"[work] {work_id} decision recorded")


@work.command(help="record a validation outcome")
@click.argument("work_id", type=str)
@click.option(
    "--result",
    type=click.Choice(["pass", "fail"]),
    required=True,
    help="validation outcome",
)
@click.option("--command", "command_text", type=str, default=None, help="what ran")
@click.option("--note", type=str, default=None, help="free-text note")
@work_command_context
def validate(ctx, work_id, result, command_text, note):
    from kungfu.work import store as work_store

    _require(ctx, work_id)
    work_store.WorkStore(ctx.runtime_dir).validate(
        work_id, work_store.RESULT_BY_NAME[result], command_text, note
    )
    click.echo(f"[work] {work_id} validation recorded: {result}")


@work.command(help="record an artifact reference (path, url, commit, ...)")
@click.argument("work_id", type=str)
@click.argument("ref", type=str)
@click.option("--kind", type=str, default=None, help="artifact kind")
@work_command_context
def artifact(ctx, work_id, ref, kind):
    from kungfu.work.store import WorkStore

    _require(ctx, work_id)
    WorkStore(ctx.runtime_dir).artifact(work_id, ref, kind)
    click.echo(f"[work] {work_id} artifact recorded: {ref}")


@work.command(name="link-run", help="link a recorded (Rewind) run to the item")
@click.argument("work_id", type=str)
@click.argument("run_id", type=str)
@work_command_context
def link_run(ctx, work_id, run_id):
    from kungfu.work.store import WorkStore

    _require(ctx, work_id)
    WorkStore(ctx.runtime_dir).link_run(work_id, run_id)
    click.echo(f"[work] {work_id} linked run {run_id}")


@work.command(name="list", help="list work items (newest activity first)")
@click.option(
    "--status",
    type=click.Choice(["active", "waiting", "blocked", "ready", "done"]),
    default=None,
    help="filter by lifecycle status",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@work_command_context
def list_items(ctx, status, as_json):
    items = [
        entry
        for entry in _load(ctx).values()
        if status is None or entry["status"] == status
    ]
    items.sort(key=lambda entry: entry["updated_time"] or 0, reverse=True)
    if as_json:
        click.echo(json.dumps(items, indent=2, sort_keys=True))
        return
    if not items:
        click.echo("[work] no work items")
        return
    for entry in items:
        next_hint = f"  next: {entry['next_action']}" if entry["next_action"] else ""
        click.echo(
            f"{entry['work_id']}  [{entry['status']}]  ({entry['kind']})  "
            f"{entry['title']}{next_hint}"
        )


@work.command(help="show one work item with its full fact history")
@click.argument("work_id", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@work_command_context
def show(ctx, work_id, as_json):
    entry = _require(ctx, work_id)
    if as_json:
        click.echo(json.dumps(entry, indent=2, sort_keys=True))
        return
    click.echo(f"{entry['work_id']}  [{entry['status']}]  ({entry['kind']})")
    click.echo(f"  title: {entry['title']}")
    if entry["summary"]:
        click.echo(f"  summary: {entry['summary']}")
    if entry["next_action"]:
        click.echo(f"  next: {entry['next_action']}")
    for label in ("checkpoints", "decisions", "validations", "artifacts", "runs"):
        for row in entry[label]:
            detail = {k: v for k, v in row.items() if k != "time" and v is not None}
            click.echo(f"  {label[:-1]}: {json.dumps(detail, sort_keys=True)}")
    for row in entry["history"]:
        if row["event"] == "status":
            click.echo(f"  history: -> {row['status']} ({row.get('reason')})")
