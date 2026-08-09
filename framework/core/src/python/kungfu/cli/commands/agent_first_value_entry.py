# SPDX-License-Identifier: Apache-2.0

"""Click projections for the bounded Agent first-value entry."""

from __future__ import annotations

import click

from kungfu.agent import documentation as documentation_pack
from kungfu.agent import first_value as first_value_protocol
from kungfu.agent.kfd3 import api_help, kfd3_api
from kungfu.cli.commands import agent_work_lab as agent_work_lab_commands


_json = agent_work_lab_commands.agent_json_output


def _contract_payload(compact: bool):
    return (
        first_value_protocol.compact_contract_view()
        if compact
        else first_value_protocol.contract_view()
    )


@kfd3_api("kungfu.agent.first-value.contract")
def first_value_contract(ctx, as_json, compact):
    del ctx
    try:
        payload = _contract_payload(compact)
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    if compact:
        click.echo(payload["contract"]["promptFamily"]["currentRoot"])
        click.echo(f"contract: {payload['productIdentity']['contractRoot']}")
        return
    click.echo(payload["contract"]["prompt"]["text"])
    click.echo(f"contract: {payload['productIdentity']['contractRoot']}")


@kfd3_api("kungfu.agent.first-value.start")
def first_value_start(ctx, as_json):
    del ctx
    try:
        payload = first_value_protocol.create_start_receipt(documentation_pack.verify())
    except (
        FileNotFoundError,
        OSError,
        ValueError,
        first_value_protocol.SubprocessError,
    ) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"verified first value: {payload['receiptRoot']}")


def register(first_value, command_context) -> None:
    """Register entry-only commands on the authoritative first-value group."""

    contract_command = command_context(first_value_contract)
    contract_command = click.option(
        "--compact", is_flag=True, help="bounded first-entry projection"
    )(contract_command)
    contract_command = click.option(
        "--json", "as_json", is_flag=True, help="machine-readable output"
    )(contract_command)
    first_value.command(
        name="contract", help=api_help("kungfu.agent.first-value.contract")
    )(contract_command)

    start_command = command_context(first_value_start)
    start_command = click.option(
        "--json", "as_json", is_flag=True, help="machine-readable output"
    )(start_command)
    first_value.command(name="start", help=api_help("kungfu.agent.first-value.start"))(
        start_command
    )
