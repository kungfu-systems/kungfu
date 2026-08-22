# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import click

from kungfu import contract as contract_runtime
from kungfu import (
    diagnostics,
    peer_lifecycle,
    runtime_broker,
    runtime_service,
    runtime_upgrade,
)
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.preflight import command_preflight
from kungfu.execution_surface import authority as runtime_surface

runtime_command_context = kfc.pass_context()


def _json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _load_object(path):
    value = json.loads(Path(path).read_text("utf-8"))
    if not isinstance(value, dict):
        raise click.ClickException(f"JSON input is not an object: {path}")
    return value


def _load_array(path):
    if path is None:
        return []
    value = json.loads(Path(path).read_text("utf-8"))
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise click.ClickException(f"JSON input is not an array of objects: {path}")
    return value


def render_plain_status(payload):
    """Render the stable human-readable status without changing its line contract."""

    product = payload.get("product") or {}
    click.echo(f"workspace: {product.get('availability', 'unknown')}")
    click.echo(f"live runtime: {product.get('liveState', 'unknown')}")
    handle = product.get("handle")
    if handle:
        readiness = handle.get("readiness") or {}
        click.echo(f"generation: {handle.get('generation', '-')}")
        click.echo(f"readiness: {readiness.get('state', '-')}")
        click.echo(f"durable cut: {json.dumps(readiness.get('durableCut'))}")
        click.echo(f"projection cut: {json.dumps(readiness.get('projectionCut'))}")
        click.echo(f"active leases: {product.get('leases', {}).get('activeCount', 0)}")
    error = product.get("error")
    if error:
        code = error.get("code") or "runtime_not_ready"
        technical_detail = error.get("message") or error
        translated = diagnostics.problem(
            str(code),
            area="runtime",
            technical_detail=str(technical_detail),
        )
        actionable = map(
            "  ".__add__, diagnostics.actionable_text(translated).splitlines()
        )
        click.echo("\n".join(["runtime problem:", *actionable]))
    click.echo(f"config: {payload['configHome']}")
    click.echo(f"data root: {payload['dataRoot']}")
    click.echo(f"runtime: {payload['runtimeDir']}")
    click.echo("process diagnostics:")
    click.echo(f"  lifecycle: {payload.get('lifecycle', {}).get('state', '-')}")
    supervisor = payload["supervisor"]
    supervisor_pid = supervisor["pid"] or "-"
    click.echo(
        "  supervisor: "
        f"{supervisor_pid} ({('stopped', 'running')[bool(supervisor['running'])]})"
    )
    if "coordinator" in payload:
        coordinator = payload["coordinator"]
        coordinator_pid = coordinator["pid"] or "-"
        click.echo(
            "  coordinator: "
            f"{coordinator_pid} "
            f"({('stopped', 'running')[bool(coordinator['running'])]})"
        )
    warnings = payload.get("lifecycle", {}).get("warnings")
    if warnings:
        click.echo(f"warnings: {', '.join(warnings)}")


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="inspect or operate the resident runtime (ordinary work auto-activates it)",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def runtime(ctx):
    pass


@runtime.group(
    name="surface",
    cls=PrioritizedCommandGroup,
    help="select and verify one explicit execution surface with rooted provenance",
)
@click.help_option("-h", "--help")
@runtime_command_context
def runtime_surface_group(ctx):
    pass


