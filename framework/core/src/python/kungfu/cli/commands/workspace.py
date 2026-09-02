# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import signal
from functools import wraps as wraps

import click

from kungfu.distribution_update import local_dogfood_residency
from kungfu.cli.surface_contract import surface
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.commands._workspace.admission import (
    admission_command as _admission_command_impl,
)
from kungfu.cli.commands._workspace.presentation import (
    human_initiative_group_line as _human_initiative_group_line_impl,
    human_work_line as _human_work_line_impl,
)
from kungfu.workspace import (
    current_workspace,
    ensure_workspace_data_home,
    import_full_evidence,
    inspect_workspace,
    load_workspace_catalog,
    load_workspace_registry,
    maintain_workspace_catalog,
    rebuild_workspace_catalog,
    rebind_workspace_locator,
    request_full_evidence,
    select_workspace,
    verify_workspace_catalog,
)
from kungfu.workspace_federation import (
    build_dogfood_gate_receipt,
    qualify_assignment_graph,
    query_federation,
)
from kungfu.workspace_federation_observer import observe_federation
from kungfu.workspace_history import (
    apply_work_history_liquidation,
    plan_work_history_liquidation,
    save_work_history_liquidation_plan,
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


def _human_work_line(row, width):
    return _human_work_line_impl(row, width)


def _human_initiative_group_line(group, width):
    return _human_initiative_group_line_impl(group, width)


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
    return _admission_command_impl(initiator)


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
    name="catalog-maintain",
    help="plan or execute explicit reversible Catalog lifecycle transitions",
)
@click.option(
    "--entry-key",
    "entry_keys",
    multiple=True,
    required=True,
    help="exact identity_root or locator_key; repeat for a bounded batch",
)
@click.option(
    "--action",
    type=click.Choice(["retire", "test-only", "quarantine", "restore"]),
    required=True,
)
@click.option("--reason", required=True, help="auditable lifecycle reason")
@click.option(
    "--execute",
    is_flag=True,
    help="write the exact dry-run transition and durable receipt",
)
@click.option(
    "--transitioned-at",
    help="reuse the transition timestamp from an exact dry-run plan",
)
@click.option(
    "--expected-plan-root",
    help="execute only when the recomputed transition matches this dry-run root",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def catalog_maintain(
    entry_keys,
    action,
    reason,
    execute,
    transitioned_at,
    expected_plan_root,
    as_json,
):
    try:
        payload = maintain_workspace_catalog(
            list(entry_keys),
            action,
            reason,
            execute=execute,
            transitioned_at=transitioned_at,
            expected_plan_root=expected_plan_root,
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    verb = "updated" if payload["executed"] else "would update"
    click.echo(
        f"{verb} {len(payload['changes'])} Catalog entries "
        f"{payload['catalog_cut_before']} -> {payload['catalog_cut_after']}"
    )
    for change in payload["changes"]:
        click.echo(
            f"{change['entry_key']} "
            f"{change['before']['lifecycle']['state']} -> "
            f"{change['after']['lifecycle']['state']} "
            f"{change.get('locator') or 'Home'}"
        )


@workspace.command(
    name="work-history-liquidate",
    help="plan or apply rooted terminal dispositions for one exact Work History cut",
)
@click.option(
    "--evidence",
    "evidence_path",
    type=click.Path(exists=True, dir_okay=False),
    help="rooted evidence declaration for a fresh dry-run plan",
)
@click.option(
    "--save-plan",
    type=click.Path(dir_okay=False),
    help="explicitly persist the dry-run plan for expected-root execution",
)
@click.option(
    "--execute-plan",
    type=click.Path(exists=True, dir_okay=False),
    help="apply this previously saved exact plan",
)
@click.option(
    "--expected-plan-root",
    help="execute only when the saved plan has this exact root",
)
@click.option(
    "--transitioned-at",
    help="fixed ISO-8601 lifecycle time for a reproducible dry-run plan",
)
@click.option(
    "--max-workers",
    type=click.IntRange(1, 16),
    default=4,
    show_default=True,
    help="bounded read-only component readers used during planning",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@surface(mutation_class="write")
def work_history_liquidate(
    evidence_path,
    save_plan,
    execute_plan,
    expected_plan_root,
    transitioned_at,
    max_workers,
    as_json,
):
    try:
        if execute_plan:
            if evidence_path or save_plan or transitioned_at:
                raise click.UsageError(
                    "--execute-plan cannot be combined with planning options"
                )
            if not expected_plan_root:
                raise click.UsageError(
                    "--expected-plan-root is required with --execute-plan"
                )
            with open(execute_plan, encoding="utf-8") as stream:
                saved_plan = json.load(stream)
            payload = apply_work_history_liquidation(
                saved_plan,
                expected_plan_root,
            )
        else:
            if not evidence_path:
                raise click.UsageError("--evidence is required for planning")
            if expected_plan_root:
                raise click.UsageError(
                    "--expected-plan-root is only valid with --execute-plan"
                )
            with open(evidence_path, encoding="utf-8") as stream:
                evidence = json.load(stream)
            identity = _identity_or_error(None, True)
            query = query_federation(
                identity,
                scope="all",
                include_excluded=True,
                include_settled=True,
                max_workers=max_workers,
            )
            payload = plan_work_history_liquidation(
                query,
                load_workspace_catalog(),
                evidence,
                transitioned_at=transitioned_at,
            )
            if save_plan:
                payload = {
                    **payload,
                    "saved_plan": save_work_history_liquidation_plan(
                        save_plan, payload
                    ),
                }
    except click.UsageError:
        raise
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    verb = "applied" if payload.get("executed") else "planned"
    counts = payload["counts"]
    click.echo(
        f"{verb} {counts['component_disposition_count']} component and "
        f"{counts['reference_disposition_count']} reference dispositions "
        f"with unchecked=0 at {payload['plan_root']}"
    )


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
@click.option(
    "--strict",
    is_flag=True,
    help="exit nonzero unless every component and proof is complete",
)
@click.option(
    "--include-settled",
    is_flag=True,
    help="include completed, archived, and closed canonical Work",
)
@click.option(
    "--include-excluded",
    is_flag=True,
    help="include policy-excluded Catalog components in raw component details",
)
@click.option(
    "--max-workers",
    type=click.IntRange(1, 16),
    default=1,
    show_default=True,
    help="parallel read-only component readers for large local Catalogs",
)
@click.option(
    "--details",
    type=click.Choice(
        ["summary", "components", "replicas", "conflicts", "unresolved", "proof"]
    ),
    default="summary",
    show_default=True,
    help="select progressive-disclosure detail for human output",
)
@click.option(
    "--gate-phase",
    type=click.Choice(["kickoff", "stage-ready", "closeout"]),
    help="emit a proof-bound installed-controller dogfood receipt",
)
@click.option(
    "--observe",
    is_flag=True,
    help="stream incremental global Work snapshots for the installed GUI",
)
@click.option(
    "--observer-state",
    type=click.Path(dir_okay=False),
    help="machine-local durable cursor/cache path required by --observe",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def work(
    path,
    home,
    scope,
    start_ref_file,
    direction,
    relation_types,
    strict,
    include_settled,
    include_excluded,
    max_workers,
    details,
    gate_phase,
    observe,
    observer_state,
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
        current = _identity_or_home_default(path, home)
        if observe:
            if scope != "all" or not as_json or not observer_state:
                raise ValueError(
                    "--observe requires --scope all --json --observer-state PATH"
                )
            if start_ref or gate_phase or include_excluded:
                raise ValueError(
                    "--observe does not accept traversal, gate, or excluded-locator options"
                )
            stop_requested = False

            def request_stop(_signum, _frame):
                nonlocal stop_requested
                stop_requested = True

            previous_sigterm = signal.signal(signal.SIGTERM, request_stop)
            try:
                for event in observe_federation(
                    current,
                    state_path=observer_state,
                    max_workers=max_workers,
                    include_settled=include_settled,
                    stop=lambda: stop_requested,
                ):
                    click.echo(json.dumps(event, sort_keys=True))
            except KeyboardInterrupt:
                pass
            finally:
                signal.signal(signal.SIGTERM, previous_sigterm)
            return
        payload = query_federation(
            current,
            scope=scope,
            start_ref=start_ref,
            direction=direction,
            relation_types=relation_types or None,
            include_excluded=include_excluded,
            include_settled=include_settled,
            max_workers=max_workers,
        )
        if gate_phase:
            payload["dogfood_gate_receipt"] = build_dogfood_gate_receipt(
                payload,
                local_dogfood_residency(),
                gate_phase,
            )
    except (OSError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        gate_verified = (
            payload.get("dogfood_gate_receipt", {})
            .get("verification", {})
            .get("ok", True)
        )
        if strict and (not payload["aggregate"]["complete"] or not gate_verified):
            raise SystemExit(2)
        return
    projection = payload["global_work"]
    aggregate = payload["aggregate"]
    if aggregate["state"] != "complete":
        click.echo(
            f"global Work is {aggregate['state']}; "
            f"required unknown={aggregate['unknown_component_count']} "
            f"conflicts={aggregate['conflict_count']} "
            f"unresolved={aggregate['unresolved_reference_count']}",
            err=True,
        )
    width = max(40, click.get_current_context().terminal_width or 80)
    for group in projection["visible_initiative_groups"]:
        click.echo(_human_initiative_group_line(group, width))
    for row in projection["visible_work"]:
        if row["object_kind"] == "initiative":
            continue
        click.echo(_human_work_line(row, width))
    if details == "components":
        for component in payload["components"]:
            workspace_row = component["workspace"]
            click.echo(
                f"component {workspace_row['workspace_id']} "
                f"{component['availability']} cut={component.get('cut_root') or '-'}"
            )
    elif details == "replicas":
        for row in projection["canonical_work"]:
            if row["replica_count"]:
                click.echo(
                    f"replica-set {row['canonical_root']} "
                    f"observations={row['observation_count']}"
                )
    elif details == "conflicts":
        for row in projection["canonical_work"]:
            if row["conflict"]:
                click.echo(
                    f"conflict {row['canonical_root']} "
                    f"{','.join(row['conflict_reasons'])}"
                )
    elif details == "unresolved":
        for row in projection["reference_resolution"]["unresolved"]:
            click.echo(f"unresolved {row['code']} {row.get('dependency_id') or ''}")
    elif details == "proof":
        click.echo(
            f"catalog-cut={payload['proof']['catalog_cut']} "
            f"query-proof={payload['proof']['proof_root']} "
            f"projection={projection['projection_root']} "
            f"verified={payload['verification']['ok']}"
        )
    if payload["proof"]["unresolved_references"]:
        click.echo(
            f"unresolved={len(payload['proof']['unresolved_references'])}",
            err=True,
        )
    click.echo(
        f"global={aggregate['state']} visible={projection['visible_work_count']} "
        f"canonical={aggregate['canonical_work_count']} "
        f"observations={aggregate['work_observation_count']} "
        f"components={aggregate['component_observation_count']} "
        f"replicas={aggregate['replica_count']} conflicts={aggregate['conflict_count']} "
        f"label-collisions={aggregate['label_collision_count']} "
        f"retained-seals={aggregate['retained_assignment_state_count']} "
        f"legacy-seals={aggregate['unqualified_retained_assignment_state_count']} "
        f"unavailable={aggregate['unavailable_component_count']} "
        f"stale={aggregate['stale_component_count']} "
        f"excluded={aggregate['excluded_component_count']} "
        f"unresolved={aggregate['unresolved_reference_count']} "
        f"proof={'ok' if aggregate['proof_ok'] else 'failed'} writes=0"
    )
    if aggregate["false_zero_guard"] == "unknown-not-empty":
        click.echo(
            "known assignments are zero, but the graph is unknown rather than empty",
            err=True,
        )
    if strict and not aggregate["complete"]:
        raise SystemExit(2)


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
