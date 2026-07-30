# SPDX-License-Identifier: Apache-2.0

import base64
import json
from pathlib import Path

import click

from kungfu import profile_composition, profile_sdk
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


def _decode_json(value):
    try:
        return json.loads(base64.b64decode(value, validate=True).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise click.UsageError("invalid base64 JSON input") from error


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


@profile.command(help="discover one installed Profile Suite by semantic id")
@click.argument("profile_id")
@click.option("--json", "as_json", is_flag=True)
@profile_context
def discover(ctx, profile_id, as_json):
    _json(_run(lambda: profile_sdk.discover_source(profile_id, ctx.runtime_dir)))


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


@profile.command(help="inspect the content-bound Profile collaboration closure")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def collaboration(ctx, source, as_json):
    _json(_run(lambda: profile_sdk.collaboration(source, ctx.runtime_dir)))


@profile.command(help="project a declared Profile for the generic Human/Agent renderer")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def application(ctx, source, as_json):
    _json(_run(lambda: profile_sdk.application(source, ctx.runtime_dir)))


@profile.command(
    name="kfd3-qualify",
    help="audit no-bypass and dual-client closure, then emit a Kungfu-owned witness",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def kfd3_qualify(ctx, source, as_json):
    _json(_run(lambda: profile_sdk.qualify_kfd3(source, ctx.runtime_dir)))


@profile.command(
    name="kfd3-status",
    help="inspect the current exact-root KFD-3 qualification without running probes",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def kfd3_status(ctx, source, as_json):
    _json(_run(lambda: profile_sdk.kfd3_status(source, ctx.runtime_dir)))


@profile.command(
    name="kfd3-plan",
    help="preview the exact KFD-3 probes without executing them",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def kfd3_plan(ctx, source, as_json):
    _json(_run(lambda: profile_sdk.kfd3_qualification_plan(source, ctx.runtime_dir)))


@profile.command(
    name="kfd3-authorize",
    help="authorize and execute one still-current KFD-3 qualification plan",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--expected-plan-id", required=True)
@click.option("--choice", required=True, type=click.Choice(["approve", "deny"]))
@click.option("--authorized-by", required=True)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def kfd3_authorize(ctx, source, expected_plan_id, choice, authorized_by, as_json):
    _json(
        _run(
            lambda: profile_sdk.authorize_kfd3_qualification(
                source,
                ctx.runtime_dir,
                expected_plan_id,
                choice,
                authorized_by,
            )
        )
    )


@profile.command(
    name="kfd3-release-build",
    help="run factory qualification and write an exact-root system Profile manifest",
)
@click.argument(
    "sources",
    nargs=-1,
    required=True,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
@click.option("--out", required=True, type=click.Path(dir_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def kfd3_release_build(ctx, sources, out, as_json):
    def operation():
        manifest = profile_sdk.build_kfd3_release_manifest(
            list(sources), ctx.runtime_dir
        )
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        return {
            "schema": "kungfu.system-profile-kfd3-build-receipt/v1",
            "out": str(out.resolve()),
            "manifestRoot": manifest["manifestRoot"],
            "profiles": [row["profileId"] for row in manifest["entries"]],
            "verified": True,
        }

    _json(_run(operation))


@profile.command(
    name="kfd3-verify",
    help="verify a KFD-3 qualification receipt against the current earned cut",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument(
    "receipt_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def kfd3_verify(ctx, source, receipt_file, as_json):
    _json(
        _run(
            lambda: profile_sdk.verify_kfd3(
                source, ctx.runtime_dir, _load_json(receipt_file)
            )
        )
    )


@profile.group(help="run the shared Profile intent application protocol")
@click.help_option("-h", "--help")
@profile_context
def intent(ctx):
    pass


@intent.command(name="inspect", help="inspect one intent at an exact Profile cut")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument("intent_id")
@click.option("--json", "as_json", is_flag=True)
@profile_context
def intent_inspect(ctx, source, intent_id, as_json):
    _json(_run(lambda: profile_sdk.intent_inspect(source, ctx.runtime_dir, intent_id)))


@intent.command(
    name="advise", help="project constraints and preconditions for one intent"
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument("intent_id")
@click.option("--json", "as_json", is_flag=True)
@profile_context
def intent_advise(ctx, source, intent_id, as_json):
    _json(_run(lambda: profile_sdk.intent_advise(source, ctx.runtime_dir, intent_id)))


@intent.command(name="plan", help="preview one still-unexecuted intent")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument("intent_id")
@click.option(
    "--input",
    "input_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--input-base64", help="UTF-8 JSON encoded as base64")
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def intent_plan(ctx, source, intent_id, input_path, input_base64, out, as_json):
    if input_path and input_base64:
        raise click.UsageError("use only one of --input or --input-base64")
    payload = _run(
        lambda: profile_sdk.intent_plan(
            source,
            ctx.runtime_dir,
            intent_id,
            (
                _load_json(input_path)
                if input_path
                else _decode_json(input_base64)
                if input_base64
                else {}
            ),
        )
    )
    if out:
        out.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        payload["intentPlanPath"] = str(out.resolve())
    _json(payload)


@intent.command(
    name="authorize",
    help="re-plan, authorize, execute, receipt and verify one exact intent",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument("intent_id")
@click.option(
    "--input",
    "input_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--input-base64", help="UTF-8 JSON encoded as base64")
@click.option("--expected-plan-id", required=True)
@click.option("--choice", required=True, type=click.Choice(["approve", "deny"]))
@click.option("--authorized-by", required=True)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def intent_authorize(
    ctx,
    source,
    intent_id,
    input_path,
    input_base64,
    expected_plan_id,
    choice,
    authorized_by,
    as_json,
):
    if input_path and input_base64:
        raise click.UsageError("use only one of --input or --input-base64")
    _json(
        _run(
            lambda: profile_sdk.authorize_current_intent(
                ctx.runtime_dir,
                source,
                intent_id,
                (
                    _load_json(input_path)
                    if input_path
                    else _decode_json(input_base64)
                    if input_base64
                    else {}
                ),
                expected_plan_id,
                choice,
                authorized_by,
            )
        )
    )


@intent.command(name="apply", help="execute an authorized, still-current intent plan")
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
def intent_apply(ctx, plan_file, authorization_file, as_json):
    _json(
        _run(
            lambda: profile_sdk.intent_apply(
                ctx.runtime_dir,
                _load_json(plan_file),
                _load_json(authorization_file),
            )
        )
    )


@intent.command(
    name="verify", help="verify an intent receipt against the current declared closure"
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument(
    "receipt_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def intent_verify(ctx, source, receipt_file, as_json):
    _json(
        _run(
            lambda: profile_sdk.intent_verify(
                source, ctx.runtime_dir, _load_json(receipt_file)
            )
        )
    )


@profile.command(help="run the installed source qualification checks")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def qualify(ctx, source, as_json):
    _json(_run(lambda: profile_sdk.qualify_source(source, ctx.runtime_dir)))


@profile.command(
    name="export", help="export an exact full or thin Profile source bundle"
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--out", required=True, type=click.Path(dir_okay=False, path_type=Path))
@click.option(
    "--thin", is_flag=True, help="export roots and inventory without source bytes"
)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def export_bundle(ctx, source, out, thin, as_json):
    def operation():
        if not out.parent.is_dir():
            raise FileNotFoundError(
                f"Profile bundle parent does not exist: {out.parent}"
            )
        bundle = profile_sdk.export_source_bundle(source, ctx.runtime_dir, thin=thin)
        out.write_text(
            json.dumps(bundle, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        return {
            "schema": "kungfu.profile-source-export-receipt/v1",
            "mode": bundle["mode"],
            "profileId": bundle["profileId"],
            "profileSuiteRoot": bundle["profileSuiteRoot"],
            "bundleRoot": bundle["bundleRoot"],
            "entryCount": len(bundle["entries"]),
            "out": str(out.resolve()),
        }

    _json(_run(operation))


@profile.command(
    name="import", help="plan or authorize reconstruction of a Profile source bundle"
)
@click.argument("bundle", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--out", required=True, type=click.Path(path_type=Path))
@click.option("--execute", is_flag=True)
@click.option("--authorized-by")
@click.option("--json", "as_json", is_flag=True)
@profile_context
def import_bundle(ctx, bundle, out, execute, authorized_by, as_json):
    def operation():
        plan = profile_sdk.source_import_plan(_load_json(bundle), out)
        if not execute:
            return plan
        if not authorized_by:
            raise profile_sdk.ProfileSdkError(
                "decision-actor-required",
                "--authorized-by is required to execute a Profile source import",
            )
        if not plan["requiresAuthorization"]:
            raise profile_sdk.ProfileSdkError(
                "source-import-not-ready",
                "Profile source import needs a full bundle and an empty destination",
                decisionCards=[plan["decisionCard"]],
            )
        answer = profile_sdk.answer_decision(
            plan["decisionCard"], "approve", authorized_by
        )
        return profile_sdk.authorized_source_import(plan, answer)

    _json(_run(operation))


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


@profile.command(
    name="authorize-lifecycle",
    help="re-plan and apply one exact approved Profile lifecycle change",
)
@click.argument(
    "action", type=click.Choice(["install", "qualify", "activate", "upgrade"])
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--expected-plan-id", required=True)
@click.option("--choice", required=True, type=click.Choice(["approve", "deny"]))
@click.option("--authorized-by", required=True)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def authorize_lifecycle(
    ctx, action, source, expected_plan_id, choice, authorized_by, as_json
):
    _json(
        _run(
            lambda: profile_sdk.authorize_current_lifecycle(
                ctx.runtime_dir,
                action,
                source,
                expected_plan_id,
                choice,
                authorized_by,
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


@profile.command(help="project lifecycle, source health and composition catalogs")
@click.option("--json", "as_json", is_flag=True)
@profile_context
def manager(ctx, as_json):
    _json(_run(lambda: profile_composition.manager(ctx.runtime_dir)))


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


@profile.command(help="compose exact-root fact, claim, policy and view bindings")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--require-active", is_flag=True)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def catalog(ctx, source, require_active, as_json):
    _json(
        _run(
            lambda: profile_composition.catalog(
                source, ctx.runtime_dir, require_active=require_active
            )
        )
    )


@profile.command(
    name="member-call",
    help="invoke one exact-root Profile member adapter operation",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument("member_id")
@click.argument("operation")
@click.option("--input-base64", help="UTF-8 JSON encoded as base64")
@click.option("--json", "as_json", is_flag=True)
@profile_context
def member_call(ctx, source, member_id, operation, input_base64, as_json):
    _json(
        _run(
            lambda: profile_sdk.invoke_member_adapter(
                source,
                ctx.runtime_dir,
                member_id,
                operation,
                _decode_json(input_base64) if input_base64 else {},
            )
        )
    )


@profile.command(
    name="query-plan",
    help="plan a contributed view through KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument("view_id")
@click.option(
    "--resolution-file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="member-resolved bindings and QueryDefinition for a query family",
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def query_plan(ctx, source, view_id, resolution_file, out, as_json):
    payload = _run(
        lambda: (
            profile_composition.resolved_query_plan(
                source,
                ctx.runtime_dir,
                view_id,
                _load_json(resolution_file),
            )
            if resolution_file
            else profile_composition.query_plan(source, ctx.runtime_dir, view_id)
        )
    )
    if out:
        out.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        payload["queryPlanPath"] = str(out.resolve())
    _json(payload)


@profile.command(name="query-run", help="execute a still-current Profile query plan")
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument(
    "plan_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def query_run(ctx, source, plan_file, as_json):
    _json(
        _run(
            lambda: profile_composition.execute_query(
                source, ctx.runtime_dir, _load_json(plan_file)
            )
        )
    )


@profile.command(
    name="query-execute",
    help="execute a still-current Profile query plan supplied as base64 JSON",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--plan-base64", required=True)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def query_execute(ctx, source, plan_base64, as_json):
    _json(
        _run(
            lambda: profile_composition.execute_query(
                source, ctx.runtime_dir, _decode_json(plan_base64)
            )
        )
    )


@profile.command(
    name="contract-plan",
    help="plan active Profile declarations into the workspace Fact Library",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def contract_plan(ctx, source, out, as_json):
    payload = _run(
        lambda: profile_composition.contract_materialization_plan(
            source, ctx.runtime_dir
        )
    )
    if out:
        out.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        payload["contractPlanPath"] = str(out.resolve())
    _json(payload)


@profile.command(
    name="contract-apply",
    help="apply an approved, still-current Profile contract plan",
)
@click.argument(
    "plan_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--authorization-file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def contract_apply(ctx, plan_file, authorization_file, as_json):
    _json(
        _run(
            lambda: profile_composition.authorized_contract_materialize(
                ctx.runtime_dir,
                _load_json(plan_file),
                _load_json(authorization_file) if authorization_file else None,
            )
        )
    )


@profile.command(
    name="assess-plan",
    help="plan a purpose-bound KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302 assessment",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument(
    "query_receipt", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--claim-id", required=True)
@click.option(
    "--claim-instance-id",
    help="runtime claim identity; defaults to the declared claim id",
)
@click.option("--policy-id", required=True)
@click.option("--purpose", required=True)
@click.option("--work-episode-id", required=True, type=int)
@click.option(
    "--independent-observation-file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="independent observation bound to the verified work Episode root",
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@click.option("--json", "as_json", is_flag=True)
@profile_context
def assess_plan(
    ctx,
    source,
    query_receipt,
    claim_id,
    claim_instance_id,
    policy_id,
    purpose,
    work_episode_id,
    independent_observation_file,
    out,
    as_json,
):
    payload = _run(
        lambda: profile_composition.assessment_plan(
            source,
            ctx.runtime_dir,
            _load_json(query_receipt),
            claim_id=claim_id,
            claim_instance_id=claim_instance_id,
            policy_id=policy_id,
            purpose=purpose,
            work_episode_id=work_episode_id,
            independent_observation=(
                _load_json(independent_observation_file)
                if independent_observation_file
                else None
            ),
        )
    )
    if out:
        out.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        payload["assessmentPlanPath"] = str(out.resolve())
    _json(payload)


@profile.command(name="assess-run", help="execute an approved, current assessment plan")
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
def assess_run(ctx, plan_file, authorization_file, as_json):
    _json(
        _run(
            lambda: profile_composition.authorized_assessment_execute(
                ctx.runtime_dir,
                _load_json(plan_file),
                _load_json(authorization_file),
            )
        )
    )


@profile.command(
    name="assessment-plan",
    help="plan a purpose-bound assessment from a base64 JSON query receipt",
)
@click.argument("source", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--query-receipt-base64", required=True)
@click.option("--claim-id", required=True)
@click.option("--claim-instance-id")
@click.option("--policy-id", required=True)
@click.option("--purpose", required=True)
@click.option("--work-episode-id", required=True, type=int)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def assessment_plan(
    ctx,
    source,
    query_receipt_base64,
    claim_id,
    claim_instance_id,
    policy_id,
    purpose,
    work_episode_id,
    as_json,
):
    _json(
        _run(
            lambda: profile_composition.assessment_plan(
                source,
                ctx.runtime_dir,
                _decode_json(query_receipt_base64),
                claim_id=claim_id,
                claim_instance_id=claim_instance_id,
                policy_id=policy_id,
                purpose=purpose,
                work_episode_id=work_episode_id,
                independent_observation=None,
            )
        )
    )


@profile.command(
    name="assessment-authorize",
    help="authorize and execute one exact base64 JSON assessment plan",
)
@click.option("--plan-base64", required=True)
@click.option("--choice", required=True, type=click.Choice(["approve", "deny"]))
@click.option("--authorized-by", required=True)
@click.option("--json", "as_json", is_flag=True)
@profile_context
def assessment_authorize(ctx, plan_base64, choice, authorized_by, as_json):
    def operation():
        plan = _decode_json(plan_base64)
        answer = profile_sdk.answer_decision(
            plan.get("decisionCard") or {}, choice, authorized_by
        )
        return profile_composition.authorized_assessment_execute(
            ctx.runtime_dir, plan, answer
        )

    _json(_run(operation))


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
