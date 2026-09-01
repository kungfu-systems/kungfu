# SPDX-License-Identifier: Apache-2.0

"""Machine-local Agent runtime profile commands."""

import click

from kungfu.agent import runtime_profiles
from kungfu.agent.kfd3 import api_help, kfd3_api
from kungfu.cli.commands._agent.base import _json, agent, agent_command_context
from kungfu.config import resolve_config


def _runtime_config_homes(ctx):
    resolved = resolve_config(runtime_home=ctx.home)
    return resolved["configHome"], resolved["runtimeHome"]


def _runtime_error(exc):
    raise click.ClickException(str(exc)) from exc


@agent.group(help=api_help("kungfu.agent.runtime"))
@kfd3_api("kungfu.agent.runtime")
@agent_command_context
def runtime(ctx):
    """Discover and configure machine-local Agent launch profiles."""


@runtime.command(name="discover", help=api_help("kungfu.agent.runtime.discover"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.discover")
@agent_command_context
def runtime_discover(ctx, as_json):
    payload = runtime_profiles.discover_catalog(
        resolved_config=resolve_config(runtime_home=ctx.home)
    )
    if as_json:
        _json(payload)
        return
    for row in payload["discovered"]:
        profile = row["profile"]
        click.echo(
            f"{profile['id']}  {profile['label']}  "
            f"{profile['launch']['executable']}  "
            f"{row.get('version') or 'version unknown'}"
        )
    for row in payload["diagnostics"]:
        click.echo(f"{row['provider']}: {row['message']}")


@runtime.command(name="list", help=api_help("kungfu.agent.runtime.list"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.list")
@agent_command_context
def runtime_list(ctx, as_json):
    payload = runtime_profiles.discover_catalog(
        resolved_config=resolve_config(runtime_home=ctx.home)
    )
    if as_json:
        _json(payload)
        return
    click.echo(f"default: {payload['defaultProfileId'] or '<automatic>'}")
    click.echo(f"recommended: {payload['recommendedProfileId'] or '<none>'}")
    for profile in payload["configured"]:
        click.echo(f"configured  {profile['id']}  {profile['label']}")
    for row in payload["discovered"]:
        profile = row["profile"]
        click.echo(f"discovered  {profile['id']}  {profile['label']}")


@runtime.command(name="upsert", help=api_help("kungfu.agent.runtime.upsert"))
@click.option("--id", "profile_id", required=True, help="stable profile id")
@click.option("--label", required=True, help="user-visible profile label")
@click.option(
    "--provider",
    required=True,
    help="built-in or registered native Provider adapter id",
)
@click.option("--executable", required=True, help="executable path or PATH name")
@click.option("--arg", "argv", multiple=True, help="repeat for each launch argv")
@click.option(
    "--interactive-arg",
    "interactive_argv",
    multiple=True,
    help="repeat for each provider-native interactive argv",
)
@click.option("--shell-mode", is_flag=True, help="explicitly allow shell semantics")
@click.option(
    "--cwd-policy",
    type=click.Choice(["workspace-root", "home", "inherit"]),
    default="workspace-root",
    show_default=True,
)
@click.option(
    "--backend",
    type=click.Choice(["tmux", "direct"]),
    default="tmux",
    show_default=True,
)
@click.option(
    "--envelope",
    type=click.Choice(["required", "disabled"]),
    default="required",
    show_default=True,
)
@click.option("--execute", is_flag=True, help="write the reviewed profile")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.upsert")
@agent_command_context
def runtime_upsert(
    ctx,
    profile_id,
    label,
    provider,
    executable,
    argv,
    interactive_argv,
    shell_mode,
    cwd_policy,
    backend,
    envelope,
    execute,
    as_json,
):
    config_home, runtime_home = _runtime_config_homes(ctx)
    try:
        plan = runtime_profiles.plan_upsert(
            profile_id=profile_id,
            label=label,
            provider=provider,
            executable=executable,
            argv=list(argv),
            interactive_argv=list(interactive_argv),
            shell_mode=shell_mode,
            cwd_policy=cwd_policy,
            backend=backend,
            envelope=envelope,
            config_home=config_home,
            runtime_home=runtime_home,
        )
        payload = (
            runtime_profiles.apply_upsert(
                plan, config_home=config_home, runtime_home=runtime_home
            )
            if execute
            else plan
        )
    except ValueError as exc:
        _runtime_error(exc)
    if as_json:
        _json(payload)
        return
    click.echo(
        f"{payload['schema']}: {profile_id} "
        f"({'applied' if execute else 'preview only'})"
    )


@runtime.command(name="remove", help=api_help("kungfu.agent.runtime.remove"))
@click.argument("profile_id")
@click.option("--execute", is_flag=True, help="remove the reviewed profile")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.remove")
@agent_command_context
def runtime_remove(ctx, profile_id, execute, as_json):
    config_home, runtime_home = _runtime_config_homes(ctx)
    try:
        plan = runtime_profiles.plan_remove(
            profile_id, config_home=config_home, runtime_home=runtime_home
        )
        payload = (
            runtime_profiles.apply_remove(
                plan, config_home=config_home, runtime_home=runtime_home
            )
            if execute
            else plan
        )
    except ValueError as exc:
        _runtime_error(exc)
    if as_json:
        _json(payload)
        return
    click.echo(f"{profile_id}: {'removed' if execute else 'preview only'}")


@runtime.command(name="set-default", help=api_help("kungfu.agent.runtime.set-default"))
@click.argument("profile_id")
@click.option("--execute", is_flag=True, help="write the default selection")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.set-default")
@agent_command_context
def runtime_set_default(ctx, profile_id, execute, as_json):
    config_home, runtime_home = _runtime_config_homes(ctx)
    try:
        payload = runtime_profiles.set_default(
            profile_id,
            execute=execute,
            config_home=config_home,
            runtime_home=runtime_home,
        )
    except ValueError as exc:
        _runtime_error(exc)
    if as_json:
        _json(payload)
        return
    click.echo(f"default {profile_id}: {'set' if execute else 'preview only'}")


@runtime.command(name="verify", help=api_help("kungfu.agent.runtime.verify"))
@click.argument("profile_id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.verify")
@agent_command_context
def runtime_verify(ctx, profile_id, as_json):
    config_home, runtime_home = _runtime_config_homes(ctx)
    try:
        profile = runtime_profiles.find_profile(
            profile_id, config_home=config_home, runtime_home=runtime_home
        )
    except ValueError as exc:
        _runtime_error(exc)
    payload = runtime_profiles.verify_profile(profile)
    if as_json:
        _json(payload)
        return
    click.echo(
        f"{profile_id}: {'ok' if payload['ok'] else 'unavailable'} "
        f"{payload.get('version') or payload.get('error') or ''}"
    )


for _symbol in (
    "runtime",
    "runtime_discover",
    "runtime_list",
    "runtime_upsert",
    "runtime_remove",
    "runtime_set_default",
    "runtime_verify",
):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.agent"
    globals()[_symbol].callback.__qualname__ = _symbol
