# SPDX-License-Identifier: Apache-2.0

"""Public CLI projection of the Core Exit Bundle composition service."""

import base64
import json
import sys
from pathlib import Path
from typing import Any

import click

from kungfu import exit_bundle, exit_verifier
from kungfu.cli.commands import PrioritizedCommandGroup, kfc


exit_command_context = kfc.pass_context()


def _json(value: Any) -> None:
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _input(file_path: str | None, input_base64: str | None) -> dict[str, Any]:
    if bool(file_path) == bool(input_base64):
        raise click.ClickException(
            "exactly one of --file or --input-base64 is required"
        )
    try:
        if input_base64:
            raw = base64.b64decode(input_base64, validate=True).decode("utf-8")
        else:
            raw = (
                sys.stdin.read()
                if file_path == "-"
                else Path(str(file_path)).read_text(encoding="utf-8")
            )
        value = json.loads(raw)
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if not isinstance(value, dict):
        raise click.ClickException("input must be a JSON object")
    return value


def _run(operation):
    try:
        return operation()
    except exit_bundle.ExitBundleError as error:
        raise click.ClickException(
            json.dumps(error.diagnosis(), sort_keys=True)
        ) from error
    except (OSError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error


def _verification_bytes(file_path: str | None, input_base64: str | None) -> bytes:
    if bool(file_path) == bool(input_base64):
        raise click.ClickException(
            "exactly one of --file or --input-base64 is required"
        )
    try:
        if input_base64:
            maximum = int(exit_verifier.info()["bounds"]["maximumPackageBytes"])
            maximum_encoded = maximum * 4 // 3 + 8
            if len(input_base64) > maximum_encoded:
                raise click.ClickException(
                    "base64 input exceeds Exit verifier byte limit"
                )
            return base64.b64decode(input_base64, validate=True)
        if file_path == "-":
            maximum = int(exit_verifier.info()["bounds"]["maximumPackageBytes"])
            return sys.stdin.buffer.read(maximum + 1)
        return Path(str(file_path)).read_bytes()
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error


@kfc.group(
    name="exit",
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="compose, inspect, and exactly import portable Exit packages",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def exit_group(ctx):
    pass


@exit_group.command(
    name="build",
    help="compose existing domain bundles into one full or thin Exit package",
)
@click.option("--file", "file_path", help="request JSON path or -")
@click.option(
    "--input-base64", help="base64-encoded request JSON for Node and GUI adapters"
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@exit_command_context
def build_cmd(ctx, file_path, input_base64, out, as_json):
    package = _run(
        lambda: exit_bundle.build(ctx.runtime_dir, _input(file_path, input_base64))
    )
    if out is not None:
        _run(lambda: exit_bundle.write(out, package))
    if as_json:
        _json(package)
        return
    click.echo(
        f"[exit] built {package['manifest']['mode']} "
        f"{package['manifest']['bundleId']}: {package['packageRoot']}"
    )
    if out is not None:
        click.echo(f"[exit] wrote {out.resolve()}")


@exit_group.command(
    name="inspect",
    help="verify package, manifest, material bytes, and delegated member roots",
)
@click.option("--file", "file_path", help="package JSON path or -")
@click.option(
    "--input-base64", help="base64-encoded package JSON for Node and GUI adapters"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@exit_command_context
def inspect_cmd(ctx, file_path, input_base64, as_json):
    result = _run(lambda: exit_bundle.inspect(_input(file_path, input_base64)))
    if as_json:
        _json(result)
        return
    click.echo(
        f"[exit] {result['bundleId']} {result['status']}: "
        f"{len(result['verifiedMembers'])} verified member(s)"
    )


@exit_group.command(
    name="verify",
    help="run the packaged read-only Exit verifier without initializing a runtime",
)
@click.option("--file", "file_path", help="package JSON path or -")
@click.option("--input-base64", help="base64-encoded package JSON for process adapters")
@click.option(
    "--info",
    "show_info",
    is_flag=True,
    help="show verifier identity, bounds, versions, corpus, and independence",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@exit_command_context
def verify_cmd(ctx, file_path, input_base64, show_info, as_json):
    if show_info:
        if file_path or input_base64:
            raise click.ClickException("--info does not accept package input")
        result = _run(exit_verifier.info)
    elif file_path and file_path != "-":
        result = exit_verifier.verify_file(file_path)
    else:
        result = exit_verifier.verify_bytes(
            _verification_bytes(file_path, input_base64)
        )
    if as_json or show_info:
        _json(result)
    else:
        click.echo(
            f"[exit-verifier] {result.get('bundleId') or '<unknown>'} "
            f"{result['verdict']}: {result['reportRoot']}"
        )
    verdict = result.get("verdict")
    if verdict == "degraded":
        ctx.exit(3)
    if verdict == "rejected":
        ctx.exit(4)


@exit_group.command(
    name="import",
    help="validate by default or explicitly execute exact import",
)
@click.option("--file", "file_path", help="package JSON path or -")
@click.option(
    "--input-base64", help="base64-encoded package JSON for Node and GUI adapters"
)
@click.option("--execute", is_flag=True, help="materialize after isolated preflight")
@click.option("--authorized-by", help="actor approving this exact execute")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@exit_command_context
def import_cmd(ctx, file_path, input_base64, execute, authorized_by, as_json):
    result = _run(
        lambda: exit_bundle.import_package(
            ctx.runtime_dir,
            _input(file_path, input_base64),
            execute=execute,
            authorized_by=authorized_by or "",
        )
    )
    if as_json:
        _json(result)
    else:
        click.echo(
            f"[exit] {result['bundleId']} {result['status']}: "
            f"written={len(result['writtenMembers'])} "
            f"remaining={len(result['remainingMembers'])}"
        )
    if result.get("ok") is not True:
        ctx.exit(2)
