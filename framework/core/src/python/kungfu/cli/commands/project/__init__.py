# SPDX-License-Identifier: Apache-2.0

"""`kungfu project` — one product path for project discovery and creation."""

from __future__ import annotations

import json

import click

from kungfu import projects
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.surface_contract import surface
from kungfu.project_template import BLANK_TEMPLATE_ID

project_context = kfc.pass_context()


def _emit(payload):
    click.echo(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def _run(operation):
    try:
        return operation()
    except (OSError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=1,
    help="create, open, select, and inspect Projects",
)
def project():
    """Manage project locators without creating a second Work authority."""


@project.command(name="list", help="list Projects remembered on this machine")
@surface(
    output={
        "defaultMode": "json",
        "modes": ["json"],
        "schemaRefs": ["kungfu.projects.catalog/v1"],
    }
)
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="emit the default machine-readable JSON response",
)
@project_context
def list_projects(ctx, as_json):
    del as_json
    _emit(_run(lambda: projects.catalog(config_home=ctx.config_home)))


@project.command(help="list installed Project templates", hidden=True)
def templates():
    _emit(_run(projects.templates))


@project.command(name="works", help="list retained Work captured in one Project")
@surface(
    output={
        "defaultMode": "json",
        "modes": ["json"],
        "schemaRefs": ["kungfu.project-work.inventory/v1"],
    }
)
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="emit the default machine-readable JSON response",
)
@click.argument("path", type=click.Path(exists=True, file_okay=False))
def works(path, as_json):
    del as_json
    _emit(_run(lambda: projects.work_inventory(path)))


@project.command(name="create-plan", help="preview creating one Project")
@click.option("--destination", type=click.Path(file_okay=False), default=None)
@click.option("--parent", type=click.Path(file_okay=False), default=None)
@click.option("--template", "template_id", default=BLANK_TEMPLATE_ID)
def create_plan(destination, parent, template_id):
    _emit(
        _run(
            lambda: projects.plan_create(
                destination=destination,
                parent=parent,
                template_id=template_id,
            )
        )
    )


@project.command(help="create and select one Project from an exact plan")
@click.argument("destination", type=click.Path(file_okay=False))
@click.option("--template", "template_id", default=BLANK_TEMPLATE_ID)
@click.option("--expected-plan-root", required=True)
@click.option("--actor", default="local-user", show_default=True)
@click.option("--execute", is_flag=True, help="confirm the planned file writes")
@project_context
def create(ctx, destination, template_id, expected_plan_root, actor, execute):
    if not execute:
        raise click.ClickException("project create requires --execute")
    _emit(
        _run(
            lambda: projects.create(
                destination=destination,
                expected_plan_root=expected_plan_root,
                actor=actor,
                template_id=template_id,
                config_home=ctx.config_home,
            )
        )
    )


@project.command(name="open-plan", help="preview opening an existing Project")
@click.argument("path", type=click.Path(exists=True, file_okay=False))
def open_plan(path):
    _emit(_run(lambda: projects.plan_import(path)))


@project.command(name="open", help="remember and open an existing Project")
@click.argument("path", type=click.Path(exists=True, file_okay=False))
@click.option("--expected-plan-root", required=True)
@click.option("--execute", is_flag=True, help="confirm opening the Project")
@project_context
def open_existing(ctx, path, expected_plan_root, execute):
    if not execute:
        raise click.ClickException("project open requires --execute")
    _emit(
        _run(
            lambda: projects.import_project(
                path,
                expected_plan_root=expected_plan_root,
                config_home=ctx.config_home,
            )
        )
    )


@project.command(help="select a remembered or existing Project")
@click.argument("path", type=click.Path(exists=True, file_okay=False))
@project_context
def select(ctx, path):
    _emit(_run(lambda: projects.select_project(path, config_home=ctx.config_home)))


@project.command(name="remove-plan", help="preview removing one Project")
@click.argument("project_id")
@project_context
def remove_plan(ctx, project_id):
    _emit(
        _run(
            lambda: projects.plan_remove(
                project_id,
                config_home=ctx.config_home,
            )
        )
    )


@project.command(help="remove one Project from this machine without deleting its files")
@click.argument("project_id")
@click.option("--expected-plan-root", required=True)
@click.option("--execute", is_flag=True, help="confirm the machine-local removal")
@project_context
def remove(ctx, project_id, expected_plan_root, execute):
    if not execute:
        raise click.ClickException("project remove requires --execute")
    _emit(
        _run(
            lambda: projects.remove(
                project_id,
                expected_plan_root=expected_plan_root,
                config_home=ctx.config_home,
            )
        )
    )
