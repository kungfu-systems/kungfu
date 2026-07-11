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
    click.echo(f"lifecycle: {payload.get('lifecycle', {}).get('state', '-')}")
    click.echo(f"config: {payload['configHome']}")
    click.echo(f"data root: {payload['dataRoot']}")
    click.echo(f"runtime: {payload['runtimeDir']}")
    click.echo(
        "supervisor: "
        f"{payload['supervisor']['pid'] or '-'} "
        f"({'running' if payload['supervisor']['running'] else 'stopped'})"
    )
    if "master" in payload:
        click.echo(
            "master: "
            f"{payload['master']['pid'] or '-'} "
            f"({'running' if payload['master']['running'] else 'stopped'})"
        )
    warnings = payload.get("lifecycle", {}).get("warnings") or []
    if warnings:
        click.echo(f"warnings: {', '.join(warnings)}")


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
    payload = master_service.route_status(ctx.home, ctx.runtime_dir, ctx.config_home)
    if as_json:
        _json(payload)
        return
    _plain_status(payload)


@master.command(help="ensure the current data-root master via the user supervisor")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def ensure(ctx, as_json):
    payload = master_service.ensure_master(
        ctx.home,
        ctx.runtime_dir,
        ctx.log_level,
        ctx.config_home,
    )
    if as_json:
        _json(payload)
        return
    click.echo("started" if payload.get("changed") else "already running")


@master.command(help="start the resident master supervisor")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def start(ctx, as_json):
    payload = master_service.ensure_master(
        ctx.home,
        ctx.runtime_dir,
        ctx.log_level,
        ctx.config_home,
    )
    if as_json:
        _json(payload)
        return
    click.echo("started" if payload.get("changed") else "already running")


@master.command(help="stop the resident master supervisor")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def stop(ctx, as_json):
    payload = master_service.stop_supervisor(ctx.config_home)
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
    stopped = master_service.stop_supervisor(ctx.config_home)
    if stopped.get("error"):
        raise click.ClickException(str(stopped["error"]))
    started = master_service.ensure_master(
        ctx.home,
        ctx.runtime_dir,
        ctx.log_level,
        ctx.config_home,
    )
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


@master.command(name="assess-worker", hidden=True)
@click.option("--runtime-dir", required=True)
@click.option("--assessment-key", required=True)
def assess_worker(runtime_dir, assessment_key):
    _json(master_service.run_assessment_worker(runtime_dir, assessment_key))


@master.command(
    name="assessments",
    help="show claim assessment freshness and fitness before proof/replay drill-down",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def assessments(ctx, as_json):
    payload = master_service.publish_assessment_snapshot(ctx.runtime_dir)
    if as_json:
        _json(payload)
        return
    click.echo(f"assessments: {payload['assessment_count']}")
    for assessment in payload["assessments"]:
        request = assessment["request"]
        click.echo(
            f"{assessment['state']}: {request['claim_id']} "
            f"for {request['purpose']} ({assessment['assessment_key']})"
        )
        if "report" in assessment:
            report = assessment["report"]
            click.echo(
                f"  fitness={report['state']} proof={report['query_proof_root']}"
            )
            risks = report.get("residual_risks") or []
            if risks:
                click.echo(f"  residual-risk={'; '.join(risks)}")


@master.command(name="trust", help="require a fresh assessment for a purpose")
@click.option("--assessment-key", required=True)
@click.option("--purpose", required=True)
@click.option("--await-seconds", type=float, default=0.0, show_default=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@master_command_context
def trust(ctx, assessment_key, purpose, await_seconds, as_json):
    if await_seconds > 0:
        payload = master_service.storage_service.trust_await(
            ctx.runtime_dir,
            assessment_key,
            purpose=purpose,
            timeout_seconds=await_seconds,
        )
    else:
        payload = master_service.storage_service.trust_require(
            ctx.runtime_dir, assessment_key, purpose=purpose
        )
    if as_json:
        _json(payload)
    else:
        click.echo("allowed" if payload["allowed"] else f"blocked: {payload['reason']}")
    if not payload["allowed"]:
        raise click.exceptions.Exit(2)


@master.command(help="run the foreground master supervisor service loop")
@click.option(
    "--home",
    "runtime_home",
    required=False,
    hidden=True,
    help="runtime home passed by the service manager",
)
@click.option(
    "--runtime-dir",
    required=False,
    hidden=True,
    help="runtime directory passed by the service manager",
)
@click.option(
    "--config-home",
    required=False,
    hidden=True,
    help="config home passed by the service manager",
)
@click.option("--foreground", is_flag=True, hidden=True)
def supervise(runtime_home, runtime_dir, config_home, foreground):
    callable(foreground)
    root = click.get_current_context().parent.parent
    sys.exit(
        master_service.run_supervisor(
            getattr(root, "log_level", "warning"),
            config_home=config_home,
            home=runtime_home,
            runtime_dir=runtime_dir,
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
        ctx.home, ctx.runtime_dir, ctx.log_level, ctx.config_home
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
    payload = master_service.service_status(
        ctx.home,
        ctx.runtime_dir,
        ctx.log_level,
        ctx.config_home,
    )
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
            ctx.home,
            ctx.runtime_dir,
            ctx.log_level,
            ctx.config_home,
        )
    else:
        payload = {
            "schema": "kungfu.master-service.result/v1",
            "action": "install",
            "changed": False,
            "dryRun": True,
            "plan": master_service.service_plan(
                ctx.home,
                ctx.runtime_dir,
                ctx.log_level,
                ctx.config_home,
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
            ctx.home,
            ctx.runtime_dir,
            ctx.log_level,
            ctx.config_home,
        )
    else:
        payload = {
            "schema": "kungfu.master-service.result/v1",
            "action": "uninstall",
            "changed": False,
            "dryRun": True,
            "plan": master_service.service_plan(
                ctx.home,
                ctx.runtime_dir,
                ctx.log_level,
                ctx.config_home,
            ).as_dict(),
        }
    if as_json:
        _json(payload)
        return
    click.echo("[dry-run] uninstall preview" if not execute else "uninstalled")
    click.echo(payload["plan"]["uninstallNote"])
