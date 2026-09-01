# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import click

from kungfu import contract as contract_runtime
from kungfu import runtime_broker, runtime_service, runtime_upgrade

from kungfu.cli.commands._runtime.base import (
    _json,
    _load_array,
    _load_object,
    runtime,
    runtime_command_context,
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


def _discover_gc_references(ctx, *, inventory_nonempty):
    workspace = runtime_broker.workspace_id(ctx.runtime_dir)
    current = runtime_upgrade.active_image(ctx.config_home, workspace)
    status = runtime_service.route_status(ctx.home, ctx.runtime_dir, ctx.config_home)
    references = runtime_upgrade.references_from_runtime_status(status, current)
    return references, bool(inventory_nonempty and current is None)


def _gc_reference_inputs(ctx, references, *, inventory_nonempty):
    if references is not None:
        return _load_array(references), False
    return _discover_gc_references(ctx, inventory_nonempty=inventory_nonempty)


def _plan_gc(ctx, references, unknown_references):
    images = runtime_upgrade.list_images(ctx.config_home)
    reference_values, discovery_incomplete = _gc_reference_inputs(
        ctx, references, inventory_nonempty=images
    )
    return runtime_upgrade.plan_gc(
        images,
        reference_values,
        unknown_references=unknown_references or discovery_incomplete,
    )


def _apply_gc(ctx, plan_value, references, unknown_references, expected_plan_id):
    reference_values, discovery_incomplete = _gc_reference_inputs(
        ctx,
        references,
        inventory_nonempty=plan_value.get("candidates") or plan_value.get("blocked"),
    )
    return runtime_upgrade.apply_gc(
        plan_value,
        expected_plan_id=expected_plan_id,
        config_home=ctx.config_home,
        references=reference_values,
        unknown_references=unknown_references or discovery_incomplete,
    )


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
    payload = _plan_gc(ctx, references, unknown_references)
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
            "removedBuildIds": _apply_gc(
                ctx,
                plan_value,
                references,
                unknown_references,
                expected_plan_id,
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


for _symbol in (
    "runtime_upgrade_group",
    "upgrade_contract",
    "upgrade_inventory",
    "upgrade_plan_install",
    "upgrade_install",
    "upgrade_plan",
    "upgrade_stage",
    "upgrade_reconcile",
    "upgrade_gc_plan",
    "upgrade_gc",
):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.runtime"
    globals()[_symbol].callback.__qualname__ = _symbol
