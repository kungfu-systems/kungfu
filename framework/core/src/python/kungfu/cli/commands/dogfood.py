# SPDX-License-Identifier: Apache-2.0

"""`kungfu dogfood` — native Finding, Issue, and consideration workflow."""

from __future__ import annotations

from functools import wraps
import json
import os
from pathlib import Path

import click

from kungfu import dogfood as dogfood_api
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.surface_contract import surface
from kungfu.workspace import prepare_workspace_write, resolve_workspace_target


dogfood_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="capture, own, query, and settle native dogfood evidence",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def dogfood(ctx):
    del ctx


def _emit(value):
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _failure(error):
    cause = getattr(error, "diagnosis", None)
    _emit(
        {
            "schema": "kungfu.dogfood-feedback.diagnosis/v1",
            "ok": False,
            "code": "dogfood-operation-failed",
            "message": str(error),
            "cause": cause if isinstance(cause, dict) else None,
            "next_actions": [],
        }
    )


def _guard(function):
    @wraps(function)
    def guarded(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except click.exceptions.Exit:
            raise
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            _failure(error)
            raise click.exceptions.Exit(2) from error

    return guarded


def _runtime(workspace_root: str, home: bool, *, write: bool):
    target = resolve_workspace_target(
        "semantic-write" if write else "read-only",
        workspace_root or None,
        home=home,
        cwd=os.getcwd(),
    )
    identity = target.identity
    if identity.workspace_kind not in {"project", "home"} or not identity.initialized:
        raise ValueError("Dogfood requires an initialized project or Home workspace")
    if write:
        receipt = prepare_workspace_write(target, "dogfood-feedback")
    else:
        receipt = {
            "schema": "kungfu.workspace.target-receipt/v1",
            "operation_class": "read-only",
            "initialized": False,
            "created_paths": [],
            "git_effects": [],
        }
    return identity, target.runtime_dir, receipt


def _load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("input JSON must be an object")
    return value


def _identity_options(function):
    for decorator in reversed(
        [
            click.option(
                "--workspace", "workspace_root", type=click.Path(file_okay=False)
            ),
            click.option("--home", is_flag=True),
        ]
    ):
        function = decorator(function)
    return function


def _json_action(name: str, intent_id: str):
    @dogfood.command(name=name, help=f"run the native {name} intent")
    @click.argument(
        "input_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
    )
    @_identity_options
    @click.option("--authorized-by", required=True)
    @dogfood_context
    @surface(id=f"kungfu.dogfood.{name.replace('-', '.')}")
    @_guard
    def command(ctx, input_file, workspace_root, home, authorized_by):
        del ctx
        identity, runtime_dir, workspace_receipt = _runtime(
            workspace_root, home, write=True
        )
        lifecycle = dogfood_api.ensure_profile(runtime_dir, authorized_by)
        values = _load(input_file)
        values.setdefault("actor", authorized_by)
        result = dogfood_api.action(runtime_dir, intent_id, values, authorized_by)
        _emit(
            {
                **result,
                "workspace": identity.as_dict(),
                "workspace_receipt": workspace_receipt,
                "profile_lifecycle_receipt_count": len(lifecycle),
            }
        )

    return command


capture = _json_action("capture", "capture-finding")
admit = _json_action("admit", "admit-issue")
transition = _json_action("transition", "transition-issue")


@dogfood.command(help="diagnose the exact Dogfood Profile root without mutation")
@_identity_options
@dogfood_context
@surface(id="kungfu.dogfood.doctor")
@_guard
def doctor(ctx, workspace_root, home):
    del ctx
    _, runtime_dir, _ = _runtime(workspace_root, home, write=False)
    _emit(dogfood_api.profile_diagnosis(runtime_dir))


@dogfood.command(help="plan or explicitly apply exact Dogfood Profile recovery")
@_identity_options
@click.option("--expected-plan-root", default="")
@click.option("--execute", is_flag=True)
@click.option("--authorized-by", default="")
@dogfood_context
@surface(id="kungfu.dogfood.recover")
@_guard
def recover(
    ctx,
    workspace_root,
    home,
    expected_plan_root,
    execute,
    authorized_by,
):
    del ctx
    _, runtime_dir, _ = _runtime(workspace_root, home, write=execute)
    if not execute:
        _emit(dogfood_api.recovery_plan(runtime_dir))
        return
    if not expected_plan_root or not authorized_by:
        raise ValueError(
            "--expected-plan-root and --authorized-by are required with --execute"
        )
    _emit(
        dogfood_api.apply_recovery(
            runtime_dir,
            expected_plan_root=expected_plan_root,
            authorized_by=authorized_by,
        )
    )


@dogfood.command(help="show the installed dogfood contract and vocabularies")
@_identity_options
@dogfood_context
@_guard
def capabilities(ctx, workspace_root, home):
    del ctx
    _, runtime_dir, _ = _runtime(workspace_root, home, write=False)
    _emit(dogfood_api.read(runtime_dir, "capabilities"))


@dogfood.command(help="query the federated dogfood projection")
@_identity_options
@click.option(
    "--scope", type=click.Choice(["local", "related", "all"]), default="local"
)
@dogfood_context
@surface(id="kungfu.dogfood.query")
@_guard
def query(ctx, workspace_root, home, scope):
    del ctx
    identity, runtime_dir, _ = _runtime(workspace_root, home, write=False)
    _emit(
        dogfood_api.read(
            runtime_dir,
            "query",
            {
                "workspaceRoot": identity.workspace_root or "",
                "home": home,
                "scope": scope,
            },
        )
    )


@dogfood.command(help="show one Finding or Issue by stable id or content root")
@click.argument("identity")
@_identity_options
@dogfood_context
@surface(id="kungfu.dogfood.show")
@_guard
def show(ctx, identity, workspace_root, home):
    del ctx
    _, runtime_dir, _ = _runtime(workspace_root, home, write=False)
    result = dogfood_api.read(
        runtime_dir,
        "lookup",
        {"identity": identity},
    )
    _emit(result)
    if not result["ok"]:
        raise click.exceptions.Exit(3)


@dogfood.command(
    name="propose-issue",
    help="build a deterministic Finding-rooted Issue admission proposal",
)
@click.argument("finding_identity")
@_identity_options
@click.option("--owner-candidate", multiple=True)
@dogfood_context
@surface(id="kungfu.dogfood.propose.issue")
@_guard
def propose_issue(
    ctx,
    finding_identity,
    workspace_root,
    home,
    owner_candidate,
):
    del ctx
    _, runtime_dir, _ = _runtime(workspace_root, home, write=False)
    _emit(
        dogfood_api.read(
            runtime_dir,
            "issue-proposal",
            {
                "findingIdentity": finding_identity,
                "ownerCandidates": list(owner_candidate),
            },
        )
    )


@dogfood.command(
    help="reconcile candidate evidence into a read-only Issue transition plan"
)
@click.argument("issue_identity")
@click.argument(
    "evidence_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@_identity_options
@dogfood_context
@surface(id="kungfu.dogfood.reconcile")
@_guard
def reconcile(ctx, issue_identity, evidence_file, workspace_root, home):
    del ctx
    _, runtime_dir, _ = _runtime(workspace_root, home, write=False)
    _emit(
        dogfood_api.read(
            runtime_dir,
            "issue-reconciliation",
            {
                "issueIdentity": issue_identity,
                "evidence": _load(evidence_file),
            },
        )
    )


@dogfood.command(
    help="project deduplicated ownership, state, recurrence, aging, and latency health"
)
@_identity_options
@click.option(
    "--scope", type=click.Choice(["local", "related", "all"]), default="local"
)
@click.option("--now", default="")
@dogfood_context
@surface(id="kungfu.dogfood.health")
@_guard
def health(ctx, workspace_root, home, scope, now):
    del ctx
    identity, runtime_dir, _ = _runtime(workspace_root, home, write=False)
    _emit(
        dogfood_api.read(
            runtime_dir,
            "health",
            {
                "workspaceRoot": identity.workspace_root or "",
                "home": home,
                "scope": scope,
                "now": now,
            },
        )
    )


@dogfood.command(help="rank bounded, explainable Issues for an Assignment")
@click.argument(
    "assignment_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@_identity_options
@click.option(
    "--scope", type=click.Choice(["local", "related", "all"]), default="local"
)
@click.option("--limit", type=click.IntRange(1, 100), default=50)
@dogfood_context
@_guard
def relevance(ctx, assignment_file, workspace_root, home, scope, limit):
    del ctx
    identity, runtime_dir, _ = _runtime(workspace_root, home, write=False)
    _emit(
        dogfood_api.read(
            runtime_dir,
            "relevance",
            {
                "workspaceRoot": identity.workspace_root or "",
                "home": home,
                "assignment": _load(assignment_file),
                "scope": scope,
                "limit": limit,
            },
        )
    )


@dogfood.command(help="record one rooted Assignment consideration stage")
@click.argument(
    "assignment_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@_identity_options
@click.option(
    "--stage",
    type=click.Choice(["design", "admission", "kickoff", "closeout"]),
    required=True,
)
@click.option(
    "--dispositions",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option(
    "--scope", type=click.Choice(["local", "related", "all"]), default="local"
)
@click.option("--limit", type=click.IntRange(1, 100), default=50)
@click.option("--actor", required=True)
@dogfood_context
@surface(id="kungfu.dogfood.consider")
@_guard
def consider(
    ctx,
    assignment_file,
    workspace_root,
    home,
    stage,
    dispositions,
    scope,
    limit,
    actor,
):
    del ctx
    identity, runtime_dir, workspace_receipt = _runtime(
        workspace_root, home, write=True
    )
    lifecycle = dogfood_api.ensure_profile(runtime_dir, actor)
    disposition_values = []
    if dispositions is not None:
        loaded = json.loads(dispositions.read_text(encoding="utf-8"))
        if not isinstance(loaded, list):
            raise ValueError("dispositions JSON must be an array")
        disposition_values = loaded
    result = dogfood_api.consider_assignment(
        runtime_dir,
        workspace_root=identity.workspace_root or "",
        home=home,
        assignment=_load(assignment_file),
        stage=stage,
        actor=actor,
        dispositions=disposition_values,
        scope=scope,
        limit=limit,
    )
    _emit(
        {
            **result,
            "workspace_receipt": workspace_receipt,
            "profile_lifecycle_receipt_count": len(lifecycle),
        }
    )


@dogfood.command(help="evaluate mandatory consideration and release policy")
@click.option("--assignment-definition-root", required=True)
@_identity_options
@click.option("--target", type=click.Choice(["run", "closeout"]), default="closeout")
@click.option("--now", default="")
@dogfood_context
@surface(id="kungfu.dogfood.gate")
@_guard
def gate(
    ctx,
    assignment_definition_root,
    workspace_root,
    home,
    target,
    now,
):
    del ctx
    _, runtime_dir, _ = _runtime(workspace_root, home, write=False)
    result = dogfood_api.consideration_gate(
        runtime_dir,
        assignment_definition_root=assignment_definition_root,
        target=target,
        now=now,
    )
    _emit(result)
    if not result["ok"]:
        raise click.exceptions.Exit(4)


@dogfood.command(help="show aging, recurrence, deferral, and release blockers")
@_identity_options
@click.option(
    "--scope", type=click.Choice(["local", "related", "all"]), default="local"
)
@click.option("--now", default="")
@dogfood_context
@_guard
def starvation(ctx, workspace_root, home, scope, now):
    del ctx
    identity, runtime_dir, _ = _runtime(workspace_root, home, write=False)
    _emit(
        dogfood_api.read(
            runtime_dir,
            "starvation",
            {
                "workspaceRoot": identity.workspace_root or "",
                "home": home,
                "scope": scope,
                "now": now,
            },
        )
    )
