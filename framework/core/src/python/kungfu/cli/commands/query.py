# SPDX-License-Identifier: Apache-2.0

import json
import sys
from pathlib import Path
from typing import Any, NoReturn

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc

query_command_context = kfc.pass_context()

ERROR_SCHEMA = "kungfu.query.error/v1"


def _echo_json(payload: Any, *, err: bool = False) -> None:
    click.echo(json.dumps(payload, indent=2, sort_keys=True), err=err)


def _fail(code: str, message: str, *, exit_code: int = 2) -> NoReturn:
    _echo_json(
        {
            "schema": ERROR_SCHEMA,
            "ok": False,
            "error": {"code": code, "message": message},
        },
        err=True,
    )
    raise click.exceptions.Exit(exit_code)


def _load_definition(file_path: str) -> dict[str, Any]:
    try:
        text = (
            sys.stdin.read()
            if file_path == "-"
            else Path(file_path).read_text(encoding="utf-8")
        )
        value = json.loads(text)
    except (OSError, json.JSONDecodeError) as error:
        _fail("KF_QUERY_INPUT", str(error))
    if not isinstance(value, dict):
        _fail("KF_QUERY_INPUT", "QueryDefinition must be a JSON object")
    return value


def _runtime_dir(ctx: click.Context) -> str:
    # runtime_dir is copied onto the click context dynamically by
    # pass_ctx_from_parent (commands/__init__), so typed access goes through
    # the context dict instead of a (nonexistent) declared attribute.
    return str(ctx.__dict__["runtime_dir"])


def _load_json_object(file_path: str, label: str) -> dict[str, Any]:
    value = _load_definition(file_path)
    if not isinstance(value, dict):
        _fail("KF_QUERY_INPUT", f"{label} must be a JSON object")
    return value


def _load_saved_view(file_path: str) -> dict[str, Any]:
    value = _load_json_object(file_path, "saved query view")
    if value.get("schema") != "kungfu.query.saved-view/v1":
        _fail("KF_QUERY_VIEW", "unsupported saved query view schema")
    if not isinstance(value.get("name"), str) or not value["name"]:
        _fail("KF_QUERY_VIEW", "saved query view requires a name")
    definition = value.get("definition")
    view = value.get("view")
    if not isinstance(definition, dict):
        _fail("KF_QUERY_VIEW", "saved query view requires a QueryDefinition")
    if not isinstance(view, dict) or view.get("kind") not in {
        "table",
        "timeline",
        "diff",
        "causal-graph",
        "attention",
        "mission-control",
    }:
        _fail("KF_QUERY_VIEW", "saved query view requires a supported ViewSpec")
    goal_cards = view.get("goalCards")
    if goal_cards is not None:
        if view.get("kind") != "mission-control":
            _fail("KF_QUERY_VIEW", "goalCards is only valid for Mission Control")
        _validate_goal_card_query(goal_cards)
    return value


def _validate_goal_card_query(value: Any) -> None:
    if not isinstance(value, dict) or value.get("schema") != (
        "kungfu.mission-control.goal-card-query/v1"
    ):
        _fail("KF_QUERY_VIEW", "unsupported goalCards schema")
    arrays = {
        "sections": {"attention", "in-motion", "delegated", "closed"},
        "statuses": None,
        "trust": {"established", "partial", "attention", "stale", "unknown"},
        "actors": None,
        "tracks": None,
        "roles": None,
        "importance": None,
        "stages": None,
    }
    for field, allowed in arrays.items():
        items = value.get(field)
        if (
            not isinstance(items, list)
            or len(items) > 256
            or not all(isinstance(item, str) for item in items)
        ):
            _fail("KF_QUERY_VIEW", f"goalCards.{field} must be a string array")
        if allowed is not None and any(item not in allowed for item in items):
            _fail("KF_QUERY_VIEW", f"goalCards.{field} contains an unsupported value")
    if not isinstance(value.get("text"), str):
        _fail("KF_QUERY_VIEW", "goalCards.text must be a string")
    updated_days = value.get("updatedWithinDays")
    if updated_days is not None and (
        not isinstance(updated_days, (int, float)) or updated_days < 0
    ):
        _fail("KF_QUERY_VIEW", "goalCards.updatedWithinDays must be non-negative")
    if value.get("hasChildren") not in {"all", "yes", "no"}:
        _fail("KF_QUERY_VIEW", "goalCards.hasChildren is unsupported")
    if value.get("closed") not in {"include", "exclude", "only"}:
        _fail("KF_QUERY_VIEW", "goalCards.closed is unsupported")
    if not isinstance(value.get("hideClosedChildren"), bool):
        _fail("KF_QUERY_VIEW", "goalCards.hideClosedChildren must be a boolean")
    sort = value.get("sort")
    if not isinstance(sort, dict) or sort.get("field") not in {
        "decision-priority",
        "updated",
        "importance",
        "trust-risk",
        "next-actor",
        "lifecycle",
        "name",
    }:
        _fail("KF_QUERY_VIEW", "goalCards.sort.field is unsupported")
    if sort.get("direction") not in {"asc", "desc"}:
        _fail("KF_QUERY_VIEW", "goalCards.sort.direction is unsupported")


