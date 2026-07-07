# SPDX-License-Identifier: Apache-2.0

import json
import sys

import click

from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.config import (
    config_schema,
    default_config,
    load_contract,
    parse_config_value,
    resolve_config,
    set_user_config_value,
    unset_user_config_value,
    user_config_path,
)

config_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=4,
    help="inspect Kungfu global JSON configuration",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def config(ctx):
    pass


def _json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _resolved(ctx):
    try:
        return resolve_config(runtime_home=ctx.home)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[config] failed to load config: {e}", err=True)
        sys.exit(1)


@config.command(help="print the config contract")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@config_command_context
def contract(ctx, as_json):
    try:
        data = load_contract()
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[config] failed to load contract: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@config.command(help="print the config JSON schema")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@config_command_context
def schema(ctx, as_json):
    try:
        data = config_schema()
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[config] failed to load schema: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@config.command(help="print the user override path")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@config_command_context
def path(ctx, as_json):
    data = _resolved(ctx)
    if as_json:
        _json(
            {
                "schema": "kungfu.config.path/v1",
                "configHome": data["configHome"],
                "configPath": data["configPath"],
                "runtimeHome": data["runtimeHome"],
            }
        )
        return
    click.echo(user_config_path(data["configHome"]))


@config.command(help="print built-in defaults before user overrides")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@config_command_context
def defaults(ctx, as_json):
    data = _default_config(ctx)
    if as_json:
        _json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@config.command(help="print resolved config defaults plus user overrides")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@config_command_context
def show(ctx, as_json):
    data = _resolved(ctx)
    if as_json:
        _json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@config.command(name="set", help="set a user config override by dotted key")
@click.argument("key")
@click.argument("value")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@config_command_context
def set_value(ctx, key, value, as_json):
    try:
        parsed = parse_config_value(value)
        data = set_user_config_value(key, parsed, runtime_home=ctx.home)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[config] failed to set {key}: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(f"{key} = {json.dumps(parsed, sort_keys=True)}")


@config.command(name="unset", help="remove a user config override by dotted key")
@click.argument("key")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@config_command_context
def unset_value(ctx, key, as_json):
    try:
        data = unset_user_config_value(key, runtime_home=ctx.home)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[config] failed to unset {key}: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(f"{key} unset")


def _default_config(ctx):
    try:
        return default_config(ctx.home)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[config] failed to load defaults: {e}", err=True)
        sys.exit(1)
