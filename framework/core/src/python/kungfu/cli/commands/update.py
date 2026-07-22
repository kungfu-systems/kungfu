# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

import click

import kungfu
from kungfu import (
    distribution_update,
    runtime_broker,
    runtime_service,
    runtime_upgrade,
)
from kungfu.cli.commands import PrioritizedCommandGroup, kfc


update_context = kfc.pass_context()


def _json(value):
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _manifest(reference):
    try:
        return distribution_update.load_release_manifest(reference)
    except (
        distribution_update.DistributionUpdateError,
        runtime_upgrade.UpgradeError,
    ) as error:
        raise click.ClickException(str(error)) from error


def _source():
    try:
        return distribution_update.install_source()
    except distribution_update.DistributionUpdateError as error:
        raise click.ClickException(str(error)) from error


def _plain_check(payload):
    message = payload["message"]
    click.echo(message["title"])
    click.echo(f"what happened: {message['whatHappened']}")
    click.echo(f"current work: {message['activeWork']}")
    click.echo(f"takes effect: {message['activation']}")
    click.echo(f"your action: {message['userAction']}")
    click.echo(f"data and sessions: {message['dataAndSessions']}")
    if payload["managerCommand"]:
        click.echo(f"Update with: {' '.join(payload['managerCommand'])}")
    click.echo(f"Learn more: {message['documentationUrl']}")


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="check and prepare product updates without a background updater",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def update(ctx):
    pass


@update.command(name="status", help="show install ownership and installed runtimes")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@update_context
def update_status(ctx, as_json):
    source = _source()
    workspace = runtime_broker.workspace_id(ctx.runtime_dir)
    current = runtime_upgrade.active_image(ctx.config_home, workspace)
    payload = {
        "schema": "kungfu.product-update-status/v1",
        "frontendVersion": kungfu.__version__,
        "frontendBuildId": source.get("selectedFrontendBuildId"),
        "installSource": source,
        "workspaceId": workspace,
        "selectedRuntime": current,
        "installedRuntimes": runtime_upgrade.list_images(ctx.config_home),
        "backgroundUpdater": False,
    }
    if as_json:
        _json(payload)
        return
    click.echo(f"frontend: {payload['frontendVersion']}")
    if payload["frontendBuildId"]:
        click.echo(f"frontend build: {payload['frontendBuildId']}")
    click.echo(f"install source: {source['source']}")
    click.echo(
        f"selected runtime: {current['buildId'] if current else 'bundled until first activation'}"
    )
    click.echo(f"installed runtimes: {len(payload['installedRuntimes'])}")
    click.echo("background updater: disabled")


@update.command(name="check", help="check one signed release manifest")
@click.argument("manifest")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def update_check(manifest, as_json):
    value, remote = _manifest(manifest)
    try:
        payload = distribution_update.check_release(
            value,
            current_version=kungfu.__version__,
            source=_source(),
            require_publication=remote
            or any(item["kind"] == "cli" for item in value["artifacts"]),
        )
    except distribution_update.DistributionUpdateError as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    _plain_check(payload)


def _activation_plan(ctx, manifest):
    images = runtime_upgrade.list_images(ctx.config_home)
    target = next(
        (image for image in images if image["buildId"] == manifest["runtimeBuildId"]),
        manifest,
    )
    workspace = runtime_broker.workspace_id(ctx.runtime_dir)
    current = runtime_upgrade.active_image(ctx.config_home, workspace)
    status = runtime_service.route_status(ctx.home, ctx.runtime_dir, ctx.config_home)
    product = status.get("product") or {}
    handle = product.get("handle") or {}
    references = runtime_upgrade.references_from_runtime_status(status, current)
    return runtime_upgrade.plan_upgrade(
        workspace_id=workspace,
        target=target,
        current=current,
        references=references,
        active_generation=handle.get("generation"),
    )


