# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from functools import wraps

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.workspace import (
    current_workspace,
    ensure_workspace_data_home,
    import_full_evidence,
    inspect_workspace,
    load_workspace_catalog,
    load_workspace_registry,
    rebuild_workspace_catalog,
    rebind_workspace_locator,
    request_full_evidence,
    select_workspace,
    verify_workspace_catalog,
)
from kungfu.workspace_federation import qualify_assignment_graph, query_federation
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


def _identity_or_home_default(path: str | None, home: bool):
    if path or home:
        return _identity_or_error(path, home)
    return inspect_workspace() or _identity_or_error(None, True)


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


def _admission_command(initiator: str):
    def decorate(function):
        @wraps(function)
        def wrapped(
            source_runtime,
            destination_runtime,
            episode_ids,
            transport,
            action,
            plan_root,
            project_cut_root,
            bundle_files,
            source_id,
            as_json,
        ):
            from kungfu.storage import service

            if (
                action in {"plan", "execute", "resume"}
                and transport == "local-direct"
                and (not source_runtime or not episode_ids)
            ):
                raise click.UsageError(
                    "--source-runtime and at least one --episode-id are required"
                )
            if (
                action in {"plan", "execute", "resume"}
                and transport != "local-direct"
                and (not bundle_files or not source_id)
            ):
                raise click.UsageError(
                    "--bundle-file and --source-id are required for bundle and remote-stream"
                )
            if action in {"inspect", "resume", "reconcile", "cancel"} and not plan_root:
                raise click.UsageError(f"--plan-root is required for {action}")
            episode_bundles = []
            for bundle_file in bundle_files:
                with open(bundle_file, encoding="utf-8") as input_file:
                    episode_bundles.append(json.load(input_file))
            values = {
                "source_runtime_dir": source_runtime,
                "episode_ids": list(episode_ids),
                "transport": transport,
                "initiator": initiator,
                "plan_root": plan_root,
                "project_cut_roots": list(project_cut_root),
                "episode_bundles": episode_bundles or None,
                "source_identity": (
                    {
                        "schema": "kungfu.workspace.identity/v1",
                        "kind": "declared",
                        "id": source_id,
                    }
                    if source_id
                    else None
                ),
            }
            if action == "execute":
                plan = service.episode_admission(
                    destination_runtime, action="plan", **values
                )
                payload = service.episode_admission(
                    destination_runtime, action="execute", plan=plan, **values
                )
            else:
                payload = service.episode_admission(
                    destination_runtime, action=action, **values
                )
            if as_json:
                _json(payload)
                return
            click.echo(
                f"{initiator} {payload.get('status', 'planned')} "
                f"{payload.get('plan_root', plan_root)}"
            )

        wrapped = click.option(
            "--json", "as_json", is_flag=True, help="machine-readable output"
        )(wrapped)
        wrapped = click.option(
            "--source-id",
            default="",
            help="declared source identity for non-local transports",
        )(wrapped)
        wrapped = click.option(
            "--bundle-file",
            "bundle_files",
            multiple=True,
            type=click.Path(exists=True, dir_okay=False),
            help="self-contained Episode bundle for bundle or remote-stream",
        )(wrapped)
        wrapped = click.option(
            "--project-cut-root", multiple=True, help="related Project Cut root"
        )(wrapped)
        wrapped = click.option(
            "--plan-root", default="", help="existing plan root for lifecycle actions"
        )(wrapped)
        wrapped = click.option(
            "--action",
            type=click.Choice(
                ["plan", "execute", "inspect", "resume", "reconcile", "cancel"]
            ),
            default="plan",
            show_default=True,
        )(wrapped)
        wrapped = click.option(
            "--transport",
            type=click.Choice(["local-direct", "bundle", "remote-stream"]),
            default="local-direct",
            show_default=True,
        )(wrapped)
        wrapped = click.option("--episode-id", "episode_ids", multiple=True, type=int)(
            wrapped
        )
        wrapped = click.option(
            "--destination-runtime",
            required=True,
            type=click.Path(file_okay=False),
            help="destination workspace runtime directory",
        )(wrapped)
        wrapped = click.option(
            "--source-runtime",
            type=click.Path(file_okay=False),
            help="source workspace runtime directory",
        )(wrapped)
        return wrapped

    return decorate


@workspace.command(
    help="destination-initiated Episode Admission from another workspace"
)
@_admission_command("destination-pull")
def pull(**_kwargs):
    pass


@workspace.command(
    help="source-initiated proposal to destination-owned Episode Admission"
)
@_admission_command("source-push")
def push(**_kwargs):
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


