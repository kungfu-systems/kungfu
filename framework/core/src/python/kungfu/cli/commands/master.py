# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import sys

import click

from kungfu import master_service
from kungfu.cli.commands import PrioritizedCommandGroup, kfc

master_command_context = kfc.pass_context()


def _json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _plain_status(payload):
    click.echo(f"status: {payload['status']}")
    click.echo(f"runtime: {payload['runtimeDir']}")
    click.echo(
        "supervisor: "
        f"{payload['supervisor']['pid'] or '-'} "
        f"({'running' if payload['supervisor']['running'] else 'stopped'})"
    )
    click.echo(
        "master: "
        f"{payload['master']['pid'] or '-'} "
        f"({'running' if payload['master']['running'] else 'stopped'})"
    )


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="manage the resident Kungfu master supervisor",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def master(ctx):
    pass


@master.command(name="status", help="print resident master supervisor status")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def master_status(ctx, as_json):
    payload = master_service.status(ctx.home, ctx.runtime_dir)
    if as_json:
        _json(payload)
        return
    _plain_status(payload)


@master.command(help="start the resident master supervisor")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def start(ctx, as_json):
    payload = master_service.start_supervisor(ctx.home, ctx.runtime_dir, ctx.log_level)
    if as_json:
        _json(payload)
        return
    click.echo("started" if payload.get("changed") else "already running")


@master.command(help="stop the resident master supervisor")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def stop(ctx, as_json):
    payload = master_service.stop_supervisor(ctx.home, ctx.runtime_dir)
    if as_json:
        _json(payload)
        return
    if payload.get("error"):
        raise click.ClickException(str(payload["error"]))
    click.echo("stopped" if payload.get("changed") else "already stopped")


@master.command(help="restart the resident master supervisor")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def restart(ctx, as_json):
    stopped = master_service.stop_supervisor(ctx.home, ctx.runtime_dir)
    if stopped.get("error"):
        raise click.ClickException(str(stopped["error"]))
    started = master_service.start_supervisor(ctx.home, ctx.runtime_dir, ctx.log_level)
    payload = {
        "schema": "kungfu.master-service.restart/v1",
        "stop": stopped,
        "start": started,
    }
    if as_json:
        _json(payload)
        return
    click.echo("restarted")


@master.command(help="run one foreground master process")
@click.option(
    "--home",
    "runtime_home",
    required=True,
    hidden=True,
    help="runtime home passed by the supervisor",
)
@click.option(
    "--runtime-dir",
    required=True,
    hidden=True,
    help="runtime directory passed by the supervisor",
)
@click.option("--low-latency", is_flag=True, hidden=True)
def run(runtime_home, runtime_dir, low_latency):
    sys.exit(master_service.run_master(runtime_home, runtime_dir, low_latency))


@master.command(help="run the foreground master supervisor service loop")
@click.option(
    "--home",
    "runtime_home",
    required=True,
    hidden=True,
    help="runtime home passed by the service manager",
)
@click.option(
    "--runtime-dir",
    required=True,
    hidden=True,
    help="runtime directory passed by the service manager",
)
@click.option("--foreground", is_flag=True, hidden=True)
def supervise(runtime_home, runtime_dir, foreground):
    callable(foreground)
    root = click.get_current_context().parent.parent
    sys.exit(
        master_service.run_supervisor(
            runtime_home,
            runtime_dir,
            getattr(root, "log_level", "warning"),
        )
    )


@master.group(
    cls=PrioritizedCommandGroup,
    help="install, remove, and inspect the user-level master service plan",
)
@click.help_option("-h", "--help")
@master_command_context
def service(ctx):
    pass


@service.command(help="print the platform service plan without writing files")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def plan(ctx, as_json):
    payload = master_service.service_plan(
        ctx.home, ctx.runtime_dir, ctx.log_level
    ).as_dict()
    if as_json:
        _json(payload)
        return
    click.echo(f"path: {payload['path']}")
    click.echo(payload["content"], nl=False)


@service.command(name="status", help="print user-level service installation status")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def service_status(ctx, as_json):
    payload = master_service.service_status(ctx.home, ctx.runtime_dir, ctx.log_level)
    if as_json:
        _json(payload)
        return
    service_payload = payload["service"]
    click.echo(f"service: {service_payload['id']}")
    click.echo(f"path: {service_payload['path']}")
    click.echo(f"installed: {'yes' if service_payload['installed'] else 'no'}")
    click.echo(f"matches plan: {'yes' if service_payload['matchesPlan'] else 'no'}")


@service.command(help="install the user-level service file")
@click.option(
    "--execute",
    is_flag=True,
    help="write the service file; default is a dry-run preview",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def install(ctx, execute, as_json):
    if execute:
        payload = master_service.install_service(
            ctx.home, ctx.runtime_dir, ctx.log_level
        )
    else:
        payload = {
            "schema": "kungfu.master-service.result/v1",
            "action": "install",
            "changed": False,
            "dryRun": True,
            "plan": master_service.service_plan(
                ctx.home, ctx.runtime_dir, ctx.log_level
            ).as_dict(),
        }
    if as_json:
        _json(payload)
        return
    click.echo("[dry-run] install preview" if not execute else "installed")
    click.echo(payload["plan"]["installNote"])


@service.command(help="uninstall the user-level service file")
@click.option(
    "--execute",
    is_flag=True,
    help="remove the service file; default is a dry-run preview",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def uninstall(ctx, execute, as_json):
    if execute:
        payload = master_service.uninstall_service(
            ctx.home, ctx.runtime_dir, ctx.log_level
        )
    else:
        payload = {
            "schema": "kungfu.master-service.result/v1",
            "action": "uninstall",
            "changed": False,
            "dryRun": True,
            "plan": master_service.service_plan(
                ctx.home, ctx.runtime_dir, ctx.log_level
            ).as_dict(),
        }
    if as_json:
        _json(payload)
        return
    click.echo("[dry-run] uninstall preview" if not execute else "uninstalled")
    click.echo(payload["plan"]["uninstallNote"])