@update.command(name="plan", help="show download ownership and Core activation timing")
@click.argument("manifest")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@update_context
def update_plan(ctx, manifest, as_json):
    value, remote = _manifest(manifest)
    source = _source()
    try:
        checked = distribution_update.check_release(
            value,
            current_version=kungfu.__version__,
            source=source,
            require_publication=remote
            or any(item["kind"] == "cli" for item in value["artifacts"]),
        )
        activation = _activation_plan(ctx, value)
    except (
        distribution_update.DistributionUpdateError,
        runtime_upgrade.UpgradeError,
    ) as error:
        raise click.ClickException(str(error)) from error
    payload = {
        "schema": "kungfu.product-update-plan/v1",
        "check": checked,
        "activationPlan": activation,
        "message": runtime_upgrade.user_message(
            activation["reasonCode"],
            documentation_url=value["documentationUrl"],
            impact=activation["impact"],
        ),
        "documentationUrl": value["documentationUrl"],
    }
    if as_json:
        _json(payload)
        return
    _plain_check(checked)
    click.echo(
        f"current work continues: {'yes' if activation['impact']['activeWorkContinues'] else 'not running'}"
    )
    click.echo(f"new runtime enables: {activation['impact']['activationTiming']}")
    click.echo(payload["message"]["userAction"])


@update.command(name="download", help="download and verify an archive update")
@click.argument("manifest")
@click.option(
    "--cache-root",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help="download cache root; defaults to the user config home",
)
@click.option("--expected-plan-id")
@click.option("--execute", is_flag=True, help="perform the planned download")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@update_context
def update_download(ctx, manifest, cache_root, expected_plan_id, execute, as_json):
    value, _remote = _manifest(manifest)
    source = _source()
    try:
        plan = distribution_update.plan_download(
            value,
            current_version=kungfu.__version__,
            source=source,
            cache_root=cache_root or Path(ctx.config_home) / "runtime" / "downloads",
        )
        if execute and plan["state"] == "download-allowed" and not expected_plan_id:
            raise distribution_update.DistributionUpdateError(
                "expected-plan-required",
                "--execute requires the exact --expected-plan-id from the dry run",
            )
        payload = (
            distribution_update.download(
                plan,
                expected_plan_id=expected_plan_id or plan["planId"],
                execute=execute,
            )
            if plan["state"] == "download-allowed"
            else plan
        )
    except distribution_update.DistributionUpdateError as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    if plan.get("reasonCode") == "downgrade-refused":
        _plain_check(plan)
    elif plan["state"] != "download-allowed":
        command = plan.get("managerCommand") or []
        detail = f": {' '.join(command)}" if command else "."
        click.echo(f"This install is updated externally{detail}")
    elif execute:
        click.echo(f"downloaded and verified: {payload['artifactPath']}")
    else:
        click.echo(f"dry-run: pass --execute --expected-plan-id {plan['planId']}")


@update.command(
    name="apply", help="install a verified archive runtime without replacing live work"
)
@click.argument(
    "manifest", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.argument("archive", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--expected-digest", required=True)
@click.option("--execute", is_flag=True, help="install into versioned inventory")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@update_context
def update_apply(ctx, manifest, archive, expected_digest, execute, as_json):
    value, _remote = _manifest(manifest)
    source = _source()
    if not source.get("selfUpdateAllowed"):
        payload = {
            "schema": distribution_update.APPLY_SCHEMA,
            "state": "action-required",
            "reasonCode": "frontend-authority-external",
            "managerCommand": source.get("managerCommand"),
            "documentationUrl": value["documentationUrl"],
        }
    else:
        try:
            payload = distribution_update.apply_archive(
                value,
                archive,
                current_version=kungfu.__version__,
                config_home=ctx.config_home,
                expected_digest=expected_digest,
                execute=execute,
            )
            if execute and payload["state"] == "complete":
                activation = _activation_plan(ctx, value)
                payload = {
                    **payload,
                    "activationPlan": activation,
                    "message": runtime_upgrade.user_message(
                        activation["reasonCode"],
                        documentation_url=value["documentationUrl"],
                        impact=activation["impact"],
                    ),
                }
        except (
            distribution_update.DistributionUpdateError,
            runtime_upgrade.UpgradeError,
        ) as error:
            raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    if payload.get("reasonCode") == "downgrade-refused":
        _plain_check(payload)
    elif payload["state"] == "action-required" and payload.get("managerCommand"):
        click.echo(f"Update with: {' '.join(payload['managerCommand'])}")
    elif not execute:
        click.echo("dry-run: pass --execute with the same expected digest")
    else:
        activation = payload["activationPlan"]
        click.echo("The verified runtime was installed without replacing current work.")
        click.echo(f"new runtime enables: {activation['impact']['activationTiming']}")
        click.echo(activation["nextAction"])
