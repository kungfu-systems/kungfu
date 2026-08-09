# SPDX-License-Identifier: Apache-2.0

"""Installed human and agent release verification commands."""

from __future__ import annotations

import json

import click

from kungfu import release_verifier
from kungfu.cli.commands import PrioritizedCommandGroup, kfc


def _json(value):
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _human(result):
    if not result["verified"]:
        click.echo("Kungfu release verification: REJECTED")
        click.echo(f"What failed: {result['issues'][0]}")
        click.echo("Meaning: this document must not be used as release proof.")
        return
    if result["releaseAvailable"]:
        click.echo("Kungfu release verification: VERIFIED CURRENT RELEASE")
        click.echo(f"Version: {result['version']}")
        if result.get("sourceSha"):
            click.echo(f"Product source: {result['sourceSha']}")
        if result.get("siteSourceSha"):
            click.echo(f"Site source: {result['siteSourceSha']}")
    else:
        click.echo("Kungfu release verification: VERIFIED, NOT AVAILABLE")
    click.echo(f"What this proves: {result['meaning']}")
    click.echo(
        "What this does not prove: legal sufficiency, trademark registration, "
        "or a first-use date."
    )


@kfc.group(
    name="release",
    cls=PrioritizedCommandGroup,
    help_priority=1,
    help="understand and verify the public Kungfu release state",
)
@click.help_option("-h", "--help")
def release_group():
    pass


@release_group.command(
    name="status",
    help="read and explain the truthful public release status",
)
@click.option(
    "--source",
    default=release_verifier.OFFICIAL_STATUS_URL,
    show_default=True,
    help="local JSON path or public HTTPS status URL",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def status_cmd(source, as_json):
    try:
        document, locator = release_verifier.load_subject(source)
    except release_verifier.ReleaseVerificationError as error:
        raise click.ClickException(str(error)) from error
    result = release_verifier.verify(document, locator=locator)
    if as_json:
        _json(result)
    else:
        _human(result)
    if not result["verified"]:
        raise click.exceptions.Exit(4)


@release_group.command(
    name="verify",
    help="verify a status, activation receipt set, or released-evidence JSON",
)
@click.argument("source")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def verify_cmd(source, as_json):
    try:
        document, locator = release_verifier.load_subject(source)
    except release_verifier.ReleaseVerificationError as error:
        raise click.ClickException(str(error)) from error
    result = release_verifier.verify(document, locator=locator)
    if as_json:
        _json(result)
    else:
        _human(result)
    if not result["verified"]:
        raise click.exceptions.Exit(4)


@release_group.command(
    name="explain",
    help="explain what release verification proves and does not prove",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def explain_cmd(as_json):
    result = release_verifier.explain()
    if as_json:
        _json(result)
        return
    click.echo("Kungfu release verification answers one practical question:")
    click.echo(
        "Can this exact public release state be trusted as internally consistent?"
    )
    for state, meaning in result["states"].items():
        click.echo(f"  {state}: {meaning}")
    click.echo("It makes no legal, registration, or first-use-date conclusion.")
