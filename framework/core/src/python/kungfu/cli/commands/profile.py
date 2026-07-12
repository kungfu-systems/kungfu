# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path

import click

from kungfu import profile_sdk
from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.storage import service as storage_service


profile_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="author, resolve and operate KFX Profile Suites",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def profile(ctx):
    pass


def _json(value):
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _run(fn):
    try:
        return fn()
    except profile_sdk.ProfileSdkError as error:
        _json(error.diagnosis)
        raise click.exceptions.Exit(2) from error
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        _json(
            {
                "schema": profile_sdk.DIAGNOSIS_SCHEMA,
                "ok": False,
                "code": "profile-operation-failed",
                "message": str(error),
            }
        )
        raise click.exceptions.Exit(2) from error


def _load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


@profile.command(help="show the installed Agent Profile SDK contract")
@click.option("--json", "as_json", is_flag=True)
@profile_context
def capabilities(ctx, as_json):
    _json(_run(profile_sdk.capabilities))


@profile.command(help="show an installed Profile brief and command flow")
@click.option("--json", "as_json", is_flag=True)
@profile_context
def examples(ctx, as_json):
    _json(profile_sdk.examples())


@profile.command(help="plan or write a deterministic Profile Suite source tree")
@click.argument("brief", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--out", required=True, type=click.Path(path_type=Path))
@click.option("--execute", is_flag=True, help="write the exact planned source files")
@click.option("--json", "as_json", is_flag=True)
@profile_context
def scaffold(ctx, brief, out, execute, as_json):
    def operation():
        plan = profile_sdk.scaffold_plan(_load_json(brief), out)
        if execute and plan.get("ok"):
            return profile_sdk.apply_scaffold(plan)
        return plan

    _json(_run(operation))


@profile.command(help="resolve members and validate an exact Profile closure")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def validate(ctx, source, as_json):
    _json(_run(lambda: profile_sdk.validate_source(source, ctx.runtime_dir)))


@profile.command(help="run the installed source qualification checks")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def qualify(ctx, source, as_json):
    _json(_run(lambda: profile_sdk.qualify_source(source, ctx.runtime_dir)))


@profile.command(help="plan a Core-owned Profile lifecycle change")
@click.argument(
    "action",
    type=click.Choice(
        ["install", "qualify", "activate", "upgrade", "rollback", "remove"]
    ),
)
@click.argument(
    "source",
    required=False,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
@click.option("--profile-id")
@click.option("--target-root")
@click.option("--expected-current-root")
@click.option("--grant", "grants", multiple=True)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def plan(
    ctx,
    action,
    source,
    profile_id,
    target_root,
    expected_current_root,
    grants,
    out,
    as_json,
):
    values = {}
    if profile_id:
        values["profile_id"] = profile_id
    if target_root:
        values["target_root"] = target_root
    if expected_current_root:
        values["expected_current_root"] = expected_current_root
    if grants:
        values["granted_permissions"] = list(grants)
    payload = _run(
        lambda: profile_sdk.lifecycle_plan(ctx.runtime_dir, action, source, **values)
    )
    if out:
        out.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        payload["agentPlanPath"] = str(out.resolve())
    _json(payload)


@profile.command(help="answer one exact Profile decision card")
@click.argument(
    "agent_plan", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--choice", required=True)
@click.option("--authorized-by", required=True)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def decide(ctx, agent_plan, choice, authorized_by, out, as_json):
    payload = _run(
        lambda: profile_sdk.answer_decision(
            _load_json(agent_plan)["decisionCard"], choice, authorized_by
        )
    )
    if out:
        out.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        payload["answerPath"] = str(out.resolve())
    _json(payload)


@profile.command(help="apply an approved, still-current Agent/Core plan")
@click.argument(
    "plan_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--authorization-file",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def apply(ctx, plan_file, authorization_file, as_json):
    _json(
        _run(
            lambda: profile_sdk.authorized_lifecycle_apply(
                ctx.runtime_dir,
                _load_json(plan_file),
                _load_json(authorization_file),
            )
        )
    )


@profile.command(name="list", help="list Core-owned current Profile state")
@click.option("--include-removed", is_flag=True)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def list_profiles(ctx, include_removed, as_json):
    _json(
        storage_service.profile_lifecycle(
            ctx.runtime_dir, "list", include_removed=include_removed
        )
    )


@profile.command(help="inspect a source closure or current Profile state")
@click.argument("target")
@click.option("--include-removed", is_flag=True)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def inspect(ctx, target, include_removed, as_json):
    path = Path(target)
    if path.is_dir():
        payload = _run(lambda: profile_sdk.validate_source(path, ctx.runtime_dir))
    else:
        payload = _run(
            lambda: storage_service.profile_lifecycle(
                ctx.runtime_dir,
                "get",
                profile_id=target,
                include_removed=include_removed,
            )
        )
    _json(payload)


@profile.command(help="show append-only lifecycle facts for a Profile")
@click.argument("profile_id")
@click.option("--json", "as_json", is_flag=True)
@profile_context
def history(ctx, profile_id, as_json):
    _json(
        _run(
            lambda: storage_service.profile_lifecycle(
                ctx.runtime_dir, "history", profile_id=profile_id
            )
        )
    )


@profile.command(help="classify semantic changes between two Profile sources")
@click.argument("left", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument("right", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def diff(ctx, left, right, as_json):
    _json(_run(lambda: profile_sdk.semantic_diff(left, right)))


@profile.command(help="list declarative actions bound to a source root")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def actions(ctx, source, as_json):
    _json(_run(lambda: profile_sdk.action_catalog(source, ctx.runtime_dir)))


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
