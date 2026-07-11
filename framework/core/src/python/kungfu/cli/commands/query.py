# SPDX-License-Identifier: Apache-2.0

import json
import sys
from pathlib import Path
from typing import Any

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc

query_command_context = kfc.pass_context()

ERROR_SCHEMA = "kungfu.query.error/v1"


def _echo_json(payload: Any, *, err: bool = False) -> None:
    click.echo(json.dumps(payload, indent=2, sort_keys=True), err=err)


def _fail(code: str, message: str, *, exit_code: int = 2) -> None:
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


def _planner_call(ctx: click.Context, action: str, **kwargs: Any) -> dict[str, Any]:
    from kungfu.storage import service

    try:
        return service.query_plan(ctx.runtime_dir, action=action, **kwargs)
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
@query_command_context
def explain(ctx: click.Context, file_path: str, as_json: bool) -> None:
    del as_json
    _echo_json(_planner_call(ctx, "explain", definition=_load_definition(file_path)))


@query.command(help="execute the authority-scan plan and emit rows with proof lineage")
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
        result = service.fact_query_definition(ctx.runtime_dir, definition)
    except (RuntimeError, TypeError, ValueError) as error:
        _fail("KF_QUERY_EXECUTION", str(error), exit_code=1)
    if as_ndjson:
        _emit_ndjson(result)
    elif as_tsv:
        _emit_tsv(result)
    else:
        _echo_json(result)
