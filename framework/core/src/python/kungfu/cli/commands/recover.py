# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json

import click

from kungfu import contract as contract_runtime
from kungfu import recovery
from kungfu.cli.commands import kfc


def _echo_json(value) -> None:
    click.echo(json.dumps(value, indent=2, sort_keys=True))


@kfc.command(
    help_priority=2,
    help="plan or execute fenced recovery across runtime, Peer, storage, and Episode",
)
@click.option("--execute", is_flag=True, help="execute the reviewed plan")
@click.option(
    "--plan-id",
    help="exact plan identity required with --execute",
)
@click.option(
    "--action",
    "action_ids",
    multiple=True,
    help="execute only one action id; repeat to select more",
)
@click.option(
    "--approve",
    "approvals",
    multiple=True,
    help="approve one confirmation-required action id or 'all'",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@click.option(
    "--contract",
    "show_contract",
    is_flag=True,
    help="print the shared diagnostics and recovery contract",
)
@kfc.pass_context()
def recover(
    ctx,
    execute,
    plan_id,
    action_ids,
    approvals,
    as_json,
    show_contract,
):
    if show_contract:
        _echo_json(contract_runtime.load_contract("diagnostics"))
        return
    if (action_ids or approvals or plan_id) and not execute:
        raise click.UsageError("--plan-id, --action, and --approve require --execute")
    if execute and not plan_id:
        raise click.UsageError("--execute requires --plan-id from a reviewed plan")

    if not execute:
        payload = recovery.plan_recovery(
            ctx.home,
            ctx.runtime_dir,
            ctx.config_home,
        )
        recovery.validate_plan(payload)
        if as_json:
            _echo_json(payload)
        else:
            click.echo(f"Kungfu recovery: {payload['status']}")
            click.echo(f"Plan: {payload['planId']}")
            if not payload["actions"]:
                click.echo("No recovery actions are required.")
            for action in payload["actions"]:
                click.echo(
                    f"  [{action['classification']}] {action['actionId']}"
                    f" - {action['label']}"
                )
            executable = [
                action for action in payload["actions"] if action["executable"]
            ]
            if executable:
                click.echo(
                    "Review the plan, then execute it with: "
                    f"kungfu recover --execute --plan-id {payload['planId']}"
                )
                confirmations = [
                    action
                    for action in executable
                    if action["classification"] == recovery.CLASS_CONFIRM
                ]
                if confirmations:
                    click.echo("Add --approve all or approve action ids individually.")
        if payload["status"] == "blocked":
            raise click.exceptions.Exit(3)
        if payload["status"] == "recoverable":
            raise click.exceptions.Exit(2)
        return

    try:
        payload = recovery.execute_recovery(
            ctx.home,
            ctx.runtime_dir,
            ctx.config_home,
            log_level=ctx.log_level,
            expected_plan_id=plan_id,
            action_ids=action_ids,
            approvals=approvals,
        )
    except recovery.RecoveryError as error:
        payload = error.to_dict()
        if as_json:
            _echo_json(payload)
        else:
            click.echo(f"Kungfu recovery refused: {error.code}", err=True)
            click.echo(error.message, err=True)
        raise click.exceptions.Exit(2) from error

    if as_json:
        _echo_json(payload)
    else:
        click.echo(f"Kungfu recovery: {payload['status']}")
        for action in payload["actions"]:
            click.echo(
                f"  {action['actionId']}: {action['status']}"
                + (f" - {action['error']['message']}" if action["error"] else "")
            )
        click.echo(f"Postflight: {payload['postflight']['status']}")
    if payload["status"] == "blocked":
        raise click.exceptions.Exit(3)
    if payload["status"] != "succeeded":
        raise click.exceptions.Exit(2)