@workspace.command(
    name="catalog",
    help="list the complete machine-local Workspace Locator Catalog",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def catalog(as_json):
    payload = load_workspace_catalog()
    if as_json:
        _json(payload)
        return
    if payload["issues"]:
        raise click.ClickException(payload["issues"][0]["message"])
    if not payload["entries"]:
        click.echo("no cataloged workspaces")
        return
    for item in payload["entries"]:
        state = "available" if item["available"] else "unavailable"
        click.echo(f"{item['workspace_id']} {state} {item.get('locator') or 'Home'}")


@workspace.command(
    name="catalog-verify",
    help="verify Catalog locators without repairing or changing authority",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def catalog_verify(as_json):
    payload = verify_workspace_catalog()
    if as_json:
        _json(payload)
        if not payload["ok"]:
            raise click.exceptions.Exit(1)
        return
    click.echo("verified" if payload["ok"] else "catalog verification failed")
    if not payload["ok"]:
        raise click.exceptions.Exit(1)


@workspace.command(
    name="catalog-rebuild",
    help="rebuild Catalog from bounded recents and explicit locators; never scan",
)
@click.argument("paths", nargs=-1, type=click.Path(file_okay=False))
@click.option(
    "--no-recents",
    is_flag=True,
    help="use only the explicit path arguments",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def catalog_rebuild(paths, no_recents, as_json):
    try:
        payload = rebuild_workspace_catalog(
            list(paths),
            include_recents=not no_recents,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"rebuilt {len(payload['entries'])} catalog entries without scanning")


@workspace.command(
    name="catalog-rebind",
    help="rebind one exact workspace identity to a moved project locator",
)
@click.argument("identity_root")
@click.argument("path", type=click.Path(exists=True, file_okay=False))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def catalog_rebind(identity_root, path, as_json):
    try:
        payload = rebind_workspace_locator(identity_root, path)
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"rebound {payload['observed']['workspace_id']} to {path}")


@workspace.command(
    name="work",
    help="query local or federated Initiative/Assignment work without writes",
)
@click.argument("path", required=False)
@click.option("--home", is_flag=True, help="query from the logical Home Workspace")
@click.option(
    "--scope",
    type=click.Choice(["local", "related", "all"]),
    default="local",
    show_default=True,
)
@click.option(
    "--from-ref",
    "start_ref_file",
    type=click.Path(exists=True, dir_okay=False),
    help="traverse from one exact WorkRef JSON object",
)
@click.option(
    "--direction",
    type=click.Choice(["forward", "backward", "both"]),
    default="both",
    show_default=True,
)
@click.option(
    "--relation-type",
    "relation_types",
    multiple=True,
    help="limit traversal to one or more typed relations",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def work(
    path,
    home,
    scope,
    start_ref_file,
    direction,
    relation_types,
    as_json,
):
    try:
        start_ref = None
        if start_ref_file:
            with open(start_ref_file, encoding="utf-8") as stream:
                start_ref = json.load(stream)
            if isinstance(start_ref, dict) and isinstance(
                start_ref.get("work_ref"), dict
            ):
                start_ref = start_ref["work_ref"]
            if not isinstance(start_ref, dict):
                raise ValueError("--from-ref must contain one WorkRef object")
        payload = query_federation(
            _identity_or_home_default(path, home),
            scope=scope,
            start_ref=start_ref,
            direction=direction,
            relation_types=relation_types or None,
        )
    except (OSError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    for component in payload["components"]:
        workspace_row = component["workspace"]
        click.echo(
            f"{workspace_row['workspace_id']} {component['availability']} "
            f"initiatives={len(component['initiatives'])} "
            f"assignments={len(component['assignments'])}"
        )
    if payload["proof"]["unresolved_references"]:
        click.echo(
            f"unresolved={len(payload['proof']['unresolved_references'])}",
            err=True,
        )


@workspace.command(
    name="graph-qualify",
    help="qualify typed Assignment graph relations and relation-specific cycles",
)
@click.option(
    "--from",
    "relation_file",
    type=click.Path(exists=True, dir_okay=False),
    required=True,
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def graph_qualify(relation_file, as_json):
    try:
        with open(relation_file, encoding="utf-8") as stream:
            value = json.load(stream)
        relations = value.get("relations") if isinstance(value, dict) else value
        if not isinstance(relations, list):
            raise ValueError("relation input must be an array or {relations: [...]}")
        payload = qualify_assignment_graph(relations)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        if not payload["ok"]:
            raise click.exceptions.Exit(1)
        return
    click.echo("qualified" if payload["ok"] else "graph qualification failed")
    if not payload["ok"]:
        raise click.exceptions.Exit(1)


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


@workspace.command(
    name="request-full-evidence",
    help="plan an exact full-evidence request without creating runtime state",
)
@click.argument("path")
@click.option("--episode-root", "episode_roots", multiple=True)
@click.option("--project-cut-root", "project_cut_roots", multiple=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def request_full_evidence_cmd(path, episode_roots, project_cut_roots, as_json):
    try:
        payload = request_full_evidence(
            _identity_or_error(path, False),
            episode_roots=list(episode_roots),
            project_cut_roots=list(project_cut_roots),
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(
        f"{payload['plan_root']} · missing={len(payload['missing_episode_roots'])}"
    )


@workspace.command(
    name="import-full-evidence",
    help="validate or import one full Episode bundle for settled history",
)
@click.argument("path")
@click.option("--from", "bundle_path", type=click.Path(dir_okay=False), required=True)
@click.option("--execute", is_flag=True, help="materialize the validated bundle")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def import_full_evidence_cmd(path, bundle_path, execute, as_json):
    try:
        payload = import_full_evidence(
            _identity_or_error(path, False), bundle_path, execute=execute
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    if execute:
        click.echo(f"{payload['receipt']['receipt_root']} · imported")
    else:
        click.echo(f"{payload['plan_root']} · validated")


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
