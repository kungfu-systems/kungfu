# SPDX-License-Identifier: Apache-2.0

import json
import sys

import click

from kungfu import agent as agent_pack
from kungfu.agent import documentation as documentation_pack


def run(
    *,
    as_json,
    atlas,
    verify_pack,
    show_catalog,
    show_bundle,
    read_path,
    projection,
    emit_json,
):
    requested = sum(
        bool(value)
        for value in (verify_pack, show_catalog, show_bundle, read_path, projection)
    )
    if requested > 1:
        raise click.UsageError(
            "choose only one of --verify, --catalog, --bundle, --read, or --projection"
        )
    try:
        if verify_pack:
            payload = documentation_pack.verify(atlas)
        elif show_catalog:
            payload = documentation_pack.catalog(atlas)
        elif show_bundle:
            payload = documentation_pack.bundle(atlas)
        elif read_path:
            payload = documentation_pack.read(read_path, atlas)
        elif projection:
            payload = documentation_pack.projection(projection, atlas)
        else:
            payload = None
    except (FileNotFoundError, KeyError, OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if payload is not None:
        if as_json:
            emit_json(payload)
        elif verify_pack:
            click.echo(
                f"Documentation Atlas: {'valid' if payload['valid'] else 'invalid'} "
                f"({payload.get('atlasRoot', 'unknown')})"
            )
        elif read_path:
            click.echo(payload["content"], nl=False)
        else:
            click.echo(json.dumps(payload, indent=2, sort_keys=True))
        if verify_pack and not payload["valid"]:
            raise click.ClickException("Documentation Atlas verification failed")
        return
    index = agent_pack.index()
    root = str(agent_pack.pack_root())
    payload = {
        "schema": "kungfu.agent-docs/v1",
        "packRoot": root,
        "documents": index["documents"],
        "skills": index["skills"],
        "contextCompiler": index["contextCompiler"],
    }
    if as_json:
        emit_json(payload)
        return
    click.echo(f"Agent pack: {root}")
    for row in index["documents"]:
        click.echo(f"- {row['path']} [{row['maturity']}]: {row['purpose']}")
    for row in index["skills"]:
        click.echo(f"- {row['path']} [{row['maturity']}]: {row['target']} skill")


def run_context(*, ctx, task, role, budget, route, as_json, default_context, emit_json):
    try:
        task_mode = any(value is not None for value in (task, role, budget, route))
        if task_mode and not all(
            value is not None for value in (task, role, budget, route)
        ):
            raise ValueError(
                "--task, --role, --budget, and --route are required together"
            )
        data = (
            documentation_pack.task_context(task, role, budget, route)
            if task_mode
            else default_context(ctx)
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        click.echo(f"[agent] failed to load context: {error}", err=True)
        sys.exit(1)
    if as_json:
        emit_json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


def run_expand(*, view, handle, budget, as_json, emit_json):
    try:
        payload = documentation_pack.expand(view, handle, budget)
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        emit_json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