def _planner_call(ctx: click.Context, action: str, **kwargs: Any) -> dict[str, Any]:
    from kungfu.storage import service

    try:
        return service.query_plan(_runtime_dir(ctx), action=action, **kwargs)
    except (RuntimeError, TypeError, ValueError) as error:
        _fail("KF_QUERY_VALIDATION", str(error))


def _emit_ndjson(result: dict[str, Any]) -> None:
    records = [
        {
            "schema": "kungfu.query.ndjson/v1",
            "type": "metadata",
            "definition": result["definition"],
            "logical_plan": result["logical_plan"],
            "result_schema": result["result_schema"],
        }
    ]
    records.extend(
        {"schema": "kungfu.query.ndjson/v1", "type": "row", "row": row}
        for row in result["rows"]
    )
    records.append(
        {
            "schema": "kungfu.query.ndjson/v1",
            "type": "proof",
            "row_count": result["row_count"],
            "result_hash": result["result_hash"],
            "lineage": result["lineage"],
        }
    )
    for record in records:
        click.echo(json.dumps(record, separators=(",", ":"), sort_keys=True))


def _tsv_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"), sort_keys=True)
    return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def _emit_tsv(result: dict[str, Any]) -> None:
    fields = [field["name"] for field in result["result_schema"]["fields"]]
    click.echo("\t".join(fields))
    for row in result["rows"]:
        click.echo("\t".join(_tsv_value(row.get(field)) for field in fields))


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=3,
    help="discover, validate, explain, and prove canonical fact queries",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def query(ctx: click.Context) -> None:
    pass


@query.command(help="list the versioned query contract and supported surfaces")
@click.option(
    "--json", "as_json", is_flag=True, help="machine-readable output (default)"
)
@query_command_context
def capabilities(ctx: click.Context, as_json: bool) -> None:
    del as_json
    _echo_json(_planner_call(ctx, "capabilities"))


@query.command(help="print the supported QueryDefinition JSON schema")
@click.option(
    "--json", "as_json", is_flag=True, help="machine-readable output (default)"
)
@query_command_context
def schema(ctx: click.Context, as_json: bool) -> None:
    del as_json
    _echo_json(_planner_call(ctx, "schema"))


@query.command(help="describe one queryable object and its canonical result schema")
@click.argument("object_name", metavar="OBJECT")
@click.option(
    "--json", "as_json", is_flag=True, help="machine-readable output (default)"
)
@query_command_context
def describe(ctx: click.Context, object_name: str, as_json: bool) -> None:
    del as_json
    _echo_json(_planner_call(ctx, "describe", object_name=object_name))


@query.command(help="print runnable canonical QueryDefinition examples")
@click.option(
    "--json", "as_json", is_flag=True, help="machine-readable output (default)"
)
@query_command_context
def examples(ctx: click.Context, as_json: bool) -> None:
    del as_json
    _echo_json(_planner_call(ctx, "examples"))


@query.command(
    name="saved-view", help="inspect a shared QueryDefinition + ViewSpec artifact"
)
@click.option(
    "--file", "file_path", required=True, help="kungfu.query.saved-view/v1 JSON path"
)
@click.option(
    "--json", "as_json", is_flag=True, help="machine-readable output (default)"
)
@query_command_context
def saved_view(ctx: click.Context, file_path: str, as_json: bool) -> None:
    del as_json
    value = _load_saved_view(file_path)
    validation = _planner_call(ctx, "validate", definition=value["definition"])
    _echo_json(
        {
            "schema": "kungfu.query.saved-view-inspection/v1",
            "ok": True,
            "name": value["name"],
            "definition": validation["definition"],
            "query_definition_hash": validation["query_definition_hash"],
            "logical_plan_hash": validation["logical_plan_hash"],
            "view": value["view"],
        }
    )


@query.group(name="saved", help="manage workspace-local saved query assets")
@click.help_option("-h", "--help")
@query_command_context
def saved_queries(ctx: click.Context) -> None:
    del ctx
    pass


def _catalog_call(ctx: click.Context, action: str, **kwargs: Any) -> dict[str, Any]:
    from kungfu.storage import service

    try:
        return service.saved_query_catalog(_runtime_dir(ctx), action, **kwargs)
    except (RuntimeError, TypeError, ValueError) as error:
        _fail("KF_SAVED_QUERY", str(error), exit_code=1)


