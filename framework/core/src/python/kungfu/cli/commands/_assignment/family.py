# SPDX-License-Identifier: Apache-2.0

"""Initiative-family, cross-workspace binding, and portable seal CLI."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import click

_facade = importlib.import_module("kungfu.cli.commands.assignment")
assignment = _facade.assignment
assignment_context = _facade.assignment_context
assignment_identity_options = _facade.assignment_identity_options
initiative_family = _facade.initiative_family
initiative_family_v2 = _facade.initiative_family_v2
orchestration = _facade.orchestration
_emit = _facade._emit
_run = _facade._run
_runtime = _facade._runtime
_status = _facade._status
_ensure_profile = _facade._ensure_profile
_write_immutable_json = _facade._write_immutable_json


@assignment.command(
    name="family-contract",
    help="show the versioned native Initiative-family protocol",
)
@assignment_context
def family_contract_command(ctx):
    _emit(initiative_family.family_contract())


@assignment.command(
    name="family-create",
    help="create one rooted inert-parent and bounded-Wave family state",
)
@click.argument(
    "blueprint_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@assignment_context
def family_create(ctx, blueprint_file, out):
    def operation():
        blueprint = json.loads(blueprint_file.read_text(encoding="utf-8"))
        state = initiative_family.create_family_state(blueprint)
        return {
            "schema": "kungfu.work-control.initiative-family-create/v1",
            "state": state,
            "stateRoot": state["stateRoot"],
            "outputPath": _write_immutable_json(out, state),
            "verification": initiative_family.verify_family_state(state),
        }

    _emit(_run(operation))


@assignment.command(
    name="family-transition",
    help="append one expected-root terminal or acceptance transition",
)
@click.argument(
    "state_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.argument(
    "transition_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@assignment_context
def family_transition(ctx, state_file, transition_file, out):
    def operation():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        transition = json.loads(transition_file.read_text(encoding="utf-8"))
        successor = initiative_family.transition_family_state(state, transition)
        return {
            "schema": "kungfu.work-control.initiative-family-transition-result/v1",
            "state": successor,
            "stateRoot": successor["stateRoot"],
            "previousStateRoot": successor["previousStateRoot"],
            "outputPath": _write_immutable_json(out, successor),
            "verification": initiative_family.verify_family_state(successor),
        }

    _emit(_run(operation))


@assignment.command(
    name="family-verify",
    help="verify one native Initiative-family state without runtime mutation",
)
@click.argument(
    "state_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@assignment_context
def family_verify(ctx, state_file):
    def operation():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        return initiative_family.verify_family_state(state)

    _emit(_run(operation))


@assignment.command(
    name="family-contract-v2",
    help="show the additive typed Initiative-family envelope protocol",
)
@assignment_context
def family_contract_v2_command(ctx):
    _emit(initiative_family_v2.family_contract_v2())


@assignment.command(
    name="family-upgrade-v2",
    help="explicitly bind one immutable v1 state into a typed v2 envelope",
)
@click.argument(
    "state_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.argument(
    "binding_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@assignment_context
def family_upgrade_v2(ctx, state_file, binding_file, out):
    def operation():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        bindings = json.loads(binding_file.read_text(encoding="utf-8"))
        upgrade = initiative_family_v2.upgrade_family_state_v2(state, bindings)
        successor = upgrade["successorState"]
        return {
            **upgrade,
            "outputPath": _write_immutable_json(out, successor),
            "verification": initiative_family_v2.verify_family_state_v2(successor),
        }

    _emit(_run(operation))


@assignment.command(
    name="family-transition-v2",
    help="advance a typed family state with an exact v1 transition and bindings",
)
@click.argument(
    "state_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.argument(
    "transition_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@assignment_context
def family_transition_v2(ctx, state_file, transition_file, out):
    def operation():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        transition = json.loads(transition_file.read_text(encoding="utf-8"))
        successor = initiative_family_v2.transition_family_state_v2(state, transition)
        return {
            "schema": "kungfu.work-control.initiative-family-transition-result/v2",
            "state": successor,
            "stateRoot": successor["stateRoot"],
            "previousStateRoot": successor["previousStateRoot"],
            "v1ProjectionRoot": successor["v1ProjectionRoot"],
            "typedBindingRoot": successor["typedBindingRoot"],
            "outputPath": _write_immutable_json(out, successor),
            "verification": initiative_family_v2.verify_family_state_v2(successor),
        }

    _emit(_run(operation))


@assignment.command(
    name="family-verify-v2",
    help="read v1 as under-typed or verify one complete typed v2 state",
)
@click.argument(
    "state_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@assignment_context
def family_verify_v2(ctx, state_file):
    def operation():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        return initiative_family_v2.verify_family_state_v2(state)

    _emit(_run(operation))


@assignment.command(
    name="binding-create",
    help="build one path-free cross-workspace parent/child binding from receipts",
)
@click.option(
    "--parent-admission",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--parent-status",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--child-admission",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--child-status",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
@assignment_context
def binding_create(
    ctx,
    parent_admission,
    parent_status,
    child_admission,
    child_status,
    out,
):
    def binding_create_operation():
        binding = orchestration.cross_workspace_binding(
            json.loads(parent_admission.read_text(encoding="utf-8")),
            json.loads(parent_status.read_text(encoding="utf-8")),
            json.loads(child_admission.read_text(encoding="utf-8")),
            json.loads(child_status.read_text(encoding="utf-8")),
        )
        output_path = None
        if out is not None:
            output_path = out.expanduser().resolve()
            content = (initiative_family.canonical_json(binding) + "\n").encode("utf-8")
            if output_path.exists() and output_path.read_bytes() != content:
                raise ValueError("binding output exists with different bytes")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            if not output_path.exists():
                output_path.write_bytes(content)
        return {
            "schema": "kungfu.assignment-orchestration.cross-workspace-binding-create/v1",
            "binding": binding,
            "bindingRoot": binding["bindingRoot"],
            "outputPath": str(output_path) if output_path else None,
            "next_actions": [
                {
                    "action": "bind",
                    "description": "admit the exact binding in both endpoint workspaces",
                }
            ],
        }

    _emit(_run(binding_create_operation))


@assignment.command(
    name="bind",
    help="plan or admit one exact cross-workspace binding in this endpoint",
)
@click.argument(
    "binding_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@assignment_identity_options
@click.option("--execute", is_flag=True)
@click.option("--expected-binding-root", default="")
@assignment_context
def bind(
    ctx,
    binding_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    execute,
    expected_binding_root,
):
    def bind_operation():
        binding = json.loads(binding_file.read_text(encoding="utf-8"))
        identity, runtime_dir, _ = _runtime(workspace_root, home, "read-only")
        current = _status(runtime_dir, initiative_id, assignment_id)
        plan = orchestration.cross_workspace_binding_plan(
            identity.workspace_root or identity.data_home,
            identity.as_dict(),
            current,
            binding,
        )
        if not execute:
            return {
                **plan,
                "next_actions": [
                    {
                        "action": "bind",
                        "expected_binding_root": plan["bindingRoot"],
                    }
                ],
            }
        return orchestration.apply_cross_workspace_binding(
            plan, binding, expected_binding_root
        )

    _emit(_run(bind_operation))


@assignment.command(
    name="verify-binding",
    help="verify a local cross-workspace binding receipt without a live runtime",
)
@click.option(
    "--binding",
    "binding_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--receipt",
    "receipt_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@assignment_context
def verify_binding(ctx, binding_file, receipt_file):
    result = _run(
        lambda: orchestration.verify_cross_workspace_binding_receipt(
            binding_file, receipt_file
        )
    )
    _emit(result)
    if not result["ok"]:
        raise click.exceptions.Exit(5)


@assignment.command(help="plan or write a portable content-addressed state snapshot")
@assignment_identity_options
@click.option("--execute", is_flag=True)
@click.option("--expected-state-root", default="")
@assignment_context
def seal(
    ctx,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    execute,
    expected_state_root,
):
    def seal_operation():
        identity, runtime_dir, _ = _runtime(workspace_root, home)
        _ensure_profile(runtime_dir, "assignment-seal")
        current = _status(runtime_dir, initiative_id, assignment_id)
        plan = orchestration.sealed_state_plan(
            identity.workspace_root or identity.data_home,
            current,
            workspace_identity=identity.as_dict(),
        )
        if not execute:
            return {
                **plan,
                "executed": False,
                "next_actions": [
                    {"action": "seal", "expected_state_root": plan["state_root"]}
                ],
            }
        return orchestration.apply_sealed_state(plan, expected_state_root)

    _emit(_run(seal_operation))


@assignment.command(
    name="verify-seal", help="verify sealed state without a live runtime"
)
@click.argument(
    "state_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@assignment_context
def verify_seal(ctx, state_file):
    result = _run(lambda: orchestration.verify_sealed_state(state_file))
    _emit(result)
    if not result["ok"]:
        raise click.exceptions.Exit(5)


for _symbol in (
    "family_contract_command",
    "family_create",
    "family_transition",
    "family_verify",
    "family_contract_v2_command",
    "family_upgrade_v2",
    "family_transition_v2",
    "family_verify_v2",
    "binding_create",
    "bind",
    "verify_binding",
    "seal",
    "verify_seal",
):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.assignment"
    globals()[_symbol].callback.__qualname__ = _symbol
