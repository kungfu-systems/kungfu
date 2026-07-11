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
from kungfu.workspace_guidance import (
    WorkspaceGuidanceError,
    advise_workspace,
    authorize_workspace_action,
    execute_workspace_action,
    inspect_guidance,
    preview_workspace_action,
    verify_workspace_action,
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


def _guidance_error(error: WorkspaceGuidanceError, as_json: bool):
    if as_json:
        _json(error.diagnosis)
        raise click.exceptions.Exit(2) from error
    raise click.ClickException(str(error)) from error


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


@workspace.command(name="inspect-guidance", help="inspect project-gravity facts")
@click.argument("path", required=False)
@click.option("--home", is_flag=True, help="inspect guidance from Home")
@click.option("--source", required=True, type=click.Path(file_okay=False))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def inspect_guidance_cmd(path, home, source, as_json):
    try:
        payload = inspect_guidance(_identity_or_error(path, home), source_path=source)
    except WorkspaceGuidanceError as error:
        _guidance_error(error, as_json)
    if as_json:
        _json(payload)
        return
    click.echo(
        f"cut {payload['cut_id']} · captures {payload['unassigned_capture_count']}"
    )


@workspace.command(help="produce bounded project-workspace advice")
@click.argument("path", required=False)
@click.option("--home", is_flag=True, help="advise from Home")
@click.option("--source", required=True, type=click.Path(file_okay=False))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def advise(path, home, source, as_json):
    try:
        payload = advise_workspace(
            inspect_guidance(_identity_or_error(path, home), source_path=source)
        )
    except WorkspaceGuidanceError as error:
        _guidance_error(error, as_json)
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['state']} · {', '.join(payload['reason_codes'])}")


@workspace.command(help="preview exact effects and required authorization")
@click.argument("path", required=False)
@click.option("--home", is_flag=True, help="preview from Home")
@click.option("--source", required=True, type=click.Path(file_okay=False))
@click.option(
    "--intent",
    required=True,
    type=click.Choice(
        [
            "create-project-workspace",
            "prepare-portable-contract",
            "keep-home",
            "suppress-source",
        ]
    ),
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def preview(path, home, source, intent, as_json):
    try:
        identity = _identity_or_error(path, home)
        payload = preview_workspace_action(
            advise_workspace(inspect_guidance(identity, source_path=source)), intent
        )
    except WorkspaceGuidanceError as error:
        _guidance_error(error, as_json)
    if as_json:
        _json(payload)
        return
    click.echo(
        f"{payload['preview_id']} · authorization={payload['authorization_class']}"
    )


@workspace.command(help="record a bounded decision for one exact preview")
@click.argument("path", required=False)
@click.option("--home", is_flag=True, help="record the decision in Home")
@click.option("--source", required=True, type=click.Path(file_okay=False))
@click.option(
    "--intent",
    required=True,
    type=click.Choice(
        [
            "create-project-workspace",
            "prepare-portable-contract",
            "keep-home",
            "suppress-source",
        ]
    ),
)
@click.option("--preview-id", required=True)
@click.option("--decision", required=True, type=click.Choice(["approve", "deny"]))
@click.option("--authorized-by", required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def authorize(
    path,
    home,
    source,
    intent,
    preview_id,
    decision,
    authorized_by,
    as_json,
):
    try:
        identity = _identity_or_error(path, home)
        current_preview = preview_workspace_action(
            advise_workspace(inspect_guidance(identity, source_path=source)), intent
        )
        payload = authorize_workspace_action(
            identity,
            current_preview,
            expected_preview_id=preview_id,
            decision=decision,
            authorized_by=authorized_by,
        )
    except WorkspaceGuidanceError as error:
        _guidance_error(error, as_json)
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['authorization_id']} · {payload['decision']}")


@workspace.command(help="execute one authorized idempotent workspace intent")
@click.argument("path", required=False)
@click.option("--home", is_flag=True, help="read authorization from Home")
@click.option("--source", required=True, type=click.Path(file_okay=False))
@click.option("--authorization-id", required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def apply(path, home, source, authorization_id, as_json):
    try:
        payload = execute_workspace_action(
            _identity_or_error(path, home),
            source_path=source,
            authorization_id=authorization_id,
        )
    except WorkspaceGuidanceError as error:
        _guidance_error(error, as_json)
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['receipt_id']} · reused={payload['reused']}")


@workspace.command(help="verify an action receipt against current effects")
@click.argument("path", required=False)
@click.option("--home", is_flag=True, help="read the receipt from Home")
@click.option("--receipt-id", required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def verify(path, home, receipt_id, as_json):
    try:
        payload = verify_workspace_action(_identity_or_error(path, home), receipt_id)
    except WorkspaceGuidanceError as error:
        _guidance_error(error, as_json)
    if as_json:
        _json(payload)
        if not payload["ok"]:
            raise click.exceptions.Exit(1)
        return
    click.echo("verified" if payload["ok"] else "verification failed")
    if not payload["ok"]:
        raise click.exceptions.Exit(1)
