# SPDX-License-Identifier: Apache-2.0

"""Skill authoring discovery, scaffold, and qualification commands."""

import json

import click

from kungfu.cli.commands._skill.base import (
    PrioritizedCommandGroup,
    _extra_paths,
    _skill_json as _json,
    skill,
    skill_command_context,
)
from kungfu.skill import (
    SkillAuthoringError,
    apply_scaffold,
    authoring_contract,
    candidate_catalog,
    inspect_candidates,
    plan_scaffold,
    qualify_draft,
)


def _authoring_error(error, as_json):
    payload = {
        "ok": False,
        "code": error.code,
        "error": str(error),
        "recovery": error.recovery,
        "sideEffects": False,
    }
    if as_json:
        _json(payload)
    else:
        click.echo(
            f"[skill author] {error.code}: {error}; recovery: {error.recovery}",
            err=True,
        )


@skill.group(
    name="author",
    cls=PrioritizedCommandGroup,
    help="discover, deduplicate, draft, and qualify safe local Skills",
)
@click.help_option("-h", "--help")
@skill_command_context
def author(ctx):
    pass


@author.command(name="contract", help="print exact authoring constraints and examples")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def author_contract_cmd(ctx, as_json):
    del ctx
    payload = authoring_contract()
    _json(payload) if as_json else click.echo(
        json.dumps(payload, indent=2, sort_keys=True)
    )


@author.command(name="catalog", help="print the rooted catalog used for deduplication")
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def author_catalog_cmd(ctx, paths, as_json):
    payload = candidate_catalog(ctx.home, _extra_paths(paths))
    _json(payload) if as_json else click.echo(
        json.dumps(payload, indent=2, sort_keys=True)
    )


@author.command(name="inspect", help="compare one bounded spec with the rooted catalog")
@click.option(
    "--spec",
    "spec_file",
    type=click.File("r", encoding="utf-8"),
    required=True,
)
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def author_inspect_cmd(ctx, spec_file, paths, as_json):
    try:
        payload = inspect_candidates(
            ctx.home, json.load(spec_file), _extra_paths(paths)
        )
    except (json.JSONDecodeError, SkillAuthoringError) as error:
        if not isinstance(error, SkillAuthoringError):
            error = SkillAuthoringError(
                "authoring-spec-invalid",
                str(error),
                "provide valid bounded JSON matching the installed authoring schema",
            )
        _authoring_error(error, as_json)
        raise click.exceptions.Exit(1) from error
    _json(payload) if as_json else click.echo(
        json.dumps(payload, indent=2, sort_keys=True)
    )


@author.command(
    name="scaffold",
    help="preview or write one new workspace-local instruction-only draft",
)
@click.option(
    "--signals",
    "signals_file",
    type=click.File("r", encoding="utf-8"),
    required=True,
    help="bounded Skill advisory signals; transcripts and hidden prompts are rejected",
)
@click.option(
    "--spec",
    "spec_file",
    type=click.File("r", encoding="utf-8"),
    required=True,
)
@click.option(
    "--workspace",
    type=click.Path(exists=True, file_okay=False),
    required=True,
)
@click.option("--target", required=True, help="new relative path below workspace")
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--execute", is_flag=True, help="write the exact approved draft plan")
@click.option(
    "--expected-plan-root",
    default=None,
    help="exact planRoot required with --execute",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def author_scaffold_cmd(
    ctx,
    signals_file,
    spec_file,
    workspace,
    target,
    paths,
    execute,
    expected_plan_root,
    as_json,
):
    try:
        signals = json.load(signals_file)
        spec = json.load(spec_file)
        plan = plan_scaffold(
            ctx.home,
            workspace,
            target,
            spec,
            signals,
            _extra_paths(paths),
        )
        if not execute:
            payload = plan
        else:
            if not expected_plan_root:
                raise SkillAuthoringError(
                    "expected-plan-root-required",
                    "--execute requires --expected-plan-root",
                    "rerun the read-only scaffold plan and approve its exact planRoot",
                )
            payload = apply_scaffold(
                plan, expected_plan_root=expected_plan_root, spec=spec
            )
    except (json.JSONDecodeError, SkillAuthoringError) as error:
        if not isinstance(error, SkillAuthoringError):
            error = SkillAuthoringError(
                "authoring-input-invalid",
                str(error),
                "provide valid bounded JSON inputs",
            )
        _authoring_error(error, as_json)
        raise click.exceptions.Exit(1) from error
    _json(payload) if as_json else click.echo(
        json.dumps(payload, indent=2, sort_keys=True)
    )


@author.command(name="qualify", help="qualify one exact workspace-local draft")
@click.argument("path", type=click.Path(exists=True, file_okay=False))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def author_qualify_cmd(ctx, path, as_json):
    del ctx
    try:
        payload = qualify_draft(path)
    except SkillAuthoringError as error:
        _authoring_error(error, as_json)
        raise click.exceptions.Exit(1) from error
    _json(payload) if as_json else click.echo(
        json.dumps(payload, indent=2, sort_keys=True)
    )
