# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from kungfu import contract as contract_runtime
from kungfu import diagnostics, peer_lifecycle
from kungfu.cli.commands import PrioritizedCommandGroup
from kungfu.cli.preflight import command_preflight

from kungfu.cli.commands._runtime.base import (
    _json,
    runtime,
    runtime_command_context,
)


@runtime.group(
    name="peer",
    cls=PrioritizedCommandGroup,
    help="operate one declared Peer through its independent fenced process host",
)
@click.help_option("-h", "--help")
@runtime_command_context
def runtime_peer(ctx):
    pass


def _peer_spec(path):
    try:
        return peer_lifecycle.load_spec(path)
    except peer_lifecycle.PeerLifecycleError as error:
        translated = diagnostics.problem_from_exception(error, area="peer")
        raise click.ClickException(diagnostics.actionable_text(translated)) from error


def _peer_call(callable_):
    try:
        return callable_()
    except peer_lifecycle.PeerLifecycleError as error:
        translated = diagnostics.problem_from_exception(error, area="peer")
        raise click.ClickException(diagnostics.actionable_text(translated)) from error


@runtime_peer.command(
    name="contract", help="show the machine-readable Peer lifecycle contract"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def peer_contract(as_json):
    payload = contract_runtime.load_contract("peer-lifecycle")
    _json(payload) if as_json else click.echo(
        json.dumps(payload, indent=2, sort_keys=True)
    )


@runtime_peer.command(
    name="plan", help="validate a Peer declaration without starting it"
)
@click.argument("spec", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def peer_plan(ctx, spec, as_json):
    payload = _peer_call(lambda: peer_lifecycle.plan(_peer_spec(spec), ctx.runtime_dir))
    if as_json:
        _json(payload)
        return
    click.echo(f"plan: {payload['planId']}")
    click.echo(f"peer: {payload['peerId']}")
    click.echo(f"process exit: {payload['recovery']['processExit']}")


@runtime_peer.command(name="start", help="start or adopt one declared Peer host")
@click.argument("spec", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--expected-plan-id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
@command_preflight("peer-activation")
def peer_start(ctx, spec, expected_plan_id, as_json):
    payload = _peer_call(
        lambda: peer_lifecycle.ensure(
            _peer_spec(spec),
            ctx.runtime_dir,
            expected_plan_id=expected_plan_id,
        )
    )
    if as_json:
        _json(payload)
        return
    click.echo("started" if payload.get("changed") else "already hosted")
    click.echo(
        f"health: {'ready' if payload['healthy'] else payload['lifecycleState']}"
    )


@runtime_peer.command(
    name="ensure", help="start or fenced-adopt one declared Peer host"
)
@click.argument("spec", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--expected-plan-id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
@command_preflight("peer-activation")
def peer_ensure(ctx, spec, expected_plan_id, as_json):
    payload = _peer_call(
        lambda: peer_lifecycle.ensure(
            _peer_spec(spec),
            ctx.runtime_dir,
            expected_plan_id=expected_plan_id,
        )
    )
    if as_json:
        _json(payload)
        return
    click.echo("started" if payload.get("changed") else "already hosted")
    click.echo(
        f"health: {'ready' if payload['healthy'] else payload['lifecycleState']}"
    )


@runtime_peer.command(name="status", help="inspect one Peer or list all declared Peers")
@click.argument("peer_id", required=False)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def peer_status(ctx, peer_id, as_json):
    payload = (
        _peer_call(lambda: peer_lifecycle.status(ctx.runtime_dir, peer_id))
        if peer_id
        else peer_lifecycle.list_status(ctx.runtime_dir)
    )
    if as_json:
        _json(payload)
        return
    items = payload.get("items", [payload])
    for item in items:
        click.echo(
            f"{item['peerId']}: {item['lifecycleState']} "
            f"host={item['host']['pid'] or '-'} peer={item['peer']['pid'] or '-'}"
        )


@runtime_peer.command(name="health", help="fail unless one Peer is Ready and fenced")
@click.argument("peer_id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def peer_health(ctx, peer_id, as_json):
    payload = _peer_call(lambda: peer_lifecycle.status(ctx.runtime_dir, peer_id))
    if as_json:
        _json(payload)
    else:
        click.echo("ready" if payload["healthy"] else payload["lifecycleState"])
    if not payload["healthy"]:
        raise click.exceptions.Exit(2)


@runtime_peer.command(
    name="stop", help="stop a Peer only through its recorded process fences"
)
@click.argument("peer_id")
@click.option("--expected-host-generation", type=int)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def peer_stop(ctx, peer_id, expected_host_generation, as_json):
    payload = _peer_call(
        lambda: peer_lifecycle.stop(
            ctx.runtime_dir,
            peer_id,
            expected_host_generation=expected_host_generation,
        )
    )
    if as_json:
        _json(payload)
        return
    click.echo("stopped" if payload.get("changed") else "already stopped")


@runtime_peer.command(name="restart", help="fenced-stop and restart one declared Peer")
@click.argument("spec", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--expected-host-generation", type=int)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def peer_restart(ctx, spec, expected_host_generation, as_json):
    payload = _peer_call(
        lambda: peer_lifecycle.restart(
            _peer_spec(spec),
            ctx.runtime_dir,
            expected_host_generation=expected_host_generation,
        )
    )
    if as_json:
        _json(payload)
        return
    click.echo("restarted")


@runtime.command(name="peer-host", hidden=True)
@click.option("--runtime-dir", required=True)
@click.option("--peer-id", required=True)
@click.option("--host-generation", type=int, required=True)
@click.option("--expected-plan-id", required=True)
def peer_host(runtime_dir, peer_id, host_generation, expected_plan_id):
    sys.exit(
        peer_lifecycle.run_host(runtime_dir, peer_id, host_generation, expected_plan_id)
    )


for _symbol in (
    "runtime_peer",
    "peer_contract",
    "peer_plan",
    "peer_start",
    "peer_ensure",
    "peer_status",
    "peer_health",
    "peer_stop",
    "peer_restart",
    "peer_host",
):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.runtime"
    globals()[_symbol].callback.__qualname__ = _symbol
