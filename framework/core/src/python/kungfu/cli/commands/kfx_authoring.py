# SPDX-License-Identifier: Apache-2.0

"""Thin Click adapter for the installed KFX authoring kit."""

import json
import subprocess
from pathlib import Path

import click

from kungfu import kfx_authoring


def register_authoring_commands(kfx, kfx_command_context):
    @kfx.group(
        name="author",
        help="build and qualify a KFX from the installed version-matched authoring kit",
    )
    @click.help_option("-h", "--help")
    @kfx_command_context
    def author_group(ctx):
        pass

    def author_json(operation):
        try:
            value = operation()
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            click.echo(
                json.dumps(kfx_authoring.emit_error(error), indent=2, sort_keys=True),
                err=True,
            )
            raise click.exceptions.Exit(1) from error
        click.echo(json.dumps(value, indent=2, sort_keys=True))

    @author_group.command(name="brief", help="print the installed KFX authoring brief")
    @kfx_command_context
    def author_brief(ctx):
        del ctx
        try:
            click.echo(kfx_authoring.brief(), nl=False)
        except (OSError, ValueError) as error:
            raise click.ClickException(str(error)) from error

    @author_group.command(
        name="capabilities",
        help="inspect installed SDK, templates, lifecycle, and roots",
    )
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    @kfx_command_context
    def author_capabilities(ctx, as_json):
        del ctx, as_json
        author_json(kfx_authoring.capabilities)

    @author_group.command(
        name="scaffold", help="plan or materialize the deterministic webhook starter"
    )
    @click.argument("package_key")
    @click.option("--out", required=True, type=click.Path(path_type=Path))
    @click.option(
        "--title", default=None, help="human title; defaults from package key"
    )
    @click.option("--version", default="0.1.0", show_default=True)
    @click.option("--execute", is_flag=True, help="write the exact planned source tree")
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    @kfx_command_context
    def author_scaffold(ctx, package_key, out, title, version, execute, as_json):
        del ctx, as_json

        def operation():
            plan = kfx_authoring.scaffold_plan(
                package_key, out, title=title, version=version
            )
            return kfx_authoring.apply_scaffold(plan) if execute else plan

        author_json(operation)

    @author_group.command(
        name="inspect", help="inspect one exact authoring source closure"
    )
    @click.argument(
        "source", type=click.Path(exists=True, file_okay=False, path_type=Path)
    )
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    @kfx_command_context
    def author_inspect(ctx, source, as_json):
        del ctx, as_json
        author_json(lambda: kfx_authoring.inspect_source(source))

    @author_group.command(
        name="validate", help="validate SDK, schema, identity, and source roots"
    )
    @click.argument(
        "source", type=click.Path(exists=True, file_okay=False, path_type=Path)
    )
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    @kfx_command_context
    def author_validate(ctx, source, as_json):
        del ctx, as_json
        author_json(lambda: kfx_authoring.inspect_source(source))

    @author_group.command(
        name="build", help="plan or materialize an offline deterministic package tree"
    )
    @click.argument(
        "source", type=click.Path(exists=True, file_okay=False, path_type=Path)
    )
    @click.option("--out", required=True, type=click.Path(path_type=Path))
    @click.option("--execute", is_flag=True, help="write the exact planned build tree")
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    @kfx_command_context
    def author_build(ctx, source, out, execute, as_json):
        del ctx, as_json

        def operation():
            plan = kfx_authoring.build_plan(source, out)
            return kfx_authoring.apply_build(plan) if execute else plan

        author_json(operation)

    @author_group.command(
        name="qualify", help="run the installed-only loopback lifecycle fixture"
    )
    @click.argument(
        "source", type=click.Path(exists=True, file_okay=False, path_type=Path)
    )
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    @kfx_command_context
    def author_qualify(ctx, source, as_json):
        del ctx, as_json
        author_json(lambda: kfx_authoring.qualify(source))

    @author_group.command(
        name="package", help="plan or write a deterministic npm-compatible KFX tgz"
    )
    @click.argument(
        "source", type=click.Path(exists=True, file_okay=False, path_type=Path)
    )
    @click.option("--out", required=True, type=click.Path(path_type=Path))
    @click.option("--execute", is_flag=True, help="write the exact planned tgz")
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    @kfx_command_context
    def author_package(ctx, source, out, execute, as_json):
        del ctx, as_json

        def operation():
            plan = kfx_authoring.package_plan(source, out)
            return kfx_authoring.apply_package(plan) if execute else plan

        author_json(operation)

    # Preserve the pre-split public callback coordinates. The Click tree owns
    # command identity; moving this adapter must not rename governed surfaces.
    for command in [author_group, *author_group.commands.values()]:
        command.callback.__module__ = "kungfu.cli.commands.kfx"
