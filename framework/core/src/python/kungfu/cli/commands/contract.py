# SPDX-License-Identifier: Apache-2.0

import json
import sys
from typing import Any

import click

from kungfu import contract as contract_runtime
from kungfu.cli.commands import PrioritizedCommandGroup, kfc

contract_command_context = kfc.pass_context()


@kfc.group(
    "contract",
    cls=PrioritizedCommandGroup,
    help_priority=3,
    help="inspect KFD-1 contract registry and welded contract artifacts",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def contract(ctx):
    pass


def _json(data):
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@contract.command("list", help="list registered KFD-1 contracts")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@contract_command_context
def list_contracts(ctx, as_json):
    try:
        data: dict[str, Any] = {
            "schema": "kungfu.contract-list/v1",
            "registry": contract_runtime.resolve_registry_path(),
            "contracts": contract_runtime.contract_rows(),
        }
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as e:
        click.echo(f"[contract] failed to load registry: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    for row in data["contracts"]:
        click.echo(f"{row['surface']}  {row['schema']}  {row['hash']}  {row['path']}")


@contract.command(help="print one registered contract")
@click.argument("surface", type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@contract_command_context
def show(ctx, surface, as_json):
    try:
        data = contract_runtime.load_contract(surface)
        metadata = contract_runtime.contract_metadata(surface)
        data["path"] = metadata["path"]
        data["hash"] = metadata["hash"]
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as e:
        click.echo(f"[contract] failed to load {surface}: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@contract.command(help="validate every registered contract can be loaded")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@contract_command_context
def verify(ctx, as_json):
    rows = []
    failures = []
    try:
        registry = contract_runtime.load_registry()
        for entry in registry["contracts"]:
            surface = entry["surface"]
            try:
                contract_runtime.load_contract(surface)
                rows.append(contract_runtime.contract_metadata(surface))
            except (OSError, ValueError, json.JSONDecodeError, KeyError) as e:
                failures.append({"surface": surface, "error": str(e)})
    except (OSError, ValueError, json.JSONDecodeError) as e:
        failures.append({"surface": "<registry>", "error": str(e)})
    data = {
        "schema": "kungfu.contract-verify/v1",
        "ok": not failures,
        "contracts": rows,
        "failures": failures,
    }
    if as_json:
        _json(data)
    elif failures:
        for failure in failures:
            click.echo(f"[contract] {failure['surface']}: {failure['error']}", err=True)
    else:
        click.echo(f"[contract] ok {len(rows)} contracts")
    if failures:
        sys.exit(1)
