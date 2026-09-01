# SPDX-License-Identifier: Apache-2.0

"""Product-owned KFD Agent Hub commands."""

import base64
import json
import sys
from pathlib import Path

import click

from kungfu.agent import agent_hub, agent_hub_qualification
from kungfu.agent.kfd3 import api_help, kfd3_api
from kungfu.cli.commands._agent.base import _json, agent, agent_command_context


@agent.group(name="hub", help=api_help("kungfu.agent.hub"))
@kfd3_api("kungfu.agent.hub")
@agent_command_context
def hub(ctx):
    """Operate the product-owned KFD Agent Hub profile projection."""


@hub.command(name="capabilities", help=api_help("kungfu.agent.hub.capabilities"))
@click.option("--hub-id", required=True, help="receiver-owned Hub identity")
@click.option(
    "--runtime-home",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
    help="exact Hub authority home",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.hub.capabilities")
@agent_command_context
def hub_capabilities(ctx, hub_id, runtime_home, as_json):
    payload = agent_hub.capabilities(hub_id, runtime_home)
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))


@hub.command(name="adapter", help=api_help("kungfu.agent.hub.adapter"))
@click.option(
    "--qualification-root",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
    help="containment root for the two isolated Hub authority homes",
)
@kfd3_api("kungfu.agent.hub.adapter")
@agent_command_context
def hub_adapter(ctx, qualification_root):
    """Serve the product-owned Hub profile over the KFD JSONL binding."""

    source_home = qualification_root / "hub-alpha" / ".kungfu"
    target_home = qualification_root / "hub-beta" / ".kungfu"
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("KFD adapter request must be a JSON object")
            payload = agent_hub.handle_request(
                request,
                source_home=source_home,
                target_home=target_home,
                qualification_root=qualification_root,
            )
            click.echo(json.dumps(payload, sort_keys=True))
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error


@hub.command(name="qualify", help=api_help("kungfu.agent.hub.qualify"))
@click.option(
    "--output-dir",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
    help="new directory for rooted qualification evidence",
)
@click.option(
    "--timeout-ms",
    default=30_000,
    show_default=True,
    type=click.IntRange(min=100),
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@click.option(
    "--kfd-entry",
    type=click.Path(dir_okay=False, path_type=Path),
    hidden=True,
)
@click.option(
    "--product-executable",
    type=click.Path(dir_okay=False, path_type=Path),
    hidden=True,
)
@kfd3_api("kungfu.agent.hub.qualify")
@agent_command_context
def hub_qualify(ctx, output_dir, timeout_ms, as_json, kfd_entry, product_executable):
    """Run Hub 20 and explain the exact installed-product result."""

    try:
        payload = agent_hub_qualification.qualify(
            output_dir,
            kfd_entry=kfd_entry,
            product_executable=product_executable,
            timeout_ms=timeout_ms,
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
    else:
        click.echo(agent_hub_qualification.render_human(payload), nl=False)
    if not payload["valid"]:
        ctx.exit(1)


@hub.command(name="verify", help=api_help("kungfu.agent.hub.verify"))
@click.option(
    "--qualification-dir",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
    help="retained qualification evidence directory",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@click.option(
    "--kfd-entry",
    type=click.Path(dir_okay=False, path_type=Path),
    hidden=True,
)
@click.option(
    "--product-executable",
    type=click.Path(dir_okay=False, path_type=Path),
    hidden=True,
)
@kfd3_api("kungfu.agent.hub.verify")
@agent_command_context
def hub_verify(ctx, qualification_dir, as_json, kfd_entry, product_executable):
    """Independently recheck retained Hub qualification evidence offline."""

    try:
        payload = agent_hub_qualification.verify(
            qualification_dir,
            kfd_entry=kfd_entry,
            product_executable=product_executable,
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
    else:
        click.echo(
            agent_hub_qualification.render_human(payload, verification=True),
            nl=False,
        )
    if not payload["valid"]:
        ctx.exit(1)


@hub.command(name="handle", help=api_help("kungfu.agent.hub.handle"))
@click.option("--file", "file_path", help="KFD adapter request JSON path or -")
@click.option("--input-base64", help="base64-encoded KFD adapter request JSON")
@click.option(
    "--source-home",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
)
@click.option(
    "--target-home",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
)
@click.option(
    "--qualification-root",
    type=click.Path(file_okay=False, path_type=Path),
    help="optional containment root for isolated qualification",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.hub.handle")
@agent_command_context
def hub_handle(
    ctx,
    file_path,
    input_base64,
    source_home,
    target_home,
    qualification_root,
    as_json,
):
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
            raise ValueError("KFD adapter request must be a JSON object")
        payload = agent_hub.handle_request(
            request,
            source_home=source_home,
            target_home=target_home,
            qualification_root=qualification_root,
        )
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))


for _symbol in (
    "hub",
    "hub_capabilities",
    "hub_adapter",
    "hub_qualify",
    "hub_verify",
    "hub_handle",
):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.agent"
    globals()[_symbol].callback.__qualname__ = _symbol