@saved_queries.command(name="list", help="list active saved queries in this workspace")
@click.option("--include-deleted", is_flag=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@query_command_context
def saved_list(ctx: click.Context, include_deleted: bool, as_json: bool) -> None:
    del as_json
    _echo_json(_catalog_call(ctx, "list", include_deleted=include_deleted))


@saved_queries.command(name="import", help="create a saved query from shared JSON")
@click.option("--file", "file_path", required=True, help="saved-view JSON path or -")
@click.option(
    "--id", "query_id", default="", help="stable catalog id; generated when omitted"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@query_command_context
def saved_import(
    ctx: click.Context, file_path: str, query_id: str, as_json: bool
) -> None:
    del as_json
    _echo_json(
        _catalog_call(
            ctx,
            "put",
            saved_view=_load_saved_view(file_path),
            **({"query_id": query_id} if query_id else {}),
        )
    )


@saved_queries.command(name="update", help="append a new revision of a saved query")
@click.argument("query_id")
@click.option("--file", "file_path", required=True, help="saved-view JSON path or -")
@click.option("--expected-revision", type=click.IntRange(min=1), required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@query_command_context
def saved_update(
    ctx: click.Context,
    query_id: str,
    file_path: str,
    expected_revision: int,
    as_json: bool,
) -> None:
    del as_json
    _echo_json(
        _catalog_call(
            ctx,
            "put",
            query_id=query_id,
            expected_revision=expected_revision,
            saved_view=_load_saved_view(file_path),
        )
    )


@saved_queries.command(name="show", help="show one current saved query entry")
@click.argument("query_id")
@click.option("--include-deleted", is_flag=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@query_command_context
def saved_show(
    ctx: click.Context, query_id: str, include_deleted: bool, as_json: bool
) -> None:
    del as_json
    _echo_json(
        _catalog_call(ctx, "get", query_id=query_id, include_deleted=include_deleted)
    )


@saved_queries.command(name="export", help="print portable saved-view JSON")
@click.argument("query_id")
@query_command_context
def saved_export(ctx: click.Context, query_id: str) -> None:
    entry = _catalog_call(ctx, "get", query_id=query_id)
    _echo_json(entry["saved_view"])


@saved_queries.command(name="history", help="show the complete revision history")
@click.argument("query_id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@query_command_context
def saved_history(ctx: click.Context, query_id: str, as_json: bool) -> None:
    del as_json
    _echo_json(_catalog_call(ctx, "history", query_id=query_id))


@saved_queries.command(name="delete", help="append a tombstone revision")
@click.argument("query_id")
@click.option("--expected-revision", type=click.IntRange(min=1), required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@query_command_context
def saved_delete(
    ctx: click.Context, query_id: str, expected_revision: int, as_json: bool
) -> None:
    del as_json
    _echo_json(
        _catalog_call(
            ctx,
            "delete",
            query_id=query_id,
            expected_revision=expected_revision,
        )
    )


@saved_queries.command(name="run", help="run the current saved query revision")
@click.argument("query_id")
@click.option(
    "--engine",
    type=click.Choice(["authority", "sqlite"]),
    default="authority",
    show_default=True,
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@query_command_context
def saved_run(ctx: click.Context, query_id: str, engine: str, as_json: bool) -> None:
    from kungfu.storage import service

    del as_json
    entry = _catalog_call(ctx, "get", query_id=query_id)
    try:
        result = service.fact_query_definition(
            _runtime_dir(ctx), entry["saved_view"]["definition"], engine=engine
        )
    except (RuntimeError, TypeError, ValueError) as error:
        _fail("KF_SAVED_QUERY_RUN", str(error), exit_code=1)
    result["saved_query"] = {
        "query_id": query_id,
        "revision": entry["revision"],
        "saved_view_hash": entry["saved_view_hash"],
    }
    _echo_json(result)


@saved_queries.command(name="rebuild", help="rebuild and verify the catalog fold")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@query_command_context
def saved_rebuild(ctx: click.Context, as_json: bool) -> None:
    del as_json
    _echo_json(_catalog_call(ctx, "rebuild"))


@query.command(help="validate and canonically hash a QueryDefinition")
@click.option(
    "--file",
    "file_path",
    required=True,
    help="QueryDefinition JSON path or - for stdin",
)
@click.option(
    "--json", "as_json", is_flag=True, help="machine-readable output (default)"
)
@query_command_context
def validate(ctx: click.Context, file_path: str, as_json: bool) -> None:
    del as_json
    _echo_json(_planner_call(ctx, "validate", definition=_load_definition(file_path)))


@query.command(help="show the normalized logical plan and bounded execution shape")
@click.option(
    "--file",
    "file_path",
    required=True,
    help="QueryDefinition JSON path or - for stdin",
)
@click.option(
    "--json", "as_json", is_flag=True, help="machine-readable output (default)"
)
@click.option(
    "--engine",
    type=click.Choice(["authority", "sqlite"]),
    default="authority",
    show_default=True,
)
@query_command_context
def explain(ctx: click.Context, file_path: str, as_json: bool, engine: str) -> None:
    del as_json
    _echo_json(
        _planner_call(
            ctx, "explain", definition=_load_definition(file_path), engine=engine
        )
    )


@query.command(
    name="compile-sql", help="compile bounded SQL into the canonical LogicalPlan"
)
@click.option("--sql", required=True, help="bounded SELECT over episodes")
@click.option(
    "--file",
    "file_path",
    required=True,
    help="base QueryDefinition JSON path or - for stdin; owns basis and cut",
)
@click.option(
    "--json", "as_json", is_flag=True, help="machine-readable output (default)"
)
@query_command_context
def compile_sql(ctx: click.Context, sql: str, file_path: str, as_json: bool) -> None:
    del as_json
    _echo_json(
        _planner_call(
            ctx,
            "compile-sql",
            definition=_load_definition(file_path),
            sql=sql,
        )
    )


@query.command(help="execute one declared engine and emit rows with proof lineage")
@click.option(
    "--file", "file_path", default=None, help="QueryDefinition JSON path or - for stdin"
)
@click.option(
    "--episode-id",
    type=click.IntRange(min=0),
    default=0,
    help="semantic shortcut filter",
)
@click.option(
    "--cut", "cut_token", default=None, help="exact manifest_frame_uid cut token"
)
@click.option(
    "--limit", type=click.IntRange(min=1, max=1000), default=100, show_default=True
)
@click.option(
    "--engine",
    type=click.Choice(["authority", "sqlite"]),
    default="authority",
    show_default=True,
)
@click.option(
    "--json", "as_json", is_flag=True, help="emit the full proof envelope (default)"
)
@click.option(
    "--ndjson", "as_ndjson", is_flag=True, help="emit metadata, rows, and proof records"
)
@click.option("--tsv", "as_tsv", is_flag=True, help="emit a shell-composable row table")
@query_command_context
def prove(
    ctx: click.Context,
    file_path: str | None,
    episode_id: int,
    cut_token: str | None,
    limit: int,
    engine: str,
    as_json: bool,
    as_ndjson: bool,
    as_tsv: bool,
) -> None:
    from kungfu.storage import service

    selected_formats = sum((as_json, as_ndjson, as_tsv))
    if selected_formats > 1:
        _fail("KF_QUERY_OUTPUT", "choose only one of --json, --ndjson, or --tsv")
    if file_path and (episode_id != 0 or cut_token is not None or limit != 100):
        _fail(
            "KF_QUERY_INPUT", "--file cannot be combined with semantic shortcut options"
        )
    if file_path:
        definition = _load_definition(file_path)
    else:
        cut = (
            {"kind": "manifest_frame_uid", "manifest_frame_uid": cut_token}
            if cut_token is not None
            else {"kind": "head"}
        )
        definition = service.build_fact_query_definition(
            episode_id=episode_id, cut=cut, limit=limit
        )
    try:
        result = service.fact_query_definition(
            _runtime_dir(ctx), definition, engine=engine
        )
    except (RuntimeError, TypeError, ValueError) as error:
        _fail("KF_QUERY_EXECUTION", str(error), exit_code=1)
    if as_ndjson:
        _emit_ndjson(result)
    elif as_tsv:
        _emit_tsv(result)
    else:
        _echo_json(result)


@query.command(help="read one resumable page of the proof-carrying changelog")
@click.option(
    "--file",
    "file_path",
    required=True,
    help="head-cut QueryDefinition JSON path or - for stdin",
)
@click.option(
    "--resume-file",
    default=None,
    help="resume-token JSON path returned by an earlier page",
)
@click.option(
    "--max-messages",
    type=click.IntRange(min=1, max=10000),
    default=100,
    show_default=True,
)
@click.option(
    "--json", "as_json", is_flag=True, help="machine-readable output (default)"
)
@query_command_context
def changelog(
    ctx: click.Context,
    file_path: str,
    resume_file: str | None,
    max_messages: int,
    as_json: bool,
) -> None:
    from kungfu.storage import service

    del as_json
    resume_token = (
        _load_json_object(resume_file, "resume token") if resume_file else None
    )
    try:
        result = service.fact_changelog(
            _runtime_dir(ctx),
            _load_definition(file_path),
            resume_token=resume_token,
            max_messages=max_messages,
        )
    except (RuntimeError, TypeError, ValueError) as error:
        _fail("KF_QUERY_CHANGELOG", str(error), exit_code=1)
    _echo_json(result)
