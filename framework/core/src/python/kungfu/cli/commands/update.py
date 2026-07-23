# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import click

import kungfu
from kungfu import (
    distribution_update,
    release_channel,
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


def _plain_orchestration_plan(plan):
    click.echo(f"channel: {plan['channel']}")
    click.echo(f"current version: {plan['currentVersion']}")
    click.echo(f"target version: {plan['targetVersion']}")
    click.echo(f"install source: {plan['installSource']['source']}")
    click.echo(
        "current work: continues on its pinned runtime; no work is stopped or migrated"
    )
    click.echo(f"new runtime enables: {plan['impact']['activationTiming']}")
    click.echo(f"state: {plan['state']} ({plan['reasonCode']})")
    click.echo(f"next action: {plan['nextAction']}")
    if plan["action"] == "package-manager":
        command = plan["installSource"].get("managerCommand")
        if command:
            click.echo(f"source-owned command argv: {json.dumps(command)}")
    click.echo(f"plan: {plan['planId']}")
    click.echo(f"Learn more: {plan['documentationUrl']}")


def _discover_update_plan(ctx, channel, offline):
    source = distribution_update.install_source()
    product_manifest = source.get("productManifest")
    if not product_manifest:
        raise distribution_update.DistributionUpdateError(
            "channel-config-unavailable",
            "this installation has no product manifest with release channel trust",
        )
    config = release_channel.channel_config(product_manifest, channel)
    resolved = release_channel.resolve_index(
        config["reference"],
        config["trustedKeys"],
        cache_root=Path(ctx.config_home) / "product" / "update" / "channels",
        offline=offline,
        allow_local=os.environ.get("KUNGFU_UPDATE_ALLOW_LOCAL_CHANNEL") == "1",
    )
    platform_name, architecture = distribution_update._normalize_platform()
    selection = release_channel.select_release(
        resolved["index"],
        channel=channel,
        platform_name=platform_name,
        architecture=architecture,
        install_source=source["source"],
        current_version=kungfu.__version__,
    )
    plan = distribution_update.plan_update(
        selection,
        current_version=kungfu.__version__,
        source=source,
        cache_root=Path(ctx.config_home) / "product" / "update" / "downloads",
    )
    return {
        "schema": "kungfu.product-update-discovery/v1",
        "transportState": resolved["transportState"],
        "cachePath": resolved["cachePath"],
        "plan": plan,
    }


def _update_failure(ctx, as_json, error):
    code = getattr(error, "code", "update-failed")
    receipt = getattr(error, "receipt", None)
    if as_json:
        _json(
            {
                "schema": "kungfu.product-update-command-result/v1",
                "state": "failed",
                "reasonCode": code,
                "message": str(error),
                "receipt": receipt,
            }
        )
    else:
        click.echo(f"Update failed [{code}]: {error}", err=True)
        if receipt:
            click.echo(f"Receipt: {receipt['receiptPath']}", err=True)
    ctx.exit(1)


def _stdin_is_interactive():
    return sys.stdin.isatty()


@kfc.group(
    cls=PrioritizedCommandGroup,
    invoke_without_command=True,
    help_priority=2,
    help=(
        "update this installed product once; existing work stays on its pinned runtime"
    ),
)
@click.option(
    "--check",
    "check_only",
    is_flag=True,
    help="discover and explain the selected release without executing an update",
)
@click.option("--yes", is_flag=True, help="approve the exact discovered update")
@click.option(
    "--channel",
    type=click.Choice(["alpha", "stable"], case_sensitive=True),
    default="alpha",
    show_default=True,
    help="signed release channel to select",
)
@click.option("--offline", is_flag=True, help="use only a fresh verified channel cache")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@click.help_option("-h", "--help")
@kfc.pass_context()
def update(ctx, check_only, yes, channel, offline, as_json):
    if ctx.invoked_subcommand is not None:
        return
    try:
        discovery = _discover_update_plan(ctx, channel, offline)
        plan = discovery["plan"]
        if check_only or plan["state"] != "update-available":
            if as_json:
                _json(discovery)
            else:
                _plain_orchestration_plan(plan)
            return
        if not yes and (as_json or not _stdin_is_interactive()):
            result = {
                **discovery,
                "state": "action-required",
                "reasonCode": "confirmation-required",
                "nextAction": "Rerun with --yes to execute this exact release plan.",
            }
            if as_json:
                _json(result)
            else:
                _plain_orchestration_plan(plan)
                click.echo(result["nextAction"])
            return
        if not yes:
            _plain_orchestration_plan(plan)
            if not click.confirm("Proceed with this exact update?", default=False):
                receipt = distribution_update.record_update_outcome(
                    plan,
                    config_home=ctx.config_home,
                    state="cancelled",
                    reason_code="cancelled-by-user",
                )
                click.echo(f"Update cancelled. Receipt: {receipt['receiptPath']}")
                return
        receipt = distribution_update.execute_update(
            plan,
            expected_plan_id=plan["planId"],
            current_version=kungfu.__version__,
            config_home=ctx.config_home,
            activation_planner=lambda manifest: _activation_plan(ctx, manifest),
        )
        if as_json:
            _json(receipt)
        else:
            click.echo(
                f"Updated and verified {plan['currentVersion']} -> {plan['targetVersion']}."
            )
            click.echo(f"Receipt: {receipt['receiptPath']}")
            activation = receipt.get("result", {}).get("activationPlan")
            if activation:
                click.echo(
                    f"new runtime enables: {activation['impact']['activationTiming']}"
                )
                click.echo(activation["nextAction"])
    except (
        distribution_update.DistributionUpdateError,
        release_channel.ReleaseChannelError,
        runtime_upgrade.UpgradeError,
    ) as error:
        _update_failure(ctx, as_json, error)


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
        "frontendInventory": distribution_update.cli_inventory_fsck(ctx.config_home),
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
    click.echo(
        "frontend inventory: "
        + ("verified" if payload["frontendInventory"]["ok"] else "recovery required")
    )
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
