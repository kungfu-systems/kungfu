# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

import click

from kungfu import (
    diagnostics,
)
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.execution_surface import authority as runtime_surface

runtime_command_context = kfc.pass_context()


def _json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _load_object(path):
    value = json.loads(Path(path).read_text("utf-8"))
    if not isinstance(value, dict):
        raise click.ClickException(f"JSON input is not an object: {path}")
    return value


def _load_array(path):
    if path is None:
        return []
    value = json.loads(Path(path).read_text("utf-8"))
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise click.ClickException(f"JSON input is not an array of objects: {path}")
    return value


def _plain_status(payload):
    product = payload.get("product") or {}
    click.echo(f"workspace: {product.get('availability', 'unknown')}")
    click.echo(f"live runtime: {product.get('liveState', 'unknown')}")
    handle = product.get("handle") or {}
    if handle:
        click.echo(f"generation: {handle.get('generation', '-')}")
        readiness = handle.get("readiness") or {}
        click.echo(f"readiness: {readiness.get('state', '-')}")
        click.echo(f"durable cut: {json.dumps(readiness.get('durableCut'))}")
        click.echo(f"projection cut: {json.dumps(readiness.get('projectionCut'))}")
        click.echo(f"active leases: {product.get('leases', {}).get('activeCount', 0)}")
    error = product.get("error") or {}
    if error:
        translated = diagnostics.problem(
            str(error.get("code") or "runtime_not_ready"),
            area="runtime",
            technical_detail=str(error.get("message") or error),
        )
        click.echo("runtime problem:")
        for line in diagnostics.actionable_text(translated).splitlines():
            click.echo(f"  {line}")
    click.echo(f"config: {payload['configHome']}")
    click.echo(f"data root: {payload['dataRoot']}")
    click.echo(f"runtime: {payload['runtimeDir']}")
    click.echo("process diagnostics:")
    click.echo(f"  lifecycle: {payload.get('lifecycle', {}).get('state', '-')}")
    click.echo(
        "  supervisor: "
        f"{payload['supervisor']['pid'] or '-'} "
        f"({'running' if payload['supervisor']['running'] else 'stopped'})"
    )
    if "coordinator" in payload:
        click.echo(
            "  coordinator: "
            f"{payload['coordinator']['pid'] or '-'} "
            f"({'running' if payload['coordinator']['running'] else 'stopped'})"
        )
    warnings = payload.get("lifecycle", {}).get("warnings") or []
    if warnings:
        click.echo(f"warnings: {', '.join(warnings)}")


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="inspect or operate the resident runtime (ordinary work auto-activates it)",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def runtime(ctx):
    pass


@runtime.group(
    name="surface",
    cls=PrioritizedCommandGroup,
    help="select and verify one explicit execution surface with rooted provenance",
)
@click.help_option("-h", "--help")
@runtime_command_context
def runtime_surface_group(ctx):
    pass


@runtime_surface_group.command(
    name="contract", help="show the machine-readable runtime surface authority"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def runtime_surface_contract(as_json):
    payload = runtime_surface.load_contract()
    _json(payload) if as_json else click.echo(
        json.dumps(payload, indent=2, sort_keys=True)
    )


@runtime_surface_group.command(
    name="resolve", help="resolve one explicit request into a rooted provenance receipt"
)
@click.argument(
    "request_path", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def runtime_surface_resolve(request_path, as_json):
    try:
        payload = runtime_surface.resolve(_load_object(request_path))
    except runtime_surface.RuntimeSurfaceError as error:
        if as_json:
            _json(error.diagnosis())
        else:
            raise click.ClickException(str(error)) from error
        raise click.exceptions.Exit(2) from error
    _json(payload) if as_json else click.echo(
        f"{payload['operationId']}: {payload['runtimeSurface']} "
        f"({payload['receiptRoot']})"
    )


@runtime_surface_group.command(
    name="verify",
    help="verify one runtime surface receipt against the current contract",
)
@click.argument(
    "receipt_path", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def runtime_surface_verify(receipt_path, as_json):
    try:
        payload = runtime_surface.verify(_load_object(receipt_path))
    except runtime_surface.RuntimeSurfaceError as error:
        if as_json:
            _json(error.diagnosis())
        else:
            raise click.ClickException(str(error)) from error
        raise click.exceptions.Exit(2) from error
    _json(payload) if as_json else click.echo(
        f"verified {payload['runtimeSurface']} {payload['receiptRoot']}"
    )


for _symbol in (
    "runtime",
    "runtime_surface_group",
    "runtime_surface_contract",
    "runtime_surface_resolve",
    "runtime_surface_verify",
):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.runtime"
    globals()[_symbol].callback.__qualname__ = _symbol
