# SPDX-License-Identifier: Apache-2.0

"""KFD-7 Work Profile commands owned by the ``kungfu agent`` facade."""

import base64
import json
import sys
from pathlib import Path

import click

from kungfu.agent import work_profile
from kungfu.agent.kfd3 import api_help, kfd3_api
from kungfu.cli.commands._agent.base import _json, agent, agent_command_context


@agent.group(name="work", help=api_help("kungfu.agent.work"))
@kfd3_api("kungfu.agent.work")
@agent_command_context
def work(ctx):
    """Inspect and apply the KFD-7 Kungfu Product Profile."""


@work.command(name="capabilities", help=api_help("kungfu.agent.work.capabilities"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.capabilities")
@agent_command_context
def work_capabilities(ctx, as_json):
    payload = work_profile.capabilities()
    if as_json:
        _json(payload)
        return
    click.echo("Kungfu KFD-7 Profile capabilities")
    for role in payload["roles"]:
        click.echo(f"- {role}")


@work.command(name="session", help=api_help("kungfu.agent.work.session"))
@click.option(
    "--operation",
    type=click.Choice(["compressibility", "expand", "project"]),
    required=True,
)
@click.option("--file", "file_path", help="session or expansion JSON path or -")
@click.option(
    "--input-base64",
    help="base64-encoded session or expansion JSON for SDK and GUI adapters",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.session")
@agent_command_context
def work_session(ctx, operation, file_path, input_base64, as_json):
    """Expand, project, or test the complexity boundary of one session."""

    try:
        if bool(file_path) == bool(input_base64):
            raise ValueError("exactly one of --file or --input-base64 is required")
        if input_base64:
            raw = base64.b64decode(input_base64, validate=True).decode("utf-8")
        else:
            raw = (
                sys.stdin.read()
                if file_path == "-"
                else Path(file_path).read_text(encoding="utf-8")
            )
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("session input must be a JSON object")
        handlers = {
            "compressibility": work_profile.session_compressibility,
            "expand": work_profile.expand_session,
            "project": work_profile.project_session,
        }
        payload = handlers[operation](value)
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))


@work.command(name="inspect", help=api_help("kungfu.agent.work.inspect"))
@click.option("--ref", "ref_name", required=True, help="exact Fact ref name")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.inspect")
@agent_command_context
def work_inspect(ctx, ref_name, as_json):
    payload = work_profile.inspect(ctx.runtime_dir, ref_name)
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    if payload.get("status") == "denied":
        ctx.exit(2)


@work.command(name="action", help=api_help("kungfu.agent.work.action"))
@click.option("--file", "file_path", help="Profile action request JSON path or -")
@click.option(
    "--input-base64",
    help="base64-encoded Profile action JSON for SDK and GUI adapters",
)
@click.option("--execute", is_flag=True, help="append and CAS the action")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.action")
@agent_command_context
def work_action(ctx, file_path, input_base64, execute, as_json):
    try:
        if bool(file_path) == bool(input_base64):
            raise ValueError("exactly one of --file or --input-base64 is required")
        if input_base64:
            raw = base64.b64decode(input_base64, validate=True).decode("utf-8")
        else:
            raw = (
                sys.stdin.read()
                if file_path == "-"
                else Path(file_path).read_text(encoding="utf-8")
            )
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("Profile action request must be a JSON object")
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    payload = work_profile.apply_action(ctx.runtime_dir, request, execute=execute)
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    if payload.get("status") == "denied":
        ctx.exit(2)


@work.command(
    name="export-authority", help=api_help("kungfu.agent.work.export-authority")
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.export-authority")
@agent_command_context
def work_export_authority(ctx, as_json):
    """Export the native Fact authority required for exact continuation."""

    payload = work_profile.export_authority(ctx.runtime_dir)
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    if payload.get("ok") is not True:
        ctx.exit(2)


@work.command(
    name="import-authority", help=api_help("kungfu.agent.work.import-authority")
)
@click.option("--file", "file_path", help="authority bundle JSON path or -")
@click.option(
    "--input-base64",
    help="base64-encoded authority bundle JSON for SDK and GUI adapters",
)
@click.option("--execute", is_flag=True, help="replay the validated bundle")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.import-authority")
@agent_command_context
def work_import_authority(ctx, file_path, input_base64, execute, as_json):
    """Validate or replay one qualified Fact authority bundle."""

    try:
        if bool(file_path) == bool(input_base64):
            raise ValueError("exactly one of --file or --input-base64 is required")
        if input_base64:
            raw = base64.b64decode(input_base64, validate=True).decode("utf-8")
        else:
            raw = (
                sys.stdin.read()
                if file_path == "-"
                else Path(file_path).read_text(encoding="utf-8")
            )
        bundle = json.loads(raw)
        if not isinstance(bundle, dict):
            raise ValueError("authority bundle must be a JSON object")
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    payload = work_profile.import_authority(ctx.runtime_dir, bundle, execute=execute)
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    if payload.get("ok") is not True:
        ctx.exit(2)


for _symbol in (
    "work",
    "work_capabilities",
    "work_session",
    "work_inspect",
    "work_action",
    "work_export_authority",
    "work_import_authority",
):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.agent"
    globals()[_symbol].callback.__qualname__ = _symbol
