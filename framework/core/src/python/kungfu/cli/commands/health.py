# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json

import click

from kungfu import contract as contract_runtime
from kungfu import diagnostics
from kungfu.cli.commands import kfc


@kfc.command(
    help_priority=1,
    help="check runtime, Peer, storage, and Episode health without changing state",
)
@click.option(
    "--deep",
    is_flag=True,
    help="include storage fsck and complete open-Episode inspection",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@click.option(
    "--verbose",
    is_flag=True,
    help="include technical details in human-readable output",
)
@click.option(
    "--contract",
    "show_contract",
    is_flag=True,
    help="print the machine-readable diagnostics contract",
)
@kfc.pass_context()
def health(ctx, deep, as_json, verbose, show_contract):
    if show_contract:
        payload = contract_runtime.load_contract("diagnostics")
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
        return
    payload = diagnostics.collect_health(
        ctx.home,
        ctx.runtime_dir,
        ctx.config_home,
        deep=deep,
    )
    diagnostics.validate_report(payload)
    if as_json:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    else:
        click.echo(f"Kungfu health: {payload['status']} ({payload['mode']})")
        for check in payload["checks"]:
            click.echo(f"  {check['area']}: {check['status']} - {check['summary']}")
        for item in payload["problems"]:
            click.echo(f"\n[{item['code']}] {item['summary']}")
            click.echo(f"  {item['message']}")
            for action in item["actions"]:
                click.echo(f"  Next: {action['label']}")
                command = action.get("command") or []
                if command:
                    click.echo("        " + " ".join(command))
            if verbose and item.get("technicalDetail"):
                click.echo(f"  Technical detail: {item['technicalDetail']}")
    if payload["exitCode"]:
        raise click.exceptions.Exit(payload["exitCode"])
