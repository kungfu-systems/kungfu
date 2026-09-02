# SPDX-License-Identifier: Apache-2.0

"""Skill registry lifecycle, selection, and dependency admission commands."""

import json
import sys
from pathlib import Path

import click

from kungfu.cli.commands._skill.base import (
    _default_skill_audit_log,
    _skill_json as _json,
    _json_file,
    skill,
    skill_command_context,
)
from kungfu.skill import (
    SkillAuthorityError,
    SkillError,
    SkillRegistryError,
    append_audit_event,
    apply_plan,
    dependency_audit_event,
    diagnose_registry,
    diff_revisions,
    inspect_registry,
    invoke_dependency_plan,
    normalize_package,
    parse_skill,
    plan_dependency_invocation,
    plan_operation,
    registry_history,
    skill_contract,
)


def _keyed_paths(values, label):
    result = {}
    for value in values:
        key, separator, path = value.partition("=")
        if not separator or not key or not path:
            raise SkillAuthorityError(
                "KF_SKILL_CLI_BINDING_INVALID",
                f"{label} must use KEY=PATH",
                f"pass each {label} as an exact KEY=PATH binding",
            )
        result[key] = path
    return result


@skill.command("contract", help="print the Skill contract metadata")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def contract_cmd(ctx, as_json):
    try:
        data = skill_contract.load_contract()
        metadata = skill_contract.contract_metadata()
        data["path"] = metadata["path"]
        data["hash"] = metadata["hash"]
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as e:
        click.echo(f"[skill] failed to load contract: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@skill.command("schema", help="print Skill JSON schemas")
@click.option(
    "--name",
    type=click.Choice(
        [
            "source",
            "catalog",
            "context",
            "dependencies",
            "manager",
            "definitionV2",
            "authoringSpecV1",
            "authoringPlanV1",
            "authoringReceiptV1",
        ]
    ),
    default=None,
    help="schema name; omit to print the whole schema bundle",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def schema_cmd(ctx, name, as_json):
    try:
        data = (
            skill_contract.load_schema(name) if name else skill_contract.schema_bundle()
        )
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as e:
        click.echo(f"[skill] failed to load schema: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@skill.command(help="validate a Kungfu Skill source directory")
@click.argument("path", type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def validate(ctx, path, as_json):
    try:
        if any(
            (Path(path) / name).is_file()
            for name in ("skill-definition.json", "kungfu.skill.json")
        ):
            package = normalize_package(path)
            result = {"ok": True, "package": package}
            label = (
                f"{package['definition']['identity']['key']}@"
                f"{package['definition']['identity']['revision']} "
                f"root={package['contentRoot']}"
            )
        else:
            parsed = parse_skill(path)
            result = {"ok": True, "skill": parsed}
            label = (
                f"{parsed['key']} ({parsed['kind']}) from {parsed['source']['path']}"
            )
    except (SkillError, SkillRegistryError) as e:
        if as_json:
            _json({"ok": False, "code": getattr(e, "code", "invalid"), "error": str(e)})
        else:
            click.echo(f"[skill] invalid: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(result)
    else:
        click.echo(f"[skill] ok {label}")


def _mutation_result(ctx, plan, execute, expected_plan_root, as_json):
    if not execute:
        if as_json:
            _json(plan)
        else:
            click.echo(
                f"[skill] plan {plan['operation']} {plan['request']['key']} "
                f"root={plan['planRoot']} changed={str(plan['changed']).lower()}"
            )
            click.echo(
                f"[skill] apply with --execute --expected-plan-root {plan['planRoot']}"
            )
        return
    if not expected_plan_root:
        raise SkillRegistryError(
            "expected-plan-root-required",
            "--execute requires --expected-plan-root from the exact plan",
        )
    receipt = apply_plan(ctx.home, plan, expected_plan_root=expected_plan_root)
    if as_json:
        _json(receipt)
    else:
        result = receipt["result"]
        click.echo(
            f"[skill] applied {receipt['operation']} "
            f"state={result['stateRoot']} generation={result['generation']} "
            f"receipt={receipt['receiptRoot']}"
        )


def _run_mutation(
    ctx,
    operation,
    *,
    key=None,
    source=None,
    work_ref=None,
    work_root=None,
    target_revision=None,
    execute=False,
    expected_plan_root=None,
    as_json=False,
):
    try:
        plan = plan_operation(
            ctx.home,
            operation,
            key=key,
            source=source,
            work_ref=work_ref,
            work_root=work_root,
            target_revision=target_revision,
        )
        _mutation_result(ctx, plan, execute, expected_plan_root, as_json)
    except SkillRegistryError as error:
        if as_json:
            _json({"ok": False, "code": error.code, "error": str(error)})
        else:
            click.echo(f"[skill] {error.code}: {error}", err=True)
        raise click.exceptions.Exit(1) from error


def _mutation_options(function):
    function = click.option(
        "--expected-plan-root",
        default=None,
        help="exact planRoot required for apply",
    )(function)
    function = click.option("--execute", is_flag=True, help="apply the exact plan")(
        function
    )
    function = click.option(
        "--json", "as_json", is_flag=True, help="machine-readable output"
    )(function)
    return function


@skill.command(help="plan or apply a Skill v2 package install")
@click.argument("source", type=click.Path(exists=True))
@click.option(
    "--force", is_flag=True, help="compatibility alias for an exact update plan"
)
@_mutation_options
@skill_command_context
def install(ctx, source, force, execute, expected_plan_root, as_json):
    _run_mutation(
        ctx,
        "update" if force else "install",
        source=source,
        execute=execute,
        expected_plan_root=expected_plan_root,
        as_json=as_json,
    )


@skill.command(help="plan or apply a compatible Skill v2 revision update")
@click.argument("source", type=click.Path(exists=True))
@_mutation_options
@skill_command_context
def update(ctx, source, execute, expected_plan_root, as_json):
    _run_mutation(
        ctx,
        "update",
        source=source,
        execute=execute,
        expected_plan_root=expected_plan_root,
        as_json=as_json,
    )


def _simple_mutation_command(name, help_text):
    def command(ctx, key, execute, expected_plan_root, as_json):
        _run_mutation(
            ctx,
            name,
            key=key,
            execute=execute,
            expected_plan_root=expected_plan_root,
            as_json=as_json,
        )

    command.__name__ = f"{name}_cmd"
    decorated = skill_command_context(command)
    decorated = _mutation_options(decorated)
    decorated = click.argument("key", type=str)(decorated)
    return skill.command(name=name, help=help_text)(decorated)


enable_cmd = _simple_mutation_command("enable", "plan or apply Skill enablement")
load_cmd = _simple_mutation_command("load", "plan or apply an exact Skill load state")
invoke_cmd = _simple_mutation_command(
    "invoke", "plan or apply an exact Skill invocation state"
)
suspend_cmd = _simple_mutation_command("suspend", "plan or apply Skill suspension")
retire_cmd = _simple_mutation_command("retire", "plan or apply Skill retirement")
remove_cmd = _simple_mutation_command(
    "remove", "plan or apply removal of active refs while retaining history"
)


@skill.command(help="plan or apply an exact Work-scoped Skill selection")
@click.argument("key", type=str)
@click.option("--work-ref", required=True, help="exact Kungfu Work reference")
@click.option("--work-root", required=True, help="exact Kungfu Work root")
@_mutation_options
@skill_command_context
def select(ctx, key, work_ref, work_root, execute, expected_plan_root, as_json):
    _run_mutation(
        ctx,
        "select",
        key=key,
        work_ref=work_ref,
        work_root=work_root,
        execute=execute,
        expected_plan_root=expected_plan_root,
        as_json=as_json,
    )


@skill.command(help="plan or apply an active-ref rollback to a retained revision")
@click.argument("key", type=str)
@click.option("--target-revision", required=True, type=int)
@_mutation_options
@skill_command_context
def rollback(ctx, key, target_revision, execute, expected_plan_root, as_json):
    _run_mutation(
        ctx,
        "rollback",
        key=key,
        target_revision=target_revision,
        execute=execute,
        expected_plan_root=expected_plan_root,
        as_json=as_json,
    )


@skill.command(
    name="admit",
    help="plan or invoke exact Skill dependencies through KFX/Profile authority",
)
@click.argument("key", type=str)
@click.option("--work-ref", required=True)
@click.option("--work-root", required=True)
@click.option("--cut-root", required=True)
@click.option("--policy-root", required=True)
@click.option("--host", required=True)
@click.option("--run-id", default=None)
@click.option("--kfx-request", type=click.Path(exists=True), default=None)
@click.option("--profile-source", multiple=True, help="exact PROFILE_ID=PATH binding")
@click.option("--profile-input", multiple=True, help="PROFILE_ID:ACTION=JSON_FILE")
@click.option("--profile-answer", multiple=True, help="PROFILE_ID:ACTION=JSON_FILE")
@_mutation_options
@skill_command_context
def admit(
    ctx,
    key,
    work_ref,
    work_root,
    cut_root,
    policy_root,
    host,
    run_id,
    kfx_request,
    profile_source,
    profile_input,
    profile_answer,
    execute,
    expected_plan_root,
    as_json,
):
    try:
        inputs = {
            name: _json_file(path)
            for name, path in _keyed_paths(profile_input, "--profile-input").items()
        }
        answers = {
            name: _json_file(path)
            for name, path in _keyed_paths(profile_answer, "--profile-answer").items()
        }
        plan = plan_dependency_invocation(
            ctx.home,
            ctx.runtime_dir,
            key,
            work_ref=work_ref,
            work_root=work_root,
            cut_root=cut_root,
            policy_root=policy_root,
            host=host,
            kfx_request=_json_file(kfx_request),
            profile_sources=_keyed_paths(profile_source, "--profile-source"),
            profile_inputs=inputs,
            run_id=run_id,
        )
        if not execute:
            _json(plan) if as_json else click.echo(
                f"[skill] dependency plan {key} status={plan['decision']['status']} "
                f"root={plan['planRoot']}"
            )
            return
        if not expected_plan_root:
            raise SkillAuthorityError(
                "KF_SKILL_EXPECTED_PLAN_ROOT_REQUIRED",
                "--execute requires --expected-plan-root",
                "use the exact root from the read-only admit plan",
            )
        try:
            receipt = invoke_dependency_plan(
                ctx.home,
                ctx.runtime_dir,
                plan,
                expected_plan_root=expected_plan_root,
                profile_answers=answers,
            )
        except SkillAuthorityError:
            append_audit_event(
                _default_skill_audit_log(ctx),
                dependency_audit_event(
                    plan, event_type="SkillTrustRefused", run_id=run_id
                ),
            )
            raise
        append_audit_event(
            _default_skill_audit_log(ctx),
            dependency_audit_event(
                receipt, event_type="SkillDependencyInvoked", run_id=run_id
            ),
        )
    except (OSError, ValueError, SkillAuthorityError) as error:
        code = getattr(error, "code", "KF_SKILL_ADMISSION_INVALID")
        recovery = getattr(error, "recovery", "inspect the exact authority inputs")
        if as_json:
            _json(
                {"ok": False, "code": code, "error": str(error), "recovery": recovery}
            )
        else:
            click.echo(f"[skill] {code}: {error}; recovery: {recovery}", err=True)
        raise click.exceptions.Exit(1) from error
    if as_json:
        _json(receipt)
    else:
        click.echo(
            f"[skill] invoked {key} receipt={receipt['receiptRoot']} completion=false"
        )


@skill.command(help="inspect the canonical Skill registry fold")
@click.argument("key", required=False)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def inspect(ctx, key, as_json):
    try:
        result = inspect_registry(ctx.home, key)
    except SkillRegistryError as error:
        click.echo(f"[skill] {error.code}: {error}", err=True)
        raise click.exceptions.Exit(1) from error
    if as_json:
        _json(result)
    else:
        click.echo(
            f"Skill registry generation={result['generation']} "
            f"root={result['stateRoot']}"
        )
        for entry in result["entries"].values():
            click.echo(
                f"{entry['key']}  {entry['status']}  "
                f"revision={entry.get('activeRevision') or '-'}"
            )


@skill.command(help="inspect retained Skill lifecycle events and receipts")
@click.argument("key", required=False)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def history(ctx, key, as_json):
    result = registry_history(ctx.home, key)
    if as_json:
        _json(result)
    else:
        click.echo(json.dumps(result, indent=2, sort_keys=True))


@skill.command(help="verify registry roots, immutable packages, and recovery state")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def diagnose(ctx, as_json):
    result = diagnose_registry(ctx.home)
    if as_json:
        _json(result)
    else:
        click.echo(json.dumps(result, indent=2, sort_keys=True))
    if result["verdict"] != "pass":
        raise click.exceptions.Exit(1)


@skill.command(name="diff", help="diff two retained Skill definition revisions")
@click.argument("key")
@click.option("--left", required=True, type=int)
@click.option("--right", required=True, type=int)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def diff_cmd(ctx, key, left, right, as_json):
    try:
        result = diff_revisions(ctx.home, key, left, right)
    except SkillRegistryError as error:
        click.echo(f"[skill] {error.code}: {error}", err=True)
        raise click.exceptions.Exit(1) from error
    if as_json:
        _json(result)
    else:
        click.echo(json.dumps(result, indent=2, sort_keys=True))