@runtime_surface_group.command(
    name="contract", help="show the machine-readable runtime surface authority"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def runtime_surface_contract(as_json):
    payload = runtime_surface.load_contract()
    _json(payload) if as_json else click.echo(
        json.dumps(payload, indent=2, sort_keys=True)
    )


@runtime_surface_group.command(
    name="resolve", help="resolve one explicit request into a rooted provenance receipt"
)
@click.argument(
    "request_path", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def runtime_surface_resolve(request_path, as_json):
    try:
        payload = runtime_surface.resolve(_load_object(request_path))
    except runtime_surface.RuntimeSurfaceError as error:
        if as_json:
            _json(error.diagnosis())
        else:
            raise click.ClickException(str(error)) from error
        raise click.exceptions.Exit(2) from error
    _json(payload) if as_json else click.echo(
        f"{payload['operationId']}: {payload['runtimeSurface']} "
        f"({payload['receiptRoot']})"
    )


@runtime_surface_group.command(
    name="verify",
    help="verify one runtime surface receipt against the current contract",
)
@click.argument(
    "receipt_path", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def runtime_surface_verify(receipt_path, as_json):
    try:
        payload = runtime_surface.verify(_load_object(receipt_path))
    except runtime_surface.RuntimeSurfaceError as error:
        if as_json:
            _json(error.diagnosis())
        else:
            raise click.ClickException(str(error)) from error
        raise click.exceptions.Exit(2) from error
    _json(payload) if as_json else click.echo(
        f"verified {payload['runtimeSurface']} {payload['receiptRoot']}"
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


@runtime.group(
    name="upgrade",
    help="inspect and plan the shared desktop/CLI runtime upgrade control plane",
)
@click.help_option("-h", "--help")
@runtime_command_context
def runtime_upgrade_group(ctx):
    pass


@runtime_upgrade_group.command(
    name="contract", help="show the welded product upgrade contract"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def upgrade_contract(as_json):
    payload = contract_runtime.load_contract("upgrade")
    if as_json:
        _json(payload)
        return
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


@runtime_upgrade_group.command(
    name="inventory", help="list verified immutable runtime images"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def upgrade_inventory(ctx, as_json):
    payload: dict[str, Any] = {
        "schema": "kungfu.runtime-image-inventory/v1",
        "images": runtime_upgrade.list_images(ctx.config_home),
    }
    if as_json:
        _json(payload)
        return
    for image in payload["images"]:
        click.echo(f"{image['buildId']}  {image['state']}  {image['artifactRoot']}")


@runtime_upgrade_group.command(
    name="plan-install", help="verify a runtime image without activating it"
)
@click.argument(
    "manifest", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def upgrade_plan_install(ctx, manifest, source, as_json):
    payload = runtime_upgrade.plan_install(
        _load_object(manifest), source, ctx.config_home
    )
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['state']}: {payload['reasonCode']}")
    click.echo(f"plan: {payload['planId']}")
    click.echo(f"target: {payload['targetRoot']}")


@runtime_upgrade_group.command(
    name="install", help="install a verified image side by side; never activates it"
)
@click.argument(
    "manifest", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--expected-plan-id", required=True)
@click.option("--execute", is_flag=True, help="perform the planned inventory write")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def upgrade_install(ctx, manifest, source, expected_plan_id, execute, as_json):
    plan = runtime_upgrade.plan_install(_load_object(manifest), source, ctx.config_home)
    if plan["planId"] != expected_plan_id:
        raise click.ClickException(
            "expected plan id does not match the current install plan"
        )
    payload = (
        runtime_upgrade.install_image(
            plan,
            expected_plan_id=expected_plan_id,
            config_home=ctx.config_home,
        )
        if execute
        else {**plan, "executeRequired": True}
    )
    if as_json:
        _json(payload)
        return
    click.echo(
        f"installed: {payload['buildId']}"
        if execute
        else f"dry-run: pass --execute with --expected-plan-id {expected_plan_id}"
    )


@runtime_upgrade_group.command(
    name="plan", help="compute activation timing and user impact for one target release"
)
@click.argument(
    "manifest", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--references", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--provider-resume-required", is_flag=True)
@click.option("--provider-resume-supported", is_flag=True)
@click.option("--backup-ready", is_flag=True)
@click.option("--user-confirmed", is_flag=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def upgrade_plan(
    ctx,
    manifest,
    references,
    provider_resume_required,
    provider_resume_supported,
    backup_ready,
    user_confirmed,
    as_json,
):
    manifest_value = runtime_upgrade.validate_manifest(_load_object(manifest))
    images = runtime_upgrade.list_images(ctx.config_home)
    target = next(
        (
            image
            for image in images
            if image["buildId"] == manifest_value["runtimeBuildId"]
        ),
        manifest_value,
    )
    workspace = runtime_broker.workspace_id(ctx.runtime_dir)
    current = runtime_upgrade.active_image(ctx.config_home, workspace)
    status = runtime_service.route_status(ctx.home, ctx.runtime_dir, ctx.config_home)
    product = status["product"]
    handle = product.get("handle") or {}
    reference_values = (
        _load_array(references)
        if references is not None
        else runtime_upgrade.references_from_runtime_status(status, current)
    )
    payload = runtime_upgrade.plan_upgrade(
        workspace_id=workspace,
        target=target,
        current=current,
        references=reference_values,
        active_generation=handle.get("generation"),
        provider_resume_required=provider_resume_required,
        provider_resume_supported=provider_resume_supported,
        backup_ready=backup_ready,
        user_confirmed=user_confirmed,
    )
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['state']}: {payload['reasonCode']}")
    click.echo(payload["nextAction"])


@runtime_upgrade_group.command(
    name="stage", help="stage a fenced generation without committing readiness"
)
@click.argument("plan", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--expected-plan-id", required=True)
@click.option("--current-generation")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def upgrade_stage(ctx, plan, expected_plan_id, current_generation, as_json):
    payload = runtime_upgrade.stage_upgrade(
        _load_object(plan),
        expected_plan_id=expected_plan_id,
        current_generation=current_generation,
        config_home=ctx.config_home,
    )
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['state']}: generation {payload['generation']}")
    click.echo(f"receipt: {payload['receiptId']}")


@runtime_upgrade_group.command(
    name="reconcile", help="commit readiness or apply the declared rollback policy"
)
@click.argument("receipt", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--readiness-passed", type=click.Choice(["yes", "no"]), required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def upgrade_reconcile(ctx, receipt, readiness_passed, as_json):
    payload = runtime_upgrade.reconcile_upgrade(
        _load_object(receipt),
        readiness_passed=readiness_passed == "yes",
        config_home=ctx.config_home,
    )
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['state']}: {payload['reasonCode']}")


@runtime_upgrade_group.command(
    name="gc-plan", help="list only images with no live or retained reference"
)
@click.option(
    "--references", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--unknown-references",
    is_flag=True,
    help="fail closed when ownership discovery is incomplete",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def upgrade_gc_plan(ctx, references, unknown_references, as_json):
    payload = runtime_upgrade.plan_gc(
        runtime_upgrade.list_images(ctx.config_home),
        _load_array(references),
        unknown_references=unknown_references,
    )
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['state']}: {len(payload['candidates'])} collectable image(s)")


@runtime_upgrade_group.command(
    name="gc", help="apply an unchanged runtime-image GC plan"
)
@click.argument("plan", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--references", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--unknown-references",
    is_flag=True,
    help="fail closed when ownership discovery is incomplete",
)
@click.option("--expected-plan-id", required=True)
@click.option(
    "--execute",
    is_flag=True,
    help="delete only plan-proven unreferenced runtime images",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@runtime_command_context
def upgrade_gc(
    ctx, plan, references, unknown_references, expected_plan_id, execute, as_json
):
    plan_value = _load_object(plan)
    if not execute:
        payload = {**plan_value, "executeRequired": True}
    else:
        payload = {
            "schema": "kungfu.runtime-image-gc-receipt/v1",
            "planId": expected_plan_id,
            "removedBuildIds": runtime_upgrade.apply_gc(
                plan_value,
                expected_plan_id=expected_plan_id,
                config_home=ctx.config_home,
                references=_load_array(references),
                unknown_references=unknown_references,
            ),
        }
    if as_json:
        _json(payload)
        return
    if execute:
        click.echo(
            f"complete: removed {len(payload['removedBuildIds'])} runtime image(s)"
        )
    else:
        click.echo(
            f"dry-run: pass --execute with --expected-plan-id {expected_plan_id}"
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
    render_plain_status(payload)


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
