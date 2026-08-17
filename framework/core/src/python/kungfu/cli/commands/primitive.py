# SPDX-License-Identifier: Apache-2.0

"""Read-only product projections over the derived Primitive Catalog."""

from __future__ import annotations

import json
from typing import Any

import click

from kungfu import contract as contract_runtime
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.commands.primitive_role import register_role_commands
from kungfu.cli.surface_contract import surface
from kungfu.primitive_management import availability_report


def _emit(payload: dict[str, Any]) -> None:
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _catalog() -> dict[str, Any]:
    try:
        return contract_runtime.load_contract("primitive-catalog")
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as error:
        raise click.ClickException(
            f"cannot load the derived Primitive Catalog: {error}"
        ) from error


def _primitive(catalog: dict[str, Any], primitive_id: str) -> dict[str, Any]:
    for row in catalog.get("primitives", []):
        if row.get("id") == primitive_id:
            return row
    raise click.ClickException(f"unknown Primitive id: {primitive_id}")


@kfc.group(
    "primitive",
    cls=PrioritizedCommandGroup,
    help_priority=4,
    help="inspect the derived Primitive Catalog and evidence boundaries",
)
@click.help_option("-h", "--help")
def primitive() -> None:
    pass


@primitive.command(
    "list", help="list every declared Primitive from the derived catalog"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def list_primitives(as_json: bool) -> None:
    catalog = _catalog()
    payload = {
        "schema": "kungfu.primitive-list/v1",
        "catalogRoot": catalog["catalogRoot"],
        "authority": catalog["authority"],
        "count": len(catalog.get("primitives", [])),
        "primitives": catalog.get("primitives", []),
    }
    if as_json:
        _emit(payload)
        return
    click.echo(f"Primitive Catalog {payload['catalogRoot']} ({payload['count']})")
    for row in payload["primitives"]:
        definition = row["definition"]
        click.echo(
            f"{row['id']}  {row['admission']['summary']['state']}  "
            f"{definition['classification']['family']}  {definition['identity']['name']}"
        )


@primitive.command("show", help="show one Primitive and its exact evidence state")
@click.argument("primitive_id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def show_primitive(primitive_id: str, as_json: bool) -> None:
    catalog = _catalog()
    payload = {
        "schema": "kungfu.primitive-show/v1",
        "catalogRoot": catalog["catalogRoot"],
        "primitive": _primitive(catalog, primitive_id),
    }
    if as_json:
        _emit(payload)
        return
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


@primitive.command(
    "explain",
    help="explain one Primitive's authority, proof state, and non-claims",
)
@click.argument("primitive_id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def explain_primitive(primitive_id: str, as_json: bool) -> None:
    catalog = _catalog()
    payload = {
        "schema": "kungfu.primitive-explanation/v1",
        "catalogRoot": catalog["catalogRoot"],
        "authority": catalog["authority"],
        "facetRoots": catalog["facetRoots"],
        "primitive": _primitive(catalog, primitive_id),
        "boundaries": {
            "intake": catalog["authority"]["intake"],
            "catalogIsDerived": True,
            "readOnly": True,
            "admissionLabelMutation": False,
            "availabilityInference": False,
        },
    }
    if as_json:
        _emit(payload)
        return
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


@primitive.command(
    "graph",
    help="query rooted typed Primitive dependency and composition relations",
)
@click.option("--from", "source", help="filter by source Primitive id")
@click.option("--to", "target", help="filter by target Primitive id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def graph_primitives(source: str | None, target: str | None, as_json: bool) -> None:
    catalog = _catalog()
    relations = catalog["relationGraph"]["relations"]
    if source:
        _primitive(catalog, source)
        relations = [row for row in relations if row["source"] == source]
    if target:
        _primitive(catalog, target)
        relations = [row for row in relations if row["target"] == target]
    payload = {
        "schema": "kungfu.primitive-relation-query/v1",
        "catalogRoot": catalog["catalogRoot"],
        "catalogAuthoredEdges": False,
        "relations": relations,
    }
    _emit(payload) if as_json else click.echo(
        json.dumps(payload, indent=2, sort_keys=True)
    )


@primitive.command(
    "availability",
    help="bind one Primitive to an explicit perspective-bound runtime observation",
)
@click.argument("primitive_id")
@click.option(
    "--observation",
    type=click.Path(exists=True, dir_okay=False, readable=True),
    help="JSON observation; omitted observations return unknown",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
def primitive_availability(
    primitive_id: str, observation: str | None, as_json: bool
) -> None:
    catalog = _catalog()
    _primitive(catalog, primitive_id)
    observed = None
    if observation:
        try:
            with open(observation, encoding="utf-8") as handle:
                observed = json.load(handle)
        except (OSError, json.JSONDecodeError) as error:
            raise click.ClickException(f"cannot load observation: {error}") from error
    try:
        payload = availability_report(catalog, primitive_id, observed)
    except ValueError as error:
        raise click.ClickException(str(error)) from error
    _emit(payload) if as_json else click.echo(
        json.dumps(payload, indent=2, sort_keys=True)
    )


@kfc.group(
    name="atlas",
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="operate proof-backed state through the Atlas primitive",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
@surface(id="kungfu.atlas")
def atlas(ctx):
    del ctx


register_role_commands(atlas, "atlas")
