# SPDX-License-Identifier: Apache-2.0

"""Declarative Profile action CLI registration."""

from __future__ import annotations

import base64
import importlib
import json
from pathlib import Path

import click

from kungfu import profile_sdk

_facade = importlib.import_module("kungfu.cli.commands.profile")
profile = _facade.profile
profile_context = _facade.profile_context
_json = _facade._json
_load_json = _facade._load_json
_run = _facade._run


def _decode_json(value):
    try:
        return json.loads(base64.b64decode(value, validate=True).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise click.UsageError("invalid base64 JSON input") from error


@profile.command(help="plan or invoke a declarative Profile action")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument("action_id")
@click.option(
    "--input",
    "input_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option(
    "--plan-file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--authorization-file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@click.option("--execute", is_flag=True)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def invoke(
    ctx,
    source,
    action_id,
    input_path,
    plan_file,
    authorization_file,
    out,
    execute,
    as_json,
):
    input_value = _load_json(input_path) if input_path else {}
    if execute:
        if plan_file is None:
            raise click.UsageError("--execute requires --plan-file")
        payload = _run(
            lambda: profile_sdk.authorized_action_invoke(
                ctx.runtime_dir,
                _load_json(plan_file),
                _load_json(authorization_file) if authorization_file else None,
            )
        )
    else:
        payload = _run(
            lambda: profile_sdk.plan_action(
                source, ctx.runtime_dir, action_id, input_value
            )
        )
        if out:
            out.write_text(
                json.dumps(payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            payload["actionPlanPath"] = str(out.resolve())
    _json(payload)


invoke.callback.__module__ = "kungfu.cli.commands.profile"
invoke.callback.__qualname__ = "invoke"
