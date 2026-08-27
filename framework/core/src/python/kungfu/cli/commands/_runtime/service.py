# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import sys

import click

from kungfu import runtime_broker, runtime_service
from kungfu.cli.commands import PrioritizedCommandGroup
from kungfu.cli.preflight import command_preflight

from kungfu.cli.commands._runtime.base import (
    _json,
    _plain_status,
    runtime,
    runtime_command_context,
)


@runtime.command(
    name="status",
    help="print workspace runtime status with advanced process diagnostics",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def runtime_status(ctx, as_json):
    payload = runtime_service.route_status(ctx.home, ctx.runtime_dir, ctx.config_home)
    if as_json:
        _json(payload)
        return
    _plain_status(payload)


@runtime.command(
    name="operations",
    help="list the machine-readable runtime capability operation catalog",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def runtime_operations(as_json):
    payload = runtime_broker.operation_catalog()
    if as_json:
        _json(payload)
        return
    for operation in payload["operations"]:
        capabilities = ", ".join(operation["requiredCapabilities"]) or "none"
        click.echo(
            f"{operation['id']}: {operation['operationClass']} "
            f"(capabilities: {capabilities})"
        )


@runtime.command(
    name="plan",
    help="project one operation into its topology-neutral runtime requirement",
)
@click.argument("operation_id")
@click.option("--request-id", default=None, help="stable caller request identity")
@click.option(
    "--minimum-cut",
    default=None,
    help="minimum stream position as a JSON object",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def runtime_plan(ctx, operation_id, request_id, minimum_cut, as_json):
    try:
        cut = json.loads(minimum_cut) if minimum_cut else None
        if cut is not None and not isinstance(cut, dict):
            raise ValueError("minimum cut must be a JSON object")
        payload = runtime_broker.plan_operation(
            operation_id,
            workspace=runtime_broker.workspace_id(ctx.runtime_dir),
            request_source="cli",
            minimum_cut=cut,
            request_id=request_id,
        )
    except (json.JSONDecodeError, KeyError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    requirement = payload["requirement"]
    click.echo(f"operation: {payload['operation']['id']}")
    click.echo(f"class: {requirement['operationClass']}")
    click.echo(
        "required capabilities: "
        f"{', '.join(requirement['requiredCapabilities']) or 'none'}"
    )
    click.echo(f"recovery: {payload['recoveryGuidance']}")


@runtime.command(
    help="ensure the current data-root coordinator via the user supervisor"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
@command_preflight("runtime-activation")
def ensure(ctx, as_json):
    payload = runtime_service.ensure_coordinator(
        ctx.home,
        ctx.runtime_dir,
        ctx.log_level,
        ctx.config_home,
    )
    if as_json:
        _json(payload)
        return
    click.echo("started" if payload.get("changed") else "already running")


@runtime.command(help="start the resident coordinator supervisor")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
@command_preflight("runtime-activation")
def start(ctx, as_json):
    payload = runtime_service.ensure_coordinator(
        ctx.home,
        ctx.runtime_dir,
        ctx.log_level,
        ctx.config_home,
    )
    if as_json:
        _json(payload)
        return
    click.echo("started" if payload.get("changed") else "already running")


@runtime.command(help="stop the resident coordinator supervisor")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def stop(ctx, as_json):
    payload = runtime_service.stop_supervisor(ctx.config_home)
    if as_json:
        _json(payload)
        return
    if payload.get("error"):
        raise click.ClickException(str(payload["error"]))
    click.echo("stopped" if payload.get("changed") else "already stopped")


@runtime.command(help="restart the resident coordinator supervisor")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
@command_preflight("runtime-activation")
def restart(ctx, as_json):
    stopped = runtime_service.stop_supervisor(ctx.config_home)
    if stopped.get("error"):
        raise click.ClickException(str(stopped["error"]))
    started = runtime_service.ensure_coordinator(
        ctx.home,
        ctx.runtime_dir,
        ctx.log_level,
        ctx.config_home,
    )
    payload = {
        "schema": runtime_service.SCHEMA_RESULT,
        "stop": stopped,
        "start": started,
    }
    if as_json:
        _json(payload)
        return
    click.echo("restarted")


@runtime.command(help="run one foreground coordinator process")
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
    sys.exit(runtime_service.run_coordinator(runtime_home, runtime_dir, low_latency))


@runtime.command(name="assess-worker", hidden=True)
@click.option("--runtime-dir", required=True)
@click.option("--assessment-key", required=True)
def assess_worker(runtime_dir, assessment_key):
    _json(runtime_service.run_assessment_worker(runtime_dir, assessment_key))


@runtime.command(
    name="assessments",
    help="show claim assessment freshness and fitness before proof/replay drill-down",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def assessments(ctx, as_json):
    payload = runtime_service.publish_assessment_snapshot(ctx.runtime_dir)
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


@runtime.command(name="trust", help="require a fresh assessment for a purpose")
@click.option("--assessment-key", required=True)
@click.option("--purpose", required=True)
@click.option("--await-seconds", type=float, default=0.0, show_default=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def trust(ctx, assessment_key, purpose, await_seconds, as_json):
    if await_seconds > 0:
        payload = runtime_service.storage_service.trust_await(
            ctx.runtime_dir,
            assessment_key,
            purpose=purpose,
            timeout_seconds=await_seconds,
        )
    else:
        payload = runtime_service.storage_service.trust_require(
            ctx.runtime_dir, assessment_key, purpose=purpose
        )
    if as_json:
        _json(payload)
    else:
        click.echo("allowed" if payload["allowed"] else f"blocked: {payload['reason']}")
    if not payload["allowed"]:
        raise click.exceptions.Exit(2)


@runtime.command(help="run the foreground coordinator supervisor service loop")
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
    # kfc -> runtime -> supervise, so both parents exist; assert rather than
    # walk defensively, because a refactor that broke the chain would otherwise
    # reach the getattr below and silently downgrade log_level to "warning".
    parent = click.get_current_context().parent
    assert parent is not None and parent.parent is not None
    root = parent.parent
    sys.exit(
        runtime_service.run_supervisor(
            getattr(root, "log_level", "warning"),
            config_home=config_home,
            home=runtime_home,
            runtime_dir=runtime_dir,
        )
    )


@runtime.group(
    cls=PrioritizedCommandGroup,
    help="install, remove, and inspect the user-level coordinator service plan",
)
@click.help_option("-h", "--help")
@runtime_command_context
def service(ctx):
    pass


@service.command(help="print the platform service plan without writing files")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def plan(ctx, as_json):
    payload = runtime_service.service_plan(
        ctx.home, ctx.runtime_dir, ctx.log_level, ctx.config_home
    ).as_dict()
    if as_json:
        _json(payload)
        return
    click.echo(f"path: {payload['path']}")
    click.echo(payload["content"], nl=False)


@service.command(name="status", help="print user-level service installation status")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def service_status(ctx, as_json):
    payload = runtime_service.service_status(
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
@runtime_command_context
def install(ctx, execute, as_json):
    if execute:
        payload = runtime_service.install_service(
            ctx.home,
            ctx.runtime_dir,
            ctx.log_level,
            ctx.config_home,
        )
    else:
        payload = {
            "schema": runtime_service.SCHEMA_RESULT,
            "action": "install",
            "changed": False,
            "dryRun": True,
            "plan": runtime_service.service_plan(
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
@runtime_command_context
def uninstall(ctx, execute, as_json):
    if execute:
        payload = runtime_service.uninstall_service(
            ctx.home,
            ctx.runtime_dir,
            ctx.log_level,
            ctx.config_home,
        )
    else:
        payload = {
            "schema": runtime_service.SCHEMA_RESULT,
            "action": "uninstall",
            "changed": False,
            "dryRun": True,
            "plan": runtime_service.service_plan(
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
