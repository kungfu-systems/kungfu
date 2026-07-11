# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.workspace import (
    current_workspace,
    ensure_workspace_data_home,
    inspect_workspace,
    load_workspace_registry,
    select_workspace,
)


def _json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _identity_or_error(path: str | None, home: bool):
    identity = inspect_workspace(path, home=home)
    if identity is None:
        raise click.ClickException(
            "no project workspace was discovered; pass a path or --home"
        )
    return identity


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="inspect and select Kungfu Home or project workspaces",
)
@click.help_option("-h", "--help")
def workspace():
    pass


@workspace.command(help="inspect a workspace candidate without creating it")
@click.argument("path", required=False)
@click.option("--home", is_flag=True, help="inspect the logical Home Workspace")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def inspect(path, home, as_json):
    payload = _identity_or_error(path, home).as_dict()
    if as_json:
        _json(payload)
        return
    click.echo(
        f"{payload['workspace_kind']} {payload['data_home']} ({payload['state']})"
    )


@workspace.command(help="resolve the current CLI workspace without GUI recents")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def current(as_json):
    payload = current_workspace()
    if as_json:
        _json(payload)
        return
    if not payload["selected"]:
        click.echo("no project workspace selected")
        return
    click.echo(f"{payload['workspace_kind']} {payload['data_home']}")


@workspace.command(name="list", help="list the global recent-workspace registry")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def list_workspaces(as_json):
    payload = load_workspace_registry()
    if as_json:
        _json(payload)
        return
    if not payload["recent"]:
        click.echo("no recent workspaces")
        return
    for item in payload["recent"]:
        marker = "*" if item["workspace_id"] == payload["last_workspace_id"] else " "
        click.echo(f"{marker} {item['workspace_kind']} {item['display_path']}")


@workspace.command(help="select a project for Desktop without creating .kungfu")
@click.argument("path")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def select(path, as_json):
    payload = select_workspace(_identity_or_error(path, False))
    if as_json:
        _json(payload)
        return
    click.echo(f"selected {payload['selected']['display_path']}")


@workspace.command(name="select-home", help="select Home without creating ~/.kungfu")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def select_home(as_json):
    payload = select_workspace(_identity_or_error(None, True))
    if as_json:
        _json(payload)
        return
    click.echo("selected Home")


@workspace.command(help="initialize a selected data home for one write intent")
@click.argument("path", required=False)
@click.option("--home", is_flag=True, help="initialize the logical Home Workspace")
@click.option("--reason", required=True, help="fact-bearing write intent")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def ensure(path, home, reason, as_json):
    payload = ensure_workspace_data_home(_identity_or_error(path, home), reason)
    if as_json:
        _json(payload)
        return
    click.echo("initialized" if payload["initialized"] else "already initialized")
